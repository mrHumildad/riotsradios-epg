/**
 * HTML adapters for stations that publish a blog/news list but no feed.
 *
 * Only server-rendered pages are supported. Each adapter extracts title and URL
 * from the list page; if the list has no date, the article page is read for
 * its published metadata.
 */

import { decodeEntities, normaliseItems, normalizeDate, stripHtml } from './feed-parse.js'
import { fetchWithUaFallback } from './feed-fetch.js'

const MOCHILEROS_URL = 'https://www.mochilerosradio.com/blog.html'
const KLASSIK_URL = 'https://www.klassikradio.de/aktuelles/'

function anchors(html) {
  const result = []
  const pattern = /<a\b[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi
  let match
  while ((match = pattern.exec(html))) {
    result.push({
      href: decodeEntities(match[1] ?? match[2] ?? ''),
      inner: match[3] ?? '',
    })
  }
  return result
}

function absolute(value, baseUrl) {
  try {
    const url = new URL(decodeEntities(value), baseUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    url.hash = ''
    return url.href
  } catch {
    return null
  }
}

function heading(inner) {
  const match = inner.match(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/i)
  return stripHtml(match?.[1] || inner)
}

function dateFromHtml(html) {
  const time = html.match(/<time\b[^>]*datetime\s*=\s*(?:"([^"]+)"|'([^']+)')/i)
  if (time) return normalizeDate(time[1] ?? time[2])

  const meta =
    html.match(/article:published_time["']?\s+content\s*=\s*(?:"([^"]+)"|'([^']+)')/i) ||
    html.match(/content\s*=\s*(?:"([^"]+)"|'([^']+)')["']?\s+property\s*=\s*["']article:published_time/i)
  if (meta) return normalizeDate(meta[1] ?? meta[2])

  const jsonLd = html.match(/"datePublished"\s*:\s*"([^"]+)"/i)
  if (jsonLd) return normalizeDate(jsonLd[1])

  return null
}

function listingDate(inner) {
  const fromTime = dateFromHtml(inner)
  if (fromTime) return fromTime

  const text = stripHtml(inner)
  const month =
    '(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)'
  const spanish = text.match(new RegExp(`\\b(\\d{1,2}\\s+${month}\\s+\\d{4})\\b`, 'i'))
  if (spanish) return normalizeDate(spanish[1])

  const german = text.match(/\b(\d{1,2}\.\s+[A-Za-zÄÖÜäöüß]+\s+\d{4})\b/)
  if (german) return normalizeDate(german[1])

  return null
}

export function parseMochileros(html, baseUrl = MOCHILEROS_URL) {
  const items = []
  const seen = new Set()

  for (const anchor of anchors(html)) {
    if (!/\/(?:blog|ciudades|editoriales)\//i.test(anchor.href)) continue
    const url = absolute(anchor.href, baseUrl)
    if (!url || seen.has(url)) continue
    const title = heading(anchor.inner)
    if (title.length < 8) continue
    seen.add(url)
    items.push({
      id: url,
      url,
      title,
      date_published: listingDate(anchor.inner),
    })
  }

  return items
}

export function parseKlassik(html, baseUrl = KLASSIK_URL) {
  const items = []
  const seen = new Set()

  for (const anchor of anchors(html)) {
    if (!/\/aktuelles\/[^/?#]+/i.test(anchor.href)) continue
    if (/\/(?:datenschutz|impressum|kontakt)\/?/i.test(anchor.href)) continue
    const url = absolute(anchor.href, baseUrl)
    if (!url || seen.has(url)) continue
    const title = heading(anchor.inner)
    if (title.length < 12 || /^aktuelles$/i.test(title)) continue
    seen.add(url)
    items.push({
      id: url,
      url,
      title,
      date_published: listingDate(anchor.inner),
    })
  }

  return items
}

export function dateFromArticle(html) {
  return dateFromHtml(html)
}

export const HTML_ADAPTERS = {
  mochileros: {
    stationId: 100,
    url: MOCHILEROS_URL,
    parseList: parseMochileros,
  },
  klassik: {
    stationId: 150,
    url: KLASSIK_URL,
    parseList: parseKlassik,
  },
}

/**
 * Fetch and normalise an HTML source. Dates missing from the list are read from
 * the article page, capped at the number of items kept.
 */
export async function loadHtmlSource(adapterName, { fetchImpl = globalThis.fetch, limit = 10 } = {}) {
  const adapter = HTML_ADAPTERS[adapterName]
  if (!adapter) throw new Error(`unknown HTML adapter: ${adapterName}`)

  const list = await fetchWithUaFallback(adapter.url, { fetchImpl })
  if (!list.ok) {
    const error = new Error(`HTML list returned HTTP ${list.status}`)
    error.status = list.status
    error.ua = list.ua
    throw error
  }

  const items = adapter.parseList(list.text, list.url).slice(0, limit)
  for (const item of items) {
    if (item.date_published) continue
    try {
      const article = await fetchWithUaFallback(item.url, { fetchImpl, timeout: 10000 })
      if (article.ok) item.date_published = dateFromArticle(article.text)
    } catch {
      /* an undated item is still useful */
    }
  }

  return {
    items: normaliseItems(items, { limit }),
    sourceUrl: list.url,
    ua: list.ua,
  }
}
