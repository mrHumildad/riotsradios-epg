# riotsradios-epg

EPG pipeline for [RIOTSRADIOS](https://github.com/mrHumildad/riotsradios). This
repository owns source discovery, raw snapshots, HTML extraction, validation and
the published guide files. The player only knows a station id and this repo's
public base URL.

## Layout

```text
config/stations.csv      station ids, sources, timezones and output files
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
node scripts/validate-epgs.js                      # structural checks
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

`config/stations.csv` is the EPG-side catalog. It must keep the app's station
ids stable. It does not replace the app's `stations.csv`; it only carries what
the EPG pipeline needs.

| Column | Meaning |
|---|---|
| `id` | App station id. This is the manifest key. |
| `name` | Human name used in reports and guides. |
| `countrycode` | Language hint for extraction (`ES`, `IT`, `FR`, ...). |
| `timezone` | IANA zone written into the guide. |
| `homepage` | Site used by source discovery. |
| `epg_url` | Exact schedule page or document. |
| `epg_file` | Published file in `public/EPGs/`, or blank. |
| `enabled` | `false` keeps the station out of the manifest. |
| `mailto` | Optional contact written into the guide. |

## Publishing policy

A guide is published only when:

1. its config row is enabled and names an existing file;
2. its `station_id` matches the config id;
3. the extraction report says `ok`, or it is an explicitly retained legacy
   guide.

Failures are visible in `data/epg-report.json`; they do not delete the previous
good guide. Raw snapshots are cache, not source, and stay out of git.

## Scheduled refresh and publishing

`.github/workflows/refresh.yml` runs daily at **04:37 UTC** (and on manual
`workflow_dispatch`):

1. restores the `data/raw` cache;
2. fetches changed sources with a 20-hour freshness window;
3. converts and validates the guides;
4. rebuilds `public/EPGs/manifest.json`;
5. uploads `data/epg-report.json` as an artifact;
6. commits changed guides/report;
7. publishes `public/` to the `gh-pages` branch.

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
