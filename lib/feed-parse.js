/**
 * Tolerant feed parsing for the station blog pipeline.
 *
 * Accepts RSS 2.0, RSS 1.0/RDF, Atom, JSON Feed, WordPress REST and Blogger
 * JSON. The output is deliberately small: id, url, title and date_published.
 * Article content is never stored.
 */

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  eacute: 'é',
  egrave: 'è',
  agrave: 'à',
  ccedil: 'ç',
  uuml: 'ü',
  ouml: 'ö',
  auml: 'ä',
  ntilde: 'ñ',
  iacute: 'í',
  oacute: 'ó',
  uacute: 'ú',
  euro: '€',
  deg: '°',
  middot: '·',
}

const MONTHS = {
  enero: 0,
  febrero: 1,
  marzo: 2,
  abril: 3,
  mayo: 4,
  junio: 5,
  julio: 6,
  agosto: 7,
  septiembre: 8,
  setiembre: 8,
  octubre: 9,
  noviembre: 10,
  diciembre: 11,
  januar: 0,
  februar: 1,
  marz: 2,
  april: 3,
  mai: 4,
  juni: 5,
  juli: 6,
  august: 7,
  september: 8,
  oktober: 9,
  november: 10,
  dezember: 11,
  janvier: 0,
  fevrier: 1,
  mars: 2,
  avril: 3,
  juin: 5,
  juillet: 6,
  aout: 7,
  septembre: 8,
  octobre: 9,
  decembre: 11,
  gennaio: 0,
  febbraio: 1,
  aprile: 3,
  maggio: 4,
  giugno: 5,
  luglio: 6,
  settembre: 8,
  ottobre: 9,
  dicembre: 11,
  january: 0,
  february: 1,
  march: 2,
  may: 4,
  june: 5,
  july: 6,
  october: 9,
  december: 11,
}

const MONTH_NAMES = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|')

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function decodeEntities(input) {
  return String(input ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      try {
        return String.fromCodePoint(Number.parseInt(hex, 16))
      } catch {
        return ''
      }
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      try {
        return String.fromCodePoint(Number.parseInt(dec, 10))
      } catch {
        return ''
      }
    })
    .replace(/&([a-z][a-z0-9]+);/gi, (match, name) => NAMED_ENTITIES[name.toLowerCase()] ?? match)
}

/** Strip scripts, styles and tags, then decode entities and collapse space. */
export function stripHtml(input) {
  return decodeEntities(
    String(input ?? '')
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim()
}

function unwrap(raw) {
  const cdata = String(raw ?? '').match(/<!\[CDATA\[([\s\S]*?)\]\]>/i)
  return cdata ? cdata[1] : String(raw ?? '')
}

function tagValue(block, names) {
  for (const name of names) {
    const pattern = new RegExp(
      `<${escapeRegExp(name)}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapeRegExp(name)}>`,
      'i',
    )
    const match = block.match(pattern)
    if (match) return unwrap(match[1])
  }
  return ''
}

function tags(block, name) {
  return [...block.matchAll(new RegExp(`<${escapeRegExp(name)}\\b[^>]*>`, 'gi'))].map((match) => match[0])
}

function attributes(tag) {
  const attrs = {}
  const pattern = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  let match
  while ((match = pattern.exec(tag))) {
    attrs[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? '')
  }
  return attrs
}

function absoluteUrl(value, baseUrl) {
  const href = decodeEntities(String(value ?? '')).trim()
  if (!href) return null
  try {
    const url = new URL(href, baseUrl || undefined)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    url.hash = ''
    return url.href
  } catch {
    return null
  }
}

function atomLink(block, baseUrl) {
  const links = tags(block, 'link').map(attributes)
  const alternate = links.find((link) => (link.rel || 'alternate') === 'alternate' && link.href)
  const any = alternate || links.find((link) => link.href)
  return absoluteUrl(any?.href, baseUrl)
}

export function normalizeDate(value) {
  const text = stripHtml(value)
  if (!text) return null

  const isoWithoutZone = text.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/)
  const candidate = isoWithoutZone ? `${text}Z` : text
  const parsed = Date.parse(candidate)
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString()

  const monthPattern = new RegExp(
    `^(\\d{1,2})(?:\\.)?\\s+(${MONTH_NAMES})\\.?\\s+(\\d{4})$`,
    'i',
  )
  const match = text.match(monthPattern)
  if (match) {
    const key = match[2]
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
    const month = MONTHS[key]
    if (month !== undefined) {
      const day = Number.parseInt(match[1], 10)
      const year = Number.parseInt(match[3], 10)
      if (day >= 1 && day <= 31) {
        return new Date(Date.UTC(year, month, day, 12)).toISOString()
      }
    }
  }

  return null
}

function cleanTitle(value) {
  return stripHtml(value).replace(/\s+/g, ' ').trim()
}

function parseItem(block, baseUrl, { atom = false } = {}) {
  const title = cleanTitle(tagValue(block, ['title']))
  const rawLink = atom
    ? atomLink(block, baseUrl)
    : absoluteUrl(tagValue(block, ['link']), baseUrl) || atomLink(block, baseUrl)
  const guid = cleanTitle(tagValue(block, ['guid', 'id']))
  const date = normalizeDate(tagValue(block, ['pubDate', 'published', 'updated', 'dc:date', 'date']))
  const id = guid || rawLink || ''
  if (!title || !rawLink) return null
  return {
    id,
    url: rawLink,
    title,
    date_published: date,
  }
}

function parseXml(xml, { atom = false, baseUrl = '' } = {}) {
  const container = atom ? xml : xml.match(/<channel\b[\s\S]*?<\/channel>/i)?.[0] || xml
  const feedTitle = cleanTitle(tagValue(container, ['title']))
  const itemTag = atom ? 'entry' : 'item'
  const blocks = [...xml.matchAll(new RegExp(`<${itemTag}\\b[\\s\\S]*?<\\/${itemTag}>`, 'gi'))].map(
    (match) => match[0],
  )
  const items = blocks
    .map((block) => parseItem(block, baseUrl, { atom }))
    .filter(Boolean)
  return { format: atom ? 'atom' : 'rss', title: feedTitle, items }
}

function jsonTitle(value) {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') return value.rendered || value.$t || value.name || ''
  return ''
}

function parseJson(text, baseUrl = '') {
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return { format: null, title: '', items: [] }
  }

  if (Array.isArray(data)) {
    const items = data
      .map((item) => {
        const url = absoluteUrl(item?.link || item?.url || item?.guid?.rendered, baseUrl)
        const title = cleanTitle(jsonTitle(item?.title))
        const date = normalizeDate(item?.date_gmt || item?.date || item?.modified_gmt || item?.modified)
        if (!url || !title) return null
        return { id: String(item?.id ?? url), url, title, date_published: date }
      })
      .filter(Boolean)
    return { format: 'wp-rest', title: '', items }
  }

  if (Array.isArray(data?.feed?.entry)) {
    const items = data.feed.entry
      .map((entry) => {
        const links = Array.isArray(entry?.link) ? entry.link : []
        const alternate = links.find((link) => link?.rel === 'alternate') || links[0]
        const url = absoluteUrl(alternate?.href, baseUrl)
        const title = cleanTitle(jsonTitle(entry?.title))
        const date = normalizeDate(entry?.published?.$t || entry?.updated?.$t)
        if (!url || !title) return null
        return { id: String(entry?.id?.$t || url), url, title, date_published: date }
      })
      .filter(Boolean)
    return { format: 'blogger', title: cleanTitle(jsonTitle(data.feed.title)), items }
  }

  if (Array.isArray(data?.items)) {
    const items = data.items
      .map((item) => {
        const url = absoluteUrl(item?.url || item?.external_url || item?.link, baseUrl)
        const title = cleanTitle(item?.title)
        const date = normalizeDate(item?.date_published || item?.date_modified)
        if (!url || !title) return null
        return { id: String(item?.id || url), url, title, date_published: date }
      })
      .filter(Boolean)
    return { format: 'json-feed', title: cleanTitle(data?.title), items }
  }

  return { format: null, title: '', items: [] }
}

export function parseFeed(text, { url = '' } = {}) {
  const raw = String(text ?? '').replace(/^\uFEFF/, '').trim()
  if (!raw) return { format: null, title: '', items: [] }

  if (raw.startsWith('{') || raw.startsWith('[')) return parseJson(raw, url)

  if (/<rss[\s>]/i.test(raw) || /<rdf:RDF[\s>]/i.test(raw)) {
    const parsed = parseXml(raw, { baseUrl: url })
    parsed.items = parsed.items
      .map((item) => ({ ...item, url: absoluteUrl(item.url, url) }))
      .filter((item) => item.url)
    return parsed
  }

  if (/<feed[\s>]/i.test(raw) && /xmlns/i.test(raw.slice(0, 2000))) {
    const parsed = parseXml(raw, { atom: true, baseUrl: url })
    parsed.items = parsed.items
      .map((item) => ({ ...item, url: absoluteUrl(item.url, url) }))
      .filter((item) => item.url)
    return parsed
  }

  return { format: null, title: '', items: [] }
}

export function normaliseItems(items, { limit = 10 } = {}) {
  const seen = new Set()
  const unique = []
  for (const item of items || []) {
    const key = item?.url || item?.id
    if (!key || seen.has(key)) continue
    if (!item.title || !item.url) continue
    seen.add(key)
    unique.push(item)
  }

  unique.sort((a, b) => {
    const left = a.date_published ? Date.parse(a.date_published) : Number.NEGATIVE_INFINITY
    const right = b.date_published ? Date.parse(b.date_published) : Number.NEGATIVE_INFINITY
    return right - left
  })

  return unique.slice(0, limit)
}

export function slugify(value) {
  const slug = String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'station'
}
