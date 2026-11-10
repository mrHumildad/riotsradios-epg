/**
 * Stream-health helpers — vendored from riotsradios `lib/health.js`.
 *
 * The probe lives here now: this repository owns `catalog/health.json`, which the
 * player copies at every catalog sync. The badge vocabulary (`healthBadge`) still
 * ships in the app, so keep the two files comparable when a status or threshold
 * changes; `tests/catalog.test.mjs` covers the classification used here.
 *
 * Pure functions only: no filesystem, no fetch, no React.
 */

/** Statuses that mean "listeners cannot play this station". */
const FAILING_STATUSES = new Set([
  'timeout',
  'tls_error',
  'unreachable',
  'http_4xx',
  'http_5xx',
  'not_audio',
  'auth_required',
  'playlist',
])

export function isFailingStatus(status) {
  return FAILING_STATUSES.has(status)
}

/** Consecutive failed checks before a station is labelled OFFLINE. */
export const OFFLINE_AFTER_FAILURES = 3

function normalizeCors(header) {
  if (!header) return null
  const value = String(header).trim()
  if (value === '*') return 'any'
  if (/^https?:\/\//i.test(value)) return 'origin'
  return null
}

/**
 * Classify one probe result.
 *
 * @param {object} probe
 * @param {string} probe.url station stream URL
 * @param {number} [probe.status] HTTP status code (absent on transport errors)
 * @param {string} [probe.content_type]
 * @param {string|null} [probe.acao] Access-Control-Allow-Origin header
 * @param {'timeout'|'tls'|'network'|null} [probe.error] transport failure
 * @returns {{ status: string, cors: string|null }}
 */
export function classifyProbe({ url, status, content_type = '', acao = null, error = null }) {
  const cors = normalizeCors(acao)

  if (error === 'timeout') return { status: 'timeout', cors }
  if (error === 'tls') return { status: 'tls_error', cors }
  if (error) return { status: 'unreachable', cors }

  if (url.startsWith('http://')) return { status: 'http_only', cors }
  if (status === 401 || status === 403) return { status: 'auth_required', cors }
  if (status >= 500) return { status: 'http_5xx', cors }
  if (status >= 400) return { status: 'http_4xx', cors }

  const type = String(content_type || '').toLowerCase()
  if (/mpegurl|m3u/.test(type) || /\.m3u8?($|\?)/i.test(url)) return { status: 'playlist', cors }
  if (/^(audio\/|application\/ogg|application\/x-ogg)/.test(type)) {
    return { status: cors ? 'ok' : 'cors_missing', cors }
  }
  return { status: 'not_audio', cors }
}

/**
 * Fold a new probe into the previous snapshot so failures accumulate.
 *
 * @param {object|undefined} previous entry from the previous health.json
 * @param {object} probe result of classifyProbe plus http_code/latency_ms
 * @param {Date} [now]
 */
export function mergeHealth(previous, probe, now = new Date()) {
  const failing = isFailingStatus(probe.status)
  const failures = failing ? (previous?.consecutive_failures || 0) + 1 : 0
  return {
    ...probe,
    checked_at: now.toISOString(),
    consecutive_failures: failures,
    last_ok_at: failing ? previous?.last_ok_at ?? null : now.toISOString(),
  }
}

/**
 * Every stream URL a catalog row carries, deduped, with the names it is known
 * under (`url`, `http`, `https`).
 *
 * @param {object} station parsed catalog row
 * @returns {Array<{ url: string, schemes: string[] }>}
 */
export function streamTargets(station) {
  const byUrl = new Map()
  const add = (url, scheme) => {
    const value = typeof url === 'string' ? url.trim() : ''
    if (!value) return
    const schemes = byUrl.get(value)
    if (schemes) schemes.push(scheme)
    else byUrl.set(value, [scheme])
  }
  add(station?.url, 'url')
  add(station?.url_http, 'http')
  add(station?.url_https, 'https')
  return [...byUrl].map(([url, schemes]) => ({ url, schemes }))
}

/**
 * Human-facing badge for a station's health entry.
 * Returns null when there is no data (nothing honest to show).
 */
export function healthBadge(health) {
  if (!health || !health.status) return null

  const failures = health.consecutive_failures || 0
  const checked = health.checked_at ? ` · checked ${new Date(health.checked_at).toISOString().slice(0, 16).replace('T', ' ')}Z` : ''

  if (health.status === 'ok' || health.status === 'cors_missing') {
    return { label: 'LIVE', tone: 'ok', title: `Responding with audio${checked}` }
  }
  if (health.status === 'http_only') {
    return {
      label: 'HTTP ONLY',
      tone: 'warn',
      title: 'This station only broadcasts over HTTP, which browsers block on the HTTPS site',
    }
  }

  const reason = health.status.replace(/_/g, ' ')
  if (failures >= OFFLINE_AFTER_FAILURES) {
    return { label: 'OFFLINE', tone: 'bad', title: `${reason} · ${failures} consecutive failed checks${checked}` }
  }
  return { label: 'UNSTABLE', tone: 'warn', title: `${reason} · ${failures} failed check(s)${checked}` }
}
