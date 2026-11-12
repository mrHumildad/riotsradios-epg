# riotsradios-epg

EPG pipeline for [RIOTSRADIOS](https://github.com/mrHumildad/riotsradios). This
repository owns source discovery, raw snapshots, HTML extraction, validation and
the published guide files. The player only knows a station id and this repo's
public base URL.

## Layout

```text
catalog/stations.csv     the app-facing station catalog — published to /catalog/
config/stations.csv      EPG pipeline config: sources, timezones, output files
data/raw/                snapshot cache, never committed
data/epg-report.json     per-station extraction report
data/epg_sources.json    discovery sidecar
docs/EPG-FORMAT.md       public EPG v2 format
public/EPGs/             validated guides + manifest.json
scripts/                 discovery, fetch, converter, validator, manifest
```

`public/EPGs/manifest.json` is the app-facing contract. It maps the app's
station id to a guide file and only advertises guides that pass the publish
policy:

```json
{
  "version": 1,
  "generated_at": "2026-11-08T21:00:00.000Z",
  "stations": {
    "1": {
      "file": "radio-contrabanda.json",
      "status": "ok",
      "updated": "2026-11-08",
      "days": 7,
      "programs": 178
    }
  }
}
```

Generated guides are canonical. `1.json` and `topo.json` were retired in favour
of `radio-contrabanda.json` and `radio-topo.json`.

Partial guides remain in the repository and report but are not published. PDF
sources are read from their embedded text layer with `pdftotext -bbox-layout`
(poppler-utils): the weekday header gives the columns, the time labels the
rows, and each text block becomes a programme. Image-only PDFs still need a text layer. Schedule images are read with the
OCR.space table engine (`isTable`, engine 2), whose tab-separated output keeps
the weekday header and clock rows aligned; the converter turns that into the
same guide shape and applies the same quality gate. Set `OCR_SPACE_API_KEY`
for the convert step (the shared demo key is rate-limited and only for tests).

## Commands

```bash
python3 scripts/find_epg_urls.py --resume          # discover sources (dry run)
python3 scripts/find_epg_urls.py --resume --write  # update config/stations.csv
python3 scripts/fetch_epgs.py --max-age-hours 20   # download raw snapshots
node scripts/convert-raw-epg.mjs                   # raw -> public/EPGs/*.json
node scripts/scrape-radiopica.mjs --station-id 10  # Radio Pica's own grid parser
node scripts/validate-epgs.js                      # structural checks
node scripts/validate-catalog.mjs                  # gate catalog/stations.csv
node scripts/build-catalog.mjs                     # publish /catalog/ files
node scripts/probe-catalog.mjs                     # refresh catalog/health.json (network)
node scripts/build-manifest.mjs                    # write the manifest
node scripts/build-manifest.mjs --check            # fail if it is stale
npm test                                           # config + manifest tests
```

Hubs that publish one page per weekday (Fujiko-style) are recorded in the
sidecar's `day_pages` map. Fetch stores those pages under
`data/raw/<id>/days/`; convert scores the combined week as a `day-pages`
candidate. Calendar-style day tabs ("Lun 09.11.2026") and day panels whose
rows are a bare clock followed by a title are handled by the `tabs`
strategy.

Radio Pica is the one station with a dedicated parser: `graella.htm` folds the
week into five-hour cycles (each row airs at five clock times, the weekend
column is shared, and the broadcast day starts at 14:00), which the generic
table strategy mis-pairs. `scripts/scrape-radiopica.mjs` owns that guide and its
`data/epg-report.json` entry, and `convert-raw-epg.mjs` skips the id.

Non-HTML sources are supported when the provider exposes a stable feed:

- **Hermes JSON** (FM La Tribu): `.../schedules/<id>/entries` returns
  `dayOfWeek` (1 = Monday), decimal `hourStart`/`hourEnd` and
  `activity.name`. The converter detects the payload shape and maps it
  directly.
- **Schedule cards** (Mochileros): items that state their own days and hours
  ("Martes 20hs.", "20 a 21hs.", "Domingo de 14 a 17hs") become one
  programme per day. Wrapper cards are ignored so days are not mixed up.

`data/epg_manual.json` records the stations that cannot be crawled, with the
reason and the next action (manual, OCR, robots-blocked, no source). Their
`data/epg_sources.json` entries are `locked: true`, so weekly discovery skips
them instead of probing them again.

Discovery records an `action` per station in `data/epg_sources.json`:
`add_source`, `review_partial`, `ocr_or_manual`, `render_or_manual`,
`blocked_by_robots`, `fix_homepage` or `no_schedule`. The same pass records
schedule images, PDFs, iframes, page titles and weekday/time evidence, so the
next discovery run does not re-derive the classification by hand.

The pipeline has no npm dependencies. Python is stdlib-only; Playwright is
optional and only used by `fetch_epgs.py --render`.

## Config

`config/stations.csv` is the EPG pipeline config. It must keep the app's station
ids stable; it only carries what guide discovery needs.

`catalog/stations.csv` is the **app-facing station catalog** — the file the player
renders, published to `/catalog/`. It is the single source of truth for stations:
a station added here reaches every running player at its next launch. The rules
are the app's own (`npm run validate:catalog` enforces them), and
`docs/EPG-FORMAT.md` plus the app's `docs/EPG-REPO-CATALOG.md` describe the
contract.

| Column | Meaning |
|---|---|
| `id` | App station id. This is the manifest key. |
| `name` | Human name used in reports and guides. |
| `countrycode` | Language hint for extraction (`ES`, `IT`, `FR`, ...). |
| `timezone` | IANA zone written into the guide. |
| `homepage` | Site used by source discovery. |
| `epg_url` | Exact schedule page or document. |
| `epg_file` | Published file in `public/EPGs/`, or blank. |
| `enabled` | `false` keeps the station out of the manifest. New app stations start here. |
| `mailto` | Optional contact written into the guide. |

## Publishing policy

A guide is published only when:

1. its config row is enabled and names an existing file;
2. its `station_id` matches the config id;
3. the extraction report says `ok`, or it is an explicitly retained legacy
   guide.

Failures are visible in `data/epg-report.json`; they do not delete the previous
good guide. Raw snapshots are cache, not source, and stay out of git.

## Stream health

`catalog/health.json` is the probe snapshot behind the player's LIVE / UNSTABLE /
OFFLINE badges and its spectrum support. `npm run probe` requests each station's
headers only (`Range: bytes=0-1`, 10 s timeout, 6 in parallel, body cancelled
immediately), classifies the answer with `lib/health.js` and folds it into the
previous snapshot, so `consecutive_failures` accumulates across runs.
`.github/workflows/health.yml` runs it daily at 04:17 UTC, commits the diff and
republishes the catalog.

The CORS answers are measured from `https://mrhumildad.github.io` (`PAGE_ORIGIN`
in `scripts/probe-catalog.mjs`), the player's web origin: `cors: "any"` survives
another origin, `cors: "origin"` (a pinned origin) does not. The app copies this
file at every catalog sync and no longer probes by itself.

Probe a single station while adding it:

```bash
npm run probe -- --only 87
```

## Published catalog

`catalog/stations.csv` is published next to the guides, and the player adopts it
at runtime:

```json
{
  "schema": 1,
  "version": "<sha256 of the CSV>",
  "file": "stations.csv",
  "rows": 87,
  "generated_at": "2026-11-10T12:00:00.000Z",
  "health": "health.json"
}
```

`npm run catalog` writes `public/catalog/{stations.csv,manifest.json,health.json}`.
Only `catalog/stations.csv` is committed; the published copies are regenerated on
every deploy. `version` is the content hash, so the app downloads the CSV only
when it changed and caches it by URL (`?v=<hash>`). `health.json` is the app
repository's latest probe snapshot, copied here so a station that arrives from
this file shows its badge and its spectrum without waiting for an app release.

`.github/workflows/catalog.yml` publishes `/catalog/` on every push that touches
it, so a new station is live minutes later. It shares the `epg-refresh`
concurrency group with `refresh.yml`: both publish the `gh-pages` branch.

Rules for this side of the contract:

1. **Never delete a row.** Set `stream_broken` to `true` instead; ids are never
   reused, because they key the guides, the health snapshot and favourites.
2. **`npm run validate:catalog` must pass.** Once the catalog is adopted at
   runtime, this is the only gate between an edit and every listener.
3. **Large removals are refused by the app.** A catalog that loses more than 40%
   of its playable rows is rejected in the field, so split a big retirement into
   reviewed pushes.

## Scheduled refresh and publishing

`.github/workflows/refresh.yml` runs daily at **04:37 UTC** (and on manual
`workflow_dispatch`):

1. reads `catalog/stations.csv` and appends stations above the highest id
   already in `config/stations.csv` as **disabled** rows;
2. runs source discovery for those new ids;
3. restores the `data/raw` cache;
4. fetches changed sources with a 20-hour freshness window;
5. converts the guides;
6. enables a new row only when its conversion report is `ok` and the generated
   guide has the matching `station_id`;
7. validates the guides and rebuilds `public/EPGs/manifest.json`;
8. validates the catalog and rebuilds `public/catalog/`;
9. uploads `data/epg-report.json` as an artifact;
10. commits the config, discovery sidecar, guides, report and manifest;
11. publishes `public/` to the `gh-pages` branch.

### Automatic app sync

The daily refresh keeps the EPG pipeline in step with `catalog/stations.csv`. Ids
are append-only, so the highest id in `config/stations.csv` is the high-water
mark: older catalog rows that were deliberately left out (no schedule, retired,
etc.) are never re-imported. A newly added catalog station is appended with
`enabled=false`, an inferred timezone and a blank `epg_url`/`epg_file`. If the
country has no timezone in the mapping, the row keeps an empty timezone and
stays disabled until a human sets it.

The import reads `catalog/stations.csv` directly (`--app-file`). It used to read
the app repository's copy, which is now the app's snapshot of this file — a
circular import that could only reintroduce drift.

Discovery then looks for its schedule. If the converter produces a complete
guide (`status: "ok"`), the workflow writes its filename to `epg_file` and sets
`enabled=true`; the manifest publishes it on the next run. If no source is found,
or the extraction is only partial, the row stays disabled and visible in
`data/epg-report.json` for review. This gate prevents a doubtful discovery from
shipping a wrong guide automatically.

Set `APP_STATIONS_URL` to point at a fork or a staging catalog. The default is
the `main` branch of `mrHumildad/riotsradios`.

Enable Pages once in **Settings → Pages → Deploy from a branch**, branch
`gh-pages`, folder `/ (root)`. The published base is:

```text
https://mrhumildad.github.io/riotsradios-epg/
```

`.github/workflows/discover.yml` runs weekly, updates
`config/stations.csv`/`data/epg_sources.json`, and opens a review PR instead of
writing to `main`.

## App contract

The app fetches `EPGs/manifest.json` and then the advertised guides. It should
use `VITE_EPG_BASE_URL` to point at a staging deployment. If the manifest or a
guide is unavailable, the app falls back to its bundled `public/EPGs/` copy;
that is why the legacy `ciroma.json` and generated guides remain in the app
until the fallback period ends.

Verify CORS after the first Pages deployment:

```bash
curl -sI https://mrhumildad.github.io/riotsradios-epg/EPGs/manifest.json \
  | grep -i access-control
```
