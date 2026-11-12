#!/usr/bin/env node
/**
 * refresh-feeds.mjs — fetch, normalise and publish station blog feeds.
 *
 * Reads data/feed_sources.json, writes public/feeds/<slug>.json and
 * public/feeds/manifest.json. Each item keeps only id, url, title,
 * content_text (title mirror, required by JSON Feed) and date_published.
 *
 * Usage:
 *   node scripts/refresh-feeds.mjs
 *   node scripts/refresh-feeds.mjs --only 1,100
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parseStationRows } from '../lib/csv.js'
import { fetchWithUaFallback } from '../lib/feed-fetch.js'
import { normaliseItems, parseFeed, slugify } from '../lib/feed-parse.js'
import { loadHtmlSource } from '../lib/html-blog.js'

const CATALOG_PATH = 'catalog/stations.csv'
const SOURCES_PATH = 'data/feed_sources.json'
const OUTPUT_DIR = 'public/feeds'
const MANIFEST_PATH = join(OUTPUT_DIR, 'manifest.json')
const REPORT_PATH = 'data/feeds-report.json'
const CACHE_DIR = 'data/raw/feeds'
const PUBLIC_BASE = 'https://mrhumildad.github.io/riotsradios-epg'
const MAX_ITEMS = 10

function cachePath(id) {
  return join(CACHE_DIR, `${id}.json`)
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
}

async function loadFeedText(entry, id) {
  let cached = {}
  try {
    cached = await readJson(cachePath(id))
  } catch {
    /* no cache */
  }

  const headers = {}
  if (cached.etag) headers['If-None-Match'] = cached.etag
  if (cached.lastModified) headers['If-Modified-Since'] = cached.lastModified

  const response = await fetchWithUaFallback(entry.url, { timeout: 12000, headers })
  if (response.status === 304 && cached.text) {
    return {
      text: cached.text,
      ua: response.ua,
      finalUrl: cached.url || entry.url,
      cached: true,
      status: 304,
    }
  }
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`)
    error.status = response.status
    error.ua = response.ua
    throw error
  }

  await writeJson(cachePath(id), {
    url: response.url,
    etag: response.headers?.get?.('etag') || null,
    lastModified: response.headers?.get?.('last-modified') || null,
    fetched_at: new Date().toISOString(),
    text: response.text,
  })

  return {
    text: response.text,
    ua: response.ua,
    finalUrl: response.url,
    cached: false,
    status: response.status,
  }
}

async function loadSource(entry, id) {
  if (entry.kind === 'html') {
    const result = await loadHtmlSource(entry.adapter, { limit: MAX_ITEMS })
    return { items: result.items, sourceUrl: result.sourceUrl, ua: result.ua, status: 200 }
  }

  const feed = await loadFeedText(entry, id)
  const parsed = parseFeed(feed.text, { url: feed.finalUrl })
  if (!parsed.format) {
    const error = new Error('response is not a recognised feed')
    error.status = feed.status
    throw error
  }
  return {
    items: normaliseItems(parsed.items, { limit: MAX_ITEMS }),
    sourceUrl: feed.finalUrl,
    ua: feed.ua,
    status: feed.status,
    cached: feed.cached,
  }
}

function latestDate(items) {
  let latest = null
  for (const item of items) {
    if (!item.date_published) continue
    if (!latest || Date.parse(item.date_published) > Date.parse(latest)) latest = item.date_published
  }
  return latest
}

function buildFeed(station, entry, source) {
  const generatedAt = new Date().toISOString()
  return {
    version: 'https://jsonfeed.org/version/1.1',
    title: `${station.name} — latest posts`,
    home_page_url: station.homepage || null,
    feed_url: `${PUBLIC_BASE}/feeds/${station.file}`,
    _station_id: Number(station.id),
    _station_name: station.name,
    _source: source.sourceUrl || entry.url,
    _generated_at: generatedAt,
    items: source.items.map((item) => ({
      id: String(item.id || item.url),
      url: item.url,
      title: item.title,
      content_text: item.title,
      ...(item.date_published ? { date_published: item.date_published } : {}),
    })),
  }
}

function uniqueSlugs(rows) {
  const used = new Set()
  const slugs = new Map()
  for (const row of rows) {
    const base = slugify(row.name)
    let slug = base
    if (used.has(slug)) slug = `${base}-${row.id}`
    used.add(slug)
    slugs.set(Number(row.id), slug)
  }
  return slugs
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

  const rows = parseStationRows(await readFile(CATALOG_PATH, 'utf8')).filter(
    (row) => !only || only.has(row.id),
  )
  const catalogRows = parseStationRows(await readFile(CATALOG_PATH, 'utf8'))
  const sources = (await readJson(SOURCES_PATH)).stations || {}
  const slugs = uniqueSlugs(catalogRows)
  const knownIds = new Set(catalogRows.map((row) => Number(row.id)))

  await mkdir(OUTPUT_DIR, { recursive: true })
  await mkdir(CACHE_DIR, { recursive: true })

  const reportById = new Map()
  try {
    const previousReport = await readJson(REPORT_PATH)
    for (const entry of previousReport.stations || []) {
      if (entry && Number.isInteger(entry.id)) reportById.set(String(entry.id), entry)
    }
  } catch {
    /* first run */
  }
  const manifest = {
    version: 1,
    generated_at: new Date().toISOString(),
    stations: {},
  }
  const existingManifest = existsSync(MANIFEST_PATH)
    ? await readJson(MANIFEST_PATH).catch(() => ({ stations: {} }))
    : { stations: {} }
  Object.assign(manifest.stations, existingManifest.stations || {})

  const results = await mapLimit(rows, 6, async (row) => {
    const id = Number(row.id)
    const entry = sources[String(id)]
    const slug = slugs.get(id)
    const file = `${slug}.json`
    const started = Date.now()

    if (!knownIds.has(id)) {
      return null
    }

    if (!entry || !['ok', 'empty'].includes(entry.status)) {
      return {
        id,
        name: row.name,
        status: entry?.status || 'no_feed',
        file: null,
        items: 0,
        latest: null,
        kind: entry?.kind || null,
        url: entry?.url || null,
        http: null,
        ua: entry?.ua || null,
        error: entry?.error || null,
        cached: false,
        duration_ms: 0,
      }
    }

    try {
      const source = await loadSource(entry, id)
      if (!source.items.length) {
        return {
          id,
          name: row.name,
          status: 'empty',
          file: null,
          items: 0,
          latest: null,
          kind: entry.kind,
          url: entry.url,
          http: source.status,
          ua: source.ua,
          error: null,
          cached: Boolean(source.cached),
          duration_ms: Date.now() - started,
        }
      }

      const feed = buildFeed({ ...row, file }, entry, source)
      await writeJson(join(OUTPUT_DIR, file), feed)
      return {
        id,
        name: row.name,
        status: 'ok',
        file,
        items: source.items.length,
        latest: latestDate(source.items),
        kind: entry.kind,
        url: source.sourceUrl,
        http: source.status,
        ua: source.ua,
        error: null,
        cached: Boolean(source.cached),
        duration_ms: Date.now() - started,
      }
    } catch (error) {
      const existingFile = join(OUTPUT_DIR, file)
      if (existsSync(existingFile)) {
        try {
          const previous = await readJson(existingFile)
          return {
            id,
            name: row.name,
            status: 'ok',
            file,
            items: Array.isArray(previous.items) ? previous.items.length : 0,
            latest: latestDate(previous.items || []),
            kind: entry.kind,
            url: entry.url,
            http: error.status || null,
            ua: error.ua || entry.ua || null,
            error: error.message,
            cached: false,
            duration_ms: Date.now() - started,
            retained: true,
          }
        } catch {
          /* fall through to the failure entry */
        }
      }

      return {
        id,
        name: row.name,
        status:
          error.status === 403 || error.status === 406
            ? 'blocked'
            : entry.kind === 'html'
              ? 'error'
              : 'error',
        file: null,
        items: 0,
        latest: null,
        kind: entry.kind,
        url: entry.url,
        http: error.status || null,
        ua: error.ua || entry.ua || null,
        error: error.message,
        cached: false,
        duration_ms: Date.now() - started,
      }
    }
  })

  for (const result of results.filter(Boolean)) {
    manifest.stations[String(result.id)] = {
      name: result.name,
      file: result.file,
      posts: result.items,
      latest: result.latest,
      status: result.status,
      kind: result.kind,
    }
    reportById.set(String(result.id), {
      id: result.id,
      name: result.name,
      status: result.status,
      file: result.file,
      posts: result.items,
      latest: result.latest,
      kind: result.kind,
      url: result.url,
      http: result.http,
      ua: result.ua,
      error: result.error,
      cached: result.cached,
      retained: Boolean(result.retained),
      duration_ms: result.duration_ms,
    })
  }

  for (const row of catalogRows) {
    if (manifest.stations[String(row.id)]) continue
    manifest.stations[String(row.id)] = {
      name: row.name,
      file: null,
      posts: 0,
      latest: null,
      status: sources[String(row.id)]?.status || 'no_feed',
      kind: sources[String(row.id)]?.kind || null,
    }
  }

  await writeJson(MANIFEST_PATH, manifest)
  const report = catalogRows
    .map((row) => reportById.get(String(row.id)))
    .filter(Boolean)
  await writeJson(REPORT_PATH, {
    generated_at: new Date().toISOString(),
    stations: report,
  })

  const ok = report.filter((entry) => entry.status === 'ok')
  const posts = ok.reduce((total, entry) => total + entry.posts, 0)
  console.log(`${MANIFEST_PATH}: ${ok.length} source(s), ${posts} post(s)`)
  for (const entry of report) {
    if (entry.status !== 'ok') {
      console.log(`  ${String(entry.id).padStart(3)}  ${entry.status.padEnd(8)} ${entry.name}`)
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message)
  process.exit(1)
})
