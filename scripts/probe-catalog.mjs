#!/usr/bin/env node
// Stream-health probe for the catalog — the owner of catalog/health.json.
//
//   node scripts/probe-catalog.mjs                 # probe every station
//   node scripts/probe-catalog.mjs --only 12 34    # probe selected ids
//   node scripts/probe-catalog.mjs --dry           # print, do not write
//
// Only headers are read: a live radio stream never ends, so the body is
// cancelled immediately. The result is folded into the previous snapshot so
// `consecutive_failures` accumulates across runs and a station reaches OFFLINE
// only after three failures in a row.
//
// The CORS answers are measured from `https://mrhumildad.github.io` — the
// player's web origin. `cors: "any"` survives a different origin, `"origin"` (a
// pinned origin) does not; the Android WebView is a different origin, so its
// spectrum support still has to be re-verified on the device.

import { readFile, writeFile } from 'node:fs/promises'
import { parseStationRows } from '../lib/csv.js'
import { isValidStreamUrl } from '../lib/catalog-rules.js'
import { classifyProbe, mergeHealth, streamTargets } from '../lib/health.js'

const CSV_PATH = 'catalog/stations.csv'
const HEALTH_PATH = 'catalog/health.json'
const PAGE_ORIGIN = 'https://mrhumildad.github.io'
const USER_AGENT = 'RIOTSRADIOS-health/1.0 (+https://github.com/mrHumildad/riotsradios-epg)'
const TIMEOUT_MS = 10000
const CONCURRENCY = 6

function parseArgs(argv) {
  const options = { only: null, dry: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--only') {
      options.only = []
      while (argv[i + 1] && !argv[i + 1].startsWith('--')) {
        const id = Number(argv[++i])
        if (Number.isInteger(id) && id > 0) options.only.push(id)
      }
      if (options.only.length === 0) options.only = null
    } else if (arg === '--dry') options.dry = true
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: probe-catalog.mjs [--only id…] [--dry]')
      process.exit(0)
    } else if (!arg.startsWith('--')) {
      const id = Number(arg)
      if (Number.isInteger(id) && id > 0) (options.only ||= []).push(id)
    } else {
      console.warn(`unknown argument "${arg}"`)
    }
  }
  return options
}

async function probe(url) {
  const started = Date.now()

  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: {
        Origin: PAGE_ORIGIN,
        Range: 'bytes=0-1',
        'User-Agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })

    const contentType = res.headers.get('content-type') || ''
    const acao = res.headers.get('access-control-allow-origin')
    /* Do not read the body: a live stream would stream forever. */
    res.body?.cancel().catch(() => {})

    return {
      url,
      status: res.status,
      content_type: contentType,
      acao,
      latency_ms: Date.now() - started,
      error: null,
    }
  } catch (e) {
    const name = e?.name || e?.cause?.name || ''
    const code = String(e?.cause?.code || e?.code || e?.message || '')
    const error = name === 'TimeoutError'
      ? 'timeout'
      : /CERT|TLS|SSL|certificate|cert/i.test(code)
        ? 'tls'
        : 'network'
    return { url, latency_ms: Date.now() - started, error }
  }
}

async function runPool(items, worker, concurrency = CONCURRENCY) {
  const results = new Array(items.length)
  let next = 0

  async function lane() {
    while (next < items.length) {
      const index = next++
      results[index] = await worker(items[index], index)
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, lane))
  return results
}

async function readPrevious() {
  try {
    return JSON.parse(await readFile(HEALTH_PATH, 'utf8'))
  } catch {
    return {}
  }
}

function summarize(health) {
  const counts = new Map()
  for (const entry of Object.values(health)) {
    if (!entry.status) continue
    counts.set(entry.status, (counts.get(entry.status) || 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])
}

/* One merged entry for one probe, folded into the previous snapshot entry so a
   recurring failure keeps accumulating. */
function mergedFor(previousEntry, result) {
  const { status, cors } = classifyProbe(result)
  return {
    status,
    entry: mergeHealth(previousEntry, {
      status,
      cors,
      http_code: result.status ?? null,
      content_type: result.content_type || null,
      latency_ms: result.latency_ms,
    }),
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const rows = parseStationRows(await readFile(CSV_PATH, 'utf8'))

  /* `url` plus every stored mirror: one job per distinct URL, so a row whose
     `url` is its own HTTPS mirror is probed once and reported under both. */
  const jobs = []
  for (const station of rows) {
    if (!Number.isInteger(station.id)) continue
    if (options.only && !options.only.includes(station.id)) continue
    for (const target of streamTargets(station)) {
      if (!isValidStreamUrl(target.url)) continue
      jobs.push({ station, target })
    }
  }

  const previous = await readPrevious()
  const stationCount = new Set(jobs.map((job) => job.station.id)).size

  console.log(`\nProbing ${jobs.length} URL(s) across ${stationCount} station(s), ${CONCURRENCY} at a time…\n`)

  const probed = await runPool(jobs, async ({ station, target }) => {
    const result = await probe(target.url)
    return { station, target, result }
  }, CONCURRENCY)

  /* Stations that were not probed keep their previous entry. */
  const health = {}
  if (options.only) {
    for (const id of options.only) {
      if (previous[String(id)]) health[String(id)] = previous[String(id)]
    }
  }

  for (const { station, target, result } of probed) {
    const id = String(station.id)
    const prev = previous[id]
    const record = health[id] || (health[id] = {})
    const parts = []

    if (target.schemes.includes('url')) {
      const { status, entry } = mergedFor(prev, result)
      Object.assign(record, entry)
      parts.push(`url:${status}`)
    }

    for (const scheme of target.schemes) {
      if (scheme === 'url') continue
      const { status, entry } = mergedFor(prev?.mirrors?.[scheme], result)
      record.mirrors ||= {}
      record.mirrors[scheme] = entry
      parts.push(`${scheme}:${status}`)
    }

    const flag = parts.some((part) => !/:(ok|cors_missing)$/.test(part)) ? '✗ ' : '  '
    console.log(`${flag}${String(station.id).padStart(3)} ${parts.join(' ').padEnd(34)} ${station.name}`)
  }

  /* Keys in catalog order so the committed diff stays readable. */
  const ordered = {}
  const catalogIds = [...new Set(rows.map((row) => row.id))]
    .filter((id) => Number.isInteger(id))
    .sort((a, b) => a - b)
  for (const id of catalogIds) {
    if (health[String(id)]) ordered[String(id)] = health[String(id)]
  }
  /* A probe of a single station must not drop the others. */
  for (const [id, entry] of Object.entries(health)) {
    if (!ordered[id]) ordered[id] = entry
  }

  if (options.dry) {
    console.log('\n(dry run — nothing written)')
    return
  }

  await writeFile(HEALTH_PATH, `${JSON.stringify(ordered, null, 2)}\n`, 'utf8')

  console.log(`\nWrote ${HEALTH_PATH}`)
  for (const [status, count] of summarize(ordered)) console.log(`  ${status.padEnd(14)} ${count}`)
  console.log('')
}

main().catch((e) => {
  console.error('Probe failed:', e)
  process.exit(1)
})
