# Station Blog Feeds — Investigation & Plan

Status: feed pipeline and console probe implemented; timeline UI and CI wiring pending
Probe date: 2026-11-12
Decisions confirmed: 2026-11-12
Scope: all 87 stations in `catalog/stations.csv` (37 currently EPG-enabled)
Current output: 57 sources and 498 posts under `public/feeds/`

## 1. Goal

Give the app a global **"Actualidad" timeline** of the latest posts from every
station that publishes a blog or news section, without the app fetching,
parsing and sanitising third-party sites at runtime.

The build fetches and normalises the sources, publishes one JSON Feed per
station plus a manifest, and the app merges those files into the timeline. The
feature is independent of the EPG and does not change the EPG manifest, schema
or refresh contract.

## 2. Confirmed decisions

| Area | Decision |
|---|---|
| App surface | **Global timeline** across stations, not a per-station tab |
| Scope | **All 87 catalog stations**, including stations without an EPG |
| Item fields | **Title, date and link only** — no excerpt, image or audio |
| Old feeds | **Publish regardless of age**; no stale flag or cutoff |
| Sources | **Standard feeds plus HTML scraping** for blogs without feeds |
| Refresh | **Daily with the EPG** in `refresh.yml` |
| Output | **Per-station JSON Feed 1.1 + manifest**; app merges them |
| Blocked hosts | **Retry once with a browser UA** after the bot UA is rejected |
| Language | **Original language**; no filtering or translation |
| Discovery | **Weekly automatic discovery**, with locked manual overrides |

Consequences worth calling out:

- Because there is no single aggregate file, the app must load the manifest and
  merge the per-station feeds client-side. Payloads stay minimal and the
  manifest carries `latest` so the app can load the most active stations first.
- Because old feeds are published, a 2016 post is still a valid item. In a
  date-sorted global timeline it simply ranks at the bottom.
- HTML scraping is scoped to pages that are server-rendered. Two of the four
  candidate sites qualify; the other two need a feasibility spike (section 4.5).
- The browser-UA fallback is a retry after rejection, not a global UA change and
  not a way around CAPTCHAs or JavaScript rendering.

## 3. Probe method

For every catalog station, in this order:

1. Fetch the homepage and look for
   `<link rel="alternate" type="application/rss+xml|atom+xml|feed+json">`.
2. Try `/feed/`, `/feed`, `/rss`, `/rss.xml`, `/feed.xml`, `/?feed=rss2`.
3. Try known platform endpoints:
   - WordPress REST: `/wp-json/wp/v2/posts`
   - Blogger JSON: `/feeds/posts/default?alt=json`
   - SPIP: `spip.php?page=backend`
   - Joomla: `/?format=feed&type=rss`
4. If the homepage has no feed, follow same-origin links containing `blog`,
   `noticias`, `actualidad` or `agenda` and repeat step 1.
5. Parse the first feed found: item count, newest date, excerpt length and
   audio enclosures.

Requests used an identifying UA, 8–12 s timeouts and a maximum of 10 concurrent
workers. Results are point-in-time; stations and hosting change.

## 4. Results

### 4.1 Coverage

| Result | Stations |
|---|---:|
| Catalog total | 87 |
| Usable feed (≥ 1 item) | 50 |
| Valid but empty feed | 4 |
| No feed found | 33 |
| Reachable via blog subdomain / alternate host / browser UA | +3 |
| Realistic feed coverage | ≈ 53 (61 %) |
| Confirmed server-rendered HTML blogs | +2 |

Empty feeds: Eguzki Irratia, Kmoradio, Radio Plaza de la Dignidad, Serenade
Radio. Counts near the boundary vary between runs because several hosts are
flaky; a station can flip between `empty`, `error` and `no_feed`.

Notable misses that do have a feed somewhere:

- Radio Ciroma — feed on the blog subdomain, `blog.ciroma.org/feed/`
  (6 items), not linked from the homepage.
- Radio Topo — `radiotopo.org/feed/` returned 261 items; the `www` host timed
  out.
- Irola Irratia — `/feed/` returns 403 to the identifying UA but 200 with a
  browser UA.

### 4.2 Freshness

Of the 50 usable feeds:

- 34 have a post ≤ 30 days old.
- 10 have no post in over a year; the oldest are Radio Pirineo (2017),
  Conaicop (2018) and AppRadio (2021).

The confirmed HTML blogs have similar spread: Klassik Radio is current,
Mochileros' newest listed post is from 2024. Publishing regardless was chosen,
so these sources stay in the manifest and their posts sort to the bottom of the
timeline.

### 4.3 Formats

| Format | Notes |
|---|---|
| RSS 2.0 | Majority (~40 stations) |
| Atom | Blogger and Jekyll sites, e.g. Radio Argayo, Radio QK |
| WordPress REST JSON | Radio Topo, Ciroma blog |
| Blogger JSON | `feed.entry`, not Atom |
| SPIP backend | Ké Huelga: `spip.php?page=backend` |
| Joomla feed | Kmoradio (empty) |

Content size varies from a 200-character excerpt to full `content:encoded`
(FilispiM ~9 KB, Radio QK ~16 KB, Onda Rossa ~12 KB, Conaicop ~104 KB). About
15 feeds include audio enclosures. None of that content is copied: v1 stores
only the title, canonical URL and date.

### 4.4 Scope finding

Only about half of the 50 usable feeds belong to EPG-enabled stations (25 in
the latest enabled-only pass). The rest belong to catalog-only stations
(Aconchego, Radio QK, Color Comunitaria, Radio Guiniguada, Siberia FM,
Paradigma, Radio Kvrruf, La 5ta Pata, 192 Radio Veronica, Tukker FM, Alpha
Boys, FilispiM, and others).

Keying the feature to the catalog rather than the EPG config preserves that
coverage.

### 4.5 HTML blog feasibility

| Site | Page | Finding |
|---|---|---|
| Mochileros | `https://www.mochilerosradio.com/blog.html` | **Confirmed.** Server-rendered list of article links with titles and dates. |
| Klassik Radio | `https://www.klassikradio.de/aktuelles/` | **Confirmed.** Server-rendered article list under `/aktuelles/…`; dates may need the article page. |
| Radio Libertaire | `https://radio-libertaire.org/agenda/` | **Spike.** Server-rendered, but it is an event/programme agenda, not a blog list. Needs a dedicated adapter if the agenda counts as posts. |
| FM La Tribu | `https://fmlatribu.com/` | **Spike.** The homepage is a 841-byte Vite/React shell; the content comes from JavaScript. HTML scraping alone will not work. Check the JS bundle for a JSON API before dropping it. |
| Radio Pica | `https://www.radiopica.cat/` | **No.** Static FrontPage-era page with no blog section. |

v1 therefore launches with **Mochileros and Klassik** as HTML adapters, and
treats Libertaire and FM La Tribu as spikes rather than promises.

### 4.6 Blocked and unreliable hosts

- WordPress.com-hosted stations (Radio la Granja, Radio Roncudo) return 403.
- Radio Malva returns 403.
- Radio Roja returned 502.
- Arrebato returned a non-feed once and a valid 50-item feed on retry.
- Topo's `www` host timed out while the bare host worked.

Retries and "keep last good" behaviour are required. Since a browser UA was
chosen for rejected hosts, Irola becomes reachable; WordPress.com still returns
403 even with a browser UA and stays `blocked`.

## 5. Why build-time

| Option | Verdict |
|---|---|
| Build-time aggregation in this repo | **Chosen.** One format, one origin, CORS solved, sanitising, caching, conditional GET, no per-listener requests to third parties. |
| Client-side fetch of third-party feeds | Rejected. CORS on most feeds, mixed content (Onda Rossa is `http://`), rate limits, four formats, no sanitising, listener IP exposed to 50 sites. |
| Proxy or edge worker | Rejected. Extra infrastructure for a problem a daily build solves. |
| Single aggregate file | Deferred. It would make the global timeline cheaper to load, but the chosen output is per-station feeds + manifest. Revisit in Phase 6 if the client merge is too slow. |

## 6. Recommended v1

### 6.1 Data flow

```
catalog/stations.csv
        │
        ▼
scripts/find-feeds.mjs ──► data/feed_sources.json   (committed, reviewable)
        │                        │
        │                        ▼
        │                 scripts/refresh-feeds.mjs
        │                        │  conditional GET, retries, UA fallback
        │                        ▼
        │                 lib/feed-parse.js   (RSS/Atom/JSON/WP/Blogger/SPIP)
        │                 lib/html-blog.js    (Mochileros, Klassik)
        │                        │  parse → normalise → sanitise
        │                        ▼
        │                 public/feeds/<slug>.json
        │                 public/feeds/manifest.json
        │                 data/feeds-report.json
        │
        ▼
.github/workflows/refresh.yml ──► commit + gh-pages
        │
        ▼
app: manifest → per-station feeds → merge, dedupe, sort, paginate
```

### 6.2 Files

| File | Purpose |
|---|---|
| `data/feed_sources.json` | Source of truth per station: `url`, `kind`, `adapter`, `status`, `checked_at`, `locked`, `ua`. |
| `scripts/find-feeds.mjs` | Weekly discovery; writes the sidecar and never overwrites locked entries. |
| `lib/feed-parse.js` | Tolerant parser for RSS, Atom, JSON Feed, Blogger JSON, WP REST, SPIP and Joomla. |
| `lib/html-blog.js` | Per-site adapters for Mochileros and Klassik. |
| `scripts/refresh-feeds.mjs` | Fetch, parse, write per-station feeds, manifest and report. |
| `public/feeds/<slug>.json` | Published JSON Feed, max 10 items. |
| `public/feeds/manifest.json` | Station id → file, name, count, latest post, status. |
| `data/feeds-report.json` | Run report: ok / empty / blocked / no_feed / error, UA used, timings. |
| `tests/feed-parse.test.mjs` | Feed format fixtures and normalisation tests. |
| `tests/html-blog.test.mjs` | Saved HTML fixtures for the two adapters. |

No new npm dependencies. Parsing is tolerant regex/scanner based, in the same
spirit as `scripts/convert-raw-epg.mjs`.

### 6.3 Sidecar shape

```json
{
  "version": 1,
  "generated_at": "2026-11-12T05:10:00Z",
  "stations": {
    "1": {
      "url": "https://www.contrabanda.org/feed/",
      "kind": "rss",
      "adapter": null,
      "status": "ok",
      "checked_at": "2026-11-12T05:10:00Z",
      "locked": false,
      "ua": "bot"
    },
    "100": {
      "url": "https://www.mochilerosradio.com/blog.html",
      "kind": "html",
      "adapter": "mochileros",
      "status": "ok",
      "checked_at": "2026-11-12T05:10:00Z",
      "locked": true,
      "ua": "browser"
    },
    "10": {
      "url": null,
      "kind": null,
      "adapter": null,
      "status": "no_feed",
      "checked_at": "2026-11-12T05:10:00Z",
      "locked": true,
      "ua": null
    }
  }
}
```

`locked: true` means discovery must not change the entry. That preserves manual
URLs, opt-outs and known-bad hosts. `ua` records whether the last successful
fetch needed the browser fallback.

### 6.4 Published feed shape

JSON Feed 1.1, minimal items. JSON Feed requires a content field, so
`content_text` mirrors the title; no article text is stored.

```json
{
  "version": "https://jsonfeed.org/version/1.1",
  "title": "Radio Contrabanda — latest posts",
  "home_page_url": "https://www.contrabanda.org/",
  "feed_url": "https://<pages>/feeds/radio-contrabanda.json",
  "language": "ca",
  "_station_id": 1,
  "_station_name": "Radio Contrabanda",
  "_source": "https://www.contrabanda.org/feed/",
  "_generated_at": "2026-11-12T05:10:00Z",
  "items": [
    {
      "id": "https://www.contrabanda.org/?p=1234",
      "url": "https://www.contrabanda.org/?p=1234",
      "title": "Programació especial",
      "content_text": "Programació especial",
      "date_published": "2026-11-10T09:00:00Z"
    }
  ]
}
```

No `summary`, `content_html`, `image`, `authors` or `attachments`. The app uses
the title, date and URL, and opens the source in a browser.

### 6.5 Manifest shape

```json
{
  "version": 1,
  "generated_at": "2026-11-12T05:10:00Z",
  "stations": {
    "1": {
      "name": "Radio Contrabanda",
      "file": "radio-contrabanda.json",
      "posts": 10,
      "latest": "2026-11-11T18:20:00Z",
      "status": "ok",
      "kind": "rss"
    },
    "100": {
      "name": "Mochileros",
      "file": "mochileros.json",
      "posts": 6,
      "latest": "2024-11-02T00:00:00Z",
      "status": "ok",
      "kind": "html"
    },
    "10": {
      "name": "Radio Pica",
      "file": null,
      "posts": 0,
      "latest": null,
      "status": "no_feed",
      "kind": null
    }
  }
}
```

Every catalog id appears with a status. Only sources with at least one item get
a file. There is no stale flag and no age cutoff.

### 6.6 Discovery rules

1. `<link rel="alternate">` with a feed MIME type or a URL ending in `feed`,
   `rss`, `atom` or `xml`.
2. Well-known paths, then platform endpoints.
3. Same-origin `blog` / `noticias` / `actualidad` / `agenda` links and known
   HTML adapters, then repeat step 1.
4. Validate before accepting: content type, root element, at least one item,
   non-empty title.
5. Prefer HTTPS; follow at most 5 redirects; reject non-`http(s)`.
6. Check `robots.txt` for the feed or list page; skip on disallow.
7. Retry once on timeout, 403, 429 and 5xx with a short backoff. After a
   403/406 from the bot UA, retry once with a browser UA
   (`Mozilla/5.0 … Chrome/120 …`), record `ua: "browser"` and keep the result if
   it validates.
8. If the browser retry also fails, record `blocked`. Do not attempt CAPTCHA
   solving or JavaScript rendering.
9. Write `status` as `ok`, `empty`, `no_feed`, `blocked` or `error`.
10. Run weekly. `locked` entries are never rewritten.

### 6.7 HTML adapters

Both adapters emit the same item shape as feed sources.

**Mochileros** — `https://www.mochilerosradio.com/blog.html`

- Select list cards linking to `/blog/…` (and related sections), with the post
  title and the date shown in the card text.
- Normalise dates such as `02 Noviembre 2024` to ISO 8601.
- Skip navigation and footer links.

**Klassik Radio** — `https://www.klassikradio.de/aktuelles/`

- Select article teasers linking to `/aktuelles/…`.
- Read the date from the card if present; otherwise fetch the article page,
  capped at 10, and read its published metadata.
- Skip tickets, privacy, Hall of Fame and other non-article links.

**Spikes, not v1 commitments:**

- Radio Libertaire `/agenda/` — determine whether agenda entries are posts and
  whether a stable date/title structure exists.
- FM La Tribu — inspect the Vite bundle for a JSON API. If none, record
  `no_feed`; the page cannot be scraped without a browser.

HTML adapters are pinned in the sidecar with `kind: "html"` and `locked: true`
so discovery does not replace them with a generic URL.

### 6.8 Normalisation rules

- Decode charset from `Content-Type` or the XML declaration; support
  ISO-8859-1 and UTF-8.
- Strip HTML tags from titles, decode entities and collapse whitespace.
- Resolve relative links against the feed or list URL.
- Accept only `http(s)` URLs; reject `javascript:`, `data:` and tracking-only
  links.
- Prefer `guid`/`id` for the item id; fall back to the canonical URL.
- Parse dates from `pubDate`, `published`, `updated`, `date_published` or the
  adapter's date parser; store ISO 8601 UTC.
- Undated items are kept without `date_published` (the field is optional in
  JSON Feed) and sort after dated ones.
- Deduplicate by id and URL within a station.
- Sort newest first, keep 10, cap the response at 1 MB.
- Drop items whose title is empty after cleaning.

### 6.9 Failure and freshness policy

- Publish every source with at least one item, regardless of age.
- A failed fetch never deletes an existing published file; the previous
  successful file stays and keeps its original `_generated_at`.
- Empty sources are not published and get `file: null` in the manifest.
- One station's failure never aborts the run, the EPG refresh or the commit.
- The report records status, HTTP code, UA used and error for every station.

### 6.10 Scheduling and publishing

The scripts run standalone today:

1. On Sundays, `node scripts/find-feeds.mjs --resume` (or when the sidecar is
   missing).
2. Every day, `node scripts/refresh-feeds.mjs`.
3. Validate the output.
4. Add `public/feeds`, `data/feed_sources.json` and `data/feeds-report.json`
   to the existing `git add` and commit.
5. Publish `public/` to gh-pages as today.

Wiring those steps into `.github/workflows/refresh.yml` is the next pipeline
task. The feed step should exit 0 with a report when individual stations fail,
so a dead station cannot block the EPG refresh. Keeping feeds in the same
workflow avoids the `force_orphan` gh-pages race a second workflow would create.

### 6.11 App timeline contract

The current probe (`lib/stationFeeds.js` in the app) does the first part of the
contract:

1. Fetch `public/feeds/manifest.json`.
2. Order stations by `latest` descending.
3. Load every advertised file with a concurrency cap of 6.
4. Merge all items, deduplicate by canonical URL, sort by `date_published`
   descending, and return the newest 10.
5. `main.jsx` calls the probe in development and logs the result.

The timeline UI, pagination and response caching are the next client step.
Worst case is ~57 small requests on a cold start. Each per-station file is a few
KB because items carry only four fields, so the total payload is modest, but
request count is the thing to watch. If measurements show a slow first paint,
add a prebuilt aggregate in Phase 6 rather than complicating the app.

## 7. Implementation phases

### Phase 0 — decisions

Done: section 2 records the confirmed choices.

### Phase 1 — discovery

- Add `scripts/find-feeds.mjs`.
- Read the catalog, reuse the existing CSV/HTML helpers and UA conventions.
- Write `data/feed_sources.json`.
- Support `--resume`, `--only <id>`, `--weekly`, and never overwrite `locked`
  entries.
- Implement the browser-UA retry and record which UA succeeded.
- Unit-test status classification with local fixtures.

### Phase 2 — feed parser

- Add `lib/feed-parse.js` with format detection.
- Add fixtures for RSS 2.0, Atom, JSON Feed, Blogger JSON, WP REST, SPIP and
  Joomla.
- Test malformed XML, CDATA, entity-escaped URLs, relative links, missing dates
  and duplicate items.

### Phase 3 — refresh and publish

- Add `scripts/refresh-feeds.mjs`.
- Conditional GET with ETag/Last-Modified; cache under `data/raw/feeds/`
  (already gitignored).
- Write per-station JSON, manifest and report atomically.
- Keep the last good file on failure.
- Derive slugs with the existing EPG filename convention and check collisions.

### Phase 4 — HTML adapters

- Add `lib/html-blog.js` with Mochileros and Klassik.
- Save representative list HTML as fixtures; test title, URL and date
  extraction.
- Run the Libertaire agenda and FM La Tribu API spikes; record the outcome in
  this document.
- Add any confirmed adapter as `kind: "html"` with a locked sidecar entry.

### Phase 5 — pipeline, docs and app contract

- Wire discovery and refresh into `refresh.yml`, including `git add` paths.
- Add validation: manifest entries point at existing files, item fields are
  limited to the agreed set, dates are ISO, URLs are `http(s)`, item cap holds.
- Document the feed contract in the README and update this plan with actual
  coverage.
- Confirm the app can merge the manifest and per-station feeds into the global
  timeline.

### Phase 6 — optional

- Prebuilt aggregate `timeline.json` if the 50-request merge is too slow.
- Images and audio enclosures.
- More HTML adapters.
- Per-station feed surfaces.
- Hourly or 6-hourly refresh.

## 8. Acceptance criteria

- Sidecar covers all 87 catalog ids and assigns a status to each.
- A second discovery run does not change locked entries or stable URLs.
- Every `status: ok` source has a published file with 1–10 items.
- Mochileros and Klassik publish through their HTML adapters.
- `manifest.json` references only files that exist and counts match.
- Items contain only `id`, `url`, `title`, `content_text` (title mirror) and
  `date_published`; no HTML, excerpt, image or audio.
- No item contains a non-`http(s)` URL or a duplicate id.
- Old feeds are published; there is no stale field or age cutoff.
- The browser UA is used only after the bot UA is rejected, and the report says
  which sources needed it.
- A simulated station failure leaves the previous file intact and the run exits
  0.
- Empty sources produce no file.
- The global timeline merges, dedupes and sorts correctly with a 20-item page.
- `npm test` passes, including feed and HTML fixtures.
- The daily workflow commits and publishes the feed outputs.

## 9. Risks

| Risk | Mitigation |
|---|---|
| Global timeline needs ~50 requests on a cold start | Minimal item payloads, manifest ordered by `latest`, concurrency cap, HTTP caching; add an aggregate in Phase 6 if measured slow. |
| gh-pages race between workflows | Keep feeds in `refresh.yml`; do not add a second publishing workflow. |
| HTML selectors break when a site changes | Fixture tests, per-adapter error isolation, report failures, keep last good file. |
| HTML pages are JavaScript-rendered | Only ship adapters for server-rendered pages; spike FM La Tribu's API, otherwise leave it out. |
| Browser-UA fallback may be unwelcome | Use only after a bot-UA rejection, respect `robots.txt`, no CAPTCHA/JS bypass, record it. |
| Hosts blocking both UAs | Record `blocked`; add a manual override only if the station asks. |
| Flaky feeds | Retry once, cache last good output, report failures. |
| Malformed XML or wrong charset | Tolerant parser, charset detection, fixtures. |
| Copyright | Store only title, URL and date; link out; no article text, images or audio. |
| Old posts looking like news | Accepted; date sorting puts them at the bottom of the timeline. |
| Feed growth and repo size | 10 items per station, four fields per item, 1 MB response cap. |
| Station id drift | Join on catalog id; validate every file against the catalog. |

## 10. Remaining questions

| # | Question | Default |
|---|---|---|
| 1 | How many posts per station? | 10 |
| 2 | Timeline page size? | 20 items per page |
| 3 | Do Libertaire agenda entries and FM La Tribu's API count as posts? | Spike first; ship only if a stable structure exists |
| 4 | If ~50 feed requests make the timeline slow, approve a prebuilt aggregate? | Revisit after measuring; Phase 6 |
| 5 | Should the timeline show the station name only, or name plus logo? | Name plus logo from the catalog |

## 11. Out of scope for v1

- Full-text article storage or a searchable archive.
- Excerpts, images, audio and podcast playback.
- Translation or language filtering.
- Comment feeds.
- Podcast platform integrations (iVoox, Apple Podcasts).
- Push notifications.
- Per-station news tabs.
- Rendering JavaScript-only sites.
