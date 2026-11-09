import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parseStationRows } from '../lib/csv.js'
import { buildManifest } from '../scripts/build-manifest.mjs'

test('config has unique station ids and canonical generated files', async () => {
  const rows = parseStationRows(await readFile('config/stations.csv', 'utf8'))
  const ids = rows.map((row) => row.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.equal(rows.find((row) => row.id === 1).epg_file, 'radio-contrabanda.json')
  assert.equal(rows.find((row) => row.id === 18).epg_file, 'radio-topo.json')
  assert.equal(rows.find((row) => row.id === 3).epg_file, 'ciroma.json')
})

test('manifest publishes only usable guides with matching station_id', async () => {
  const manifest = await buildManifest()
  assert.equal(manifest.version, 1)
  assert.ok(manifest.stations['1'])
  assert.equal(manifest.stations['1'].file, 'radio-contrabanda.json')
  assert.equal(manifest.stations['18'].file, 'radio-topo.json')
  assert.equal(manifest.stations['3'].status, 'ok')
  assert.equal(manifest.stations['8'], undefined)
  assert.equal(manifest.stations['29'], undefined)
})
