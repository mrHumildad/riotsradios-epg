/**
 * Catalog rules — vendored from riotsradios `lib/stations.js` and `lib/catalog.js`.
 *
 * The player refuses a published catalog that breaks these rules, so the publish
 * side must enforce exactly the same ones, or a station would pass here and be
 * rejected (or worse, silently dropped) in the app. This file is the single copy
 * on the EPG side: keep it byte-comparable with the app's modules when the rules
 * change, and update `tests/catalog.test.mjs` with it.
 *
 * Pure: no filesystem, no network, no fetch.
 */

import { parseStationRows } from './csv.js'

/* Column the player relies on; other columns are passed through untouched. */
export const REQUIRED_COLUMNS = ['id', 'name', 'stream_broken', 'url']

/** Whitespace inside a URL is never valid, even though a quoted CSV field may
    legally contain a newline. */
export function isValidStreamUrl(value) {
  const raw = typeof value === 'string' ? value : ''
  if (!raw || /\s/.test(raw)) return false
  try {
    const url = new URL(raw)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== ''
  } catch {
    return false
  }
}

/**
 * Mirrors `isPlayableStation` in the app.
 *
 * `cleartextHosts` is the app's device allowlist (`data/cleartext-hosts.json`).
 * On the publish side an `http://` row with no allowlist entry is a warning, not
 * an error: the row is still valid catalog content, it simply cannot be rendered
 * by the HTTPS build. Pass `allowHttp: true` for an https-only strictness check.
 */
export function isPlayableStation(station, { cleartextHosts, allowHttp = false } = {}) {
  if (!station || !Number.isInteger(station.id) || station.id <= 0) return false
  if (station.stream_broken) return false
  if (!isValidStreamUrl(station.url)) return false
  if (!station.url.startsWith('http://')) return true
  if (allowHttp) return false
  return cleartextHosts instanceof Set && cleartextHosts.has(hostOf(station.url))
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** Header cells of a catalog CSV, trimmed, in file order. */
export function catalogHeaders(csvString) {
  const [first = ''] = String(csvString || '').replace(/^\uFEFF/, '').split(/\r?\n/)
  if (!first.trim()) return []
  return splitHeader(first).map((cell) => cell.trim())
}

function splitHeader(line) {
  const cells = []
  let value = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (char === '"') {
      if (quoted && line[i + 1] === '"') { value += '"'; i++ } else quoted = !quoted
    } else if (char === ',' && !quoted) {
      cells.push(value)
      value = ''
    } else {
      value += char
    }
  }
  cells.push(value)
  return cells
}

export function catalogSummary(stations) {
  const seen = new Set()
  let playable = 0
  let hidden = 0
  for (const station of stations) {
    if (!Number.isInteger(station.id) || station.id <= 0 || seen.has(station.id)) continue
    seen.add(station.id)
    if (isPlayableStation(station)) playable++
    if (station.stream_broken) hidden++
  }
  return { rows: stations.length, playable, hidden, uniqueIds: seen.size }
}

/**
 * Decide whether this CSV may be published at all.
 *
 * The app runs the same check on the published file before adopting it, so a
 * catalog that fails here would be refused in the field rather than fixed on the
 * next push. Refusing to publish is the cheaper failure.
 *
 * @param {string} csvString
 * @param {object} [options]
 * @param {Array<object>} [options.current] the previously published catalog
 * @param {number} [options.minRatio] floor relative to the current playable count
 * @returns {{ ok: boolean, errors: string[], summary: object }}
 */
export function assessCatalogCsv(csvString, { current = [], minRatio = 0.6 } = {}) {
  const errors = []
  const text = typeof csvString === 'string' ? csvString : ''

  if (!text.trim()) return { ok: false, errors: ['file is empty'], summary: catalogSummary([]) }

  const missing = REQUIRED_COLUMNS.filter((column) => !catalogHeaders(text).includes(column))
  if (missing.length > 0) {
    return { ok: false, errors: [`missing required column(s): ${missing.join(', ')}`], summary: catalogSummary([]) }
  }

  const rows = parseStationRows(text)
  const summary = catalogSummary(rows)

  const invalidIds = rows.filter((station) => !Number.isInteger(station.id) || station.id <= 0)
  if (invalidIds.length > 0) errors.push(`${invalidIds.length} row(s) with an id that is not a positive integer`)
  if (summary.uniqueIds !== rows.length) errors.push(`${rows.length - summary.uniqueIds} duplicate id(s)`)
  if (summary.playable === 0) errors.push('no playable station')

  const currentPlayable = catalogSummary(current).playable
  if (currentPlayable > 0 && summary.playable < Math.ceil(currentPlayable * minRatio)) {
    errors.push(
      `only ${summary.playable} playable row(s), down from ${currentPlayable} ` +
      `(a publish may not drop more than ${Math.round((1 - minRatio) * 100)}%)`
    )
  }

  return { ok: errors.length === 0, errors, summary }
}
