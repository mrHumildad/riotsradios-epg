#!/usr/bin/env python3
"""
fetch_epgs.py - step 2 of the EPG pipeline for riotsradios-epg.

For every station with an `epg_url` in config/stations.csv, download the page and keep
a raw snapshot, so later stages (parse / normalise) work from files on disk and never
hit the network. It also decides whether the content REALLY changed.

Layout written under data/raw/ (git-ignore it, it is a cache):

    data/raw/<id>/latest.<ext>      last good snapshot (html / pdf / png / jpg / ics / json ...)
    data/raw/<id>/previous.<ext>    the snapshot before the last real change
    data/raw/<id>/rejected.<ext>    last download that looked broken (never promoted)
    data/raw/<id>/meta.json         url, hashes, etag, status, failure counter ...
    data/raw/_run.json              report of this run + list of changed ids (feeds step 3)

Per-station status:
    new        first successful download
    changed    visible content differs from the last good snapshot
    unchanged  304 Not Modified, or only scripts/markup noise differs
    suspect    200 OK but much emptier than before (error page, JS shell) -> NOT promoted
    failed     network / HTTP error; the last good snapshot is kept
    skipped    no epg_url, or fetched recently (--max-age-hours)

Usage (repo root, after find_epg_urls.py):
    python3 scripts/fetch_epgs.py
    python3 scripts/fetch_epgs.py --only 1 18
    python3 scripts/fetch_epgs.py --max-age-hours 20     # cron friendly
    python3 scripts/fetch_epgs.py --render               # JS-drawn pages via Playwright (optional)

Same politeness as step 1: robots.txt, 1 req/s per host, identifying User-Agent.
Stdlib only; Playwright is imported lazily and only with --render.
"""
import argparse
import base64
import csv
import hashlib
import inspect
import json
import os
import re
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, quote, urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from find_epg_urls import UA, Fetcher, count_days_times, parse_html  # noqa: E402

MAX_BYTES = 15_000_000


def now_iso():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


# --------------------------------------------------------------------------- content detection


def sniff(body: bytes, ctype: str):
    """Decide the real kind from the bytes (headers lie often). -> (kind, ext)"""
    head = body[:2048]
    low = head.lower()
    if head.startswith(b"%PDF-"):
        return "pdf", "pdf"
    if head.startswith(b"\x89PNG"):
        return "image", "png"
    if head.startswith(b"\xff\xd8\xff"):
        return "image", "jpg"
    if head.startswith(b"GIF8"):
        return "image", "gif"
    if head.startswith(b"RIFF") and head[8:12] == b"WEBP":
        return "image", "webp"
    if head.lstrip().upper().startswith(b"BEGIN:VCALENDAR"):
        return "ical", "ics"
    if head.lstrip()[:1] in (b"{", b"[") and ("json" in ctype or True):
        try:
            json.loads(body.decode("utf-8", errors="replace"))
            return "json", "json"
        except ValueError:
            pass
    if b"<html" in low or b"<!doctype" in low or b"<body" in low or "html" in ctype:
        return "html", "html"
    if "xml" in ctype or low.lstrip().startswith(b"<?xml"):
        return "xml", "xml"
    return "other", "bin"


def ical_text(body: bytes) -> str:
    txt = body.decode("utf-8", errors="replace").replace("\r\n", "\n")
    txt = re.sub(r"\n[ \t]", "", txt)  # unfold
    keep = [ln for ln in txt.split("\n") if not re.match(r"(?i)(DTSTAMP|LAST-MODIFIED|CREATED|PRODID)[:;]", ln)]
    return "\n".join(keep)


def fingerprint(kind: str, body: bytes, ctype: str):
    """-> (text_hash, text_len, days, times, scripts). The hash ignores noise so we only
    call something 'changed' when the human-visible content moved."""
    days = times = scripts = 0
    if kind == "html":
        _, p = parse_html(body, ctype)
        text = re.sub(r"\s+", " ", " ".join(p.text)).strip()
        days, times = count_days_times(text)
        scripts = p.scripts
    elif kind == "ical":
        text = ical_text(body)
    elif kind == "json":
        try:
            text = json.dumps(json.loads(body.decode("utf-8", errors="replace")), sort_keys=True)
        except ValueError:
            text = body.decode("utf-8", errors="replace")
    else:
        return hashlib.sha256(body).hexdigest(), len(body), 0, 0, 0
    return hashlib.sha256(text.encode("utf-8")).hexdigest(), len(text), days, times, scripts


def looks_js_rendered(kind, text_len, days, times, scripts):
    return kind == "html" and days == 0 and times < 3 and scripts >= 5 and text_len < 3000


# --------------------------------------------------------------------------- google calendar embed


def gcal_ics_url(url: str):
    """calendar.google.com/calendar/embed?src=<id> -> public iCal URL (works only for public calendars)."""
    u = urlparse(url)
    if u.netloc != "calendar.google.com" or "/embed" not in u.path:
        return None
    src = (parse_qs(u.query).get("src") or [None])[0]
    if not src:
        return None
    if "@" not in src:  # newer embeds base64-encode the calendar id
        try:
            dec = base64.urlsafe_b64decode(src + "=" * (-len(src) % 4)).decode()
            src = dec if "@" in dec else None
        except Exception:
            src = None
    return f"https://calendar.google.com/calendar/ical/{quote(src)}/public/basic.ics" if src else None


# --------------------------------------------------------------------------- optional rendering


def render_html(url: str):
    """Render a JS page with Playwright and return the final DOM as bytes (or None)."""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("    (playwright not installed: pip install playwright && playwright install chromium)")
        return None
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page(user_agent=UA)
            page.goto(url, wait_until="networkidle", timeout=45000)
            html = page.content()
            browser.close()
        return html.encode("utf-8")
    except Exception as e:
        print(f"    render failed: {type(e).__name__}: {str(e)[:100]}")
        return None


# --------------------------------------------------------------------------- storage


def read_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def write_atomic(path, data: bytes):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path))
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    os.replace(tmp, path)


def write_json(path, obj):
    write_atomic(path, json.dumps(obj, ensure_ascii=False, indent=2).encode("utf-8"))


def find_snapshot(d, stem):
    if not os.path.isdir(d):
        return None
    for name in os.listdir(d):
        if name.startswith(stem + "."):
            return os.path.join(d, name)
    return None


def drop_snapshots(d, stem):
    p = find_snapshot(d, stem)
    while p:
        os.remove(p)
        p = find_snapshot(d, stem)


# --------------------------------------------------------------------------- one station


def process(row, fetcher, raw_dir, args):
    sid, name, url = row["id"].strip(), row["name"], row["epg_url"].strip()
    d = os.path.join(raw_dir, sid)
    meta_path = os.path.join(d, "meta.json")
    meta = read_json(meta_path, {})
    meta.update(id=sid, name=name, url=url)

    if args.max_age_hours and meta.get("fetched_at") and meta.get("status") != "failed":
        age = datetime.now(timezone.utc) - datetime.fromisoformat(meta["fetched_at"])
        if age < timedelta(hours=args.max_age_hours):
            return {"status": "skipped", "note": "fetched recently"}

    fetch_url = gcal_ics_url(url) or url
    meta["fetch_url"] = fetch_url
    cond = {}
    if not args.force and meta.get("etag") and meta.get("last_fetch_url") == fetch_url and find_snapshot(d, "latest"):
        cond["If-None-Match"] = meta["etag"]
    if not args.force and meta.get("last_modified") and meta.get("last_fetch_url") == fetch_url and find_snapshot(d, "latest"):
        cond["If-Modified-Since"] = meta["last_modified"]

    r = fetcher.get(fetch_url, headers=cond, max_bytes=MAX_BYTES)
    if (r["status"] == 0 and r["error"] and "robots" not in r["error"]) or r["status"] >= 500:
        time.sleep(3)  # one gentle retry
        r = fetcher.get(fetch_url, headers=cond, max_bytes=MAX_BYTES)

    meta["fetched_at"] = now_iso()

    if r["status"] == 304:
        meta.update(status="unchanged", http_status=304, error=None, consecutive_failures=0,
                    last_success_at=meta["fetched_at"])
        write_json(meta_path, meta)
        return {"status": "unchanged", "note": "304 not modified"}

    problem = None
    if r["error"] or r["status"] != 200:
        problem = r["error"] or f"HTTP {r['status']}"
    elif r["truncated"]:
        problem = f"larger than {MAX_BYTES // 1_000_000} MB"
    elif not r["body"]:
        problem = "empty response"
    if problem:
        meta.update(status="failed", http_status=r["status"], error=problem,
                    consecutive_failures=meta.get("consecutive_failures", 0) + 1)
        write_json(meta_path, meta)
        return {"status": "failed", "note": problem}

    body, ctype = r["body"], r["ctype"]
    kind, ext = sniff(body, ctype)
    thash, tlen, days, times, scripts = fingerprint(kind, body, ctype)

    rendered = False
    needs_render = looks_js_rendered(kind, tlen, days, times, scripts)
    if needs_render and args.render:
        dom = render_html(fetch_url)
        if dom:
            body, rendered = dom, True
            thash, tlen, days, times, scripts = fingerprint("html", body, "text/html; charset=utf-8")
            needs_render = looks_js_rendered("html", tlen, days, times, scripts)
    meta["needs_render"] = needs_render

    # --- sanity gate: don't let a broken page replace a good snapshot
    prev_len, prev_days = meta.get("text_len", 0), meta.get("days", 0)
    suspect = None
    if meta.get("text_hash") and kind in ("html", "ical", "json"):
        if prev_len > 1000 and tlen < 0.3 * prev_len:
            suspect = f"content shrank {prev_len} -> {tlen} chars"
        elif prev_days >= 3 and days == 0 and kind == "html":
            suspect = "weekday names disappeared"
    if suspect:
        drop_snapshots(d, "rejected")
        write_atomic(os.path.join(d, f"rejected.{ext}"), body)
        meta.update(status="suspect", error=suspect, http_status=200)
        write_json(meta_path, meta)
        return {"status": "suspect", "note": suspect}

    # --- promote
    had_latest = find_snapshot(d, "latest")
    changed = (not meta.get("text_hash")) or thash != meta["text_hash"] or (
        had_latest and not had_latest.endswith("." + ext))
    if not had_latest:
        status = "new"
    else:
        status = "changed" if changed else "unchanged"

    if status in ("new", "changed"):
        if had_latest:
            drop_snapshots(d, "previous")
            os.replace(had_latest, os.path.join(d, "previous." + had_latest.rsplit(".", 1)[1]))
        write_atomic(os.path.join(d, f"latest.{ext}"), body)
        meta.update(content_hash=hashlib.sha256(body).hexdigest(), bytes=len(body), kind=kind, ext=ext,
                    changed_at=meta["fetched_at"])
    meta.update(status=status, http_status=200, error=None, consecutive_failures=0,
                last_success_at=meta["fetched_at"], text_hash=thash, text_len=tlen, days=days,
                times=times, rendered=rendered, last_fetch_url=fetch_url,
                etag=r["headers"].get("etag"), last_modified=r["headers"].get("last-modified"),
                final_url=r["url"])
    write_json(meta_path, meta)
    note = f"{kind}, {len(body):,} bytes" + (", days=%d times=%d" % (days, times) if kind == "html" else "")
    if needs_render:
        note += "  [JS-rendered: re-run with --render]"
    return {"status": status, "note": note}


# --------------------------------------------------------------------------- main


def check_step1_version():
    params = inspect.signature(Fetcher.get).parameters
    if "headers" not in params or "max_bytes" not in params:
        sys.exit("scripts/find_epg_urls.py is an older version (its Fetcher.get() has no headers/max_bytes).\n"
                 "Replace it with the updated find_epg_urls.py that came with fetch_epgs.py, then re-run.")


def main():
    check_step1_version()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--csv", default="config/stations.csv")
    ap.add_argument("--raw-dir", default="data/raw")
    ap.add_argument("--sources", default="data/epg_sources.json", help="sidecar written by find_epg_urls.py")
    ap.add_argument("--only", nargs="*", type=int, default=None, help="station ids to process")
    ap.add_argument("--delay", type=float, default=1.0, help="seconds between requests to one host")
    ap.add_argument("--max-age-hours", type=float, default=0, help="skip stations fetched more recently")
    ap.add_argument("--force", action="store_true", help="ignore ETag / Last-Modified")
    ap.add_argument("--render", action="store_true", help="use Playwright for JS-drawn pages")
    ap.add_argument("--fail-on-error", action="store_true", help="exit 1 if any station failed")
    args = ap.parse_args()

    with open(args.csv, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))

    fetcher = Fetcher(delay=args.delay, timeout=30)
    # stations whose certificate was broken at discovery time (flagged by find_epg_urls.py)
    sources = read_json(args.sources, {}).get("stations", {})
    for row in rows:
        if sources.get(row["id"].strip(), {}).get("tls_unverified") and row["epg_url"].strip():
            fetcher.insecure_hosts.add(urlparse(row["epg_url"]).netloc)
    results, changed_ids = [], []
    for row in rows:
        sid = row["id"].strip()
        if args.only is not None and int(sid or -1) not in args.only:
            continue
        if not row["epg_url"].strip():
            continue
        res = process(row, fetcher, args.raw_dir, args)
        results.append({"id": sid, "name": row["name"], **res})
        if res["status"] in ("new", "changed"):
            changed_ids.append(int(sid))
        print(f"[{sid:>3}] {row['name'][:28]:28s} {res['status']:9s} {res['note']}")

    os.makedirs(args.raw_dir, exist_ok=True)
    counts = {}
    for r in results:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    write_json(os.path.join(args.raw_dir, "_run.json"),
               {"run_at": now_iso(), "counts": counts, "changed": changed_ids, "results": results})
    print("\n" + ", ".join(f"{k}: {v}" for k, v in sorted(counts.items())) + f"   changed ids: {changed_ids}")
    if args.fail_on_error and counts.get("failed"):
        sys.exit(1)


if __name__ == "__main__":
    main()
