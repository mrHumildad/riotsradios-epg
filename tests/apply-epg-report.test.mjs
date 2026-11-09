import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { applyReport } from '../scripts/apply-epg-report.mjs'
import { parseStationRows } from '../lib/csv.js'

const CONFIG = [
  'id,name,countrycode,timezone,homepage,epg_url,epg_file,enabled,mailto',
  '3,New Radio,DE,Europe/Berlin,https://new.example/,,,false,',
  '4,No Source,GB,Europe/London,https://no.example/,,,false,',
  '5,Unknown Zone,ZZ,,https://zone.example/,,,false,',
  '',
].join('\n')

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'epg-apply-'))
  const epgDir = join(root, 'EPGs')
  await mkdir(epgDir, { recursive: true })
  await writeFile(join(epgDir, 'new-radio.json'), JSON.stringify({ station_id: 3, days: [] }))
  return { root, epgDir }
}

test('enables an ok guide and leaves other new rows disabled', async () => {
  const { root, epgDir } = await fixture()
  try {
    await writeFile(join(epgDir, 'unknown.json'), JSON.stringify({ station_id: 5, days: [] }))
    const report = {
      stations: [
        { id: 3, status: 'ok', suggested_epg_file: 'new-radio.json' },
        { id: 4, status: 'partial', suggested_epg_file: 'no-source.json' },
        { id: 5, status: 'ok', suggested_epg_file: 'unknown.json' },
      ],
    }
    const result = await applyReport({ configText: CONFIG, report, only: [3, 4, 5], epgDir })
    assert.deepEqual(result.enabled, [3])

    const rows = parseStationRows(result.csv)
    assert.equal(rows.find((row) => row.id === 3).enabled, 'true')
    assert.equal(rows.find((row) => row.id === 3).epg_file, 'new-radio.json')
    assert.equal(rows.find((row) => row.id === 4).enabled, 'false')
    assert.equal(rows.find((row) => row.id === 4).epg_file, '')
    assert.equal(rows.find((row) => row.id === 5).enabled, 'false')
    assert.equal(rows.find((row) => row.id === 5).epg_file, '')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('does not touch ids outside --only', async () => {
  const { root, epgDir } = await fixture()
  try {
    const report = { stations: [{ id: 3, status: 'ok', suggested_epg_file: 'new-radio.json' }] }
    const result = await applyReport({ configText: CONFIG, report, only: [4], epgDir })
    assert.deepEqual(result.enabled, [])
    assert.equal(result.csv, CONFIG)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects a guide whose station_id does not match', async () => {
  const { root, epgDir } = await fixture()
  try {
    await writeFile(join(epgDir, 'wrong.json'), JSON.stringify({ station_id: 99, days: [] }))
    const report = { stations: [{ id: 3, status: 'ok', suggested_epg_file: 'wrong.json' }] }
    await assert.rejects(
      applyReport({ configText: CONFIG, report, only: [3], epgDir }),
      /does not match config station 3/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
