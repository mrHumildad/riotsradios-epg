import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  assessCatalogCsv,
  catalogHeaders,
  catalogSummary,
  isPlayableStation,
} from '../lib/catalog-rules.js'
import { classifyProbe, isFailingStatus, mergeHealth } from '../lib/health.js'
import { buildCatalogFiles, isHealthSnapshot, sha256 } from '../scripts/build-catalog.mjs'

const CSV = [
  'id,name,stream_broken,has_ads,url,url_http,url_https,homepage,favicon,country,countrycode,state,tags,codec,bitrate,hls,lastcheckok,epg_file,mailto',
  '1,One,,,https://one.example/stream,,,,,,,,,,,MP3,128,0,1,one.json,',
  '2,Two,,,https://two.example/stream,,,,,,,,,,,AAC,96,0,1,,',
  '3,Three,true,,,,,,,,,,,,,,,,',
].join('\n')

const csvWith = (rows) =>
  ['id,name,stream_broken,url', ...rows.map(([id, url]) => `${id},S${id},,${url}`)].join('\n')

const HEALTH = { 1: { status: 'ok', cors: 'any', consecutive_failures: 0 } }

async function fixture({ csv = CSV, published = null, health = null } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'epg-catalog-'))
  const catalogPath = join(dir, 'stations.csv')
  const publishedPath = join(dir, 'published.csv')
  const healthFile = join(dir, health ? 'source-health.json' : 'absent-health.json')
  const healthPath = join(dir, 'published-health.json')

  await writeFile(catalogPath, csv, 'utf8')
  if (published !== null) await writeFile(publishedPath, published, 'utf8')
  if (health !== null) await writeFile(healthFile, JSON.stringify(health), 'utf8')

  return { catalogPath, publishedPath, healthFile, healthPath }
}

/* ── rules ─────────────────────────────────────────────────────── */

test('catalogHeaders reads the first line of the catalog', () => {
  assert.equal(catalogHeaders(CSV)[0], 'id')
  assert.equal(catalogHeaders(CSV).length, 19)
  assert.deepEqual(catalogHeaders(''), [])
})

test('isPlayableStation mirrors the app rules', () => {
  assert.equal(isPlayableStation({ id: 1, url: 'https://a.example/s' }), true)
  assert.equal(isPlayableStation({ id: 0, url: 'https://a.example/s' }), false)
  assert.equal(isPlayableStation({ id: 1, url: 'https://a.example/s', stream_broken: 'true' }), false)
  assert.equal(isPlayableStation({ id: 1, url: 'ftp://a.example/s' }), false)
  assert.equal(isPlayableStation({ id: 1, url: 'https://a.example/s p' }), false)
  /* http is only playable for a host the app has allowlisted. */
  assert.equal(isPlayableStation({ id: 1, url: 'http://a.example/s' }), false)
  assert.equal(
    isPlayableStation({ id: 1, url: 'http://a.example/s' }, { cleartextHosts: new Set(['a.example']) }),
    true
  )
})

test('catalogSummary counts playable rows and unique ids', () => {
  const summary = catalogSummary([
    { id: 1, url: 'https://a.example/s' },
    { id: 1, url: 'https://b.example/s' },
    { id: 2, url: 'http://c.example/s' },
  ])
  assert.deepEqual(summary, { rows: 3, playable: 1, hidden: 0, uniqueIds: 2 })
})

test('assessCatalogCsv accepts the real shape and refuses broken files', () => {
  assert.equal(assessCatalogCsv(CSV).ok, true)
  assert.equal(assessCatalogCsv('').ok, false)
  assert.equal(assessCatalogCsv('id,name\n1,One').ok, false)
  assert.equal(assessCatalogCsv(csvWith([[1, 'https://a.example/s'], [1, 'https://b.example/s']])).ok, false)
})

test('assessCatalogCsv refuses a catalog that mostly disappeared', () => {
  const current = [
    { id: 1, url: 'https://1.example/s' },
    { id: 2, url: 'https://2.example/s' },
    { id: 3, url: 'https://3.example/s' },
    { id: 4, url: 'https://4.example/s' },
    { id: 5, url: 'https://5.example/s' },
  ]
  const verdict = assessCatalogCsv(csvWith([[1, 'https://1.example/s']]), { current })
  assert.equal(verdict.ok, false)
  assert.match(verdict.errors.join(' '), /down from 5/)
})

/* ── health ────────────────────────────────────────────────────── */

test('classifyProbe names the failures the badges depend on', () => {
  assert.equal(classifyProbe({ url: 'https://a.example/s', status: 200, content_type: 'audio/mpeg', acao: '*' }).status, 'ok')
  assert.equal(classifyProbe({ url: 'https://a.example/s', status: 200, content_type: 'audio/mpeg' }).status, 'cors_missing')
  assert.equal(classifyProbe({ url: 'http://a.example/s', status: 200 }).status, 'http_only')
  assert.equal(classifyProbe({ url: 'https://a.example/s', status: 403 }).status, 'auth_required')
  assert.equal(classifyProbe({ url: 'https://a.example/s', error: 'timeout' }).status, 'timeout')
  assert.equal(isFailingStatus('ok'), false)
  assert.equal(isFailingStatus('http_5xx'), true)
})

test('mergeHealth accumulates consecutive failures and only moves last_ok_at on success', () => {
  let entry = mergeHealth(undefined, { status: 'timeout', cors: null }, new Date('2026-01-01T00:00:00Z'))
  entry = mergeHealth(entry, { status: 'timeout', cors: null }, new Date('2026-01-02T00:00:00Z'))
  assert.equal(entry.consecutive_failures, 2)
  assert.equal(entry.last_ok_at, null)

  entry = mergeHealth(entry, { status: 'ok', cors: 'any' }, new Date('2026-01-03T00:00:00Z'))
  assert.equal(entry.consecutive_failures, 0)
  assert.equal(entry.last_ok_at, '2026-01-03T00:00:00.000Z')
})

test('isHealthSnapshot rejects anything that is not id -> status', () => {
  assert.equal(isHealthSnapshot(HEALTH), true)
  assert.equal(isHealthSnapshot({}), false)
  assert.equal(isHealthSnapshot([]), false)
  assert.equal(isHealthSnapshot({ 1: { cors: 'any' } }), false)
  assert.equal(isHealthSnapshot(null), false)
})

/* ── published files ───────────────────────────────────────────── */

test('buildCatalogFiles versions the catalog by its content hash', async () => {
  const paths = await fixture()
  const { csv, manifest, health } = await buildCatalogFiles(paths)

  assert.equal(csv, CSV)
  assert.equal(manifest.version, sha256(CSV))
  assert.equal(manifest.file, 'stations.csv')
  assert.equal(manifest.rows, 3)
  assert.equal(manifest.schema, 1)
  assert.equal(manifest.health, null)
  assert.equal(health, null)
})

test('buildCatalogFiles copies the committed health snapshot', async () => {
  const paths = await fixture({ health: HEALTH })
  const { manifest, health, healthSource } = await buildCatalogFiles(paths)

  assert.equal(manifest.health, 'health.json')
  assert.deepEqual(health, HEALTH)
  assert.equal(healthSource, paths.healthFile)
})

test('a malformed health snapshot does not block the catalog', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'epg-catalog-'))
  const catalogPath = join(dir, 'stations.csv')
  const healthFile = join(dir, 'broken-health.json')
  await writeFile(catalogPath, CSV, 'utf8')
  await writeFile(healthFile, '{not json', 'utf8')

  const { manifest, health } = await buildCatalogFiles({
    catalogPath,
    publishedPath: join(dir, 'published.csv'),
    healthFile,
    healthPath: join(dir, 'absent-published-health.json'),
  })
  assert.equal(health, null)
  assert.equal(manifest.health, null)
})

test('buildCatalogFiles refuses an empty or shrinking catalog', async () => {
  const empty = await fixture({ csv: '' })
  await assert.rejects(() => buildCatalogFiles(empty), /empty/)

  const shrinking = await fixture({
    csv: csvWith([[1, 'https://1.example/s']]),
    published: csvWith([
      [1, 'https://1.example/s'], [2, 'https://2.example/s'], [3, 'https://3.example/s'],
      [4, 'https://4.example/s'], [5, 'https://5.example/s'],
    ]),
  })
  await assert.rejects(() => buildCatalogFiles(shrinking), /not publishable/)
})

test('the committed catalog and health snapshot are publishable', async () => {
  const catalogPath = new URL('../catalog/stations.csv', import.meta.url).pathname
  const healthFile = new URL('../catalog/health.json', import.meta.url).pathname
  const csv = await readFile(catalogPath, 'utf8')

  const verdict = assessCatalogCsv(csv)
  assert.deepEqual(verdict.errors, [])
  assert.ok(verdict.summary.rows > 0)

  const { manifest } = await buildCatalogFiles({
    catalogPath,
    publishedPath: '/nonexistent/stations.csv',
    healthFile,
    healthPath: '/nonexistent/health.json',
  })
  assert.equal(manifest.rows, verdict.summary.rows)
  assert.equal(manifest.version, sha256(csv))
  assert.equal(manifest.health, 'health.json')

  const snapshot = JSON.parse(await readFile(healthFile, 'utf8'))
  assert.equal(isHealthSnapshot(snapshot), true)
  for (const id of Object.keys(snapshot)) assert.ok(snapshot[id].checked_at, `station ${id} has no checked_at`)
})
