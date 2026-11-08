#!/usr/bin/env python3
"""
find_epg_urls.py (v2) - step 1 of the EPG pipeline for riotsradios-epg.

For every station in config/stations.csv that has a `homepage` and an empty `epg_url`, find
the page holding the weekly programme grid and (with --write) fill `epg_url`. Details for
each station go to data/epg_sources.json (format, confidence, alternatives) for review.

What changed in v2
  FASTER   stations run in parallel (--workers, default 8); the per-host rate limit (1 req/s)
           still applies, so we stay polite. Pages are fetched once and reused, path probes are
           chosen by the station's country and stop early, and timeouts are short (8 s).
  SMARTER  dated blog/news posts (/2023/11/..., ?p=123) and deep single-show pages are demoted;
           a "hub" page (e.g. /programacion/) is followed one level to find the real grid
           (/programacion/parrilla/); German "Programm" is understood.
  TLS      a station with a broken certificate is read anyway, flagged `tls_unverified`
           (disable with --strict-tls). Step 2 honours the flag.
  EVIDENCE candidate pages also report schedule images, PDFs, iframes, title and script count.
  ACTION   every result is classified as add_source, review_partial, ocr_or_manual,
           render_or_manual, blocked_by_robots, fix_homepage or no_schedule.
  ASSETS   schedule images and documents become candidates even without link text.
  SOURCE   SAPO radio widgets (data-station + sapo-widget.js) resolve to their JSON
           schedule API, so JS-only pages with that widget become add_source.

Usage (repo root):
    python3 scripts/find_epg_urls.py                    # dry run
    python3 scripts/find_epg_urls.py --write
    python3 scripts/find_epg_urls.py --only 12 66 --force --write
    python3 scripts/find_epg_urls.py --resume --write   # skip stations already checked today
    python3 scripts/find_epg_urls.py --ollama qwen2.5:3b --write

Rules: never overwrites a non-empty epg_url without --force; never touches a sidecar entry with
"locked": true; honours robots.txt; identifying User-Agent. Stdlib only.
"""
import argparse
import csv
import json
import os
import re
import ssl
import sys
import tempfile
import threading
import time
import unicodedata
import urllib.error
import urllib.request
import urllib.robotparser
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date
from html.parser import HTMLParser
from urllib.parse import quote, urldefrag, urljoin, urlparse

UA = "riotsradios-epg-finder/0.3 (+https://github.com/mrHumildad/riotsradios-epg)"
MAX_BYTES = 2_000_000

# --------------------------------------------------------------------------- text helpers


def norm(s: str) -> str:
    """lowercase + strip accents, so 'Programació' == 'programacio'."""
    s = unicodedata.normalize("NFKD", s or "")
    return "".join(c for c in s if not unicodedata.combining(c)).lower()


DAYS = [
    ["lunes", "dilluns", "lunedi", "lundi", "monday", "montag", "astelehena", "segunda"],
    ["martes", "dimarts", "martedi", "mardi", "tuesday", "dienstag", "asteartea", "terca"],
    ["miercoles", "dimecres", "mercoledi", "mercredi", "wednesday", "mittwoch", "asteazkena", "quarta"],
    ["jueves", "dijous", "giovedi", "jeudi", "thursday", "donnerstag", "osteguna", "quinta"],
    ["viernes", "divendres", "venerdi", "vendredi", "friday", "freitag", "ostirala", "sexta"],
    ["sabado", "dissabte", "sabato", "samedi", "saturday", "samstag", "larunbata"],
    ["domingo", "diumenge", "domenica", "dimanche", "sunday", "sonntag", "igandea"],
]
DAY_RES = [re.compile(r"\b(?:%s)\b" % "|".join(names)) for names in DAYS]
TIME_RE = re.compile(
    r"\b(?:[01]?\d|2[0-3])(?:(?::|h|\.)\s?[0-5]\d|\s?(?:hs?|am|pm))\b", re.I
)
ASSET_RE = re.compile(r"program|parrilla|palinsest|grill|horari|agenda|calend|semanal|schedule|programm", re.I)
DOC_RE = re.compile(r"\.(?:pdf|jpe?g|png|webp)(?:\?|$)", re.I)
SUSPICIOUS_RE = re.compile(r"casino|apuestas|bonos|slots|pin up|domain (?:for sale|parked)|redirecting", re.I)

STRONG = re.compile(
    r"parrilla|programaci|palinsesto|programmazione|grille|sendeplan|horario|schedule|egitarau|"
    r"programazio|programme|programmation|programacao|\bprogramm\b|\bgrade\b|tableau"
)
WEAK = re.compile(r"\bprogramas?\b|emision|emissions|agenda|\bguia\b|\bshows?\b|\bprogramm?s?\b|sendungen")
BONUS = re.compile(r"semanal|semana|setmanal|settimanale|weekly|hebdo|wochen")
PENALTY = re.compile(r"podcast|archiv|noticia|news|blog|shop|tienda|dona|socio|contact|especial")
# a dated post / numeric article id is an article, not the schedule page
POST_RE = re.compile(r"/(?:19|20)\d{2}/\d{1,2}(?:/\d{1,2})?/|[?&]p=\d+|\d{4}-\d{2}-\d{2}|/(?:blog|noticias?|news|entradas?)/")


def is_post_url(url: str) -> bool:
    return bool(POST_RE.search(url))


def score_link(text: str, href: str) -> float:
    path = urlparse(href).path
    s = norm(text + " " + path.replace("-", " ").replace("_", " ").replace("/", " "))
    base = 1.0 if STRONG.search(s) else 0.4 if WEAK.search(s) else 0.0
    if base == 0:
        return 0.0
    if BONUS.search(s):
        base += 0.15
    if PENALTY.search(s):
        base -= 0.5
    if is_post_url(href):
        base -= 0.6
    segs = [x for x in path.split("/") if x]
    if len(segs) >= 4 and not STRONG.search(norm(segs[-1])):  # deep leaf = probably one show
        base *= 0.6
    return max(0.1, min(1.0, base))   # floor: keep demoted links visible as low-score alternatives


def count_days_times(text: str):
    t = norm(text)
    return sum(1 for r in DAY_RES if r.search(t)), len(TIME_RE.findall(t))


# --------------------------------------------------------------------------- html parsing


class PageParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.links, self.text, self.iframes, self.images = [], [], [], []
        self.scripts = 0
        self.script_srcs = []
        self.sapo_stations = []
        self.title = ""
        self.lang = None
        self._skip = 0
        self._a = None
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "html" and a.get("lang"):
            self.lang = a["lang"][:2].lower()
        if tag == "title":
            self._in_title = True
        if tag in ("script", "style", "noscript"):
            self._skip += 1
            if tag == "script":
                self.scripts += 1
                if a.get("src"):
                    self.script_srcs.append(a["src"])
        elif tag == "a" and a.get("href"):
            self._a = [a["href"], ((a.get("aria-label") or "") + " " + (a.get("title") or "")).strip()]
        elif tag == "iframe" and a.get("src"):
            self.iframes.append(a["src"])
        elif tag == "img" and a.get("src"):
            self.images.append((a["src"], a.get("alt") or ""))
        elif tag == "div":
            if a.get("id") == "sapo-widget" or "sapo-widget" in (a.get("class") or ""):
                station = (a.get("data-station") or "").strip()
                if station:
                    self.sapo_stations.append(station)

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
        if tag in ("script", "style", "noscript") and self._skip:
            self._skip -= 1
        elif tag == "a" and self._a:
            self.links.append((self._a[0], self._a[1].strip()))
            self._a = None

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        if self._skip:
            return
        self.text.append(data)
        if self._a is not None:
            self._a[1] += " " + data


def parse_html(body: bytes, ctype_hint: str = ""):
    m = re.search(r"charset=([\w-]+)", ctype_hint or "")
    try:
        html = body.decode(m.group(1) if m else "utf-8", errors="replace")
    except LookupError:
        html = body.decode("utf-8", errors="replace")
    p = PageParser()
    try:
        p.feed(html)
    except Exception:
        pass
    return html, p


def sapo_api_url(base, p):
    """SAPO renders client-side; its JSON API is the real, repeatable source."""
    if not p.sapo_stations:
        return None
    for src in p.script_srcs:
        if "sapo-widget" not in src:
            continue
        u = urlparse(urljoin(base, src))
        if u.scheme in ("http", "https") and u.netloc:
            station = quote(p.sapo_stations[0], safe="")
            return f"{u.scheme}://{u.netloc}/api_schedule.php?station={station}"
    return None


def asset_urls(base, p):
    """Schedule images and documents found on a page, even without useful link text."""
    found = []
    for src, alt in p.images:
        if ASSET_RE.search(norm(f"{src} {alt}")):
            u = clean_url(base, src)
            if u:
                found.append(u)
    for href, text in p.links:
        if DOC_RE.search(href) and ASSET_RE.search(norm(f"{href} {text}")):
            u = clean_url(base, href)
            if u:
                found.append(u)
    return list(dict.fromkeys(found))


def action_for(candidate):
    """Turn the evidence into the next human action."""
    if not candidate.get("ok"):
        return "fix_homepage"
    fmt = candidate.get("format")
    days = candidate.get("days", 0)
    times = candidate.get("times", 0)
    if fmt in ("pdf", "image"):
        return "ocr_or_manual"
    if fmt == "js-rendered":
        return "render_or_manual"
    if fmt in ("ical", "json-api"):
        return "add_source"
    if (days >= 5 and times >= 2) or (days >= 4 and times >= 8):
        return "add_source"
    if days >= 1 or times >= 3:
        return "review_partial"
    if candidate.get("schedule_assets"):
        return "ocr_or_manual"
    return "manual_review"


# --------------------------------------------------------------------------- fetching (thread-safe)

_UNVERIFIED = ssl.create_default_context()
_UNVERIFIED.check_hostname = False
_UNVERIFIED.verify_mode = ssl.CERT_NONE


class Fetcher:
    """Polite, thread-safe fetcher: per-host rate limit by slot reservation, cached robots.txt."""

    def __init__(self, delay=1.0, timeout=8, allow_insecure_fallback=False):
        self.delay, self.timeout = delay, timeout
        self.allow_insecure_fallback = allow_insecure_fallback
        self.insecure_hosts = set()          # hosts we read without certificate verification
        self._next = {}                      # host -> earliest next request time
        self._lock = threading.Lock()
        self._robots = {}
        self._rlocks = {}

    def _wait(self, host):
        with self._lock:
            slot = max(time.time(), self._next.get(host, 0))
            self._next[host] = slot + self.delay
        gap = slot - time.time()
        if gap > 0:
            time.sleep(gap)

    def _open(self, req, host):
        ctx = _UNVERIFIED if host in self.insecure_hosts else None
        return urllib.request.urlopen(req, timeout=self.timeout, context=ctx)

    def _raw(self, url, headers=None, max_bytes=MAX_BYTES):
        host = urlparse(url).netloc
        hdrs = {"User-Agent": UA, "Accept": "*/*"}
        hdrs.update(headers or {})
        tls_flag = False
        for attempt in (0, 1):
            self._wait(host)
            req = urllib.request.Request(url, headers=hdrs)
            try:
                with self._open(req, host) as r:
                    data = r.read(max_bytes + 1)
                    return {"url": r.geturl(), "status": r.status,
                            "ctype": (r.headers.get("Content-Type") or "").lower(),
                            "headers": {k.lower(): v for k, v in r.headers.items()},
                            "body": data[:max_bytes], "truncated": len(data) > max_bytes,
                            "tls_unverified": host in self.insecure_hosts, "error": None}
            except urllib.error.HTTPError as e:
                return {"url": url, "status": e.code, "ctype": "", "headers": {}, "body": b"",
                        "truncated": False, "tls_unverified": False, "error": f"HTTP {e.code}"}
            except Exception as e:
                is_tls = "CERTIFICATE_VERIFY_FAILED" in str(e) or isinstance(getattr(e, "reason", None), ssl.SSLCertVerificationError)
                if is_tls and self.allow_insecure_fallback and attempt == 0 and host not in self.insecure_hosts:
                    self.insecure_hosts.add(host)   # retry once without verification, flagged
                    continue
                return {"url": url, "status": 0, "ctype": "", "headers": {}, "body": b"", "truncated": False,
                        "tls_unverified": False, "error": type(e).__name__ + ": " + str(e)[:100]}

    def allowed(self, url):
        u = urlparse(url)
        base = f"{u.scheme}://{u.netloc}"
        with self._lock:
            lock = self._rlocks.setdefault(base, threading.Lock())
        with lock:
            if base not in self._robots:
                rp = urllib.robotparser.RobotFileParser()
                r = self._raw(base + "/robots.txt", max_bytes=200_000)
                if r["status"] == 200:
                    rp.parse(r["body"].decode("utf-8", errors="replace").splitlines())
                else:
                    rp = None
                self._robots[base] = rp
        rp = self._robots[base]
        return True if rp is None else rp.can_fetch(UA, url)

    def get(self, url, headers=None, max_bytes=MAX_BYTES):
        if not self.allowed(url):
            return {"url": url, "status": 0, "ctype": "", "headers": {}, "body": b"", "truncated": False,
                    "tls_unverified": False, "error": "blocked by robots.txt"}
        return self._raw(url, headers, max_bytes)


# --------------------------------------------------------------------------- discovery

PROBES = {
    "es": ["/programacion", "/parrilla", "/programacio", "/parrilla-semanal", "/programas", "/horarios",
           "/egitaraua", "/programazioa"],
    "it": ["/palinsesto", "/programmazione", "/programma"],
    "fr": ["/grille", "/grille-des-programmes", "/programme", "/programmation"],
    "de": ["/programm", "/sendeplan", "/programm/sendeplan"],
    "pt": ["/programacao", "/grade", "/programas"],
    "en": ["/schedule", "/programme", "/programs", "/shows"],
}
COUNTRY_LANG = {**{c: "es" for c in "ES MX AR CL EC CO VE PE UY BO PY CR GT HN NI SV PA DO CU".split()},
                "IT": "it", "FR": "fr", "BE": "fr", "DE": "de", "AT": "de", "CH": "de", "PT": "pt", "BR": "pt",
                "GB": "en", "US": "en", "IE": "en", "CA": "en", "AU": "en"}
GCAL_RE = re.compile(r"https?://calendar\.google\.com/calendar/(?:embed|ical)[^\"'\s<>]*")


def probe_list(lang, limit=8):
    out = list(PROBES.get(lang, []))
    for other in ("es", "en"):
        for p in PROBES[other]:
            if p not in out:
                out.append(p)
    if "/schedule" not in out[:limit]:
        out.insert(limit - 1, "/schedule")
    return out[:limit]


def clean_url(base, href):
    href = (href or "").strip()
    if not href or href.startswith(("mailto:", "tel:", "javascript:", "#")):
        return None
    u = urldefrag(urljoin(base, href))[0]
    return u if urlparse(u).scheme in ("http", "https") else None


def classify_response(r):
    ct, url = r["ctype"], r["url"].lower().split("?")[0]
    if "pdf" in ct or url.endswith(".pdf"):
        return "pdf", None, None
    if ct.startswith("image/") or url.endswith((".png", ".jpg", ".jpeg", ".webp", ".gif")):
        return "image", None, None
    if "calendar" in ct or url.endswith(".ics"):
        return "ical", None, None
    if "json" in ct:
        return "json-api", None, None
    html, p = parse_html(r["body"], ct)
    return "html", html, p


def evaluate(fetcher, url, link_score, via, resp=None):
    r = resp or fetcher.get(url)
    if r["error"] or r["status"] != 200:
        return {"url": url, "ok": False, "error": r["error"] or f"HTTP {r['status']}", "via": via}
    fmt, html, p = classify_response(r)
    out = {"url": r["url"], "ok": True, "format": fmt, "via": via, "link_score": round(link_score, 2),
           "days": 0, "times": 0, "gcal": [], "tls_unverified": r.get("tls_unverified", False),
           "title": "", "scripts": 0, "text_len": 0, "iframes": [], "schedule_assets": []}
    if fmt == "html":
        text = " ".join(p.text)
        days, times = count_days_times(text)
        out["days"], out["times"] = days, times
        out["gcal"] = GCAL_RE.findall(html)
        out["title"] = " ".join(p.title.split())[:120]
        out["scripts"] = p.scripts
        out["text_len"] = len(text)
        out["iframes"] = [urljoin(r["url"], s) for s in p.iframes[:5]]
        out["schedule_assets"] = asset_urls(r["url"], p)[:6]
        page = 0.6 * min(days, 7) / 7 + 0.4 * min(times, 30) / 30
        if days == 0 and times < 3 and p.scripts >= 5 and len(text) < 3000:
            out["format"] = "js-rendered"
            page = 0.45
        sapo = sapo_api_url(r["url"], p)
        if sapo:
            out["page_url"] = r["url"]
            out["sapo_station"] = p.sapo_stations[0]
            out["url"] = sapo
            out["format"] = "json-api"
            page = 0.9
        out["page_score"] = round(page, 2)
        out["_parser"] = p
    else:
        out["page_score"] = {"ical": 1.0, "json-api": 0.7, "pdf": 0.6, "image": 0.5}[fmt]
    conf = 0.35 * link_score + 0.65 * out["page_score"]
    if out["format"] == "js-rendered":
        conf = min(conf, 0.5)
    if is_post_url(out["url"]):          # an article, not the schedule: always needs a human look
        conf, out["post_like"] = min(conf, 0.5), True
    out["confidence"] = round(conf, 2)
    out["action"] = action_for(out)
    return out


def find_for_station(fetcher, homepage, country="", max_eval=8):
    home = fetcher.get(homepage)
    meta = {"homepage_status": home["status"], "homepage_url": home["url"]}
    if home["error"] or home["status"] != 200:
        error = "homepage: " + (home["error"] or f"HTTP {home['status']}")
        action = "blocked_by_robots" if "robots" in error.lower() else "fix_homepage"
        return {**meta, "status": "error", "error": error, "candidates": [], "action": action}
    fmt, html, p = classify_response(home)
    if fmt != "html":
        return {**meta, "status": "error", "error": "homepage is not html", "candidates": [],
                "homepage_format": fmt, "action": "ocr_or_manual"}
    base = home["url"]
    home_text = " ".join(p.text)
    home_title = " ".join(p.title.split())[:120]
    home_assets = asset_urls(base, p)
    suspicious = bool(SUSPICIOUS_RE.search(norm(home_title + " " + home_text[:2000])))
    meta.update(homepage_title=home_title, homepage_suspicious=suspicious, homepage_assets=home_assets[:6])
    lang = COUNTRY_LANG.get((country or "").upper()) or p.lang
    lang = lang if lang in PROBES else None

    cands, cache = {}, {base: home}
    for href, text in p.links:
        u = clean_url(base, href)
        if not u:
            continue
        s = score_link(text, u)
        if s > 0 and (u not in cands or s > cands[u][0]):
            cands[u] = (s, "link:" + " ".join(text.split())[:40])
    candidates = dict(sorted(cands.items(), key=lambda kv: -kv[1][0])[:5])
    for asset in home_assets[:5]:
        candidates.setdefault(asset, (0.55, "asset:homepage"))
    for g in GCAL_RE.findall(html):
        candidates.setdefault(g.replace("&amp;", "&"), (0.6, "gcal-embed"))
    candidates.setdefault(base, (0.2, "homepage"))

    results = [evaluate(fetcher, u, s, via, cache.get(u)) for u, (s, via) in list(candidates.items())[:max_eval + 1]]
    seen = set(candidates)

    def top():
        return max((r["confidence"] for r in results if r.get("ok")), default=0.0)

    # phase 2 - only if the links did not give a confident answer: follow hub pages one level
    if top() < 0.6:
        hubs = sorted([r for r in results if r.get("ok") and r["format"] == "html" and "_parser" in r],
                      key=lambda r: -r["confidence"])[:2]
        hop = {}
        for hub in hubs:
            for href, text in hub["_parser"].links:
                u = clean_url(hub["url"], href)
                if u and u not in seen and u not in hop:
                    sc = score_link(text, u)
                    if sc >= 1.0:
                        hop[u] = (sc, "hop:" + " ".join(text.split())[:40])
        for u, (sc, via) in sorted(hop.items(), key=lambda kv: -kv[1][0])[:3]:
            seen.add(u)
            results.append(evaluate(fetcher, u, sc, via))

    # phase 3 - still not confident: probe typical paths (country-aware, max 8 requests, stop at 2 hits)
    if top() < 0.6:
        root = f"{urlparse(base).scheme}://{urlparse(base).netloc}"
        homepath = urlparse(base).path.rstrip("/")
        bases = ([root + homepath] if homepath else []) + [root]
        probes = [b + path for path in probe_list(lang, 4) for b in bases][:8]
        hits = 0
        for u in probes:
            if u in seen or hits >= 2:
                continue
            seen.add(u)
            r = fetcher.get(u)
            if r["status"] == 200 and urlparse(r["url"]).path.rstrip("/") not in ("", homepath):
                results.append(evaluate(fetcher, r["url"], 0.5, "probe:" + urlparse(u).path, r))
                hits += 1

    for res in results:
        if res.get("ok") and "calendar.google.com" in res["url"]:
            res["format"] = "google-calendar"
    good = sorted([r for r in results if r.get("ok")], key=lambda r: -r["confidence"])
    for r in good:
        r.pop("_parser", None)
    if good:
        action = good[0].get("action", "manual_review")
    elif suspicious:
        action = "fix_homepage"
    elif home_assets:
        action = "ocr_or_manual"
    else:
        action = "no_schedule"
    return {**meta, "status": "ok" if good else "error",
            "error": None if good else "no candidate reachable",
            "candidates": good, "failed": [r for r in results if not r.get("ok")],
            "action": action}


# --------------------------------------------------------------------------- optional Ollama tie-break


def ollama_pick(model, name, a, b, host="http://localhost:11434"):
    prompt = (f"Radio station: {name}. Which URL is the WEEKLY PROGRAMME GRID (days x times), "
              f"not a list of shows or a blog post?\n0: {a['url']} (found via {a['via']})\n"
              f"1: {b['url']} (found via {b['via']})\nAnswer ONLY as JSON: {{\"choice\": 0}} or {{\"choice\": 1}}")
    body = json.dumps({"model": model, "prompt": prompt, "stream": False, "format": "json",
                       "options": {"num_ctx": 2048, "temperature": 0}}).encode()
    try:
        req = urllib.request.Request(host + "/api/generate", data=body, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=120) as r:
            choice = json.loads(json.loads(r.read())["response"]).get("choice")
        return choice if choice in (0, 1) else None
    except Exception:
        return None


# --------------------------------------------------------------------------- main


def load_sidecar(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"generated": None, "stations": {}}


def work(row, fetcher, args):
    res = find_for_station(fetcher, row["homepage"].strip(), row.get("countrycode", ""))
    cands = res["candidates"]
    if args.ollama and len(cands) >= 2 and cands[0]["confidence"] - cands[1]["confidence"] < 0.08 \
            and cands[1]["confidence"] >= 0.4:
        if ollama_pick(args.ollama, row["name"], cands[0], cands[1]) == 1:
            cands[0], cands[1] = cands[1], cands[0]
            cands[0]["via"] += "+ollama"
    return res


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--csv", default="config/stations.csv")
    ap.add_argument("--out", default="data/epg_sources.json")
    ap.add_argument("--write", action="store_true", help="update config/stations.csv (default: dry run)")
    ap.add_argument("--force", action="store_true", help="re-detect even when epg_url is already set")
    ap.add_argument("--resume", action="store_true", help="skip stations already checked today")
    ap.add_argument("--only", nargs="*", type=int, default=None, help="station ids to process")
    ap.add_argument("--threshold", type=float, default=0.6, help="min confidence to fill epg_url")
    ap.add_argument("--workers", type=int, default=8, help="stations processed in parallel")
    ap.add_argument("--delay", type=float, default=1.0, help="seconds between requests to ONE host")
    ap.add_argument("--timeout", type=float, default=8, help="per-request timeout, seconds")
    ap.add_argument("--strict-tls", action="store_true", help="never read pages with a broken certificate")
    ap.add_argument("--ollama", metavar="MODEL", help="local model for tie-breaks, e.g. qwen2.5:3b")
    args = ap.parse_args()

    with open(args.csv, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        fields, rows = reader.fieldnames, list(reader)
    for need in ("id", "name", "homepage", "epg_url"):
        if need not in fields:
            sys.exit(f"{args.csv}: missing column '{need}'")

    sidecar = load_sidecar(args.out)
    stations = sidecar.setdefault("stations", {})
    fetcher = Fetcher(delay=args.delay, timeout=args.timeout, allow_insecure_fallback=not args.strict_tls)
    today = date.today().isoformat()

    todo = []
    for row in rows:
        sid = row["id"].strip()
        tag = f"[{sid}] {row['name']}"
        if args.only is not None and int(sid or -1) not in args.only:
            continue
        if stations.get(sid, {}).get("locked"):
            print(f"{tag}: locked, skipped")
        elif row["epg_url"].strip() and not args.force:
            print(f"{tag}: epg_url already set, skipped")
        elif args.resume and stations.get(sid, {}).get("checked_at") == today:
            print(f"{tag}: already checked today, skipped")
        elif not row["homepage"].strip().startswith(("http://", "https://")):
            print(f"{tag}: no usable homepage")
            stations[sid] = {"name": row["name"], "status": "error", "error": "no homepage", "checked_at": today}
        else:
            todo.append(row)

    t0, changed, done = time.time(), 0, 0
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        futs = {pool.submit(work, row, fetcher, args): row for row in todo}
        for fut in as_completed(futs):
            row, sid = futs[fut], futs[fut]["id"].strip()
            done += 1
            prog = f"({done}/{len(todo)})"
            try:
                res = fut.result()
            except Exception as e:  # a bug in one station must not stop the run
                print(f"{prog} [{sid}] {row['name']}: CRASH {type(e).__name__}: {e}")
                stations[sid] = {"name": row["name"], "status": "error", "error": f"crash: {e}", "checked_at": today}
                continue
            cands = res["candidates"]
            entry = {"name": row["name"], "checked_at": today, "alternatives": cands[1:4],
                     "failed": res.get("failed", [])[:3],
                     "homepage_status": res.get("homepage_status"),
                     "homepage_title": res.get("homepage_title"),
                     "homepage_suspicious": res.get("homepage_suspicious", False)}
            if cands:
                best = cands[0]
                entry.update(url=best["url"], format=best["format"], confidence=best["confidence"],
                             method=best["via"], days=best["days"], times=best["times"],
                             tls_unverified=best.get("tls_unverified", False),
                             post_like=best.get("post_like", False),
                             action=best.get("action", "manual_review"))
                if best.get("page_url"):
                    entry["page_url"] = best["page_url"]
                evidence = {k: best.get(k) for k in ("title", "scripts", "text_len", "iframes", "schedule_assets")
                            if best.get(k)}
                if evidence:
                    entry["evidence"] = evidence
                if best["confidence"] >= args.threshold:
                    entry["status"] = "ok"
                    if args.write:
                        row["epg_url"] = best["url"]
                        changed += 1
                else:
                    entry["status"] = "needs_review"
                flags = (" [TLS unverified]" if entry["tls_unverified"] else "") + (" [post-like]" if entry["post_like"] else "")
                print(f"{prog} [{sid}] {row['name']}: {entry['status']:12s} {entry['action']:16s} "
                      f"{best['confidence']:.2f} {best['format']:12s} {best['url']}{flags}")
            else:
                entry.update(status="error", error=res["error"], action=res.get("action", "no_schedule"))
                print(f"{prog} [{sid}] {row['name']}: ERROR {entry['action']:16s} {res['error']}")
            entry["locked"] = stations.get(sid, {}).get("locked", False)
            stations[sid] = entry

    actions = Counter(e.get("action", "unknown") for e in stations.values())
    sidecar["generated"] = today
    sidecar["summary"] = {"stations": len(stations), "actions": dict(sorted(actions.items()))}
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(sidecar, f, ensure_ascii=False, indent=2)

    if args.write and changed:
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(os.path.abspath(args.csv)), suffix=".tmp")
        with os.fdopen(fd, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=fields, lineterminator="\n")
            w.writeheader()
            w.writerows(rows)
        os.replace(tmp, args.csv)
        print(f"\nupdated {changed} epg_url value(s) in {args.csv} - review with `git diff`")
    elif not args.write:
        print("\ndry run: nothing written to stations.csv (use --write)")
    print("actions: " + ", ".join(f"{k}={v}" for k, v in sorted(actions.items())))
    print(f"{len(todo)} stations in {time.time() - t0:.1f}s - details: {args.out}")


if __name__ == "__main__":
    main()
