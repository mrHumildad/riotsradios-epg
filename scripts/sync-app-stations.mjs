#!/usr/bin/env node
/**
 * sync-app-stations.mjs — add stations that exist in the app but not in the EPG
 * catalog yet.
 *
 * The app assigns ids append-only, so the highest id already present in
 * config/stations.csv is the high-water mark. Only app stations above that mark
 * are imported; older gaps are intentional (no source, disabled, or retired) and
 * are left alone.
 *
 * Imported rows start disabled with an empty source/file. The refresh workflow
 * then runs discovery for those ids and enables them only when the converter
 * reports an `ok` guide.
 *
 * Usage:
 *   node scripts/sync-app-stations.mjs                 # dry run
 *   node scripts/sync-app-stations.mjs --write         # append new rows
 *   APP_STATIONS_URL=... node scripts/sync-app-stations.mjs --write
 */
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { parseCsv, parseStationRows, formatCsvRow } from '../lib/csv.js'

export const DEFAULT_APP_URL = 'https://raw.githubusercontent.com/mrHumildad/riotsradios/main/stations.csv'

// Same mapping used by the converter, plus the countries present in the app
// today. Unknown countries get no timezone and stay disabled for review.
export const TIMEZONES = {
  ES: 'Europe/Madrid', IT: 'Europe/Rome', FR: 'Europe/Paris', MC: 'Europe/Monaco',
  DE: 'Europe/Berlin', AT: 'Europe/Vienna', CH: 'Europe/Zurich', PT: 'Europe/Lisbon',
  GB: 'Europe/London', IE: 'Europe/Dublin', BE: 'Europe/Brussels', NL: 'Europe/Amsterdam',
  MX: 'America/Mexico_City', AR: 'America/Argentina/Buenos_Aires', CL: 'America/Santiago',
  VE: 'America/Caracas', EC: 'America/Guayaquil', CO: 'America/Bogota', PE: 'America/Lima',
  UY: 'America/Montevideo', BO: 'America/La_Paz', PY: 'America/Asuncion',
  CR: 'America/Costa_Rica', GT: 'America/Guatemala', HN: 'America/Tegucigalpa',
  NI: 'America/Managua', SV: 'America/El_Salvador', PA: 'America/Panama',
  DO: 'America/Santo_Domingo', CU: 'America/Havana', BR: 'America/Sao_Paulo',
  US: 'America/New_York', CA: 'America/Toronto', AU: 'Australia/Sydney',
  JM: 'America/Jamaica',
}

const REQUIRED_CONFIG_COLUMNS = ['id', 'name', 'countrycode', 'timezone', 'homepage', 'epg_url', 'epg_file', 'enabled', 'mailto']
const REQUIRED_APP_COLUMNS = ['id', 'name', 'homepage', 'countrycode']

function parseArgs(argv) {
  const options = {
    config: 'config/stations.csv',
    appUrl: process.env.APP_STATIONS_URL || DEFAULT_APP_URL,
    appFile: null,
    write: false,
  }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--config') options.config = argv[++index]
    else if (arg === '--app-url') options.appUrl = argv[++index]
    else if (arg === '--app-file') options.appFile = argv[++index]
    else if (arg === '--write') options.write = true
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/sync-app-stations.mjs [--config path] [--app-url url] [--app-file path] [--write]')
      process.exit(0)
    } else {
      console.warn(`unknown argument "${arg}"`)
    }
  }
  return options
}

/**
 * Pure merge used by the CLI and tests.
 * @returns {{csv: string, added: number[], unknownTimezones: string[]}}
 */
export function mergeNewStations({ configText, appCsvText, timezones = TIMEZONES }) {
  const configRows = parseCsv(configText)
  if (configRows.length === 0) throw new Error('config/stations.csv is empty')

  const headers = configRows[0].map((header) => header.trim())
  for (const column of REQUIRED_CONFIG_COLUMNS) {
    if (!headers.includes(column)) throw new Error(`config/stations.csv: missing column "${column}"`)
  }

  const appRows = parseCsv(appCsvText)
  if (appRows.length === 0) throw new Error('app catalog is empty')
  const appHeaders = appRows[0].map((header) => header.trim())
  for (const column of REQUIRED_APP_COLUMNS) {
    if (!appHeaders.includes(column)) throw new Error(`app catalog: missing column "${column}"`)
  }

  const existing = parseStationRows(configText)
  const existingIds = new Set(existing.map((row) => row.id))
  const highWaterMark = Math.max(0, ...existingIds)
  const seenAppIds = new Set()
  const additions = []
  const unknownTimezones = []

  for (const row of parseStationRows(appCsvText)) {
    if (!Number.isInteger(row.id) || row.id <= 0) {
      throw new Error(`app catalog: invalid station id "${row.id}" on line ${row._line}`)
    }
    if (seenAppIds.has(row.id)) {
      throw new Error(`app catalog: duplicate station id ${row.id} on line ${row._line}`)
    }
    seenAppIds.add(row.id)

    // Deliberately ignore ids at or below the high-water mark. Older app rows
    // may be absent from the EPG catalog because they have no usable schedule.
    if (row.id <= highWaterMark || existingIds.has(row.id)) continue

    const countrycode = String(row.countrycode || '').trim().toUpperCase()
    const timezone = timezones[countrycode] || ''
    if (!timezones[countrycode]) unknownTimezones.push(`${row.id} ${countrycode || '(no country)'}`)

    const values = Object.fromEntries(headers.map((header) => [header, '']))
    values.id = String(row.id)
    values.name = String(row.name || '').trim() || `Station ${row.id}`
    values.countrycode = countrycode
    values.timezone = timezone
    values.homepage = String(row.homepage || '').trim()
    values.epg_url = ''
    values.epg_file = ''
    values.enabled = 'false'
    values.mailto = String(row.mailto || '').trim()
    additions.push(values)
  }

  additions.sort((a, b) => Number(a.id) - Number(b.id))
  const prefix = configText.endsWith('\n') ? configText : `${configText}\n`
  const csv = additions.length
    ? `${prefix}${additions.map((row) => formatCsvRow(headers.map((header) => row[header] ?? ''))).join('\n')}\n`
    : configText

  return { csv, added: additions.map((row) => Number(row.id)), unknownTimezones }
}

async function readAppCatalog(options) {
  if (options.appFile) return readFile(options.appFile, 'utf8')
  const response = await fetch(options.appUrl, {
    headers: { 'User-Agent': 'riotsradios-epg-sync/1.0', Accept: 'text/csv,text/plain,*/*' },
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(`cannot fetch app catalog: HTTP ${response.status} from ${options.appUrl}`)
  return response.text()
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const [configText, appCsvText] = await Promise.all([
    readFile(options.config, 'utf8'),
    readAppCatalog(options),
  ])
  const result = mergeNewStations({ configText, appCsvText })

  if (options.write && result.added.length > 0) {
    await writeFile(options.config, result.csv, 'utf8')
  }

  for (const id of result.added) console.log(`new station ${id}`)
  for (const warning of result.unknownTimezones) {
    console.warn(`unknown timezone for ${warning}; row stays disabled until one is set`)
  }
  console.log(`${options.write ? 'added' : 'would add'} ${result.added.length} station(s)`)
  console.log(`added=${result.added.join(' ')}`)
  console.log(`count=${result.added.length}`)

  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `added=${result.added.join(' ')}\ncount=${result.added.length}\n`)
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    console.error(error.stack || error.message)
    process.exit(1)
  })
}
