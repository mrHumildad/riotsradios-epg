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
of `radio-contrabanda.json` and `radio-topo.json`. `ciroma.json` is the only
legacy guide kept: station 3 publishes a PDF, so there is no generated
replacement yet; it is marked `status: "legacy"` in the manifest.

Partial guides remain in the repository and report but are not published. If a
source is a PDF or image, the converter reports it as unsupported instead of
inventing a schedule.

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
