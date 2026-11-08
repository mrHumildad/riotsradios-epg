#!/usr/bin/env node
/**
 * build-manifest.mjs — publish the app-facing EPG index.
 *
 * The app knows station ids, not filenames. This script reads config/stations.csv
 * and data/epg-report.json, checks that every usable guide declares the same
 * station_id as its config row, and writes public/EPGs/manifest.json.
 *
 * Only fully extracted guides are published by default. A hand-maintained legacy
 * guide is published only when it is explicitly named in the config and has no
 * generated replacement; it is marked "legacy". Partial guides stay in the repo
 * and in the report but are not advertised to listeners.
 *
 * Usage:
 *   node scripts/build-manifest.mjs
 *   node scripts/build-manifest.mjs --check
 */
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseStationRows } from '../lib/csv.js'

const CONFIG_PATH = 'config/stations.csv'
const EPG_DIR = 'public/EPGs'
const REPORT_PATH = 'data/epg-report.json'
const MANIFEST_PATH = 'public/EPGs/manifest.json'

function programCount(guide) {
  return (guide.days || []).reduce((total, day) => total + (Array.isArray(day.programs) ? day.programs.length : 0), 0)
}

/**
 * Build the manifest without writing it.
 * Throws when the config or a published guide violates the contract.
 */
export async function buildManifest({
  configPath = CONFIG_PATH,
  epgDir = EPG_DIR,
  reportPath = REPORT_PATH,
} = {}) {
  const config = parseStationRows(await readFile(configPath, 'utf8'))
  let report = { stations: [] }
  try {
    report = JSON.parse(await readFile(reportPath, 'utf8'))
  } catch {
    /* A missing report is allowed while bootstrapping; generated guides are then trusted. */
  }
  const reportById = new Map((report.stations || []).map((station) => [Number(station.id), station]))
  const stations = {}

  for (const row of config) {
    if (row.enabled === 'false' || !row.epg_file) continue
    const id = Number(row.id)
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error(`${configPath}: invalid station id "${row.id}" on line ${row._line}`)
    }

    const filePath = join(epgDir, row.epg_file)
    if (!existsSync(filePath)) {
      throw new Error(`${configPath}: station ${id} points at missing ${filePath}`)
    }

    const guide = JSON.parse(await readFile(filePath, 'utf8'))
    if (Number(guide.station_id) !== id) {
      throw new Error(`${row.epg_file}: station_id ${guide.station_id} does not match config station ${id}`)
    }

    const reportStatus = reportById.get(id)?.status
    const status = guide.generator ? (reportStatus || 'ok') : 'legacy'
    if (status !== 'ok' && status !== 'legacy') continue

    stations[String(id)] = {
      file: row.epg_file,
      status,
      updated: guide.last_updated || null,
      days: Array.isArray(guide.days) ? guide.days.length : 0,
      programs: programCount(guide),
    }
  }

  return {
    version: 1,
    generated_at: new Date().toISOString(),
    stations,
  }
}

async function main() {
  const check = process.argv.includes('--check')
  const manifest = await buildManifest()

  if (check) {
    let current
    try {
      current = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'))
    } catch {
      console.error(`${MANIFEST_PATH} is missing or unreadable; run node scripts/build-manifest.mjs`)
      process.exit(1)
    }
    if (JSON.stringify(current.stations) !== JSON.stringify(manifest.stations)) {
      console.error(`${MANIFEST_PATH} is stale; run node scripts/build-manifest.mjs`)
      process.exit(1)
    }
    console.log(`${MANIFEST_PATH} is current (${Object.keys(manifest.stations).length} guide(s))`)
    return
  }

  try {
    const current = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'))
    if (JSON.stringify(current.stations) === JSON.stringify(manifest.stations) && current.generated_at) {
      manifest.generated_at = current.generated_at
    }
  } catch {
    /* first build */
  }

  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  console.log(`${MANIFEST_PATH}: ${Object.keys(manifest.stations).length} guide(s) published`)
  for (const [id, entry] of Object.entries(manifest.stations)) {
    console.log(`  ${id.padStart(3)}  ${entry.file.padEnd(30)} ${entry.status.padEnd(7)} ${entry.days}d ${entry.programs}p`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.stack || error.message)
    process.exit(1)
  })
}
