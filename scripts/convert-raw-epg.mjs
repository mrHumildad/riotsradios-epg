#!/usr/bin/env node
/**
 * convert-raw-epg.mjs — raw snapshots (data/raw/<id>/) -> EPG v2 (public/EPGs/).
 *
 * This is the normalisation step of the EPG pipeline. It never touches the
 * network: it reads the snapshot written by scripts/fetch_epgs.py and the
 * station row in config/stations.csv, extracts the weekly grid, and writes one
 * EPG v2 file plus a machine-readable report.
 *
 * It is deliberately generic: radio schedules come in five very different
 * shapes (day x time tables, day tabs, one column per day, day sections and
 * "day HH:MM-HH:MM" show lists) in five languages. Several strategies run and
 * the one that resolves the most days/programmes wins; every rejection and
 * every cleanup is logged, and stations that cannot be resolved keep their old
 * guide and are reported with a diagnostic instead of being silently dropped.
 *
 * Usage (repo root):
 *   npm run convert
 *   node scripts/convert-raw-epg.mjs --only 1 18
 *   node scripts/convert-raw-epg.mjs --raw data/raw --out public/EPGs --force
 *
 * Output:
 *   public/EPGs/<station-slug>.json   EPG v2 (only for parsed stations)
 *   data/epg-report.json              per-station report + summary
 *
 * HTML only for now: PDF/image snapshots are reported as unsupported. The
 * script does not edit config/stations.csv; the report suggests the epg_file value.
 */
import { spawnSync } from 'node:child_process'
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseStationRows } from '../lib/csv.js'

const VERSION = '2.0'
const MINUTES_PER_DAY = 1440
const DEFAULT_DURATION = 60

/**
 * Station ids whose guide a dedicated scraper owns. They are skipped here so a
 * generic extraction can never overwrite that output; the scraper also writes
 * their data/epg-report.json entry.
 */
const DEDICATED_SCRAPERS = new Map([[10, 'scripts/scrape-radiopica.mjs']])

// ---------------------------------------------------------------------------
// days — multilingual aliases. Canonical names follow lib/epg.js.
// ---------------------------------------------------------------------------

const DAY_DEFS = [
  {
    day: 'monday',
    label: 'Lunes',
    aliases: ['lunes', 'dilluns', 'lunedi', 'lundi', 'monday', 'montag', 'astelehena', 'segunda-feira', 'segunda', 'lun', 'mon'],
  },
  {
    day: 'tuesday',
    label: 'Martes',
    aliases: ['martes', 'dimarts', 'martedi', 'mardi', 'tuesday', 'dienstag', 'asteartea', 'terca-feira', 'terca', 'mar', 'tue'],
  },
  {
    day: 'wednesday',
    label: 'Miércoles',
    aliases: ['miercoles', 'dimecres', 'mercoledi', 'mercredi', 'wednesday', 'mittwoch', 'asteazkena', 'quarta-feira', 'quarta', 'mie', 'mer', 'wed'],
  },
  {
    day: 'thursday',
    label: 'Jueves',
    aliases: ['jueves', 'dijous', 'giovedi', 'jeudi', 'thursday', 'donnerstag', 'osteguna', 'quinta-feira', 'quinta', 'jue', 'jeu', 'thu'],
  },
  {
    day: 'friday',
    label: 'Viernes',
    aliases: ['viernes', 'divendres', 'venerdi', 'vendredi', 'friday', 'freitag', 'ostirala', 'sexta-feira', 'sexta', 'vie', 'ven', 'fri'],
  },
  {
    day: 'saturday',
    label: 'Sábado',
    aliases: ['sabado', 'dissabte', 'sabato', 'samedi', 'saturday', 'samstag', 'larunbata', 'sab', 'sat'],
  },
  {
    day: 'sunday',
    label: 'Domingo',
    aliases: ['domingo', 'diumenge', 'domenica', 'dimanche', 'sunday', 'sonntag', 'igandea', 'dom', 'sun'],
  },
]

const DAY_INDEX = new Map(DAY_DEFS.map((entry, index) => [entry.day, index]))
const DAY_NAMES = DAY_DEFS.map((entry) => entry.day)
const DAY_BY_ALIAS = new Map()
for (const entry of DAY_DEFS) {
  for (const alias of entry.aliases) DAY_BY_ALIAS.set(fold(alias), entry.day)
}
const DAY_ALIASES = [...DAY_BY_ALIAS.keys()].sort((a, b) => b.length - a.length)

const MONTHS = [
  ['enero', 'gennaio', 'janvier', 'january', 'januar'],
  ['febrero', 'febbraio', 'fevrier', 'february', 'februar'],
  ['marzo', 'marzo', 'mars', 'march', 'marz'],
  ['abril', 'aprile', 'avril', 'april'],
  ['mayo', 'maggio', 'mai', 'may'],
  ['junio', 'giugno', 'juin', 'june', 'juni'],
  ['julio', 'luglio', 'juillet', 'july', 'juli'],
  ['agosto', 'agosto', 'aout', 'august'],
  ['septiembre', 'setiembre', 'settembre', 'septembre', 'september'],
  ['octubre', 'ottobre', 'octobre', 'october', 'oktober'],
  ['noviembre', 'novembre', 'november'],
  ['diciembre', 'dicembre', 'decembre', 'december', 'dezember'],
]

// Timezone by station country; existing guides are preferred over this table.
const COUNTRY_TZ = {
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
}
const LANGUAGE_TZ = { es: 'Europe/Madrid', it: 'Europe/Rome', fr: 'Europe/Paris', de: 'Europe/Vienna', pt: 'Europe/Lisbon', en: 'UTC' }

const CATEGORY_LABELS = {
  musica: 'Música',
  directo: 'Directo',
  podcast: 'Podcast / repetición',
  especial: 'Especial',
  taller: 'Taller / educación',
}

// ---------------------------------------------------------------------------
// tiny helpers
// ---------------------------------------------------------------------------

function fold(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2018\u2019\u201a\u201b]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .toLowerCase()
}

function escapeRe(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function cleanSpace(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

function formatMinutes(value) {
  const wrapped = ((Math.round(value) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`
}

function slugify(value) {
  return fold(value)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'show'
}

function unique(values) {
  return [...new Set(values)]
}

/** A calendar label after a weekday: "09.11.2026", "10/11", "10 de noviembre". */
const DATE_AFTER_DAY = String.raw`\s*,?\s*(?:\d{1,2}\s*[/.\-]\s*\d{1,2}(?:\s*[/.\-]\s*\d{2,4})?|\d{1,2}\s+(?:de\s+)?[a-z]{3,10}(?:\s+\d{2,4})?)`

function dayFromExact(text) {
  const value = fold(text).replace(/\s+/g, ' ').trim().replace(/[.:]+$/, '')
  if (!value) return null
  for (const alias of DAY_ALIASES) {
    if (value === alias) return DAY_BY_ALIAS.get(alias)
    // Day tabs often carry the date too: "Lun 09.11.2026", "Montag, 10.11."
    if (new RegExp(`^${escapeRe(alias)}${DATE_AFTER_DAY}$`).test(value)) return DAY_BY_ALIAS.get(alias)
  }
  return null
}

function dayFromHeading(line) {
  const value = fold(line).replace(/\s+/g, ' ').trim().replace(/[.:]+$/, '')
  const exact = dayFromExact(value)
  if (exact) return exact
  for (const alias of DAY_ALIASES) {
    if (new RegExp(`^${escapeRe(alias)}\\s*[—–-]\\s*`).test(value) && value.length <= 90) return DAY_BY_ALIAS.get(alias)
  }
  return null
}

function matchMultiDay(line) {
  const value = fold(line)
  const aliases = DAY_ALIASES.join('|')
  const match = new RegExp(`\\b(${aliases})\\b\\s*(?:a|al|au|à|to|bis|-|–)\\s*\\b(${aliases})\\b`).exec(value)
  if (!match) return null
  const from = DAY_BY_ALIAS.get(match[1])
  const to = DAY_BY_ALIAS.get(match[2])
  if (!from || !to) return null
  const start = DAY_INDEX.get(from)
  let end = DAY_INDEX.get(to)
  if (end < start) end += 7
  return Array.from({ length: end - start + 1 }, (_, offset) => DAY_NAMES[(start + offset) % 7])
}

// ---------------------------------------------------------------------------
// time parsing
// ---------------------------------------------------------------------------

function toMinutes(hours, minutes = 0, ampm = '') {
  let h = Number(hours)
  let m = Number(minutes || 0)
  if (!Number.isInteger(h) || !Number.isInteger(m) || m > 59) return null
  if (ampm) {
    const pm = /^p/i.test(ampm)
    if (h === 12) h = pm ? 12 : 0
    else if (pm) h += 12
  }
  if (h > 24 || (h === 24 && m !== 0)) return null
  return h * 60 + m
}

function normalizeTimes(text) {
  return String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/(\d{1,2})\s*([:.])\s*(\d)\s+(\d)(?!\d)/g, '$1$2$3$4') // 11: 0 0 -> 11:00
    .replace(/(\d)\s*\.\s*(\d{2})\b/g, '$1.$2')
}

const RANGE_SRC = String.raw`(?<![\d/])(\d{1,2})(?:\s*[:.h]\s*(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\s*(?:-|–|—|−|\ba\b|\bà\b|\bal\b|\bau\b|\bto\b|\bbis\b)\s*(\d{1,2})(?:\s*[:.h]\s*(\d{2}))?\s*(a\.?m\.?|p\.?m\.?|h)?(?!\d)`

function findRanges(text) {
  const source = normalizeTimes(text)
  const re = new RegExp(RANGE_SRC, 'gi')
  const out = []
  let match
  while ((match = re.exec(source))) {
    const startMin = toMinutes(match[1], match[2] || 0, match[3])
    const endMin = toMinutes(match[4], match[5] || 0, match[6] === 'h' ? '' : match[6])
    if (startMin === null || endMin === null) continue
    if (startMin >= MINUTES_PER_DAY || endMin > MINUTES_PER_DAY) continue
    out.push({ startMin, endMin, index: match.index, raw: match[0] })
  }
  return out
}

const CLOCK_SRC = String.raw`(?<![\d/])(\d{1,2})\s*[:.h]\s*(\d{2})\s*(a\.?m\.?|p\.?m\.?)?(?!\d)`

function findClocks(text) {
  const source = normalizeTimes(text)
  const re = new RegExp(CLOCK_SRC, 'gi')
  const out = []
  let match
  while ((match = re.exec(source))) {
    const value = toMinutes(match[1], match[2], match[3])
    if (value === null || value >= MINUTES_PER_DAY) continue
    out.push({ value, index: match.index, raw: match[0] })
  }
  return out
}

function extractClocks(text) {
  const values = findClocks(text).map((clock) => clock.value)
  return unique(values).sort((a, b) => a - b)
}

// ---------------------------------------------------------------------------
// title heuristics
// ---------------------------------------------------------------------------

function stripLead(value) {
  return String(value || '')
    .replace(/^\s*[|·•\-–—:>»«"'“”]+\s*/, '')
    .replace(/\s*[|·•]+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function isDayOnly(value) {
  let rest = fold(value)
  for (const alias of DAY_ALIASES) rest = rest.replace(new RegExp(`\\b${escapeRe(alias)}\\b`, 'g'), ' ')
  for (const group of MONTHS) for (const month of group) rest = rest.replace(new RegExp(`\\b${month}\\b`, 'g'), ' ')
  rest = rest.replace(/\b\d{1,4}\b/g, ' ').replace(/[/.,:;()\-–—]/g, ' ').replace(/\s+/g, ' ').trim()
  return rest === ''
}

function isTitle(value) {
  const title = stripLead(value)
  if (!title) return false
  const letters = title.replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  if (letters.length < 2 || !/\p{L}{2}/u.test(letters)) return false
  if (isDayOnly(title)) return false
  if (/^(hasta las|desde las|a las|hora|horario|horarios|hs|en vivo|directo|live|aqui|aquí)$/i.test(letters)) return false
  if (/^(se vuelve a emitir|franja|repeticiones? de|horarios de redifusion)/i.test(letters)) return false
  if (/^(proxima|próxima|next|previous|siguiente|anterior)$/i.test(letters)) return false
  if (/^(quinzomadaire|biweekly|bimensual|semanal|weekly|mensual|monthly|une semaine sur \d|ogni .* settimana|every .* week)$/i.test(letters)) return false
  if (/^(ogni|in onda ogni|every|todos los|todas las|tots els|chaque|jeden)\b/i.test(letters)) return false
  if (/^(primera|segunda|tercera|cuarta|quinta|first|second|third|fourth)\s+(y\s+\w+\s+)?(semana|week|domingo|lunes|martes|miercoles|jueves|viernes|sabado|monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i.test(letters)) return false
  return true
}

function tidyCandidate(raw) {
  const lines = String(raw || '').replace(/\u00a0/g, ' ').split('\n')
  for (let line of lines) {
    let value = stripLead(line)
    if (!value) continue
    // leading duration ("1h", "1h 30'", "30'")
    value = value.replace(/^\d+\s*h(?:\s*\d+\s*'?)?\s*[:\-–—]?\s*/i, '').replace(/^\d+\s*'\s*/, '')
    // leading recurrence markers ("1er", "2ème", "4e", "dernier")
    value = value.replace(/^(?:(?:\d+\s*(?:er|ere|e|eme|ème|º|ª|o|a))|dernier|ultimo|último|last)\b[\s·,;:\-/–—]*/gi, '')
    value = stripLead(value).split(/\s*>>\s*/)[0].replace(/\s+\S+@\S+.*$/, '')
    if (!value || !isTitle(value)) continue
    if (value.length > 140) value = value.slice(0, 140).trim()
    return value
  }
  return ''
}

function cleanTitle(raw) {
  let value = tidyCandidate(raw)
  if (!value) return ''
  value = value
    .split(/\s*>>\s*/)[0]
    .replace(/\s+\S+@\S+.*$/, '')
    .replace(/\s+https?:\/\/\S+.*$/, '')
    .replace(/\s*\((?:r|q|m|h|live|directo|redifusion|rediffusion|replica|repeticion)\)\s*$/i, '')
    .replace(/\s*\[(?:r|q|m)\]\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
  return isTitle(value) ? value : ''
}

function cutDescription(value) {
  let title = value
  const marker = title.search(/\s+(?:conduccion|conduce|presentado|presentada|programa dedicado|espacio radiofonico|una coproduccion|repeticiones|repeticion|emision|horario|animateurs|ou\?)\b/i)
  if (marker > 20) title = title.slice(0, marker)
  return title.trim()
}

// ---------------------------------------------------------------------------
// minimal HTML parser (no dependencies, tolerant of malformed markup)
// ---------------------------------------------------------------------------

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])
const RAW_TAGS = new Set(['script', 'style', 'textarea', 'title', 'noscript'])
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt', 'fieldset', 'figcaption',
  'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav',
  'ol', 'p', 'pre', 'section', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
])
const AUTO_CLOSE = {
  td: ['td', 'th'], th: ['td', 'th'], tr: ['tr', 'td', 'th'], p: ['p'], li: ['li'], option: ['option'], dt: ['dt', 'dd'], dd: ['dt', 'dd'],
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', middot: '·', bull: '•',
  deg: '°', euro: '€', times: '×', copy: '©', reg: '®', trade: '™', eacute: 'é', egrave: 'è',
  agrave: 'à', ccedil: 'ç', uacute: 'ú', oacute: 'ó', iacute: 'í', ntilde: 'ñ', aacute: 'á',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ', Ccedil: 'Ç',
}

function decodeEntities(value) {
  return String(value || '').replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]+);/gi, (whole, name) => {
    if (name[0] === '#') {
      const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try { return String.fromCodePoint(code) } catch { return whole }
      }
      return whole
    }
    return ENTITIES[name] ?? ENTITIES[name.toLowerCase()] ?? whole
  })
}

function parseAttrs(text) {
  const attrs = {}
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g
  let match
  while ((match = re.exec(text))) {
    attrs[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '')
  }
  return attrs
}

function parseHtml(html) {
  const root = { tag: '#root', attrs: {}, children: [], parent: null }
  const stack = [root]
  const top = () => stack[stack.length - 1]
  const addText = (raw, parent = top()) => {
    if (!raw) return
    parent.children.push({ type: 'text', text: decodeEntities(raw) })
  }

  let index = 0
  while (index < html.length) {
    const lt = html.indexOf('<', index)
    if (lt === -1) {
      addText(html.slice(index))
      break
    }
    if (lt > index) addText(html.slice(index, lt))

    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4)
      index = end === -1 ? html.length : end + 3
      continue
    }
    if (html.startsWith('<![CDATA[', lt)) {
      const end = html.indexOf(']]>', lt + 9)
      addText(html.slice(lt + 9, end === -1 ? html.length : end))
      index = end === -1 ? html.length : end + 3
      continue
    }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      const end = html.indexOf('>', lt)
      index = end === -1 ? html.length : end + 1
      continue
    }

    let cursor = lt + 1
    let quote = null
    for (; cursor < html.length; cursor++) {
      const char = html[cursor]
      if (quote) {
        if (char === quote) quote = null
      } else if (char === '"' || char === "'") {
        quote = char
      } else if (char === '>') {
        break
      }
    }
    if (cursor >= html.length) {
      addText(html.slice(lt))
      break
    }

    const raw = html.slice(lt + 1, cursor)
    index = cursor + 1

    if (raw[0] === '/') {
      const tag = raw.slice(1).trim().toLowerCase().split(/\s/)[0]
      for (let depth = stack.length - 1; depth > 0; depth--) {
        if (stack[depth].tag === tag) {
          stack.length = depth
          break
        }
      }
      continue
    }

    const nameMatch = /^([a-zA-Z][^\s/>]*)/.exec(raw)
    if (!nameMatch) continue
    const tag = nameMatch[1].toLowerCase()
    const selfClosing = /\/\s*$/.test(raw)
    const attrs = parseAttrs(raw.slice(nameMatch[0].length))

    if (AUTO_CLOSE[tag]) {
      while (stack.length > 1 && AUTO_CLOSE[tag].includes(top().tag)) stack.pop()
    }

    const node = { tag, attrs, children: [], parent: top() }
    top().children.push(node)

    if (VOID_TAGS.has(tag) || selfClosing) continue

    if (RAW_TAGS.has(tag)) {
      const closeRe = new RegExp(`</${tag}\\s*>`, 'i')
      const rest = html.slice(index)
      const match = closeRe.exec(rest)
      if (match) {
        addText(html.slice(index, index + match.index), node)
        index += match.index + match[0].length
      }
      continue
    }
    stack.push(node)
  }

  return root
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function plainText(node) {
  const parts = []
  const walk = (current) => {
    if (!current) return
    if (current.type === 'text') {
      parts.push(current.text)
      return
    }
    if (current.tag === 'br') {
      parts.push('\n')
      return
    }
    for (const child of current.children || []) walk(child)
  }
  walk(node)
  return parts.join('').replace(/\u00a0/g, ' ')
}

/** Text with block boundaries as newlines — keeps titles on their own lines. */
function blockText(node) {
  const parts = []
  const walk = (current) => {
    if (!current) return
    if (current.type === 'text') {
      parts.push(current.text)
      return
    }
    if (current.tag === 'br') {
      parts.push('\n')
      return
    }
    const block = BLOCK_TAGS.has(current.tag)
    if (block) parts.push('\n')
    for (const child of current.children || []) walk(child)
    if (block) parts.push('\n')
  }
  walk(node)
  return cleanSpace(parts.join(''))
}

function* descendants(node, includeSelf = false) {
  if (includeSelf && node.tag) yield node
  for (const child of node.children || []) {
    if (!child.tag) continue
    yield child
    yield* descendants(child)
  }
}

function classesOf(node) {
  return String(node?.attrs?.class || '')
}

/** Day of the tab a one-day view is showing, instead of guessing from the fetch date. */
function activeTabDay(root) {
  for (const node of descendants(root)) {
    const marker = `${classesOf(node)} ${attrsOf(node)['aria-selected'] || ''} ${attrsOf(node)['aria-current'] || ''}`
    if (!/active|selected|current|true/i.test(marker)) continue
    const text = blockText(node).replace(/\n+/g, ' ').trim()
    if (!text || text.length > 40) continue
    const day = dayFromExact(text)
    if (day) return day
  }
  return null
}

function attrsOf(node) {
  return node?.attrs || {}
}

function closest(node, predicate) {
  let current = node
  while (current && current.tag) {
    if (predicate(current)) return current
    current = current.parent
  }
  return null
}

function nextElementSibling(node) {
  if (!node?.parent) return null
  const siblings = node.parent.children
  const index = siblings.indexOf(node)
  for (let i = index + 1; i < siblings.length; i++) if (siblings[i].tag) return siblings[i]
  return null
}

function directCells(row) {
  return row.children.filter((child) => child.tag === 'td' || child.tag === 'th')
}

function tableRows(table) {
  const rows = []
  const walk = (node) => {
    for (const child of node.children || []) {
      if (!child.tag) continue
      if (child.tag === 'table') continue
      if (child.tag === 'tr') rows.push(child)
      walk(child)
    }
  }
  walk(table)
  return rows
}

// ---------------------------------------------------------------------------
// extraction: time+ranges from a text block
// ---------------------------------------------------------------------------

function isRangeStyleAfter(text, ranges) {
  if (!ranges.length) return false
  const first = ranges[0]
  const nextIndex = ranges[1]?.index ?? text.length
  const before = tidyCandidate(text.slice(0, first.index))
  const after = tidyCandidate(text.slice(first.index + first.raw.length, nextIndex))
  if (after && !before) return true
  if (after && before) {
    // "TITLE 12:00 - 12:30" keeps the title before; "12:00 - 12:30 TITLE" after.
    return isDayOnly(before) || /^[—–\-:|]/.test(text.slice(0, first.index).trim())
  }
  return false
}

function extractRangedPrograms(rawText, { maxRanges = 40 } = {}) {
  const text = cleanSpace(rawText)
  const ranges = findRanges(text)
  if (!ranges.length || ranges.length > maxRanges) return []
  const afterStyle = isRangeStyleAfter(text, ranges)
  const out = []
  for (let index = 0; index < ranges.length; index++) {
    const range = ranges[index]
    const previousEnd = index === 0 ? 0 : ranges[index - 1].index + ranges[index - 1].raw.length
    const nextStart = index + 1 < ranges.length ? ranges[index + 1].index : text.length
    let title = ''
    if (afterStyle) {
      title = tidyCandidate(text.slice(range.index + range.raw.length, nextStart))
      if (!title) title = tidyCandidate(text.slice(previousEnd, range.index))
    } else {
      title = tidyCandidate(text.slice(previousEnd, range.index))
      if (!title) title = tidyCandidate(text.slice(range.index + range.raw.length, nextStart))
    }
    title = cutDescription(title)
    if (!isTitle(title)) continue
    out.push({ startMin: range.startMin, endMin: range.endMin, title })
  }
  return out
}

function parsePipeTimes(line) {
  const text = normalizeTimes(line)
  const clocks = findClocks(text)
  if (clocks.length < 2) return []
  const between = text.slice(clocks[0].index, clocks[clocks.length - 1].index + clocks[clocks.length - 1].raw.length)
  if (!/\|/.test(between)) return []
  const tail = text.slice(clocks[clocks.length - 1].index + clocks[clocks.length - 1].raw.length).replace(/^\s*[:–—-]\s*/, '')
  const title = cutDescription(tidyCandidate(tail))
  if (!isTitle(title)) return []
  return clocks.map((clock) => ({ startMin: clock.value, endMin: Math.min(clock.value + 60, MINUTES_PER_DAY), title }))
}

function parseHourStart(line) {
  const match = new RegExp(String.raw`^(?:a\s+las\s+)?(\d{1,2})\s*h(?:s)?\s*[–—:-]\s*(.+)$`, 'i').exec(normalizeTimes(line))
  if (!match) return null
  const startMin = toMinutes(match[1], 0)
  const title = cutDescription(tidyCandidate(match[2]))
  if (startMin === null || !isTitle(title)) return null
  return { startMin, endMin: Math.min(startMin + 60, MINUTES_PER_DAY), title }
}

function parseStartLine(line) {
  const text = normalizeTimes(line)
  if (!/^\s*(?:a\s+las\s+)?\d{1,2}\s*[:.h]/i.test(text)) return null
  const clocks = findClocks(text)
  if (!clocks.length) return null
  const first = clocks[0]
  const last = clocks[clocks.length - 1]
  const tail = text.slice(last.index + last.raw.length).replace(/^\s*[:–—-]\s*/, '')
  const head = text.slice(0, first.index).replace(/[:–—\s]+$/, '')
  const title = cutDescription(tidyCandidate(tail) || tidyCandidate(head))
  if (!isTitle(title)) return null
  return { startMin: clocks[0].value, endMin: null, title }
}

const SKIP_LINE = /^(se vuelve a emitir|franja|horarios? de redifusion|repeticiones?:|programas? antiguos|archivo|menu|inicio|contacto|buscar|aceptar|rechazar|cerrar)/i

/** A line holding nothing but a clock ("07:00", "7h"): its title is on the next line. */
function parseClockOnly(line) {
  const text = normalizeTimes(line).trim()
  const match = /^(?:a\s+las\s+)?(\d{1,2})\s*[:.h]\s*(\d{2})\s*(?:hs?\.?)?$/i.exec(text)
  if (!match) return null
  const value = toMinutes(match[1], match[2])
  return value !== null && value < MINUTES_PER_DAY ? value : null
}

/**
 * Pages that write the hour as "3.0" / "5.30" / "12.0 AM" (Serenade Radio's
 * weekday pages) drop the zero minutes and often state AM/PM once or never.
 * Resolve each clock monotonically against the previous start.
 */
function hourDotClock(text) {
  const match = /^(\d{1,2})\s*\.\s*(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)?/i.exec(String(text || '').trim())
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (!Number.isInteger(hour) || hour > 24 || !Number.isInteger(minute) || minute > 59) return null
  const ampm = String(match[3] || '').toLowerCase()
  return { hour, minute, ampm: ampm ? (ampm[0] === 'p' ? 'pm' : 'am') : '', length: match[0].length }
}

function hourDotMinutes(clock, { after = null, inclusive = false } = {}) {
  const base = clock.hour % 12
  const offsets = clock.ampm === 'am' ? [0] : clock.ampm === 'pm' ? [12] : [0, 12]
  const candidates = []
  for (const offset of offsets) {
    for (const wrap of [0, MINUTES_PER_DAY]) {
      const value = (base + offset) * 60 + clock.minute + wrap
      if (value < 0 || value > MINUTES_PER_DAY) continue
      if (after === null) candidates.push(value)
      else if (inclusive ? value >= after : value > after) candidates.push(value)
    }
  }
  return candidates.length ? Math.min(...candidates) : null
}

const HOUR_DOT_SEPARATOR = /^(?:-|–|—|to\b|bis\b|a\b|à\b)\s*/i

function parseHourDotLines(lines, day) {
  const entries = []
  let previous = null
  for (let index = 0; index < lines.length; index++) {
    const line = normalizeTimes(lines[index]).trim()
    const start = hourDotClock(line)
    if (!start) continue
    const startMin = hourDotMinutes(start, { after: previous, inclusive: previous === null })
    if (startMin === null) continue
    const rest = line.slice(start.length).trim()
    const separator = HOUR_DOT_SEPARATOR.exec(rest)
    const end = separator ? hourDotClock(rest.slice(separator[0].length)) : null
    const endMin = end ? hourDotMinutes(end, { after: startMin, inclusive: true }) : null
    let title = cutDescription(tidyCandidate(rest))
    if (!isTitle(title)) {
      const next = lines.slice(index + 1).find((candidate) => String(candidate || '').trim())
      title = next ? cutDescription(tidyCandidate(next)) : ''
    }
    if (!isTitle(title)) continue
    entries.push({ day, startMin, endMin: endMin !== null && endMin > startMin ? endMin : null, title })
    previous = startMin
  }
  return entries
}

function parseLinesForDay(lines, day) {
  const whole = Array.isArray(lines) ? lines.join('\n') : String(lines || '')
  // A range and its title often live in sibling blocks ("09:00 — 10:00" then
  // the title), so try the whole section before falling back to single lines.
  const wholeRanges = extractRangedPrograms(whole)
  if (wholeRanges.length) return wholeRanges.map((entry) => ({ day, ...entry }))

  const entries = []
  let pendingStart = null
  for (const rawLine of lines) {
    const line = normalizeTimes(rawLine).trim()
    if (!line || SKIP_LINE.test(line)) continue
    const clockOnly = parseClockOnly(line)
    if (clockOnly !== null) {
      pendingStart = clockOnly
      continue
    }
    if (pendingStart !== null) {
      const title = cutDescription(tidyCandidate(line))
      if (isTitle(title)) {
        entries.push({ day, startMin: pendingStart, endMin: null, title })
        pendingStart = null
        continue
      }
      pendingStart = null
    }
    const ranges = extractRangedPrograms(line)
    if (ranges.length) {
      for (const entry of ranges) entries.push({ day, ...entry })
      continue
    }
    const piped = parsePipeTimes(line)
    if (piped.length) {
      for (const entry of piped) entries.push({ day, ...entry })
      continue
    }
    const hour = parseHourStart(line)
    if (hour) {
      entries.push({ day, ...hour })
      continue
    }
    const started = parseStartLine(line)
    if (started) entries.push({ day, ...started })
  }
  return entries
}

// ---------------------------------------------------------------------------
// strategy: tables with a day header (matrix grids)
// ---------------------------------------------------------------------------

function headerMapping(row) {
  const cells = directCells(row)
  if (cells.length < 4) return null
  const mapping = new Map()
  for (let index = 0; index < cells.length; index++) {
    const text = plainText(cells[index]).replace(/\s+/g, ' ').trim()
    if (text.length > 30) continue
    const day = dayFromExact(text)
    if (day) mapping.set(index, day)
  }
  return mapping.size >= 3 ? mapping : null
}

function rowLabelInfo(cells) {
  if (!cells.length) return { starts: [], endMin: null, explicit: false }
  const label = blockText(cells[0])
  const ranges = findRanges(label)
  const clocks = extractClocks(label)
  if (ranges.length === 1) {
    return { starts: [ranges[0].startMin], endMin: ranges[0].endMin, explicit: true }
  }
  return { starts: clocks, endMin: null, explicit: false }
}

function parseMatrixTable(table, diagnostics) {
  const rows = tableRows(table)
  if (rows.length < 3) return []
  let mapping = null
  let headerIndex = -1
  for (let index = 0; index < Math.min(rows.length, 4); index++) {
    mapping = headerMapping(rows[index])
    if (mapping) {
      headerIndex = index
      break
    }
  }
  if (!mapping) return []

  const labelCache = new Map()
  const labelFor = (rowIndex) => {
    if (!labelCache.has(rowIndex)) labelCache.set(rowIndex, rowLabelInfo(directCells(rows[rowIndex])))
    return labelCache.get(rowIndex)
  }

  const nextStartAfter = (rowIndex, value) => {
    for (let cursor = rowIndex + 1; cursor < rows.length && cursor < rowIndex + 30; cursor++) {
      const info = labelFor(cursor)
      for (const start of info.starts) {
        if (start > value) return start
      }
    }
    return Math.min(value + 60, MINUTES_PER_DAY)
  }

  const programs = []
  let lastStart = null
  for (let rowIndex = headerIndex + 1; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex]
    const nextHeader = headerMapping(row)
    if (nextHeader) {
      mapping = nextHeader
      lastStart = null
      continue
    }
    const cells = directCells(row)
    if (!cells.length) continue
    const info = labelFor(rowIndex)
    const starts = info.starts.length ? info.starts : lastStart !== null ? [lastStart] : []
    if (!starts.length) continue

    const multiple = starts.length > 1
    const rowStarts = multiple ? starts : [starts[0]]
    for (const startMin of rowStarts) {
      const endMin = info.explicit
        ? info.endMin
        : multiple
          ? Math.min(startMin + 30, MINUTES_PER_DAY)
          : nextStartAfter(rowIndex, startMin)

      for (const [column, day] of mapping) {
        const cell = cells[column]
        if (!cell) continue
        const cellText = blockText(cell)
        const compact = plainText(cell).replace(/\s+/g, ' ').trim()
        if (!compact || compact.length > 4000) continue
        const ranges = findRanges(cellText)
        if (ranges.length > 12) {
          diagnostics.push(`ignored an oversized cell (${ranges.length} time ranges) on ${day} around ${formatMinutes(startMin)}`)
          continue
        }
        if (ranges.length) {
          const parsed = extractRangedPrograms(cellText)
          if (!parsed.length) {
            diagnostics.push(`could not name a range on ${day} around ${formatMinutes(startMin)}: "${compact.slice(0, 70)}"`)
            continue
          }
          for (const entry of parsed) programs.push({ day, ...entry })
        } else {
          const title = cutDescription(tidyCandidate(cellText))
          if (!isTitle(title)) continue
          programs.push({ day, startMin, endMin, title })
        }
      }
    }
    if (info.starts.length) lastStart = info.starts[0]
  }
  return programs
}

function matrixStrategy(root, diagnostics) {
  const tables = [...descendants(root)].filter((node) => node.tag === 'table')
  let best = { programs: [], score: -1, tableIndex: -1 }
  tables.slice(0, 200).forEach((table, index) => {
    const programs = parseMatrixTable(table, diagnostics)
    if (!programs.length) return
    const score = programs.length + new Set(programs.map((entry) => entry.day)).size * 20
    if (score > best.score) best = { programs, score, tableIndex: index }
  })
  return best.programs.length ? { programs: best.programs, detail: `table #${best.tableIndex} of ${tables.length}` } : { programs: [], detail: `${tables.length} tables, none with a day header + time rows` }
}

/** Nested day columns: a 7-day header row whose cells each hold a vertical
    table of time labels + show titles (Radio Libertaire's tableau.php). */
function parseNestedDayTable(table, day) {
  const entries = []
  let currentStart = null
  for (const row of tableRows(table)) {
    const text = blockText(row)
    if (!text) continue
    const clocks = findClocks(text)
    const stripped = normalizeTimes(text).replace(/\d{1,2}\s*[:.h]\s*\d{2}/g, '').replace(/[|·•\s]/g, '')
    if (clocks.length === 1 && !stripped) {
      currentStart = clocks[0].value
      continue
    }
    const title = cutDescription(tidyCandidate(text))
    if (!isTitle(title) || currentStart === null) continue
    entries.push({ day, startMin: currentStart, endMin: null, title })
  }
  const seen = new Set()
  const uniqueStarts = new Set()
  const uniqueEntries = entries.filter((entry) => {
    const key = `${entry.startMin}|${fold(entry.title)}`
    if (seen.has(key) || uniqueStarts.has(entry.startMin)) return false
    seen.add(key)
    uniqueStarts.add(entry.startMin)
    return true
  })
  uniqueEntries.sort((a, b) => a.startMin - b.startMin)
  uniqueEntries.forEach((entry, index) => {
    const next = uniqueEntries[index + 1]
    entry.endMin = next && next.startMin > entry.startMin ? next.startMin : Math.min(entry.startMin + 30, MINUTES_PER_DAY)
  })
  return uniqueEntries
}

function nestedColumnsStrategy(root, diagnostics) {
  const tables = [...descendants(root)].filter((node) => node.tag === 'table')
  for (const table of tables) {
    const rows = tableRows(table)
    if (rows.length < 2) continue
    const mapping = headerMapping(rows[0])
    if (!mapping) continue
    for (let rowIndex = 1; rowIndex < rows.length; rowIndex++) {
      const cells = directCells(rows[rowIndex])
      const days = [...mapping.values()]
      const dayCells = [...mapping].map(([column, day]) => [day, cells[column]])
      const nestedTables = [...descendants(rows[rowIndex])].filter((node) => node.tag === 'table')
      let pairs = []
      if (nestedTables.length === days.length) {
        // The nested tables are ordered like the header columns even when the
        // vendor's markup merged the outer <td>s (Radio Libertaire).
        pairs = days.map((day, index) => [day, nestedTables[index]])
      } else if (dayCells.every(([, cell]) => cell && [...descendants(cell)].some((node) => node.tag === 'table'))) {
        pairs = dayCells.map(([day, cell]) => [day, [...descendants(cell)].find((node) => node.tag === 'table')])
      } else {
        // Some vendors close the outer table after the first day cell, leaving
        // the remaining day tables as siblings in document order
        // (Radio Libertaire). The header still describes their order.
        const headerIndex = tables.indexOf(table)
        const siblings = tables.slice(headerIndex + 1, headerIndex + 1 + days.length)
        if (siblings.length !== days.length) continue
        pairs = days.map((day, index) => [day, siblings[index]])
      }
      const programs = []
      for (const [day, nested] of pairs) programs.push(...parseNestedDayTable(nested, day))
      if (programs.length >= 10 && new Set(programs.map((entry) => entry.day)).size >= 3) {
        return { programs, detail: `nested day tables under a ${mapping.size}-day header` }
      }
    }
  }
  return { programs: [], detail: 'no nested day tables' }
}

/** Hour rail + one table per day (Radio Almaina's verticalcolumn layout). */
function hourRailStrategy(root, diagnostics) {
  for (const container of descendants(root)) {
    const children = container.children.filter((child) => child.tag)
    if (children.length < 6) continue
    const columns = children.map((child) => {
      const table = [...descendants(child, true)].find((node) => node.tag === 'table')
      if (!table) return null
      const rows = tableRows(table)
      const texts = rows.map((row) => blockText(row)).filter(Boolean)
      return { child, rows, texts }
    }).filter(Boolean)
    if (columns.length < 6) continue
    const rail = columns.find((column) => column.texts.filter((text) => /^\d{1,2}\s*h\s*\d{2}$/i.test(text.replace(/\s+/g, ' '))).length >= 10)
    if (!rail) continue
    const times = rail.texts.map((text) => {
      const match = /^(\d{1,2})\s*h\s*(\d{2})$/i.exec(text.replace(/\s+/g, ' '))
      return match ? toMinutes(match[1], match[2]) : null
    }).filter((value) => value !== null)
    if (times.length < 10) continue
    const dayColumns = columns.filter((column) => column !== rail && column.rows.length >= 5)
    if (dayColumns.length < 5) continue
    const programs = []
    dayColumns.forEach((column, index) => {
      const head = blockText(column.child).split('\n')[0] || ''
      const token = (head.match(/^\s*([a-zà-ÿ]+)/i) || [])[1] || ''
      const day = dayFromExact(token) || dayFromClass(column.child) || DAY_NAMES[index % 7]
      column.rows.forEach((row, rowIndex) => {
        const title = cutDescription(tidyCandidate(blockText(row)))
        if (!isTitle(title) || rowIndex >= times.length) return
        programs.push({ day, startMin: times[rowIndex], endMin: rowIndex + 1 < times.length ? times[rowIndex + 1] : MINUTES_PER_DAY, title })
      })
    })
    if (programs.length >= 20 && new Set(programs.map((entry) => entry.day)).size >= 5) {
      return { programs, detail: `hour rail + ${dayColumns.length} day columns` }
    }
  }
  return { programs: [], detail: 'no hour-rail column layout' }
}

// ---------------------------------------------------------------------------
// strategy: day tabs + panels
// ---------------------------------------------------------------------------

function dayFromClass(node) {
  const text = fold(`${classesOf(node)} ${attrsOf(node)['data-label'] || ''} ${attrsOf(node)['data-day'] || ''}`)
  for (const alias of DAY_ALIASES) {
    if (alias.length < 3) continue
    if (new RegExp(`(?:^|[\\s_-])${escapeRe(alias)}(?:$|[\\s_-])`).test(text)) return DAY_BY_ALIAS.get(alias)
  }
  return null
}

function tabsStrategy(root, diagnostics) {
  const labels = []
  for (const node of descendants(root)) {
    if (!['a', 'button', 'li', 'div', 'span'].includes(node.tag)) continue
    const text = plainText(node).replace(/\s+/g, ' ').trim()
    if (text.length > 30) continue
    const day = dayFromExact(text)
    if (!day) continue
    const tabish = node.tag !== 'div' || /tab|nav|cta|day|heading/i.test(classesOf(node)) || node.parent?.tag === 'ul' || node.parent?.tag === 'ol'
    if (!tabish) continue
    if (!labels.some((entry) => entry.day === day)) labels.push({ day, node })
  }
  if (labels.length < 3) return { programs: [], detail: `${labels.length} day labels` }

  const wanted = labels.length
  const candidates = []
  for (const node of descendants(root)) {
    const children = node.children.filter((child) => child.tag)
    if (children.length !== wanted) continue
    let withTimes = 0
    let total = 0
    for (const child of children) {
      const clocks = findClocks(blockText(child)).length
      if (clocks > 0) withTimes++
      total += clocks
    }
    if (withTimes >= wanted && total >= wanted * 2) candidates.push({ node, children, total })
  }
  candidates.sort((a, b) => b.total - a.total)

  for (const candidate of candidates.slice(0, 4)) {
    const programs = []
    for (let index = 0; index < wanted; index++) {
      const day = labels[index].day
      const text = blockText(candidate.children[index])
      programs.push(...parseLinesForDay(text.split('\n'), day))
    }
    if (programs.length >= wanted && new Set(programs.map((entry) => entry.day)).size >= Math.min(wanted, 4)) {
      return { programs, detail: `tab strip (${wanted} days) + ${wanted} panels, ${candidate.total} time markers` }
    }
  }
  return { programs: [], detail: `${wanted} day tabs, no matching ${wanted}-panel container` }
}

// ---------------------------------------------------------------------------
// strategy: one column per day (blocks with start times)
// ---------------------------------------------------------------------------

function columnsStrategy(root, diagnostics) {
  const columns = []
  for (const node of descendants(root)) {
    const day = dayFromClass(node) || dayFromExact(blockText(node).split('\n')[0])
    if (!day) continue
    const text = blockText(node)
    if (findClocks(text).length < 2) continue
    columns.push({ node, day })
  }
  if (columns.length < 3) return { programs: [], detail: `${columns.length} day columns` }

  const byDay = new Map()
  for (const column of columns) {
    const blocks = []
    for (const node of descendants(column.node, true)) {
      const text = plainText(node).replace(/\s+/g, ' ').trim()
      if (text.length > 200) continue
      const match = /^(\d{1,2})\s*[:.h]\s*(\d{2})\s*([A-Za-zÀ-ÿ0-9].*)$/.exec(text)
      if (!match) continue
      const startMin = toMinutes(match[1], match[2])
      const title = cutDescription(tidyCandidate(match[3]))
      if (startMin === null || !isTitle(title)) continue
      if (blocks.some((entry) => entry.startMin === startMin)) continue
      blocks.push({ day: column.day, startMin, endMin: null, title })
    }
    if (blocks.length < 2) continue
    const current = byDay.get(column.day)
    if (!current || blocks.length > current.length) byDay.set(column.day, blocks)
  }

  const programs = []
  for (const blocks of byDay.values()) {
    blocks.sort((a, b) => a.startMin - b.startMin)
    blocks.forEach((entry, index) => {
      const next = blocks[index + 1]
      entry.endMin = next ? next.startMin : Math.min(entry.startMin + 60, MINUTES_PER_DAY)
      programs.push(entry)
    })
  }
  if (programs.length < 5) return { programs: [], detail: `${byDay.size} columns but only ${programs.length} blocks` }
  return { programs, detail: `${byDay.size} day columns` }
}

// ---------------------------------------------------------------------------
// strategy: day headings + sections
// ---------------------------------------------------------------------------

function isDayMarker(node) {
  if (!node.tag) return false
  const text = plainText(node).replace(/\s+/g, ' ').trim()
  if (!text || text.length > 40) return false
  return Boolean(dayFromExact(text))
}

function containsOtherMarker(node, markerSet, self) {
  for (const child of descendants(node, true)) {
    if (child !== self && markerSet.has(child)) return true
  }
  return false
}

function sectionText(marker, markerSet) {
  let node = marker
  while (node.parent && node.parent.tag !== '#root') {
    const parent = node.parent
    if (containsOtherMarker(parent, markerSet, node)) break
    if (plainText(parent).length > 60000) break
    node = parent
  }
  if (node !== marker) return blockText(node)

  const parts = [blockText(marker)]
  let sibling = nextElementSibling(marker)
  while (sibling && !markerSet.has(sibling)) {
    parts.push(blockText(sibling))
    sibling = nextElementSibling(sibling)
  }
  return parts.join('\n')
}

function sectionsStrategy(root, diagnostics) {
  const markers = [...descendants(root)].filter(isDayMarker)
  if (!markers.length) return { programs: [], detail: 'no day headings' }
  const markerSet = new WeakSet(markers)
  const programs = []
  for (const marker of markers) {
    const day = dayFromExact(plainText(marker))
    if (!day) continue
    const text = sectionText(marker, markerSet)
    const entries = parseLinesForDay(text.split('\n'), day)
    if (entries.length) programs.push(...entries)
  }
  return programs.length
    ? { programs, detail: `${markers.length} day headings` }
    : { programs: [], detail: `${markers.length} day headings but no programmes under them` }
}

// ---------------------------------------------------------------------------
// strategy: title + "Day HH:MM - HH:MM" lines (flat show catalogues)
// ---------------------------------------------------------------------------

function dayRangeStrategy(root, diagnostics) {
  const programs = []
  const seen = new Set()
  let lastHeading = ''
  for (const node of descendants(root)) {
    if (/^h[1-6]$/.test(node.tag)) {
      const heading = cleanTitle(plainText(node))
      if (heading) lastHeading = heading
      continue
    }
    if (/^(script|style|nav|footer|header)$/.test(node.tag)) continue
    const text = plainText(node).replace(/\s+/g, ' ').trim()
    if (!text || text.length > 120) continue
    const day = dayFromExact(text.split(/\s+\d/)[0]) || dayFromExact(text.split(/\s+/)[0])
    if (!day) continue
    const ranges = findRanges(text)
    if (!ranges.length) continue
    let title = cleanTitle(lastHeading)
    if (!isTitle(title)) {
      const container = closest(node, (candidate) => /program|schedule|show|item|card|class/i.test(classesOf(candidate)))
      title = cleanTitle(container ? plainText(container) : '')
    }
    if (!isTitle(title)) continue
    for (const range of ranges) {
      const key = `${day}|${range.startMin}|${range.endMin}|${fold(title)}`
      if (seen.has(key)) continue
      seen.add(key)
      programs.push({ day, startMin: range.startMin, endMin: range.endMin, title })
    }
  }
  const days = new Set(programs.map((entry) => entry.day))
  return programs.length
    ? { programs, detail: `${programs.length} day+range lines over ${days.size} days` }
    : { programs: [], detail: 'no day+range lines' }
}

// ---------------------------------------------------------------------------
// strategy: a list of items (one day, active tab or "today" list)
// ---------------------------------------------------------------------------

/** Schedule cards that state their own days and hours: "Martes 20hs.",
    "20 a 21hs.", "Domingo de 14 a 17hs - Lunes de 21 a 24hs." (Mochileros). */
function cardTimeClauses(line) {
  const aliases = DAY_ALIASES.filter((alias) => alias.length >= 3).join('|')
  const re = new RegExp(`(?:(?:${aliases})\\b[^0-9]{0,12})?(\\d{1,2})(?:\\s*[:.]\\s*(\\d{2}))?\\s*(?:(?:a|al|hasta)\\s*(\\d{1,2})(?:\\s*[:.]\\s*(\\d{2}))?)?\\s*hs?\\b\\.?`, 'gi')
  const out = []
  let match
  while ((match = re.exec(line))) {
    const prefix = line.slice(Math.max(0, match.index - 24), match.index).toLowerCase()
    const startMin = toMinutes(match[1], match[2] || 0)
    if (startMin === null || startMin >= MINUTES_PER_DAY) continue
    let endMin = match[3] ? toMinutes(match[3], match[4] || 0) : null
    if (endMin === null) endMin = Math.min(startMin + 60, MINUTES_PER_DAY)
    let day = null
    for (const alias of DAY_ALIASES) {
      if (alias.length >= 3 && new RegExp(`\\b${escapeRe(alias)}\\b`).test(prefix)) day = DAY_BY_ALIAS.get(alias)
    }
    out.push({ startMin, endMin, day })
  }
  return out
}

function cardDayList(lines) {
  const days = []
  for (const line of lines) {
    const value = fold(line).replace(/\s+/g, ' ').trim()
    if (!value || value.length > 60) continue
    const rest = value.replace(/\b[a-z]{3,10}\b/g, (word) => (DAY_BY_ALIAS.has(word) ? ' ' : word))
    if (rest.replace(/[\s,;./&y]+/g, '')) continue
    for (const alias of DAY_ALIASES) {
      if (alias.length >= 3 && new RegExp(`\\b${escapeRe(alias)}\\b`).test(value)) days.push(DAY_BY_ALIAS.get(alias))
    }
  }
  return unique(days)
}

function showCardStrategy(root, diagnostics) {
  const cards = []
  for (const node of descendants(root)) {
    if (!['article', 'li', 'div', 'section'].includes(node.tag)) continue
    const text = blockText(node)
    if (text.length < 8 || text.length > 500) continue
    if (!/\d[^\n]{0,12}hs?\b/i.test(text)) continue
    if (/\d{1,3}[.,]\d\s*(?:mgz|mhz)/i.test(text)) continue // transmitter lists, not programmes
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
    if (lines.length < 2) continue
    if (!lines.some((line) => cardTimeClauses(line).length)) continue
    cards.push({ text, lines })
  }
  // Only the innermost card: a wrapper around several cards would mix their days.
  const leafCards = cards.filter((card) => !cards.some((other) =>
    other !== card && other.text.length < card.text.length && card.text.includes(other.text)))

  const programs = []
  const seen = new Set()
  for (const { lines } of leafCards) {
    const clauses = lines.flatMap(cardTimeClauses)
    const listedDays = cardDayList(lines)
    const titleLine = lines.find((line) => {
      if (line.length < 2 || line.length > 80) return false
      if (/^ver$/i.test(line)) return false
      if (cardTimeClauses(line).length) return false
      if (dayFromExact(line) || cardDayList([line]).length) return false
      return true
    })
    const title = titleLine || ''
    if (!title) continue
    // The same page often lists the transmitter network ("Radio Web X", "88.3 Mgz.").
    if (/^(?:radio\s*web|.*\b(?:mgz|mhz)\b)/i.test(title)) continue
    for (const clause of clauses) {
      const days = clause.day ? [clause.day] : listedDays
      for (const day of days) {
        const key = `${day}|${clause.startMin}|${fold(title)}`
        if (seen.has(key)) continue
        seen.add(key)
        programs.push({ day, startMin: clause.startMin, endMin: clause.endMin, title })
      }
    }
  }
  return programs.length
    ? { programs, detail: `${programs.length} day+hours schedule cards` }
    : { programs: [], detail: 'no day+hours schedule cards' }
}

function itemListStrategy(root, fallbackDay) {
  let best = []
  let detail = 'no item list'
  for (const node of descendants(root)) {
    const children = node.children.filter((child) => child.tag)
    if (children.length < 5 || children.length > 120) continue
    let withTimes = 0
    for (const child of children) if (findClocks(blockText(child)).length) withTimes++
    if (withTimes < Math.max(5, Math.ceil(children.length * 0.6))) continue
    const entries = []
    for (const child of children) {
      const text = blockText(child)
      const ranges = extractRangedPrograms(text)
      if (ranges.length) {
        entries.push(...ranges)
        continue
      }
      const wholeStart = parseStartLine(text)
      if (wholeStart) {
        entries.push(wholeStart)
        continue
      }
      const wholeHour = parseHourStart(text)
      if (wholeHour) {
        entries.push(wholeHour)
        continue
      }
      for (const line of text.split('\n')) {
        const piped = parsePipeTimes(line)
        if (piped.length) {
          entries.push(...piped)
          continue
        }
        const hour = parseHourStart(line)
        if (hour) {
          entries.push(hour)
          continue
        }
        const started = parseStartLine(line)
        if (started) entries.push(started)
      }
    }
    if (entries.length > best.length) {
      best = entries
      detail = `${children.length} item children`
    }
  }
  if (best.length < 5) return { programs: [], detail }
  return { programs: best.map((entry) => ({ day: fallbackDay, ...entry })), detail }
}

// ---------------------------------------------------------------------------
// strategy: linear document, split at day headings
// ---------------------------------------------------------------------------

function linearStrategy(root, diagnostics) {
  const lines = blockText(root).split('\n').map((line) => line.trim()).filter(Boolean)
  const programs = []
  let currentDay = null
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (line.length > 160) continue
    const multi = matchMultiDay(line)
    if (multi && multi.length >= 2) {
      const block = []
      let cursor = index + 1
      while (cursor < lines.length && !dayFromHeading(lines[cursor]) && !matchMultiDay(lines[cursor])) {
        block.push(lines[cursor])
        cursor++
      }
      for (const day of multi) programs.push(...parseLinesForDay(block, day))
      index = cursor - 1
      continue
    }
    const day = dayFromHeading(line)
    if (day) {
      currentDay = day
      continue
    }
    if (currentDay) programs.push(...parseLinesForDay([line], currentDay))
  }
  return {
    programs,
    detail: currentDay ? `linear text, ${new Set(programs.map((entry) => entry.day)).size} day headings` : 'linear text, no day headings',
  }
}

// ---------------------------------------------------------------------------
// strategy: one unnamed day (active tab / today's list)
// ---------------------------------------------------------------------------

function singleDayStrategy(root, fallbackDay, diagnostics) {
  const lines = blockText(root).split('\n').map((line) => line.trim()).filter(Boolean)
  const programs = []
  for (const line of lines) {
    if (line.length > 200) continue
    const ranges = extractRangedPrograms(line, { maxRanges: 3 })
    if (ranges.length) {
      for (const entry of ranges) programs.push({ day: fallbackDay, ...entry })
      continue
    }
    const piped = parsePipeTimes(line)
    if (piped.length) {
      for (const entry of piped) programs.push({ day: fallbackDay, ...entry })
      continue
    }
    const hour = parseHourStart(line)
    if (hour) {
      programs.push({ day: fallbackDay, ...hour })
      continue
    }
    const started = parseStartLine(line)
    if (started) programs.push({ day: fallbackDay, ...started })
  }
  const uniqueTitles = new Set(programs.map((entry) => fold(entry.title)))
  if (programs.length < 5 || uniqueTitles.size < 2) {
    return { programs: [], detail: `only ${programs.length} time-coded lines (${uniqueTitles.size} titles)` }
  }
  return { programs, detail: `single day assumed ${fallbackDay} (${programs.length} entries)` }
}

// ---------------------------------------------------------------------------
// finalisation: infer, dedupe, clip, build shows + days
// ---------------------------------------------------------------------------

function categorize(title) {
  const value = fold(title)
  if (/\b(repeticion|repetition|redifusion|rediffusion|replica|repliche|replay|reemision|rerun|repeat)\b/.test(value)) return 'podcast'
  if (/^(musica|music|musique|musik|continuidad|continuity|nonstop|non-stop)\b/.test(value)) return 'musica'
  if (/\b(especial|special|monografico|monographic)\b/.test(value)) return 'especial'
  return 'directo'
}

function isLiveTitle(title) {
  return /\b(en vivo|directo|directe|diretta|live|zuzenean|direct)\b/i.test(title)
}

function normalizeTitle(title) {
  return cleanSpace(title)
    .replace(/\s*\[r\]\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function gapsFor(programs) {
  const gaps = []
  let cursor = 0
  for (const program of programs) {
    if (program.startMin > cursor) {
      gaps.push({ start: formatMinutes(cursor), end: formatMinutes(program.startMin), minutes: program.startMin - cursor })
    }
    cursor = Math.max(cursor, program.endMin)
  }
  if (cursor < MINUTES_PER_DAY) gaps.push({ start: formatMinutes(cursor), end: '24:00', minutes: MINUTES_PER_DAY - cursor })
  return gaps
}

function finalizePrograms(rawPrograms) {
  const stats = {
    extracted: rawPrograms.length,
    kept: 0,
    uniqueShows: 0,
    missingTitles: 0,
    invalidTimes: 0,
    duplicates: 0,
    overlapsClipped: 0,
    gapCount: 0,
    gapMinutes: 0,
    daysWithPrograms: 0,
  }
  const warnings = []
  const dayMap = new Map()

  for (const raw of rawPrograms) {
    if (!raw || !raw.day || !DAY_INDEX.has(raw.day)) continue
    const title = normalizeTitle(raw.title)
    if (!isTitle(title)) {
      stats.missingTitles++
      continue
    }
    if (!Number.isFinite(raw.startMin)) {
      stats.invalidTimes++
      continue
    }
    if (!dayMap.has(raw.day)) dayMap.set(raw.day, [])
    dayMap.get(raw.day).push({ ...raw, title, endMin: Number.isFinite(raw.endMin) ? raw.endMin : null })
  }

  const days = []
  for (const day of DAY_NAMES) {
    const entries = dayMap.get(day)
    if (!entries || !entries.length) continue
    entries.sort((a, b) => a.startMin - b.startMin || (a.endMin ?? 0) - (b.endMin ?? 0))

    // infer missing ends from the next start (sequential broadcast lists)
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]
      if (entry.endMin !== null) continue
      const next = entries[index + 1]
      entry.endMin = next && next.startMin > entry.startMin ? next.startMin : Math.min(entry.startMin + 60, MINUTES_PER_DAY)
    }

    // duplicate starts: keep the longest, count the rest
    const byStart = new Map()
    const deduped = []
    for (const entry of entries) {
      if (entry.startMin >= MINUTES_PER_DAY) {
        stats.invalidTimes++
        continue
      }
      const previous = byStart.get(entry.startMin)
      if (previous) {
        stats.duplicates++
        warnings.push(`${day} ${formatMinutes(entry.startMin)}: duplicate start (kept "${previous.title}", dropped "${entry.title}")`)
        if ((entry.endMin ?? 0) - entry.startMin > (previous.endMin ?? 0) - previous.startMin) {
          byStart.set(entry.startMin, entry)
          const at = deduped.indexOf(previous)
          if (at !== -1) deduped[at] = entry
        }
        continue
      }
      byStart.set(entry.startMin, entry)
      deduped.push(entry)
    }

    // invalid / cross-midnight normalization
    const valid = []
    for (const entry of deduped) {
      let { startMin, endMin } = entry
      if (!Number.isFinite(endMin)) {
        stats.invalidTimes++
        continue
      }
      if (endMin > MINUTES_PER_DAY) {
        endMin -= MINUTES_PER_DAY
        entry.crosses_midnight = true
      }
      if (endMin === startMin) {
        stats.invalidTimes++
        warnings.push(`${day} ${formatMinutes(startMin)}: zero duration ("${entry.title}")`)
        continue
      }
      if (endMin < startMin) {
        const lateNight = startMin >= 18 * 60 && endMin <= 6 * 60
        if (!lateNight) {
          stats.invalidTimes++
          warnings.push(`${day} ${formatMinutes(startMin)}: end ${formatMinutes(endMin)} before start ("${entry.title}")`)
          continue
        }
        entry.crosses_midnight = true
        endMin += MINUTES_PER_DAY
      } else if (entry.crosses_midnight) {
        delete entry.crosses_midnight
      }
      entry.startMin = startMin
      entry.endMin = endMin
      valid.push(entry)
    }

    // overlap: clip the earlier programme at the next start
    const cleaned = []
    for (let index = 0; index < valid.length; index++) {
      const entry = valid[index]
      const next = valid[index + 1]
      if (next && next.startMin < entry.endMin) {
        stats.overlapsClipped++
        const clipped = next.startMin
        warnings.push(`${day} ${formatMinutes(entry.startMin)}: overlap clipped at ${formatMinutes(clipped)} ("${entry.title}")`)
        entry.endMin = clipped
        if (entry.crosses_midnight && clipped < MINUTES_PER_DAY) delete entry.crosses_midnight
      }
      if (entry.endMin === entry.startMin) {
        stats.invalidTimes++
        continue
      }
      cleaned.push(entry)
    }

    if (!cleaned.length) continue
    const gaps = gapsFor(cleaned)
    stats.gapCount += gaps.length
    stats.gapMinutes += gaps.reduce((total, gap) => total + gap.minutes, 0)
    if (gaps.length) {
      const sample = gaps.slice(0, 3).map((gap) => `${gap.start}-${gap.end}`).join(', ')
      diagnosticsGap(warnings, `${day}: ${gaps.length} gap(s), ${gaps.reduce((total, gap) => total + gap.minutes, 0)} min (${sample}${gaps.length > 3 ? ', …' : ''})`)
    }

    days.push({ day, label: DAY_DEFS.find((entry) => entry.day === day)?.label || day, programs: cleaned })
  }

  stats.daysWithPrograms = days.length
  stats.kept = days.reduce((total, day) => total + day.programs.length, 0)

  // shows catalog — one entry per unique title
  const shows = {}
  const byTitle = new Map()
  for (const day of days) {
    for (const program of day.programs) {
      const key = fold(program.title)
      let showId = byTitle.get(key)
      if (!showId) {
        showId = slugify(program.title)
        let suffix = 2
        const base = showId
        while (shows[showId]) showId = `${base}-${suffix++}`
        byTitle.set(key, showId)
        shows[showId] = { title: program.title, category: categorize(program.title) }
      }
      program.show_id = showId
      delete program.title
      if (isLiveTitle(shows[showId].title) && shows[showId].category !== 'podcast') program.live = true
      else program.live = false
    }
  }
  stats.uniqueShows = Object.keys(shows).length

  // Project the internal working shape onto the EPG v2 program shape. The app
  // only consumes wall-clock start/end, show_id, live and crosses_midnight.
  for (const day of days) {
    day.programs = day.programs.map((program) => {
      const output = {
        start: formatMinutes(program.startMin),
        end: program.crosses_midnight
          ? formatMinutes(program.endMin - MINUTES_PER_DAY)
          : program.endMin >= MINUTES_PER_DAY
            ? '24:00'
            : formatMinutes(program.endMin),
        show_id: program.show_id,
        live: Boolean(program.live),
      }
      if (program.crosses_midnight) output.crosses_midnight = true
      return output
    })
  }

  return { days, shows, stats, warnings }
}

function diagnosticsGap(warnings, message) {
  warnings.push(message)
}

// ---------------------------------------------------------------------------
// station context, timezone, existing guides
// ---------------------------------------------------------------------------

async function readExistingGuides(outDir) {
  const guides = new Map()
  if (!existsSync(outDir)) return guides
  for (const file of await readdir(outDir)) {
    if (!file.endsWith('.json') || file.includes('schema')) continue
    try {
      const data = JSON.parse(await readFile(join(outDir, file), 'utf8'))
      if (Number.isInteger(data.station_id)) guides.set(data.station_id, { timezone: data.timezone, file, generated: Boolean(data.generator) })
    } catch {
      /* malformed guides are the validator's problem, not ours */
    }
  }
  return guides
}

function timezoneFor(station, existing, diagnostics, language = 'es') {
  if (station.timezone) return station.timezone
  if (existing?.timezone) return existing.timezone
  const byCountry = COUNTRY_TZ[String(station.countrycode || '').toUpperCase()]
  if (byCountry) return byCountry
  const tz = LANGUAGE_TZ[language] || 'UTC'
  diagnostics.push(`timezone not in the catalog or an existing guide; used ${tz} (check it)`)
  return tz
}

function stationLanguage(station) {
  const code = String(station.countrycode || '').toUpperCase()
  const es = new Set(['ES', 'MX', 'AR', 'CL', 'EC', 'CO', 'VE', 'PE', 'UY', 'BO', 'PY', 'CR', 'GT', 'HN', 'NI', 'SV', 'PA', 'DO', 'CU'])
  if (es.has(code)) return 'es'
  if (code === 'IT') return 'it'
  if (['FR', 'BE', 'MC'].includes(code)) return 'fr'
  if (['DE', 'AT', 'CH'].includes(code)) return 'de'
  if (['PT', 'BR'].includes(code)) return 'pt'
  return 'en'
}

function snapshotDay(fetchedAt) {
  const date = fetchedAt ? new Date(fetchedAt) : new Date()
  const safe = Number.isNaN(date.getTime()) ? new Date() : date
  // JS getUTCDay(): 0 = Sunday; DAY_NAMES is Monday-first.
  return DAY_NAMES[(safe.getUTCDay() + 6) % 7]
}

function parseSapoClock(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim())
  if (!match) return null
  return toMinutes(match[1], match[2])
}

function sapoPrograms(payload) {
  if (!payload || !Array.isArray(payload.schedule)) return { programs: [], detail: 'no schedule[]' }
  const programs = []
  for (const dayEntry of payload.schedule) {
    const day = dayFromHeading(dayEntry?.name || '')
    if (!day) continue
    for (const program of dayEntry.programs || []) {
      const startMin = parseSapoClock(program.start_time)
      const endMin = parseSapoClock(program.end_time)
      const title = cleanTitle(program.title || '')
      if (startMin === null || !isTitle(title)) continue
      programs.push({ day, startMin, endMin, title })
    }
  }
  return { programs, detail: `${payload.schedule.length} day blocks` }
}

/** Hermes scheduler (FM La Tribu): dayOfWeek 1–7, hourStart/hourEnd as decimal hours. */
function hermesPrograms(payload) {
  const programs = []
  let skipped = 0
  for (const entry of payload) {
    const dayNumber = Number(entry?.dayOfWeek)
    const day = Number.isInteger(dayNumber) && dayNumber >= 1 && dayNumber <= 7 ? DAY_NAMES[dayNumber - 1] : null
    const startHour = Number(entry?.hourStart)
    const endHour = Number(entry?.hourEnd)
    const title = cleanTitle(entry?.activity?.name || '')
    if (!day || !Number.isFinite(startHour) || !Number.isFinite(endHour) || !isTitle(title)) {
      skipped++
      continue
    }
    const startMin = Math.round(startHour * 60)
    let endMin = Math.round(endHour * 60)
    if (startMin < 0 || startMin >= MINUTES_PER_DAY) {
      skipped++
      continue
    }
    if (endMin <= startMin) endMin += MINUTES_PER_DAY
    if (endMin > startMin + MINUTES_PER_DAY) {
      skipped++
      continue
    }
    programs.push({ day, startMin, endMin, title })
  }
  return { programs, detail: `${programs.length} entries${skipped ? `, ${skipped} skipped` : ''}` }
}

// ---------------------------------------------------------------------------
// PDF sources: word geometry from `pdftotext -bbox-layout`
// ---------------------------------------------------------------------------

const PDF_ROW_TOLERANCE = 8

function parsePdfClock(text) {
  const match = /^(\d{1,2})\s*[:.]\s*(\d{2})$/.exec(String(text || '').trim())
  if (!match) return null
  const value = toMinutes(match[1], match[2])
  return value !== null && value < MINUTES_PER_DAY ? value : null
}

function dayFromPdfBlock(text) {
  const token = fold(text).replace(/[^a-z]/g, '')
  if (!token || token.length > 12) return null
  return DAY_BY_ALIAS.get(token) || null
}

/** `pdftotext -bbox-layout` gives one <block> per schedule cell: title + x/y. */
function pdfLayoutBlocks(path) {
  const run = spawnSync('pdftotext', ['-bbox-layout', path, '-'], { encoding: 'utf8', maxBuffer: 40_000_000 })
  if (run.error) return { blocks: [], error: `pdftotext is not available (${run.error.code}); install poppler-utils` }
  if (run.status !== 0) return { blocks: [], error: `pdftotext failed: ${String(run.stderr || '').trim().slice(0, 120)}` }
  const dom = parseHtml(run.stdout || '')
  const blocks = []
  for (const node of descendants(dom)) {
    if (node.tag !== 'block') continue
    const text = plainText(node).replace(/\s+/g, ' ').trim()
    if (!text) continue
    const xMin = Number(node.attrs.xmin)
    const xMax = Number(node.attrs.xmax)
    const yMin = Number(node.attrs.ymin)
    if (!Number.isFinite(xMin) || !Number.isFinite(xMax) || !Number.isFinite(yMin)) continue
    blocks.push({ text, xMin, xMax, xCenter: (xMin + xMax) / 2, yMin })
  }
  return { blocks, error: null }
}

/** Map positioned blocks to a weekly grid: x picks the day, the nearest row above picks the time. */
function pdfProgramsFromBlocks(blocks) {
  if (!Array.isArray(blocks) || !blocks.length) return { programs: [], detail: 'no text blocks' }

  // The header is the row with the most weekday names (ignores a show called "Sabato").
  const headerRows = []
  for (const block of blocks) {
    const day = dayFromPdfBlock(block.text)
    if (!day) continue
    let row = headerRows.find((entry) => Math.abs(entry.yMin - block.yMin) <= 6)
    if (!row) headerRows.push((row = { yMin: block.yMin, days: new Map() }))
    if (!row.days.has(day)) row.days.set(day, block.xCenter)
  }
  headerRows.sort((a, b) => b.days.size - a.days.size)
  const header = headerRows[0]
  if (!header || header.days.size < 3) return { programs: [], detail: `${header ? header.days.size : 0} day headers` }

  const columns = [...header.days.entries()]
    .map(([day, xCenter]) => ({ day, xCenter }))
    .sort((a, b) => a.xCenter - b.xCenter)
  const centers = columns.map((column) => column.xCenter)
  const gaps = centers.slice(1).map((center, index) => center - centers[index])
  const spacing = gaps.length ? gaps.reduce((total, gap) => total + gap, 0) / gaps.length : 100

  const times = blocks
    .map((block) => ({ ...block, startMin: parsePdfClock(block.text) }))
    .filter((block) => block.startMin !== null && block.xCenter < centers[0] - spacing * 0.35)
    .sort((a, b) => a.yMin - b.yMin)
  if (times.length < 3) return { programs: [], detail: `${times.length} time labels` }
  // Text below the last time row is a legend/footer, not a programme.
  const gridBottom = times[times.length - 1].yMin + PDF_ROW_TOLERANCE * 2

  const byKey = new Map()
  for (const block of blocks) {
    if (block.yMin > gridBottom) continue
    if (dayFromPdfBlock(block.text) || parsePdfClock(block.text) !== null) continue
    let column = null
    let distance = Infinity
    for (const candidate of columns) {
      const current = Math.abs(block.xCenter - candidate.xCenter)
      if (current < distance) {
        distance = current
        column = candidate
      }
    }
    if (!column || distance > spacing * 0.7) continue
    const slot = times.filter((time) => time.yMin <= block.yMin + PDF_ROW_TOLERANCE).pop()
    if (!slot) continue
    const title = cutDescription(tidyCandidate(block.text))
    if (!isTitle(title)) continue
    const key = `${column.day}|${slot.startMin}`
    const previous = byKey.get(key)
    if (!previous || title.length > previous.title.length) {
      byKey.set(key, { day: column.day, startMin: slot.startMin, endMin: null, title })
    }
  }

  const programs = [...byKey.values()].sort((a, b) => DAY_INDEX.get(a.day) - DAY_INDEX.get(b.day) || a.startMin - b.startMin)
  for (const program of programs) {
    const next = programs.find((entry) => entry.day === program.day && entry.startMin > program.startMin)
    program.endMin = next ? next.startMin : Math.min(program.startMin + 30, MINUTES_PER_DAY)
  }
  return {
    programs,
    detail: `${columns.length} day columns, ${times.length} time rows, ${programs.length} programmes`,
  }
}

/** Pick the JSON adapter by payload shape rather than by station id. */
function jsonSchedule(payload) {
  if (Array.isArray(payload)) {
    if (payload.some((entry) => entry && typeof entry === 'object' && 'dayOfWeek' in entry)) {
      return { adapter: 'hermes', ...hermesPrograms(payload) }
    }
    return { adapter: null, programs: [], detail: 'unrecognised JSON array' }
  }
  if (payload && Array.isArray(payload.schedule)) return { adapter: 'sapo', ...sapoPrograms(payload) }
  return { adapter: null, programs: [], detail: 'unrecognised JSON object' }
}

// ---------------------------------------------------------------------------
// strategy: weekly grid embedded in a JSON payload (Next.js / headless CMS)
// ---------------------------------------------------------------------------

const DAY_COLLECTION_KEYS = new Map()
for (const entry of DAY_DEFS) {
  DAY_COLLECTION_KEYS.set(entry.day, entry.day)
  DAY_COLLECTION_KEYS.set(`${entry.day}collection`, entry.day)
}

function embeddedSchedulePayloads(html) {
  const payloads = []
  const re = /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/gi
  let match
  while ((match = re.exec(String(html || '')))) {
    try {
      payloads.push(JSON.parse(match[1]))
    } catch {
      /* a malformed payload is not a schedule */
    }
  }
  return payloads
}

/** Collect every object that carries a monday…sunday collection of items. */
function collectDayCollections(node, found = [], seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return found
  seen.add(node)
  if (Array.isArray(node)) {
    for (const value of node) collectDayCollections(value, found, seen)
    return found
  }
  const byDay = new Map()
  for (const [key, value] of Object.entries(node)) {
    const day = DAY_COLLECTION_KEYS.get(key.toLowerCase())
    if (!day) continue
    if (value && Array.isArray(value.items)) byDay.set(day, value.items)
    else if (Array.isArray(value)) byDay.set(day, value)
  }
  if (byDay.size >= 3) found.push(byDay)
  for (const value of Object.values(node)) collectDayCollections(value, found, seen)
  return found
}

function embeddedTitle(item) {
  const candidates = [item?.title, item?.headline]
  for (const raw of candidates) {
    const value = cleanSpace(String(raw || '').replace(/\s+/g, ' '))
      .replace(/^\s*(?:neu|new|nuevo|nouveau|nuovo)\s+/i, '')
      .replace(/\s*[-–—]?\s*\d{1,2}\s*[:.]\s*\d{2}\s*(?:uhr)?\s*(?:-|–|—|bis|to)\s*\d{1,2}\s*[:.]\s*\d{2}\s*(?:uhr)?\s*$/i, '')
      .trim()
    if (isTitle(value)) return value
  }
  return ''
}

function embeddedSchedulePrograms(html) {
  const payloads = embeddedSchedulePayloads(html)
  if (!payloads.length) return { programs: [], detail: 'no __NEXT_DATA__ payload' }
  const collections = payloads.flatMap((payload) => collectDayCollections(payload))
  if (!collections.length) return { programs: [], detail: `${payloads.length} JSON payload(s), no day collections` }
  const programs = []
  const seen = new Set()
  for (const collection of collections) {
    for (const [day, items] of collection) {
      for (const item of items) {
        if (!item || typeof item !== 'object') continue
        const startMin = findClocks(String(item.timeFrom || ''))[0]?.value
        const endMin = findClocks(String(item.timeTo || ''))[0]?.value
        const title = embeddedTitle(item)
        if (startMin === undefined || !title) continue
        const key = `${day}|${startMin}|${fold(title)}`
        if (seen.has(key)) continue
        seen.add(key)
        programs.push({ day, startMin, endMin: endMin !== undefined && endMin > startMin ? endMin : null, title })
      }
    }
  }
  return { programs, detail: `${collections.length} day collection(s)` }
}

async function convertJsonStation(id, station, outDir, meta, buffer, report, guides, options) {
  let payload
  try {
    payload = JSON.parse(buffer.toString('utf8'))
  } catch (error) {
    report.errors.push(`unreadable JSON snapshot: ${error.message}`)
    return report
  }
  const { adapter, programs, detail } = jsonSchedule(payload)
  report.format = 'json-api'
  report.strategy = adapter ? `${adapter}-json` : 'json'
  report.diagnostics.push(`${adapter || 'unknown'} schedule: ${programs.length} programmes — ${detail}`)
  if (!programs.length) {
    report.errors.push('no weekly schedule could be extracted from the SAPO schedule')
    return report
  }

  const finalized = finalizePrograms(programs)
  report.stats = finalized.stats
  report.warnings.push(...finalized.warnings.slice(0, 80))
  if (finalized.warnings.length > 80) report.warnings.push(`… ${finalized.warnings.length - 80} more warning(s) in this station`)
  if (!finalized.days.length || finalized.stats.kept < 3) {
    report.status = 'failed'
    report.errors.push(`extraction produced only ${finalized.stats.kept} usable programme(s)`)
    return report
  }

  const existing = guides.get(Number(id))
  const timezoneDiagnostics = []
  const timezone = timezoneFor(station || {}, existing, timezoneDiagnostics, 'es')
  report.diagnostics.push(...timezoneDiagnostics)

  // The catalog owns the published name; fall back to a slug for ad-hoc snapshots.
  const fileName = station?.epg_file || `${slugify(station?.name || meta.name || `station-${id}`)}.json`
  if (existsSync(join(outDir, fileName))) {
    try {
      const current = JSON.parse(await readFile(join(outDir, fileName), 'utf8'))
      if (!current.generator && !options.force) {
        report.status = 'skipped'
        report.file = null
        report.suggested_epg_file = fileName
        report.errors.push(`refusing to overwrite the curated guide ${fileName} (use --force)`)
        return report
      }
    } catch {
      /* unreadable target: overwrite is safe */
    }
  }

  const epg = {
    version: VERSION,
    station: station?.name || meta.name || `Station ${id}`,
    station_id: Number(id),
    schedule_type: 'weekly',
    timezone,
    last_updated: String(meta.fetched_at || new Date().toISOString()).slice(0, 10),
    source: report.source || undefined,
    contact: station?.mailto || undefined,
    notes: `Generado automáticamente desde ${report.source || 'la fuente'} (snapshot ${String(meta.fetched_at || '').slice(0, 10)}); revisar data/epg-report.json.`,
    generator: 'scripts/convert-raw-epg.mjs',
    metadata: {
      categories: CATEGORY_LABELS,
      default_filler: { title: 'Música', category: 'musica' },
    },
    shows: finalized.shows,
    days: finalized.days,
  }
  if (!epg.contact) delete epg.contact

  await mkdir(outDir, { recursive: true })
  await writeFile(join(outDir, fileName), `${JSON.stringify(epg, null, 2)}\n`, 'utf8')

  report.file = fileName
  report.suggested_epg_file = fileName
  report.confidence = Math.max(
    0.1,
    Math.min(
      0.98,
      0.15 + finalized.stats.daysWithPrograms * 0.1 + Math.min(finalized.stats.kept / 60, 0.4) - (finalized.stats.missingTitles + finalized.stats.invalidTimes > 10 ? 0.1 : 0)
    )
  )

  const dayNames = new Set(finalized.days.map((day) => day.day))
  const missingDays = DAY_NAMES.filter((day) => !dayNames.has(day))
  if (missingDays.length) report.warnings.push(`no programmes extracted for: ${missingDays.join(', ')}`)
  if (finalized.stats.daysWithPrograms === 1) report.warnings.push('only one day extracted (the source may show only the active day)')

  report.status = finalized.stats.daysWithPrograms >= 3 && finalized.stats.kept >= 8 && finalized.stats.missingTitles + finalized.stats.invalidTimes <= 5
    ? 'ok'
    : 'partial'
  if (report.status === 'partial') report.warnings.push('partial extraction: review the strategy diagnostics before publishing this guide')
  return report
}

/**
 * Schedule images are read with OCR.space's table engine. Local Tesseract was
 * measured on the same grids and could not separate the day columns reliably;
 * the table engine returns one tab-separated line per visual row, which keeps
 * the weekday header and the clock column aligned.
 */
async function ocrSpaceText(buffer, meta, apiKey) {
  const ext = String(meta.ext || 'jpg').toLowerCase()
  const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[ext] || 'image/jpeg'
  const form = new FormData()
  form.append('apikey', apiKey)
  form.append('language', 'spa')
  form.append('isTable', 'true')
  form.append('scale', 'true')
  form.append('OCREngine', '2')
  form.append('file', new Blob([buffer], { type: mime }), `schedule.${ext}`)
  const response = await fetch('https://api.ocr.space/parse/image', {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status} from OCR.space`)
  const payload = await response.json()
  const message = Array.isArray(payload.ErrorMessage) ? payload.ErrorMessage.join('; ') : payload.ErrorMessage
  if (payload.IsErroredOnProcessing || message) throw new Error(message || 'OCR.space rejected the image')
  const text = (payload.ParsedResults || []).map((result) => result.ParsedText || '').join('\n').trim()
  if (!text) throw new Error('OCR.space returned no text')
  return text
}

function ocrClockMinutes(text) {
  const match = /(\d{1,2})\s*[:.]\s*(\d{2})/.exec(String(text || ''))
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : null
}

function cleanOcrTitle(text) {
  return String(text || '')
    .replace(/^[\s|[\]]+|[\s|[\]]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function ocrTablePrograms(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.split('\t').map((cell) => cell.trim()))

  let header = null
  lines.forEach((cells, index) => {
    const days = []
    cells.forEach((cell, cellIndex) => {
      const day = dayFromExact(cell)
      if (day && !days.some((entry) => entry.day === day)) days.push({ day, index: cellIndex })
    })
    if (days.length >= 3 && (!header || days.length > header.days.length)) header = { days, index }
  })
  if (!header) return { programs: [], detail: 'no weekday header row' }

  const shift = header.days[0].index === 0 ? 1 : 0
  const dayAt = (index) => header.days.find((entry) => entry.index === index - shift)?.day || null
  const rows = []
  let current = null
  let skipped = 0

  for (const cells of lines.slice(header.index + 1)) {
    const startMin = ocrClockMinutes(cells[0])
    if (startMin !== null) {
      current = { startMin, cells: new Map() }
      rows.push(current)
    }
    if (!current) continue

    const titles = []
    cells.forEach((cell, index) => {
      const day = dayAt(index)
      const title = cleanOcrTitle(cell)
      if (!day || !title) return
      if (ocrClockMinutes(title) !== null || dayFromExact(title)) return
      if (title.replace(/[^a-z0-9]/gi, '').length < 2) return
      titles.push({ day, title })
    })

    if (startMin === null) {
      // A wrapped title line sits between two clock rows. Only merge it when
      // OCR kept several columns; a lone fragment has lost its column.
      if (titles.length < 2) {
        if (titles.length) skipped += 1
        continue
      }
      for (const { day, title } of titles) {
        const previous = current.cells.get(day)
        if (previous) current.cells.set(day, `${previous} ${title}`)
      }
      continue
    }

    for (const { day, title } of titles) {
      const previous = current.cells.get(day)
      if (previous !== title) current.cells.set(day, previous ? `${previous} ${title}` : title)
    }
  }

  const seen = new Set()
  const programs = []
  for (const row of rows) {
    for (const [day, title] of row.cells) {
      const key = `${day}|${row.startMin}|${title}`
      if (seen.has(key)) continue
      seen.add(key)
      programs.push({ day, startMin: row.startMin, title })
    }
  }
  const detail = `${header.days.length} days, ${rows.length} time rows, ${programs.length} cells${skipped ? `, ${skipped} wrapped line(s) skipped` : ''}`
  return { programs, detail }
}

async function convertImageStation(id, station, outDir, meta, buffer, report, guides, options) {
  report.format = 'image'
  report.strategy = 'ocr-table'
  const apiKey = process.env.OCR_SPACE_API_KEY || 'helloworld'
  if (!process.env.OCR_SPACE_API_KEY) report.warnings.push('OCR_SPACE_API_KEY is not set; using the rate-limited OCR.space demo key')

  let text
  try {
    text = await ocrSpaceText(buffer, meta, apiKey)
  } catch (error) {
    report.errors.push(`OCR failed: ${error.message}`)
    return report
  }

  const { programs, detail } = ocrTablePrograms(text)
  report.diagnostics.push(`OCR.space table: ${programs.length} programmes — ${detail}`)
  if (!programs.length) {
    report.errors.push('no weekly grid could be read from the schedule image')
    return report
  }

  const finalized = finalizePrograms(programs)
  report.stats = finalized.stats
  report.warnings.push(...finalized.warnings.slice(0, 80))
  if (finalized.warnings.length > 80) report.warnings.push(`… ${finalized.warnings.length - 80} more warning(s) in this station`)
  if (!finalized.days.length || finalized.stats.kept < 3) {
    report.status = 'failed'
    report.errors.push(`extraction produced only ${finalized.stats.kept} usable programme(s)`)
    return report
  }

  const existing = guides.get(Number(id))
  const timezoneDiagnostics = []
  const timezone = timezoneFor(station || {}, existing, timezoneDiagnostics, 'es')
  report.diagnostics.push(...timezoneDiagnostics)

  // The catalog owns the published name; fall back to a slug for ad-hoc snapshots.
  const fileName = station?.epg_file || `${slugify(station?.name || meta.name || `station-${id}`)}.json`
  if (existsSync(join(outDir, fileName))) {
    try {
      const current = JSON.parse(await readFile(join(outDir, fileName), 'utf8'))
      if (!current.generator && !options.force) {
        report.status = 'skipped'
        report.file = null
        report.suggested_epg_file = fileName
        report.errors.push(`refusing to overwrite the curated guide ${fileName} (use --force)`)
        return report
      }
    } catch {
      /* unreadable target: overwrite is safe */
    }
  }

  const epg = {
    version: VERSION,
    station: station?.name || meta.name || `Station ${id}`,
    station_id: Number(id),
    schedule_type: 'weekly',
    timezone,
    last_updated: String(meta.fetched_at || new Date().toISOString()).slice(0, 10),
    source: report.source || undefined,
    contact: station?.mailto || undefined,
    notes: `Generado automáticamente desde ${report.source || 'la fuente'} (snapshot ${String(meta.fetched_at || '').slice(0, 10)}); revisar data/epg-report.json.`,
    generator: 'scripts/convert-raw-epg.mjs',
    metadata: {
      categories: CATEGORY_LABELS,
      default_filler: { title: 'Música', category: 'musica' },
    },
    shows: finalized.shows,
    days: finalized.days,
  }
  if (!epg.contact) delete epg.contact

  await mkdir(outDir, { recursive: true })
  await writeFile(join(outDir, fileName), `${JSON.stringify(epg, null, 2)}\n`, 'utf8')

  report.file = fileName
  report.suggested_epg_file = fileName
  report.confidence = Math.max(
    0.1,
    Math.min(
      0.98,
      0.15 + finalized.stats.daysWithPrograms * 0.1 + Math.min(finalized.stats.kept / 60, 0.4) - (finalized.stats.missingTitles + finalized.stats.invalidTimes > 10 ? 0.1 : 0)
    )
  )

  const dayNames = new Set(finalized.days.map((day) => day.day))
  const missingDays = DAY_NAMES.filter((day) => !dayNames.has(day))
  if (missingDays.length) report.warnings.push(`no programmes extracted for: ${missingDays.join(', ')}`)
  if (finalized.stats.daysWithPrograms === 1) report.warnings.push('only one day extracted (the source may show only the active day)')

  report.status = finalized.stats.daysWithPrograms >= 3 && finalized.stats.kept >= 8 && finalized.stats.missingTitles + finalized.stats.invalidTimes <= 5
    ? 'ok'
    : 'partial'
  if (report.status === 'partial') report.warnings.push('partial extraction: review the strategy diagnostics before publishing this guide')
  return report
}

async function convertPdfStation(id, station, outDir, meta, snapshotPath, report, guides, options) {
  report.format = 'pdf'
  report.strategy = 'pdf-text'
  const { blocks, error } = pdfLayoutBlocks(snapshotPath)
  if (error) {
    report.errors.push(error)
    return report
  }
  report.diagnostics.push(`pdf: ${blocks.length} text blocks`)
  if (blocks.length < 10) {
    report.errors.push('the PDF has no usable text layer; it needs OCR (see data/epg_manual.json)')
    return report
  }
  const { programs, detail } = pdfProgramsFromBlocks(blocks)
  report.diagnostics.push(`pdf grid: ${detail}`)
  if (!programs.length) {
    report.errors.push('no weekly grid could be read from the PDF text layer')
    return report
  }

  const finalized = finalizePrograms(programs)
  report.stats = finalized.stats
  report.warnings.push(...finalized.warnings.slice(0, 80))
  if (finalized.warnings.length > 80) report.warnings.push(`… ${finalized.warnings.length - 80} more warning(s) in this station`)
  if (!finalized.days.length || finalized.stats.kept < 3) {
    report.status = 'failed'
    report.errors.push(`extraction produced only ${finalized.stats.kept} usable programme(s)`)
    return report
  }

  const language = stationLanguage(station || {})
  const existing = guides.get(Number(id))
  const timezoneDiagnostics = []
  const timezone = timezoneFor(station || {}, existing, timezoneDiagnostics, language)
  report.diagnostics.push(...timezoneDiagnostics)

  // The catalog owns the published name; fall back to a slug for ad-hoc snapshots.
  const fileName = station?.epg_file || `${slugify(station?.name || meta.name || `station-${id}`)}.json`
  if (existsSync(join(outDir, fileName))) {
    try {
      const current = JSON.parse(await readFile(join(outDir, fileName), 'utf8'))
      if (!current.generator && !options.force) {
        report.status = 'skipped'
        report.file = null
        report.suggested_epg_file = fileName
        report.errors.push(`refusing to overwrite the curated guide ${fileName} (use --force)`)
        return report
      }
    } catch {
      /* unreadable target: overwrite is safe */
    }
  }

  const epg = {
    version: VERSION,
    station: station?.name || meta.name || `Station ${id}`,
    station_id: Number(id),
    schedule_type: 'weekly',
    timezone,
    last_updated: String(meta.fetched_at || new Date().toISOString()).slice(0, 10),
    source: report.source || undefined,
    contact: station?.mailto || undefined,
    notes: `Generado automáticamente desde ${report.source || 'la fuente'} (snapshot ${String(meta.fetched_at || '').slice(0, 10)}); revisar data/epg-report.json.`,
    generator: 'scripts/convert-raw-epg.mjs',
    metadata: {
      categories: CATEGORY_LABELS,
      default_filler: { title: 'Música', category: 'musica' },
    },
    shows: finalized.shows,
    days: finalized.days,
  }
  if (!epg.contact) delete epg.contact

  await mkdir(outDir, { recursive: true })
  await writeFile(join(outDir, fileName), `${JSON.stringify(epg, null, 2)}\n`, 'utf8')

  report.file = fileName
  report.suggested_epg_file = fileName
  report.confidence = Math.max(
    0.1,
    Math.min(
      0.98,
      0.15 + finalized.stats.daysWithPrograms * 0.1 + Math.min(finalized.stats.kept / 60, 0.4) - (finalized.stats.missingTitles + finalized.stats.invalidTimes > 10 ? 0.1 : 0)
    )
  )

  const dayNames = new Set(finalized.days.map((day) => day.day))
  const missingDays = DAY_NAMES.filter((day) => !dayNames.has(day))
  if (missingDays.length) report.warnings.push(`no programmes extracted for: ${missingDays.join(', ')}`)
  if (finalized.stats.daysWithPrograms === 1) report.warnings.push('only one day extracted (the source may show only the active day)')

  report.status = finalized.stats.daysWithPrograms >= 3 && finalized.stats.kept >= 8 && finalized.stats.missingTitles + finalized.stats.invalidTimes <= 5
    ? 'ok'
    : 'partial'
  if (report.status === 'partial') report.warnings.push('partial extraction: review the strategy diagnostics before publishing this guide')
  return report
}

async function readDayPagePrograms(dir, diagnostics) {
  const daysDir = join(dir, 'days')
  if (!existsSync(daysDir)) return { programs: [], detail: 'no days/ folder' }
  const files = (await readdir(daysDir)).filter((file) => /\.html?$/i.test(file))
  const programs = []
  let pages = 0
  for (const file of files) {
    const day = file.replace(/\.[^.]+$/, '').toLowerCase()
    if (!DAY_INDEX.has(day)) continue
    pages++
    const { html } = decodeSnapshot(await readFile(join(daysDir, file)))
    const dom = parseHtml(html)
    const lines = blockText(dom).split('\n').map((line) => line.trim()).filter(Boolean)
    const stop = lines.findIndex((line) => /^(articoli correlati|altro dall'autore|ascolta la diretta|iscriviti alla newsletter|related articles)\b/i.test(line))
    const bodyLines = stop >= 0 ? lines.slice(0, stop) : lines
    const scheduleLines = bodyLines
      .filter((line) => /^(?:a las\s+)?\d{1,2}\s*[:.h]\s*\d{2}/i.test(line))
    let entries = []
    for (const line of scheduleLines) entries.push(...parseLinesForDay([line], day))
    if (!entries.length) entries = parseHourDotLines(bodyLines, day)
    if (!entries.length) entries = singleDayStrategy(dom, day, diagnostics).programs || []
    if (entries.length) {
      programs.push(...entries)
      diagnostics.push(`day page ${file}: ${entries.length} programmes`)
    } else {
      diagnostics.push(`day page ${file}: no programmes`)
    }
  }
  return { programs, detail: `${pages} day page(s), ${new Set(programs.map((entry) => entry.day)).size} day(s)` }
}

function decodeSnapshot(buffer) {
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buffer)
  const bad = (utf8.match(/\uFFFD/g) || []).length
  if (bad > 3) {
    try {
      return { html: new TextDecoder('windows-1252').decode(buffer), charset: 'windows-1252' }
    } catch {
      /* fall through */
    }
  }
  return { html: utf8, charset: 'utf-8' }
}

// ---------------------------------------------------------------------------
// one station
// ---------------------------------------------------------------------------

async function convertStation(id, station, rawDir, outDir, guides, options) {
  const dir = join(rawDir, String(id))
  const metaPath = join(dir, 'meta.json')
  const report = {
    id,
    name: station?.name || `Station ${id}`,
    source: null,
    format: null,
    status: 'failed',
    strategy: null,
    file: null,
    confidence: 0,
    stats: {},
    warnings: [],
    errors: [],
    diagnostics: [],
    suggested_epg_file: null,
  }
  if (!existsSync(metaPath)) {
    report.errors.push(`missing ${metaPath}`)
    return report
  }

  let meta
  try {
    meta = JSON.parse(await readFile(metaPath, 'utf8'))
  } catch (error) {
    report.errors.push(`unreadable meta.json: ${error.message}`)
    return report
  }
  report.source = meta.final_url || meta.url || null
  report.format = meta.kind || '(unknown)'

  const diagnostics = []
  const files = await readdir(dir)
  const snapshot = files.find((file) => file.startsWith('latest.'))
  if (!snapshot) {
    report.errors.push('no latest.* snapshot')
    return report
  }
  if (meta.kind === 'image') {
    const buffer = await readFile(join(dir, snapshot))
    report.diagnostics.push(`snapshot ${snapshot} (${buffer.length} bytes, image)`)
    return convertImageStation(id, station, outDir, meta, buffer, report, guides, options)
  }
  if (meta.kind === 'pdf') {
    const buffer = await readFile(join(dir, snapshot))
    report.diagnostics.push(`snapshot ${snapshot} (${buffer.length} bytes, pdf)`)
    return convertPdfStation(id, station, outDir, meta, join(dir, snapshot), report, guides, options)
  }
  if (meta.kind === 'json') {
    const buffer = await readFile(join(dir, snapshot))
    report.diagnostics.push(`snapshot ${snapshot} (${buffer.length} bytes, json)`)
    return convertJsonStation(id, station, outDir, meta, buffer, report, guides, options)
  }
  if (meta.kind !== 'html') {
    report.errors.push(`unsupported snapshot format "${meta.kind}" (HTML, PDF or JSON only for now)`)
    report.diagnostics.push(`file ${snapshot}, ${meta.bytes || '?'} bytes`)
    return report
  }

  const buffer = await readFile(join(dir, snapshot))
  const { html, charset } = decodeSnapshot(buffer)
  const dom = parseHtml(html)
  const activeDay = activeTabDay(dom)
  const fallbackDay = activeDay || snapshotDay(meta.fetched_at)
  const language = stationLanguage(station || {})
  report.diagnostics.push(`snapshot ${snapshot} (${buffer.length} bytes, ${charset}), language hint ${language}, fallback day ${fallbackDay}`)

  const candidates = []
  const run = (name, fn) => {
    try {
      const result = fn()
      const programs = Array.isArray(result) ? result : result.programs || []
      const detail = Array.isArray(result) ? '' : result.detail || ''
      const days = new Set(programs.map((entry) => entry.day))
      candidates.push({ name, programs, detail, score: days.size * 60 + Math.min(programs.length, 120) + (programs.length >= 8 ? 20 : 0) })
    } catch (error) {
      candidates.push({ name, programs: [], detail: `crashed: ${error.message}`, score: -1 })
    }
  }

  run('tables', () => matrixStrategy(dom, diagnostics))
  run('nested-columns', () => nestedColumnsStrategy(dom, diagnostics))
  run('hour-rail', () => hourRailStrategy(dom, diagnostics))
  run('tabs', () => tabsStrategy(dom, diagnostics))
  run('columns', () => columnsStrategy(dom, diagnostics))
  run('sections', () => sectionsStrategy(dom, diagnostics))
  run('item-list', () => itemListStrategy(dom, fallbackDay))
  run('show-cards', () => showCardStrategy(dom, diagnostics))
  run('day-ranges', () => dayRangeStrategy(dom, diagnostics))
  run('linear', () => linearStrategy(dom, diagnostics))
  run('single-day', () => singleDayStrategy(dom, fallbackDay, diagnostics))

  const embedded = embeddedSchedulePrograms(html)
  if (embedded.programs.length) {
    const embeddedDays = new Set(embedded.programs.map((entry) => entry.day))
    candidates.push({
      name: 'embedded-json',
      programs: embedded.programs,
      detail: embedded.detail,
      score: embeddedDays.size * 60 + Math.min(embedded.programs.length, 120) + (embedded.programs.length >= 8 ? 20 : 0),
    })
  }

  const dayPages = await readDayPagePrograms(dir, diagnostics)
  const dayPageDays = new Set(dayPages.programs.map((entry) => entry.day))
  if (dayPageDays.size >= 3) {
    candidates.push({
      name: 'day-pages',
      programs: dayPages.programs,
      detail: dayPages.detail,
      score: dayPageDays.size * 60 + Math.min(dayPages.programs.length, 120) + (dayPages.programs.length >= 8 ? 20 : 0),
    })
  }

  for (const candidate of candidates) {
    report.diagnostics.push(`strategy ${candidate.name}: ${candidate.programs.length} programmes / ${new Set(candidate.programs.map((entry) => entry.day)).size} days${candidate.detail ? ` — ${candidate.detail}` : ''}`)
  }
  candidates.sort((a, b) => b.score - a.score)
  const winner = candidates[0]
  if (!winner || !winner.programs.length) {
    report.status = 'failed'
    report.errors.push('no weekly schedule could be extracted')
    report.diagnostics.push(...diagnostics.slice(0, 20))
    return report
  }

  report.strategy = winner.name
  const finalized = finalizePrograms(winner.programs)
  report.stats = finalized.stats
  report.warnings.push(...finalized.warnings.slice(0, 80))
  if (finalized.warnings.length > 80) report.warnings.push(`… ${finalized.warnings.length - 80} more warning(s) in this station`)

  if (!finalized.days.length || finalized.stats.kept < 3) {
    report.status = 'failed'
    report.errors.push(`extraction produced only ${finalized.stats.kept} usable programme(s)`)
    return report
  }

  const existing = guides.get(Number(id))
  const timezoneDiagnostics = []
  const timezone = timezoneFor(station || {}, existing, timezoneDiagnostics, language)
  report.diagnostics.push(...timezoneDiagnostics)

  // The catalog owns the published name; fall back to a slug for ad-hoc snapshots.
  const fileName = station?.epg_file || `${slugify(station?.name || meta.name || `station-${id}`)}.json`
  if (existsSync(join(outDir, fileName))) {
    try {
      const current = JSON.parse(await readFile(join(outDir, fileName), 'utf8'))
      if (!current.generator && !options.force) {
        report.status = 'skipped'
        report.file = null
        report.suggested_epg_file = fileName
        report.errors.push(`refusing to overwrite the curated guide ${fileName} (use --force)`)
        return report
      }
    } catch {
      /* unreadable target: overwrite is safe */
    }
  }

  const epg = {
    version: VERSION,
    station: station?.name || meta.name || `Station ${id}`,
    station_id: Number(id),
    schedule_type: 'weekly',
    timezone,
    last_updated: String(meta.fetched_at || new Date().toISOString()).slice(0, 10),
    source: report.source || undefined,
    contact: station?.mailto || undefined,
    notes: `Generado automáticamente desde ${report.source || 'la fuente'} (snapshot ${String(meta.fetched_at || '').slice(0, 10)}); revisar data/epg-report.json.`,
    generator: 'scripts/convert-raw-epg.mjs',
    metadata: {
      categories: CATEGORY_LABELS,
      default_filler: { title: 'Música', category: 'musica' },
    },
    shows: finalized.shows,
    days: finalized.days,
  }
  if (!epg.contact) delete epg.contact

  await mkdir(outDir, { recursive: true })
  await writeFile(join(outDir, fileName), `${JSON.stringify(epg, null, 2)}\n`, 'utf8')

  report.file = fileName
  report.suggested_epg_file = fileName
  report.confidence = Math.max(
    0.1,
    Math.min(
      0.98,
      0.15 + finalized.stats.daysWithPrograms * 0.1 + Math.min(finalized.stats.kept / 60, 0.4) - (finalized.stats.missingTitles + finalized.stats.invalidTimes > 10 ? 0.1 : 0)
    )
  )

  const dayNames = new Set(finalized.days.map((day) => day.day))
  const missingDays = DAY_NAMES.filter((day) => !dayNames.has(day))
  if (missingDays.length) report.warnings.push(`no programmes extracted for: ${missingDays.join(', ')}`)
  if (finalized.stats.daysWithPrograms === 1) report.warnings.push('only one day extracted (the source may show only the active day)')

  report.status = finalized.stats.daysWithPrograms >= 3 && finalized.stats.kept >= 8 && finalized.stats.missingTitles + finalized.stats.invalidTimes <= 5
    ? 'ok'
    : 'partial'
  if (report.status === 'partial') report.warnings.push('partial extraction: review the strategy diagnostics before publishing this guide')
  return report
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { csv: 'config/stations.csv', raw: 'data/raw', out: 'public/EPGs', report: 'data/epg-report.json', only: null, force: false }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--csv') options.csv = argv[++index]
    else if (arg === '--raw') options.raw = argv[++index]
    else if (arg === '--out') options.out = argv[++index]
    else if (arg === '--report') options.report = argv[++index]
    else if (arg === '--force') options.force = true
    else if (arg === '--only') {
      const values = []
      while (argv[index + 1] && /^\d+$/.test(argv[index + 1])) values.push(Number(argv[++index]))
      options.only = values
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/convert-raw-epg.mjs [--csv config/stations.csv] [--raw data/raw] [--out public/EPGs] [--report data/epg-report.json] [--only 1 18] [--force]')
      process.exit(0)
    } else {
      console.warn(`unknown argument "${arg}"`)
    }
  }
  return options
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const catalog = new Map()
  try {
    const rows = parseStationRows(await readFile(options.csv, 'utf8'))
    for (const row of rows) if (Number.isInteger(row.id)) catalog.set(row.id, row)
  } catch (error) {
    console.warn(`${options.csv} not readable (${error.message}); station names come from data/raw meta.json`)
  }

  const snapshots = (await readdir(options.raw, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => Number(entry.name))
    .filter((id) => !options.only || options.only.includes(id))
    .sort((a, b) => a - b)
  const dedicated = snapshots.filter((id) => DEDICATED_SCRAPERS.has(id))
  const entries = snapshots.filter((id) => !DEDICATED_SCRAPERS.has(id))

  const guides = await readExistingGuides(options.out)
  console.log(`EPG raw → ${options.out}`)
  console.log(`${entries.length} station snapshot(s) in ${options.raw}${options.only ? ` (only ${options.only.join(', ')})` : ''}\n`)
  for (const id of dedicated) console.log(`skipped ${id}: ${DEDICATED_SCRAPERS.get(id)} owns its guide\n`)

  const stations = []
  for (let index = 0; index < entries.length; index++) {
    const id = entries[index]
    const station = catalog.get(id)
    let report
    try {
      report = await convertStation(id, station, options.raw, options.out, guides, options)
    } catch (error) {
      report = {
        id,
        name: station?.name || `Station ${id}`,
        source: null,
        format: null,
        status: 'failed',
        strategy: null,
        file: null,
        confidence: 0,
        stats: {},
        warnings: [],
        errors: [`converter crashed: ${error.stack || error.message}`],
        diagnostics: [],
        suggested_epg_file: null,
      }
    }
    stations.push(report)

    const tag = `[${index + 1}/${entries.length}] [${id}] ${report.name}`
    console.log(tag)
    if (report.source) console.log(`  source    ${report.source}`)
    if (report.status === 'failed' || report.status === 'skipped') {
      console.log(`  result    ${report.status.toUpperCase()}`)
      for (const error of report.errors.slice(0, 6)) console.log(`  reason    ${error}`)
      for (const note of report.diagnostics.slice(0, 10)) console.log(`  diag      ${note}`)
      console.log('')
      continue
    }
    const stats = report.stats
    console.log(`  strategy  ${report.strategy}`)
    console.log(`  result    ${report.status.toUpperCase()} · ${stats.daysWithPrograms} days · ${stats.kept} programmes · ${stats.uniqueShows} shows · confidence ${report.confidence.toFixed(2)}`)
    console.log(`  quality   ${stats.gapCount} gaps (${stats.gapMinutes} min) · ${stats.overlapsClipped} overlaps clipped · ${stats.duplicates} duplicates · ${stats.invalidTimes} invalid times · ${stats.missingTitles} missing titles`)
    console.log(`  file      ${report.file ? `${options.out}/${report.file}` : '(not written)'}`)
    const notable = report.warnings.filter((warning) => !/^strategy /.test(warning)).slice(0, 6)
    for (const warning of notable) console.log(`  note      ${warning}`)
    if (report.warnings.length > notable.length) console.log(`  note      … ${report.warnings.length - notable.length} more in the report`)
    console.log('')
  }

  const summary = {
    stations: stations.length,
    ok: stations.filter((entry) => entry.status === 'ok').length,
    partial: stations.filter((entry) => entry.status === 'partial').length,
    failed: stations.filter((entry) => entry.status === 'failed').length,
    skipped: stations.filter((entry) => entry.status === 'skipped').length,
    extracted: stations.reduce((total, entry) => total + (entry.stats.extracted || 0), 0),
    programmes: stations.reduce((total, entry) => total + (entry.stats.kept || 0), 0),
    shows: stations.reduce((total, entry) => total + (entry.stats.uniqueShows || 0), 0),
    missingTitles: stations.reduce((total, entry) => total + (entry.stats.missingTitles || 0), 0),
    invalidTimes: stations.reduce((total, entry) => total + (entry.stats.invalidTimes || 0), 0),
    duplicates: stations.reduce((total, entry) => total + (entry.stats.duplicates || 0), 0),
    gaps: stations.reduce((total, entry) => total + (entry.stats.gapCount || 0), 0),
    gapMinutes: stations.reduce((total, entry) => total + (entry.stats.gapMinutes || 0), 0),
    overlapsClipped: stations.reduce((total, entry) => total + (entry.stats.overlapsClipped || 0), 0),
  }

  const report = {
    generated_at: new Date().toISOString(),
    raw_dir: options.raw,
    out_dir: options.out,
    html_only: true,
    summary,
    stations,
  }
  await mkdir(join(options.report, '..'), { recursive: true })
  await writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

  console.log('Summary')
  console.log(`  ${summary.ok} ok · ${summary.partial} partial · ${summary.failed} failed · ${summary.skipped} skipped`)
  console.log(`  ${summary.programmes} programmes · ${summary.shows} unique shows`)
  console.log(`  ${summary.gaps} gaps · ${summary.overlapsClipped} overlaps clipped · ${summary.duplicates} duplicates · ${summary.invalidTimes} invalid times · ${summary.missingTitles} missing titles`)
  console.log(`\nreport: ${options.report}`)
  console.log('review the generated guides with `npm run validate` before publishing the manifest')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.stack || error.message)
    process.exit(1)
  })
}

export {
  activeTabDay,
  blockText,
  dayFromExact,
  descendants,
  directCells,
  embeddedSchedulePrograms,
  extractRangedPrograms,
  findClocks,
  headerMapping,
  hermesPrograms,
  itemListStrategy,
  jsonSchedule,
  nestedColumnsStrategy,
  parseHtml,
  parseHourDotLines,
  parseLinesForDay,
  ocrTablePrograms,
  parseNestedDayTable,
  parseStartLine,
  pdfProgramsFromBlocks,
  plainText,
  sectionsStrategy,
  showCardStrategy,
  tableRows,
  tabsStrategy,
}
