import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normaliseItems,
  normalizeDate,
  parseFeed,
  slugify,
  stripHtml,
} from '../lib/feed-parse.js'

test('RSS keeps title, absolute link and date, and resolves relative links', () => {
  const xml = `<?xml version="1.0"?>
    <rss version="2.0"><channel>
      <title>Radio Test</title>
      <item>
        <title><![CDATA[Hello &amp; welcome]]></title>
        <link>https://example.org/post-1</link>
        <guid>post-1</guid>
        <pubDate>Mon, 10 Nov 2026 09:00:00 GMT</pubDate>
      </item>
      <item>
        <title>Second post</title>
        <link>/post-2</link>
        <pubDate>Tue, 11 Nov 2026 09:00:00 GMT</pubDate>
      </item>
    </channel></rss>`

  const feed = parseFeed(xml, { url: 'https://example.org/feed/' })
  assert.equal(feed.format, 'rss')
  assert.equal(feed.title, 'Radio Test')
  assert.equal(feed.items.length, 2)
  assert.equal(feed.items[0].title, 'Hello & welcome')
  assert.equal(feed.items[1].url, 'https://example.org/post-2')
  assert.equal(feed.items[0].date_published, '2026-11-10T09:00:00.000Z')
})

test('Atom reads alternate links and entry dates', () => {
  const xml = `<?xml version="1.0"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <title>Atom Test</title>
      <entry>
        <title>Atom post</title>
        <link rel="alternate" href="https://example.org/atom-post" />
        <id>tag:example.org,2026:1</id>
        <updated>2026-11-11T10:00:00Z</updated>
      </entry>
    </feed>`

  const feed = parseFeed(xml)
  assert.equal(feed.format, 'atom')
  assert.equal(feed.items[0].url, 'https://example.org/atom-post')
  assert.equal(feed.items[0].date_published, '2026-11-11T10:00:00.000Z')
})

test('JSON Feed, WordPress REST and Blogger payloads are supported', () => {
  const jsonFeed = parseFeed(
    JSON.stringify({
      version: 'https://jsonfeed.org/version/1.1',
      title: 'JSON',
      items: [
        {
          id: '1',
          url: 'https://example.org/json',
          title: 'JSON post',
          date_published: '2026-11-09T08:00:00Z',
        },
      ],
    }),
  )
  assert.equal(jsonFeed.format, 'json-feed')
  assert.equal(jsonFeed.items[0].title, 'JSON post')

  const wp = parseFeed(
    JSON.stringify([
      {
        id: 7,
        link: 'https://example.org/wp',
        title: { rendered: 'WP &amp; post' },
        date_gmt: '2026-11-08T10:00:00',
      },
    ]),
  )
  assert.equal(wp.format, 'wp-rest')
  assert.equal(wp.items[0].title, 'WP & post')
  assert.equal(wp.items[0].date_published, '2026-11-08T10:00:00.000Z')

  const blogger = parseFeed(
    JSON.stringify({
      feed: {
        title: { $t: 'Blog' },
        entry: [
          {
            id: { $t: 'tag:example.org,2026:2' },
            published: { $t: '2026-11-07T10:00:00Z' },
            title: { $t: 'Blog post' },
            link: [{ rel: 'alternate', href: 'https://example.org/blog-post' }],
          },
        ],
      },
    }),
  )
  assert.equal(blogger.format, 'blogger')
  assert.equal(blogger.items[0].url, 'https://example.org/blog-post')
})

test('normaliseItems deduplicates by URL and keeps the newest ten', () => {
  const items = Array.from({ length: 12 }, (_, index) => ({
    id: String(index),
    url: `https://example.org/${index}`,
    title: `Post ${index}`,
    date_published: new Date(Date.UTC(2026, 10, 1 + index, 12)).toISOString(),
  }))
  items.push({
    id: 'duplicate',
    url: 'https://example.org/11',
    title: 'Duplicate',
    date_published: '2026-11-12T12:00:00Z',
  })

  const normalised = normaliseItems(items, { limit: 10 })
  assert.equal(normalised.length, 10)
  assert.equal(normalised[0].url, 'https://example.org/11')
  assert.equal(new Set(normalised.map((item) => item.url)).size, 10)
})

test('dates handle RFC 822, Spanish and German text', () => {
  assert.equal(normalizeDate('Mon, 10 Nov 2026 09:00:00 GMT'), '2026-11-10T09:00:00.000Z')
  assert.equal(normalizeDate('25 Abril 2026'), '2026-04-25T12:00:00.000Z')
  assert.equal(normalizeDate('29. Oktober 2026'), '2026-10-29T12:00:00.000Z')
  assert.equal(normalizeDate('not a date'), null)
})

test('HTML is stripped and slugs match the EPG filenames', () => {
  assert.equal(stripHtml('<p>Hello <b>world</b> &amp; all</p>'), 'Hello world & all')
  assert.equal(slugify('Alba Ciudad 96.3 FM'), 'alba-ciudad-96-3-fm')
  assert.equal(slugify('Ké Huelga Radio'), 'ke-huelga-radio')
  assert.equal(slugify('Radio Onda d’Urto'), 'radio-onda-d-urto')
})

test('plain HTML is not mistaken for a feed', () => {
  const feed = parseFeed('<html><body><h1>No feed</h1></body></html>')
  assert.equal(feed.format, null)
  assert.equal(feed.items.length, 0)
})
