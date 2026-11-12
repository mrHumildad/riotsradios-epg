/**
 * Shared HTTP helpers for feed discovery and refresh.
 *
 * The bot UA is used first. A browser UA is tried only when the host rejects
 * that UA with 403/406, and the caller records which one succeeded.
 */

export const BOT_UA =
  'riotsradios-feeds/1.0 (+https://github.com/mrHumildad/riotsradios-epg)'
export const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const ACCEPT =
  'application/rss+xml, application/atom+xml, application/feed+json, application/json, ' +
  'application/xml, text/xml, text/html;q=0.8, */*;q=0.5'

export function decodeBody(buffer, contentType = '') {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  let charset = String(contentType).match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1]
  if (!charset) {
    const head = new TextDecoder('utf-8').decode(bytes.slice(0, 400))
    charset = head.match(/<\?xml[^>]*encoding\s*=\s*["']([^"']+)/i)?.[1]
  }
  try {
    return new TextDecoder(charset || 'utf-8').decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

export async function fetchResource(
  url,
  { ua = BOT_UA, timeout = 12000, fetchImpl = globalThis.fetch, headers = {} } = {},
) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is not available')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetchImpl(url, {
      headers: {
        'User-Agent': ua,
        Accept: ACCEPT,
        ...headers,
      },
      redirect: 'follow',
      signal: controller.signal,
    })
    const buffer = new Uint8Array(await response.arrayBuffer())
    const contentType = response.headers?.get?.('content-type') || ''
    return {
      ok: response.ok,
      status: response.status,
      url: response.url || url,
      contentType,
      text: decodeBody(buffer, contentType),
      headers: response.headers,
      ua,
    }
  } finally {
    clearTimeout(timer)
  }
}

/** Retry once with a browser UA after a 403/406 from the bot UA. */
export async function fetchWithUaFallback(url, options = {}) {
  const first = await fetchResource(url, { ...options, ua: BOT_UA })
  if (first.status === 403 || first.status === 406) {
    return fetchResource(url, { ...options, ua: BROWSER_UA })
  }
  return first
}
