// Catalog gate for catalog/stations.csv
//
//   node scripts/validate-catalog.mjs
//
// This is the only gate between a catalog edit and every listener: the player
// adopts a published catalog at runtime, so nothing else checks it before it is
// in use. The rules are the app's own (`npm run validate:stations` in
// riotsradios), mirrored here through lib/catalog-rules.js.
//
// The one thing this gate cannot decide is the app's plain-HTTP allowlist
// (`data/cleartext-hosts.json`, a device policy that lives in the app repo), so
// an active http:// row is reported as app-only here and must survive the app's
// validator when the snapshot is synced.

import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseCsv, parseStationRows } from '../lib/csv.js'
import {
  REQUIRED_COLUMNS,
  catalogHeaders,
  catalogSummary,
  isPlayableStation,
  hostOf,
} from '../lib/catalog-rules.js'

const CATALOG_PATH = 'catalog/stations.csv'
const CONFIG_PATH = 'config/stations.csv'
const EPG_DIR = 'public/EPGs'
const ALLOWLIST_PATH = 'catalog/cleartext-hosts.json'

const errors = []
const warnings = []
const info = []

const fail = (line, message) => errors.push({ line, message })
const warn = (line, message) => warnings.push({ line, message })

function label(station) {
  return `id ${station.id}${station.name ? ` (${station.name})` : ''}`
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(value)
}

async function loadAllowlist() {
  /* The app's allowlist is device policy and lives in the app repo. When it is
     copied here, this gate can confirm an http:// row; when it is not, the row is
     app-only by definition and the app's own validator decides — a warning would
     be noise on every run. */
  if (!existsSync(ALLOWLIST_PATH)) return { present: false, hostSet: new Set(), stationIds: new Map() }
  try {
    const parsed = JSON.parse(await readFile(ALLOWLIST_PATH, 'utf8'))
    const hostSet = new Set()
    const stationIds = new Map()
    for (const entry of Array.isArray(parsed?.hosts) ? parsed.hosts : []) {
      const host = hostOf(entry?.host?.includes('://') ? entry.host : `http://${entry?.host ?? ''}`)
      if (!host) continue
      hostSet.add(host)
      stationIds.set(host, new Set((Array.isArray(entry.station_ids) ? entry.station_ids : []).map(Number)))
    }
    return { present: true, hostSet, stationIds }
  } catch (e) {
    warn(null, `cannot read ${ALLOWLIST_PATH}; treating every http:// row as app-only (${e.message})`)
    return { present: false, hostSet: new Set(), stationIds: new Map() }
  }
}

async function loadEpgFiles() {
  try {
    return new Set(await readdir(EPG_DIR))
  } catch {
    warn(null, `cannot read ${EPG_DIR}; skipping EPG file checks`)
    return null
  }
}

async function loadConfig() {
  try {
    return parseStationRows(await readFile(CONFIG_PATH, 'utf8'))
  } catch {
    warn(null, `cannot read ${CONFIG_PATH}; skipping the config cross-check`)
    return []
  }
}

async function main() {
  let csv
  try {
    csv = await readFile(CATALOG_PATH, 'utf8')
  } catch (e) {
    console.error(`Cannot read ${CATALOG_PATH}: ${e.message}`)
    process.exit(1)
  }

  /* ── structure ─────────────────────────────────────────────────── */
  const rawRows = parseCsv(csv)
  if (rawRows.length < 2) {
    console.error(`${CATALOG_PATH} has no data rows`)
    process.exit(1)
  }

  const headers = catalogHeaders(csv)
  const missing = REQUIRED_COLUMNS.filter((column) => !headers.includes(column))
  if (missing.length > 0) {
    console.error(`${CATALOG_PATH} is missing required column(s): ${missing.join(', ')}`)
    process.exit(1)
  }

  for (const [index, values] of rawRows.slice(1).entries()) {
    if (values.length !== rawRows[0].length) {
      fail(index + 2, `expected ${rawRows[0].length} fields, found ${values.length} — is a quoted field unterminated?`)
    }
  }

  const allowlist = await loadAllowlist()
  const epgFiles = await loadEpgFiles()
  const rows = parseStationRows(csv)
  const active = rows.filter((station) => !station.stream_broken)

  const seenIds = new Map()
  const seenUrls = new Map()
  const appOnly = []
  let brokenWithoutUrl = 0

  /* ── rows ──────────────────────────────────────────────────────── */
  for (const station of rows) {
    const line = station._line

    if (!Number.isInteger(station.id) || station.id <= 0) {
      fail(line, `invalid id "${station.id}" — ids must be positive integers`)
    } else if (seenIds.has(station.id)) {
      fail(line, `duplicate id ${station.id} (also on line ${seenIds.get(station.id)})`)
    } else {
      seenIds.set(station.id, line)
    }

    if (station.stream_broken && station.stream_broken !== 'true') {
      warn(line, `${label(station)}: stream_broken is "${station.stream_broken}", expected "" or "true"`)
    }

    if (!station.stream_broken && !station.name) {
      fail(line, `active station id ${station.id} has no name`)
    }

    /* A defect only blocks the publish when the row is rendered; broken rows are
       already hidden, so their defects are reported as warnings. */
    const problem = station.stream_broken ? warn : fail

    if (!station.url) {
      if (station.stream_broken) brokenWithoutUrl++
      else fail(line, `${label(station)}: active station has no stream URL`)
    } else if (/\s/.test(station.url)) {
      problem(line, `${label(station)}: stream URL contains whitespace/newline — ${JSON.stringify(station.url)}`)
    } else if (!isHttpUrl(station.url)) {
      problem(line, `${label(station)}: stream URL must start with http:// or https:// — ${JSON.stringify(station.url)}`)
    } else if (!station.stream_broken) {
      if (seenUrls.has(station.url)) {
        const first = seenUrls.get(station.url)
        fail(line, `${label(station)}: duplicate stream URL (also id ${first.id} on line ${first.line})`)
      } else {
        seenUrls.set(station.url, { id: station.id, line })
      }

      if (station.url.startsWith('http://')) {
        const host = hostOf(station.url)
        const carried = allowlist.stationIds.get(host)
        if (!allowlist.present || carried?.has(station.id)) appOnly.push(station)
        else {
          warn(
            line,
            `${label(station)}: active http:// row is not in ${ALLOWLIST_PATH} — add it to the app's data/cleartext-hosts.json or it will be hidden from listeners`
          )
        }
      }
    }

    for (const field of ['homepage', 'favicon']) {
      const value = station[field]
      if (value && !isHttpUrl(value)) {
        fail(line, `${label(station)}: ${field} must start with http:// or https:// — ${JSON.stringify(value)}`)
      }
    }

    for (const [field, prefix] of [['url_http', 'http://'], ['url_https', 'https://']]) {
      const value = station[field]
      if (!value) continue
      if (/\s/.test(value)) warn(line, `${label(station)}: ${field} contains whitespace/newline — ${JSON.stringify(value)}`)
      else if (!value.startsWith(prefix)) warn(line, `${label(station)}: ${field} must start with ${prefix} — ${JSON.stringify(value)}`)
    }

    if (station.countrycode && !/^[A-Z]{2}$/.test(station.countrycode)) {
      warn(line, `${label(station)}: countrycode should be a two-letter ISO code — ${JSON.stringify(station.countrycode)}`)
    }
    if (station.bitrate && !/^\d+$/.test(station.bitrate)) {
      warn(line, `${label(station)}: bitrate should be whole kbps — ${JSON.stringify(station.bitrate)}`)
    }
    for (const field of ['hls', 'lastcheckok']) {
      const value = station[field]
      if (value && !/^[01]$/.test(value)) warn(line, `${label(station)}: ${field} is "0" or "1" — ${JSON.stringify(value)}`)
    }

    if (station.epg_file && !station.stream_broken && epgFiles && !epgFiles.has(station.epg_file)) {
      fail(line, `${label(station)}: epg_file "${station.epg_file}" does not exist in ${EPG_DIR}/`)
    }
  }

  /* ── cross-check against the guide pipeline config ─────────────── */
  const config = await loadConfig()
  const byId = new Map(rows.map((station) => [station.id, station]))
  for (const row of config) {
    const catalogRow = byId.get(row.id)
    if (!catalogRow) {
      warn(row._line, `config id ${row.id} (${row.name}) is not in ${CATALOG_PATH} — the app cannot show its guide`)
      continue
    }
    if (row.epg_file && catalogRow.epg_file && row.epg_file !== catalogRow.epg_file) {
      warn(
        row._line,
        `id ${row.id}: config epg_file "${row.epg_file}" differs from ${CATALOG_PATH} "${catalogRow.epg_file}"`
      )
    }
  }

  /* ── report ────────────────────────────────────────────────────── */
  const summary = catalogSummary(rows)
  const renderable = rows.filter((station) =>
    isPlayableStation(station, { cleartextHosts: allowlist.hostSet })
  ).length

  console.log(`\n${CATALOG_PATH}`)
  console.log(
    `  rows: ${summary.rows}   active: ${active.length}   marked broken: ${summary.rows - active.length}   renderable: ${renderable}`
  )

  if (brokenWithoutUrl > 0) info.push(`${brokenWithoutUrl} broken row(s) have no URL yet`)
  if (appOnly.length > 0) {
    info.push(
      `${appOnly.length} active http:// row(s) are app-only: ${appOnly.map((s) => s.id).join(', ')} — hidden by the HTTPS build` +
      (allowlist.present ? '' : `; ${ALLOWLIST_PATH} is absent, so the app's own validate:stations decides`) 
    )
  }
  for (const message of info) console.log(`\nℹ️  ${message}`)

  if (warnings.length > 0) {
    console.log(`\n⚠️  ${warnings.length} warning(s)`)
    for (const { line, message } of warnings) console.log(`   ${line ? `line ${line}  ` : ''}${message}`)
    console.log('   warnings do not block the publish')
  }

  if (errors.length > 0) {
    console.log(`\n❌ ${errors.length} error(s)`)
    for (const { line, message } of errors) console.log(`   ${line ? `line ${line}  ` : ''}${message}`)
    console.log('')
    process.exit(1)
  }

  console.log('\n✅ Catalog valid\n')
}

main().catch((error) => {
  console.error('Error:', error.stack || error.message)
  process.exit(1)
})
