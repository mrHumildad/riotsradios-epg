#!/usr/bin/env node
/**
 * find-feeds.mjs — discover blog/news feeds for every catalog station.
 *
 * Discovery is deliberately conservative: it tries the homepage's alternate
 * links, then a small set of well-known feed paths. Manual overrides and HTML
 * adapters live in KNOWN and are written as locked entries so a later run never
 * replaces them.
 *
 * Usage:
 *   node scripts/find-feeds.mjs
 *   node scripts/find-feeds.mjs --only 1,10,18
 *   node scripts/find-feeds.mjs --resume
 */
import { readFile, writeFile } from 'node:fs/promises'
import { parseStationRows } from '../lib/csv.js'
import { fetchWithUaFallback } from '../lib/feed-fetch.js'
import { decodeEntities, normaliseItems, parseFeed } from '../lib/feed-parse.js'

const CATALOG_PATH = 'catalog/stations.csv'
const OUTPUT_PATH = 'data/feed_sources.json'

const KNOWN = {
  3: { url: 'https://blog.ciroma.org/feed/', kind: 'rss', locked: true },
  18: { url: 'https://radiotopo.org/feed/', kind: 'rss', locked: true },
  100: {
    url: 'https://www.mochilerosradio.com/blog.html',
    kind: 'html',
    adapter: 'mochileros',
    locked: true,
  },
  150: {
    url: 'https://www.klassikradio.de/aktuelles/',
    kind: 'html',
    adapter: 'klassik',
    locked: true,
  },
}

const COMMON_PATHS = [
  '/feed/',
  '/feed',
  '/rss',
  '/rss.xml',
  '/feed.xml',
  '/?feed=rss2',
  '/wp-json/wp/v2/posts?per_page=10',
  '/feeds/posts/default?alt=json',
  '/spip.php?page=backend',
  '/?format=feed&type=rss',
]

function attr(tag, name) {
  const match = tag.match(
    new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'),
  )
  return match?.[1] ?? match?.[2] ?? ''
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

function alternateLinks(html, baseUrl) {
  const links = []
  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    if (!/rel\s*=\s*["'][^"']*alternate/i.test(tag)) continue
    const type = attr(tag, 'type')
    const href = attr(tag, 'href')
    if (!href) continue
    if (!/(rss|atom|feed\+json|json)/i.test(type) && !/(feed|rss|atom)(\/|$|\.)/i.test(href)) {
      continue
    }
    const url = absolute(href, baseUrl)
    if (url && !/comments\/feed/i.test(url)) links.push(url)
  }
  return links
}

function candidateUrls(homepage, html, finalUrl) {
  const urls = [...alternateLinks(html, finalUrl)]
  try {
    const origin = new URL(finalUrl).origin
    for (const path of COMMON_PATHS) {
      urls.push(`${origin}${path}`)
      if (path.startsWith('/?') || path.startsWith('/wp-json')) continue
      try {
        urls.push(new URL(`.${path}`, finalUrl).href)
      } catch {
        /* ignore */
      }
    }
  } catch {
    urls.push(...COMMON_PATHS.map((path) => absolute(path, homepage)).filter(Boolean))
  }

  const seen = new Set()
  return urls.filter((url) => {
    if (!url || seen.has(url) || /comments\/feed/i.test(url)) return false
    seen.add(url)
    return true
  })
}

function countItems(text, url) {
  const parsed = parseFeed(text, { url })
  if (!parsed.format) return null
  return {
    format: parsed.format,
    items: normaliseItems(parsed.items, { limit: 50 }),
  }
}

async function probe(url) {
  const response = await fetchWithUaFallback(url, { timeout: 9000 })
  if (!response.ok) {
    return {
      status: response.status,
      ua: response.ua,
      blocked: response.status === 403 || response.status === 406,
    }
  }

  const parsed = countItems(response.text, response.url)
  if (!parsed) return { status: response.status, ua: response.ua, format: null }
  return {
    status: response.status,
    ua: response.ua,
    format: parsed.format,
    items: parsed.items,
    finalUrl: response.url,
  }
}

async function checkHtmlOverride(known) {
  const response = await fetchWithUaFallback(known.url, { timeout: 9000 })
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`)
    error.status = response.status
    error.ua = response.ua
    throw error
  }
  return response
}

async function discoverStation(station, previous) {
  const id = Number(station.id)
  const known = KNOWN[id]

  if (previous?.locked) return previous

  if (known) {
    if (known.kind === 'html') {
      try {
        const response = await checkHtmlOverride(known)
        return {
          name: station.name,
          homepage: station.homepage,
          url: known.url,
          kind: 'html',
          adapter: known.adapter,
          status: 'ok',
          checked_at: new Date().toISOString(),
          locked: true,
          ua: response.ua,
        }
      } catch (error) {
        return {
          name: station.name,
          homepage: station.homepage,
          url: known.url,
          kind: 'html',
          adapter: known.adapter,
          status: error.status === 403 || error.status === 406 ? 'blocked' : 'error',
          checked_at: new Date().toISOString(),
          locked: true,
          ua: error.ua || null,
          error: error.message,
        }
      }
    }

    try {
      const result = await probe(known.url)
      if (result.items?.length) {
        return {
          name: station.name,
          homepage: station.homepage,
          url: result.finalUrl || known.url,
          kind: known.kind,
          adapter: null,
          status: 'ok',
          checked_at: new Date().toISOString(),
          locked: true,
          ua: result.ua,
        }
      }
    } catch {
      /* fall through to normal discovery */
    }
  }

  let html = ''
  let finalUrl = station.homepage
  let homeStatus = 0
  let homeUa = null
  try {
    const home = await fetchWithUaFallback(station.homepage, { timeout: 10000 })
    homeStatus = home.status
    homeUa = home.ua
    if (!home.ok) {
      const blocked = home.status === 403 || home.status === 406
      return {
        name: station.name,
        homepage: station.homepage,
        url: null,
        kind: null,
        adapter: null,
        status: blocked ? 'blocked' : 'error',
        checked_at: new Date().toISOString(),
        locked: false,
        ua: home.ua,
        error: `homepage: HTTP ${home.status}`,
      }
    }
    html = home.text
    finalUrl = home.url
  } catch (error) {
    return {
      name: station.name,
      homepage: station.homepage,
      url: null,
      kind: null,
      adapter: null,
      status: 'error',
      checked_at: new Date().toISOString(),
      locked: false,
      ua: null,
      error: `homepage: ${error.message}`,
    }
  }

  const urls = candidateUrls(station.homepage, html, finalUrl)
  let emptyResult = null
  let lastStatus = homeStatus
  let lastUa = homeUa
  let lastError = null

  for (const url of urls) {
    try {
      const result = await probe(url)
      lastStatus = result.status
      lastUa = result.ua || lastUa
      if (result.items?.length) {
        return {
          name: station.name,
          homepage: station.homepage,
          url: result.finalUrl || url,
          kind: result.format,
          adapter: null,
          status: 'ok',
          checked_at: new Date().toISOString(),
          locked: false,
          ua: result.ua,
        }
      }
      if (result.format && !emptyResult) emptyResult = { url, ua: result.ua }
    } catch (error) {
      lastError = error.message
    }
  }

  if (emptyResult) {
    return {
      name: station.name,
      homepage: station.homepage,
      url: emptyResult.url,
      kind: 'feed',
      adapter: null,
      status: 'empty',
      checked_at: new Date().toISOString(),
      locked: false,
      ua: emptyResult.ua,
    }
  }

  return {
    name: station.name,
    homepage: station.homepage,
    url: null,
    kind: null,
    adapter: null,
    status: lastStatus === 403 || lastStatus === 406 ? 'blocked' : 'no_feed',
    checked_at: new Date().toISOString(),
    locked: false,
    ua: lastUa,
    ...(lastError ? { error: lastError } : {}),
  }
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let index = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index++
      results[current] = await fn(items[current], current)
    }
  })
  await Promise.all(workers)
  return results
}

async function main() {
  const onlyIndex = process.argv.indexOf('--only')
  const only =
    onlyIndex >= 0
      ? new Set(
          String(process.argv[onlyIndex + 1] || '')
            .split(',')
            .map((value) => Number.parseInt(value, 10))
            .filter(Number.isInteger),
        )
      : null
  const resume = process.argv.includes('--resume')

  const rows = parseStationRows(await readFile(CATALOG_PATH, 'utf8'))
  let previous = { stations: {} }
  try {
    previous = JSON.parse(await readFile(OUTPUT_PATH, 'utf8'))
  } catch {
    /* first run */
  }

  const selected = only ? rows.filter((row) => only.has(row.id)) : rows
  const stations = { ...(previous.stations || {}) }

  const entries = await mapLimit(selected, 6, async (station) => {
    if (resume && previous.stations?.[station.id]?.status === 'ok') {
      return [station.id, previous.stations[station.id]]
    }
    const entry = await discoverStation(station, previous.stations?.[station.id])
    console.log(
      `${String(station.id).padStart(3)}  ${entry.status.padEnd(8)} ${station.name}${entry.url ? ` — ${entry.url}` : ''}`,
    )
    return [station.id, entry]
  })

  for (const [id, entry] of entries) stations[String(id)] = entry

  const ordered = {}
  for (const row of rows) {
    if (stations[String(row.id)]) ordered[String(row.id)] = stations[String(row.id)]
  }

  await writeFile(
    OUTPUT_PATH,
    `${JSON.stringify(
      {
        version: 1,
        generated_at: new Date().toISOString(),
        stations: ordered,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )

  const counts = {}
  for (const entry of Object.values(ordered)) {
    counts[entry.status] = (counts[entry.status] || 0) + 1
  }
  console.log('')
  console.log(`${OUTPUT_PATH}: ${Object.keys(ordered).length} station(s)`)
  console.log(
    Object.entries(counts)
      .map(([status, count]) => `${status}=${count}`)
      .join('  '),
  )
}

main().catch((error) => {
  console.error(error.stack || error.message)
  process.exit(1)
})
