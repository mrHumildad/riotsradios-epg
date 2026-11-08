// EPG validator
// Run: node scripts/validate-epgs.js   (or `npm run validate`)
//
// Errors block CI; warnings are informational. Checks structure, clock ranges,
// duplicates, overlaps, show references, station_id ownership, timezone and
// unknown categories.

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { parseStationRows } from '../lib/csv.js'

const PUBLIC_DIR = 'public/EPGs'
const CSV_PATH = 'config/stations.csv'
const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const NON_GUIDES = new Set(['epg-schema.json', 'template.json', 'manifest.json'])

function parseTime(value) {
  if (!/^\d{2}:\d{2}$/.test(value || '')) return null
  const [hours, minutes] = value.split(':').map(Number)
  if (hours > 24 || minutes > 59) return null
  if (hours === 24 && minutes !== 0) return null
  return hours * 60 + minutes
}

async function loadStationOwners() {
  const owners = new Map()
  try {
    const rows = parseStationRows(await readFile(CSV_PATH, 'utf8'))
    for (const station of rows) {
      if (station.epg_file) owners.set(station.epg_file, station.id)
    }
  } catch {
    /* catalog problems are reported by validate-stations */
  }
  return owners
}

function validateProgram(program, shows, index, errors) {
  const start = parseTime(program.start)
  const end = parseTime(program.end)

  if (start === null) errors.push(`  [${index}] invalid start "${program.start}"`)
  if (program.end && end === null) errors.push(`  [${index}] invalid end "${program.end}"`)

  if (start !== null && end !== null) {
    if (end <= start && !program.crosses_midnight) {
      errors.push(`  [${index}] end must be after start (or set crosses_midnight)`)
    }
    if (program.crosses_midnight && end > start) {
      errors.push(`  [${index}] crosses_midnight set but end is not before start`)
    }
  }

  if (program.show_id && !Object.prototype.hasOwnProperty.call(shows, program.show_id)) {
    errors.push(`  [${index}] show_id "${program.show_id}" not found in shows`)
  }
  if (!program.show_id && (!program.title || !program.category)) {
    errors.push(`  [${index}] title and category required when no show_id`)
  }
}

async function validateFile(filePath, filename, owners) {
  console.log(`\nValidating ${filename}...`)
  const content = await readFile(filePath, 'utf8')

  let data
  try {
    data = JSON.parse(content)
  } catch (e) {
    console.error(`  ❌ JSON parse error: ${e.message}`)
    return false
  }

  const errors = []
  const warnings = []

  if (data.version !== '2.0') {
    warnings.push('version is not "2.0" (some checks skipped)')
  }

  const expectedId = owners.get(filename)
  if (expectedId !== undefined) {
    if (data.station_id === undefined) {
      warnings.push(`station_id missing; ${CSV_PATH} maps this file to station ${expectedId}`)
    } else if (Number(data.station_id) !== expectedId) {
      errors.push(`station_id ${data.station_id} does not match station ${expectedId} in ${CSV_PATH}`)
    }
  }

  if (data.timezone) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: data.timezone })
    } catch {
      errors.push(`invalid timezone "${data.timezone}"`)
    }
  } else {
    warnings.push('no timezone; the app falls back to UTC')
  }

  if (!Array.isArray(data.days)) {
    console.error('  ❌ No days array')
    return false
  }

  const shows = data.shows || {}
  const categories = data.metadata?.categories || {}

  for (const [dayIdx, day] of data.days.entries()) {
    const label = day.label || day.day
    if (!DAY_NAMES.includes(day.day)) {
      errors.push(`day ${dayIdx}: "${day.day}" is not a valid weekday name`)
    }
    if (!Array.isArray(day.programs) || day.programs.length === 0) {
      warnings.push(`day ${label}: no programs`)
      continue
    }

    const seenStarts = new Map()
    for (const [progIdx, program] of day.programs.entries()) {
      validateProgram(program, shows, progIdx, errors)

      if (program.start) {
        if (seenStarts.has(program.start)) {
          errors.push(`day ${label}: duplicate start ${program.start} (programs ${seenStarts.get(program.start)} and ${progIdx})`)
        } else {
          seenStarts.set(program.start, progIdx)
        }
      }

      const category = program.category
      if (category && Object.keys(categories).length > 0 && !categories[category]) {
        warnings.push(`day ${label}: unknown category "${category}"`)
      }
    }

    const sorted = [...day.programs]
      .map((program, index) => ({ ...program, index }))
      .sort((a, b) => (parseTime(a.start) ?? 0) - (parseTime(b.start) ?? 0))

    for (let i = 1; i < sorted.length; i++) {
      const previous = sorted[i - 1]
      const current = sorted[i]
      const previousEnd = previous.crosses_midnight
        ? 24 * 60
        : parseTime(previous.end) ?? parseTime(previous.start) ?? 0
      const currentStart = parseTime(current.start) ?? 0
      if (currentStart < previousEnd) {
        errors.push(
          `day ${label}: overlap between "${previous.title || previous.show_id}" and "${current.title || current.show_id}"`
        )
      }
    }
  }

  for (const warning of warnings) console.log(`  ℹ️  ${warning}`)
  if (errors.length > 0) {
    for (const error of errors) console.error(`  ❌ ${error}`)
    return false
  }

  console.log('  ✅ Valid')
  return true
}

async function main() {
  try {
    const owners = await loadStationOwners()
    const files = await readdir(PUBLIC_DIR)
    const jsonFiles = files.filter((f) => f.endsWith('.json') && !NON_GUIDES.has(f))

    let passed = 0
    for (const file of jsonFiles) {
      if (await validateFile(join(PUBLIC_DIR, file), file, owners)) passed++
    }

    console.log(`\n${passed}/${jsonFiles.length} files valid`)
    process.exit(passed !== jsonFiles.length ? 1 : 0)
  } catch (e) {
    console.error('Error:', e.message)
    process.exit(1)
  }
}

main()
