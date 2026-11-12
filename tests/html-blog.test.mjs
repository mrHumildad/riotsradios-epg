import test from 'node:test'
import assert from 'node:assert/strict'
import { dateFromArticle, parseKlassik, parseMochileros } from '../lib/html-blog.js'

test('Mochileros extracts blog cards and reads the card date', () => {
  const html = `
    <main>
      <a class="uk-panel" href="/blog/64-la-economia-del-descarte.html">
        <h3>La economía del descarte</h3>
        <time datetime="2026-04-25T13:37:36-03:00">25 Abril 2026</time>
      </a>
      <a href="/blog.html">Blog</a>
      <a href="/blog/11-medios/24-prensa.html">
        <h3>Una comunicación sin inclusión</h3>
      </a>
    </main>`

  const items = parseMochileros(html)
  assert.equal(items.length, 2)
  assert.equal(items[0].title, 'La economía del descarte')
  assert.equal(items[0].date_published, '2026-04-25T16:37:36.000Z')
  assert.equal(items[1].url, 'https://www.mochilerosradio.com/blog/11-medios/24-prensa.html')
})

test('Klassik keeps article links and drops navigation', () => {
  const html = `
    <nav><a href="/aktuelles/">Aktuelles</a></nav>
    <main>
      <a href="/aktuelles/50-jahre-augsburger-domsingknaben/">
        <h3>50 Jahre Augsburger Domsingknaben</h3>
      </a>
      <a href="/aktuelles/rolando-villazon-goldene-erbse/">
        <h3>Unser Kollege Rolando Villazón</h3>
      </a>
      <a href="/datenschutz/"><h3>Datenschutz Klassik Radio</h3></a>
    </main>`

  const items = parseKlassik(html)
  assert.equal(items.length, 2)
  assert.equal(
    items[0].url,
    'https://www.klassikradio.de/aktuelles/50-jahre-augsburger-domsingknaben/',
  )
  assert.equal(items[0].date_published, null)
})

test('article metadata supplies a date when the list has none', () => {
  const jsonLd =
    '<script type="application/ld+json">{"datePublished":"2026-10-29T14:49:12.307Z"}</script>'
  assert.equal(dateFromArticle(jsonLd), '2026-10-29T14:49:12.307Z')

  const meta =
    '<meta property="article:published_time" content="2026-11-10T09:00:00Z">'
  assert.equal(dateFromArticle(meta), '2026-11-10T09:00:00.000Z')
})
