import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeNewStations } from '../scripts/sync-app-stations.mjs'
import { parseStationRows } from '../lib/csv.js'

const CONFIG = [
  'id,name,countrycode,timezone,homepage,epg_url,epg_file,enabled,mailto',
  '1,Radio Contrabanda,ES,Europe/Madrid,https://contrabanda.org/,https://contrabanda.org/programacio/,radio-contrabanda.json,true,contrabanda@contrabanda.org',
  '2,Radio Arrebato,ES,Europe/Madrid,https://radioarrebato.net/,https://radioarrebato.net/programacion/,radio-arrebato.json,true,',
  '',
].join('\n')

const APP = [
  'id,name,homepage,countrycode,mailto',
  '1,Radio Contrabanda,https://contrabanda.org/,ES,contrabanda@contrabanda.org',
  '2,Radio Arrebato,https://radioarrebato.net/,ES,',
  '3,"Nueva, Radio",https://nueva.example/,DE,hola@nueva.example',
  '4,UK Station,https://uk.example/,GB,',
  '',
].join('\n')

test('adds only ids above the existing EPG high-water mark', () => {
  const result = mergeNewStations({ configText: CONFIG, appCsvText: APP })
  assert.deepEqual(result.added, [3, 4])
  assert.deepEqual(result.unknownTimezones, [])

  const rows = parseStationRows(result.csv)
  const three = rows.find((row) => row.id === 3)
  assert.equal(three.name, 'Nueva, Radio')
  assert.equal(three.countrycode, 'DE')
  assert.equal(three.timezone, 'Europe/Berlin')
  assert.equal(three.homepage, 'https://nueva.example/')
  assert.equal(three.epg_url, '')
  assert.equal(three.epg_file, '')
  assert.equal(three.enabled, 'false')
  assert.equal(three.mailto, 'hola@nueva.example')

  const four = rows.find((row) => row.id === 4)
  assert.equal(four.timezone, 'Europe/London')
  assert.equal(four.enabled, 'false')
})

test('is idempotent and keeps existing rows untouched', () => {
  const first = mergeNewStations({ configText: CONFIG, appCsvText: APP })
  const second = mergeNewStations({ configText: first.csv, appCsvText: APP })
  assert.deepEqual(second.added, [])
  assert.equal(second.csv, first.csv)
  assert.match(first.csv, /^1,Radio Contrabanda,ES,Europe\/Madrid,https:\/\/contrabanda\.org\//m)
})

test('ignores older app ids that are not in the EPG catalog', () => {
  const highConfig = `${CONFIG.trimEnd()}\n10,Existing High,ES,Europe/Madrid,https://high.example/,,,false,\n`
  const app = [
    'id,name,homepage,countrycode,mailto',
    '9,Old Missing,https://old.example/,ES,',
    '1,Radio Contrabanda,https://contrabanda.org/,ES,',
    '2,Radio Arrebato,https://radioarrebato.net/,ES,',
    '',
  ].join('\n')
  const result = mergeNewStations({ configText: highConfig, appCsvText: app })
  assert.deepEqual(result.added, [])
})

test('leaves an unknown-country row without a timezone', () => {
  const app = [
    'id,name,homepage,countrycode,mailto',
    '1,Radio Contrabanda,https://contrabanda.org/,ES,',
    '2,Radio Arrebato,https://radioarrebato.net/,ES,',
    '7,Unknown,https://unknown.example/,ZZ,',
    '',
  ].join('\n')
  const result = mergeNewStations({ configText: CONFIG, appCsvText: app })
  assert.deepEqual(result.added, [7])
  assert.deepEqual(result.unknownTimezones, ['7 ZZ'])
  assert.equal(parseStationRows(result.csv).find((row) => row.id === 7).timezone, '')
})
