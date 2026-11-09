#!/usr/bin/env node
/**
 * apply-epg-report.mjs — turn a successful conversion into a published guide.
 *
 * Discovery may fill epg_url for a new station, but the config still needs the
 * generated file name. This script only touches the ids passed with --only and
 * only enables a row when the conversion report says `ok`, the suggested file
 * exists, and its station_id matches. Everything else stays disabled for review.
 *
 * Usage:
 *   node scripts/apply-epg-report.mjs --only 152 153
 */
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseCsv, formatCsv } from '../lib/csv.js'

function parseArgs(argv) {
  const options = { config: 'config/stations.csv', report: 'data/epg-report.json', epgDir: 'public/EPGs', only: [] }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--config') options.config = argv[++index]
    else if (arg === '--report') options.report = argv[++index]
    else if (arg === '--epg-dir') options.epgDir = argv[++index]
    else if (arg === '--only') {
      while (argv[index + 1] && /^\d+$/.test(argv[index + 1])) options.only.push(Number(argv[++index]))
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/apply-epg-report.mjs --only 152 153 [--config path] [--report path] [--epg-dir path]')
      process.exit(0)
    } else {
      console.warn(`unknown argument "${arg}"`)
    }
  }
  if (options.only.length === 0) throw new Error('--only is required; this script never enables rows it was not asked to handle')
  return options
}

/**
 * Pure-ish helper used by the CLI and tests. `epgDir` is only read for existing
 * generated guides.
 * @returns {Promise<{csv: string, enabled: number[]}>}
 */
export async function applyReport({ configText, report, only, epgDir }) {
  const rows = parseCsv(configText)
  if (rows.length === 0) throw new Error('config/stations.csv is empty')
  const headers = rows[0].map((header) => header.trim())
  for (const column of ['id', 'timezone', 'epg_file', 'enabled']) {
    if (!headers.includes(column)) throw new Error(`config/stations.csv: missing column "${column}"`)
  }

  const idIndex = headers.indexOf('id')
  const timezoneIndex = headers.indexOf('timezone')
  const fileIndex = headers.indexOf('epg_file')
  const enabledIndex = headers.indexOf('enabled')
  const targets = new Set(only.map(Number))
  const reportById = new Map((report.stations || []).map((station) => [Number(station.id), station]))
  const enabled = []

  for (const row of rows.slice(1)) {
    const id = Number(row[idIndex])
    if (!targets.has(id)) continue
    // An unknown country has no timezone yet; publishing would shift every
    // programme by an unknown offset. Leave it disabled for a human.
    if (!String(row[timezoneIndex] || '').trim()) continue
    const entry = reportById.get(id)
    if (!entry || entry.status !== 'ok') continue

    const file = String(entry.suggested_epg_file || '').trim()
    if (!file) continue
    const guidePath = join(epgDir, file)
    if (!existsSync(guidePath)) throw new Error(`station ${id}: report points at missing ${guidePath}`)

    const guide = JSON.parse(await readFile(guidePath, 'utf8'))
    if (Number(guide.station_id) !== id) {
      throw new Error(`${file}: station_id ${guide.station_id} does not match config station ${id}`)
    }

    if (row[fileIndex] === file && row[enabledIndex] === 'true') continue
    row[fileIndex] = file
    row[enabledIndex] = 'true'
    enabled.push(id)
  }

  return { csv: formatCsv(rows), enabled }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const configText = await readFile(options.config, 'utf8')
  const report = JSON.parse(await readFile(options.report, 'utf8'))
  const result = await applyReport({
    configText,
    report,
    only: options.only,
    epgDir: options.epgDir,
  })

  if (result.enabled.length > 0) await writeFile(options.config, result.csv, 'utf8')
  for (const id of result.enabled) console.log(`enabled station ${id}`)
  console.log(`enabled ${result.enabled.length} station(s) from ${options.report}`)
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    console.error(error.stack || error.message)
    process.exit(1)
  })
}
