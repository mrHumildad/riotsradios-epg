#!/usr/bin/env node
/**
 * build-catalog.mjs — publish the app-facing station catalog and its health.
 *
 *   node scripts/build-catalog.mjs                 # write public/catalog/
 *   node scripts/build-catalog.mjs --check         # fail when it is stale
 *   node scripts/build-catalog.mjs --no-health     # publish without a snapshot
 *   node scripts/build-catalog.mjs --health-file other.json
 *
 * Output, served from the Pages root:
 *
 *   public/catalog/stations.csv   byte copy of catalog/stations.csv
 *   public/catalog/manifest.json  { schema, version = sha256(csv), file, rows,
 *                                   generated_at, health }
 *   public/catalog/health.json    copy of catalog/health.json
 *
 * `version` is the SHA-256 of the CSV: the app compares it against its copy and
 * only downloads on a change, and it fetches the CSV as `?v=<hash>` so a CDN edge
 * cannot answer with stale bytes.
 *
 * Health is owned here too — `npm run probe` writes `catalog/health.json`, and
 * this script only copies it. The app's `data/health.json` is a snapshot synced
 * from this output, never generated on its side.
 *
 * Both published files and the manifest are build artifacts; only
 * `catalog/stations.csv` and `catalog/health.json` are committed.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseStationRows } from '../lib/csv.js'
import { assessCatalogCsv, catalogSummary } from '../lib/catalog-rules.js'

const CATALOG_PATH = 'catalog/stations.csv'
const HEALTH_SOURCE_PATH = 'catalog/health.json'
const OUT_DIR = 'public/catalog'
const MANIFEST_PATH = join(OUT_DIR, 'manifest.json')
const PUBLISHED_PATH = join(OUT_DIR, 'stations.csv')
const HEALTH_PATH = join(OUT_DIR, 'health.json')

export const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

async function readText(path) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/** Health snapshots are keyed by station id; anything else is not usable. */
export function isHealthSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entries = Object.values(value)
  return entries.length > 0 && entries.every((entry) => entry && typeof entry === 'object' && 'status' in entry)
}

/**
 * Resolve the health snapshot to publish.
 *
 * A missing or malformed source is not fatal — losing every badge because one
 * file did not parse is worse than publishing the previous snapshot, and worse
 * still than publishing none.
 */
async function resolveHealth({ healthFile, healthPath }) {
  if (healthFile) {
    const text = await readText(healthFile)
    if (text === null) {
      console.warn(`⚠️  ${healthFile} is missing — run \`npm run probe\``)
    } else {
      try {
        const parsed = JSON.parse(text)
        if (isHealthSnapshot(parsed)) return { health: parsed, source: healthFile }
        console.warn(`⚠️  ${healthFile} is not a health snapshot`)
      } catch (e) {
        console.warn(`⚠️  ${healthFile} is not readable JSON (${e.message})`)
      }
    }
  }

  if (healthPath && existsSync(healthPath)) {
    const text = await readText(healthPath)
    try {
      const parsed = JSON.parse(text)
      if (isHealthSnapshot(parsed)) {
        console.warn('⚠️  keeping the previously published health.json')
        return { health: parsed, source: healthPath }
      }
    } catch {
      /* fall through: no health file */
    }
  }

  console.warn('⚠️  publishing without a health snapshot — new stations will have no badge')
  return { health: null, source: null }
}

/**
 * Build the three published files in memory.
 * Throws when the source catalog is not publishable.
 */
export async function buildCatalogFiles({
  catalogPath = CATALOG_PATH,
  publishedPath = PUBLISHED_PATH,
  healthFile = HEALTH_SOURCE_PATH,
  healthPath = HEALTH_PATH,
} = {}) {
  const csv = await readText(catalogPath)
  if (csv === null) throw new Error(`cannot read ${catalogPath}`)
  if (!csv.trim()) throw new Error(`${catalogPath} is empty`)

  const previous = await readText(publishedPath)
  const verdict = assessCatalogCsv(csv, { current: parseStationRows(previous || '') })
  if (!verdict.ok) {
    const error = new Error(`${catalogPath} is not publishable:\n  ${verdict.errors.join('\n  ')}`)
    error.errors = verdict.errors
    throw error
  }

  const { health, source } = await resolveHealth({ healthFile, healthPath })
  const version = sha256(csv)

  const manifest = {
    schema: 1,
    version,
    file: 'stations.csv',
    rows: catalogSummary(parseStationRows(csv)).rows,
    generated_at: new Date().toISOString(),
    health: health ? 'health.json' : null,
  }

  return { csv, manifest, health, healthSource: source }
}

async function main() {
  const args = process.argv.slice(2)
  const check = args.includes('--check')
  const noHealth = args.includes('--no-health')
  const healthIndex = args.indexOf('--health-file')
  const healthFile = noHealth ? null : healthIndex === -1 ? HEALTH_SOURCE_PATH : args[healthIndex + 1]

  if (args.includes('--help') || args.includes('-h')) {
    console.log('usage: build-catalog.mjs [--check] [--no-health] [--health-file path]')
    return 0
  }

  const { csv, manifest, health } = await buildCatalogFiles({
    healthFile,
    healthPath: noHealth ? null : HEALTH_PATH,
  })

  if (check) {
    let current
    try {
      current = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'))
    } catch {
      console.error(`${MANIFEST_PATH} is missing or unreadable; run node scripts/build-catalog.mjs`)
      return 1
    }
    const published = await readText(PUBLISHED_PATH)
    if (current.version !== manifest.version || current.rows !== manifest.rows || published !== csv) {
      console.error(`${OUT_DIR} is stale; run node scripts/build-catalog.mjs`)
      return 1
    }
    console.log(`${OUT_DIR} is current (${manifest.rows} rows, ${manifest.version.slice(0, 12)})`)
    return 0
  }

  await mkdir(dirname(MANIFEST_PATH), { recursive: true })
  await writeFile(PUBLISHED_PATH, csv, 'utf8')
  if (health) await writeFile(HEALTH_PATH, `${JSON.stringify(health, null, 2)}\n`, 'utf8')
  else if (existsSync(HEALTH_PATH)) await writeFile(HEALTH_PATH, '{}\n', 'utf8')

  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  console.log(`${MANIFEST_PATH}: ${manifest.rows} rows, version ${manifest.version.slice(0, 12)}`)
  console.log(`  ${PUBLISHED_PATH}`)
  console.log(`  ${manifest.health ? HEALTH_PATH : '(no health snapshot)'}`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`❌ ${error.message}`)
      process.exit(1)
    })
}
