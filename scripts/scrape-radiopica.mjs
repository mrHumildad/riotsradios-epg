#!/usr/bin/env node
/**
 * Dedicated scraper: Radio Pica (https://www.radiopica.cat/graella.htm)
 * -> RIOTSRADIOS EPG v2 guide (docs/EPG-FORMAT.md in mrHumildad/riotsradios-epg).
 *
 * No npm dependencies (Node >= 18: global fetch, util.parseArgs).
 *
 *   node scripts/scrape-radiopica.mjs --station-id 10
 *   node scripts/scrape-radiopica.mjs --station-id 10 --html graella.htm -o -
 *
 * Station 10 (Radio Pica) is owned by this script: the refresh workflow runs it
 * after `convert-raw-epg.mjs`, which skips the id, and it also rewrites that
 * station's entry in data/epg-report.json so the report matches the guide.
 *
 * Page layout this relies on
 * --------------------------
 * - Columns: hora | Dilluns | Dimarts | Dimecres | Dijous | Divendres | Dissabte i Diumenge
 * - The 24 h day is folded into FIVE-hour cycles: one cell airs at five clock times,
 *   listed in the row's "hora" cell (e.g. 15.00 / 20.00 / 1.00 / 6.00 / 11.00).
 * - Row "INFORMACIÓ SILENCIADA" (colspan 6) = first hour of every cycle, all days.
 * - Four programme rows; the weekend cell (rowspan 4) = random repeats + music.
 * - The broadcast day starts at 14:00, so slots 00:00-13:59 belong to the PREVIOUS
 *   column's day (a listener at Tuesday 01:00 hears Monday's column). Use
 *   --calendar-day to disable that shift.
 * - "***" inside a cell separates fortnightly-alternating shows. EPG v2 forbids
 *   overlaps, so they become ONE combined show ("A / B") with a recurrence_note.
 * - Consecutive hours of the same show ("1ª part" / "2ª part") are merged.
 * - The Friday row's 5th time is garbled in the page (".00-.00-"); that airing
 *   falls back to the previous hour's show, which is the info slot in practice.
 */

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

export const URL_DEFAULT = "https://www.radiopica.cat/graella.htm";
const DEFAULT_CONTACT = "rsps@gmx.es";

const DAYS = [
  ["monday", "Dilluns"],
  ["tuesday", "Dimarts"],
  ["wednesday", "Dimecres"],
  ["thursday", "Dijous"],
  ["friday", "Divendres"],
  ["saturday", "Dissabte"],
  ["sunday", "Diumenge"],
];
const HEADER_KEYS = ["DILLUNS", "DIMARTS", "DIMECRES", "DIJOUS", "DIVENDRES", "DISSABTE"];

const DEFAULT_CATEGORY = "podcast"; // pre-recorded programmes sent by the hosts
const FILLER_CATEGORY = "musica";
const INFO_TITLE = "Informació Silenciada";
const FILLER_TITLE = "Repeticions aleatòries i continuïtat musical";

// keys: uppercase, accents and punctuation stripped (see normKey)
const TITLE_FIXES = {
  "DESCANSAR ESCOLTAR IMAGINAR": "Descansar, Escoltar, Imaginar...",
  "HISTORIA LEIDAS": "Historias Leídas...",
  "ESCARBAT BUM BUM": "Escarbat Bum Bum",
};
const SMALL_WORDS = new Set(["de", "del", "la", "las", "los", "el", "en", "y", "i", "a", "in", "o", "per", "para", "amb"]);
const CATEGORY_OVERRIDES = {}; // e.g. { "informacio-silenciada": "especial" }

export class ScrapeError extends Error {}

const warnings = [];
function warn(msg) {
  warnings.push(msg);
  console.error("warning: " + msg);
}

// --------------------------------------------------------------------------- fetch / decode

export function decode(buf, headerCharset) {
  const head = Buffer.from(buf).subarray(0, 4096).toString("latin1");
  const meta = /charset=["']?([\w-]+)/i.exec(head);
  const cands = [];
  for (const c of [headerCharset, meta && meta[1]]) {
    if (!c) continue;
    cands.push(/^(iso-8859-1|latin-?1)$/i.test(c) ? "windows-1252" : c);
  }
  cands.push("utf-8", "windows-1252");
  for (const c of cands) {
    try {
      return new TextDecoder(c, { fatal: true }).decode(buf);
    } catch {
      /* try next */
    }
  }
  return new TextDecoder("latin1").decode(buf);
}

async function fetchPage(url, timeoutMs = 30000) {
  const res = await fetch(url, {
    headers: { "User-Agent": "riotsradios-epg/1.0 (+https://github.com/mrHumildad/riotsradios-epg)" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new ScrapeError(`HTTP ${res.status} for ${url}`);
  const cs = /charset=([\w-]+)/i.exec(res.headers.get("content-type") || "");
  return decode(await res.arrayBuffer(), cs && cs[1]);
}

// --------------------------------------------------------------------------- HTML table parsing

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", acute: "´" };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

class Cell {
  constructor(colspan = 1, rowspan = 1) {
    this.colspan = colspan;
    this.rowspan = rowspan;
    this.raw = [""];
  }
  get lines() {
    return this.raw
      .map((l) => l.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim())
      .filter(Boolean);
  }
  get text() {
    return this.lines.join(" ");
  }
}

const toInt = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
};

function attr(attrs, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(attrs);
  return m ? (m[2] ?? m[3] ?? m[4]) : undefined;
}

/** Every <table> as rows of Cell. Tolerates FrontPage-style unclosed <p>/<td>/<tr> and nesting. */
export function parseTables(html) {
  const tables = [];
  const stack = [];
  const tokenRe = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w:-]*)([^>]*)>|([^<]+|<)/g;
  let m;
  while ((m = tokenRe.exec(html))) {
    if (m[4] !== undefined) {
      const st = stack[stack.length - 1];
      if (st && st.cell) st.cell.raw[st.cell.raw.length - 1] += decodeEntities(m[4]);
      continue;
    }
    if (!m[2]) continue; // comment
    const closing = m[1] === "/";
    const tag = m[2].toLowerCase();
    const attrs = m[3] || "";
    if (!closing) {
      if (tag === "table") {
        stack.push({ rows: [], row: null, cell: null });
        continue;
      }
      const st = stack[stack.length - 1];
      if (!st) continue;
      if (tag === "tr") {
        st.row = [];
        st.cell = null;
        st.rows.push(st.row);
      } else if (tag === "td" || tag === "th") {
        if (!st.row) {
          st.row = [];
          st.rows.push(st.row);
        }
        st.cell = new Cell(toInt(attr(attrs, "colspan")), toInt(attr(attrs, "rowspan")));
        st.row.push(st.cell);
      } else if (["p", "br", "div", "li"].includes(tag)) {
        if (st.cell) st.cell.raw.push("");
      }
    } else {
      const st = stack[stack.length - 1];
      if (!st) continue;
      if (tag === "td" || tag === "th") st.cell = null;
      else if (["p", "div", "li"].includes(tag)) {
        if (st.cell) st.cell.raw.push("");
      } else if (tag === "tr") {
        st.row = null;
        st.cell = null;
      } else if (tag === "table") tables.push(stack.pop().rows);
    }
  }
  return tables;
}

const stripAccents = (s) => s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
/** 'I N F O R M A C I Ó' -> 'INFORMACIO' (fuzzy matching). */
const letters = (s) => stripAccents(s).toUpperCase().replace(/[^A-Z]/g, "");
const normKey = (s) =>
  stripAccents(s).toUpperCase().replace(/[^A-Z0-9 ]/g, "").replace(/\s+/g, " ").trim();

/** Resolve colspan/rowspan into { column: Cell } per row. */
function expand(rows) {
  const grid = [];
  const pending = new Map(); // col -> [cell, rowsLeft]
  for (const r of rows) {
    const line = new Map();
    const queue = [...r];
    let col = 0;
    for (;;) {
      if (pending.has(col)) {
        const [cell, left] = pending.get(col);
        line.set(col, cell);
        if (left > 1) pending.set(col, [cell, left - 1]);
        else pending.delete(col);
        col += 1;
      } else if (queue.length) {
        const cell = queue.shift();
        for (let k = 0; k < cell.colspan; k++) {
          line.set(col + k, cell);
          if (cell.rowspan > 1) pending.set(col + k, [cell, cell.rowspan - 1]);
        }
        col += cell.colspan;
      } else if ([...pending.keys()].some((c) => c > col)) {
        col += 1;
      } else break;
    }
    grid.push(line);
  }
  return grid;
}

// --------------------------------------------------------------------------- cell -> show

function cleanTitle(t) {
  t = t.replace(/[´`’]/g, "'");
  t = t.replace(/\s+\.(?=\w)/g, " "); // "BUM .BUM" -> "BUM BUM"
  t = t.replace(/[\s.]+$/, "").replace(/\s+/g, " ").trim();
  const fixed = TITLE_FIXES[normKey(t)];
  if (fixed) return fixed;
  let first = true;
  return t.replace(/\p{L}+/gu, (word) => {
    const w = word.toLowerCase();
    const out = SMALL_WORDS.has(w) && !first ? w : w[0].toUpperCase() + w.slice(1);
    first = false;
    return out;
  });
}

const slug = (t) =>
  stripAccents(t).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const PART_RE = /^\d+\s*[ªaº]?\s*part\b/i;
const ALT_RE = /quinc|quinz/i;
const OTHER_DAY_RE = /diumenge|domingo|dissabte|s[aá]bado/i;

/** -> [title, category, recurrenceNote] or null. */
function parseCell(cell, notes) {
  const lines = cell.lines.filter((l) => !/^[\s.\-]*$/.test(l));
  if (!lines.length) return null;
  if (lines.some((l) => /repeticions|repeticiones/i.test(l))) return [FILLER_TITLE, FILLER_CATEGORY, ""];

  const groups = [[]];
  for (const l of lines) {
    if (/^\*+$/.test(l)) groups.push([]);
    else groups[groups.length - 1].push(l);
  }

  const parsed = [];
  for (const g of groups) {
    const titleL = [];
    const noteL = [];
    for (const l of g) {
      if (PART_RE.test(l)) continue;
      if (noteL.length || l.startsWith("(")) noteL.push(l);
      else titleL.push(l);
    }
    if (!titleL.length) continue;
    const title = cleanTitle(titleL.join(" "));
    const note = noteL.join(" ").replace(/\s+/g, " ").trim().replace(/^[\s()\-]+|[\s()\-]+$/g, "");
    parsed.push([title, note]);
  }

  const keep = [];
  for (const [title, note] of parsed) {
    if (note && OTHER_DAY_RE.test(note) && !ALT_RE.test(note)) {
      notes.push(`${title}: «${note.replace(/[´']/g, "’")}»`);
      continue;
    }
    keep.push([title, note]);
  }
  if (!keep.length) return null;
  if (keep.length === 1) {
    const [title, note] = keep[0];
    return [title, DEFAULT_CATEGORY, ALT_RE.test(note) ? "Quincenal" : ""];
  }
  const titles = keep.map(([t]) => t);
  if (!keep.every(([, n]) => ALT_RE.test(n)))
    warn(`cell with several shows but not all fortnightly: ${titles.join(", ")} (treated as alternating)`);
  return [titles.join(" / "), DEFAULT_CATEGORY, "Quincenal: se alternan semana a semana"];
}

// --------------------------------------------------------------------------- grid -> schedule

function parseTimes(cell) {
  const out = [];
  for (const m of cell.text.matchAll(/(\d{1,2})[.:](\d{2})/g)) {
    const h = +m[1];
    let mi = +m[2];
    if (mi === 1) mi = 0; // "14.01" = right after the 14:00 start jingle
    if (h > 23 || mi > 59) continue;
    const t = h * 60 + mi;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

function findTable(html) {
  for (const rows of parseTables(html))
    for (const r of rows) if (r.some((c) => letters(c.text) === "DILLUNS")) return rows;
  throw new ScrapeError("schedule table (header 'Dilluns') not found - page layout changed?");
}

/** -> { schedule, dayStart, notes }; schedule[col 0..5] = Map(startMinute -> spec). */
export function readGrid(html) {
  const grid = expand(findTable(html));
  const hdr = grid.findIndex(
    (l) => l.has(0) && letters(l.get(0).text) === "HORA" && l.has(1) && letters(l.get(1).text) === "DILLUNS"
  );
  if (hdr < 0) throw new ScrapeError("header row not found");
  HEADER_KEYS.forEach((k, i) => {
    const c = grid[hdr].get(i + 1);
    if (!c || !letters(c.text).startsWith(k))
      throw new ScrapeError(`unexpected column ${i + 1} header: ${JSON.stringify(c ? c.text : null)}`);
  });

  const schedule = Array.from({ length: 6 }, () => new Map());
  const notes = [];
  let dayStart = null;
  const specCache = new Map();
  const specOf = (cell) => {
    if (!specCache.has(cell)) specCache.set(cell, parseCell(cell, notes));
    return specCache.get(cell);
  };
  const put = (col, start, spec, where) => {
    if (!spec) return;
    if (schedule[col].has(start))
      warn(`duplicate slot ${hhmm(start)} in column ${col + 1} (${where})`);
    schedule[col].set(start, spec);
  };

  for (const line of grid.slice(hdr + 1)) {
    if (!line.has(0) || !line.has(1)) continue;
    const k0 = letters(line.get(0).text);
    const k1 = letters(line.get(1).text);
    if (k0 === "HORA" || k1 === "LUNES") break; // repeated Spanish header = end of grid
    const times = parseTimes(line.get(0));
    if (k1.includes("INICI") && k1.includes("PROGRAMACI")) {
      if (times.length) dayStart = times[0];
      continue;
    }
    if (k1.includes("SILENCIADA") && line.get(1).colspan >= 6) {
      for (const t of times) for (let col = 0; col < 6; col++) put(col, t, [INFO_TITLE, DEFAULT_CATEGORY, ""], "info row");
      continue;
    }
    if (![1, 2, 3, 4, 5, 6].every((c) => line.has(c))) {
      warn(`skipping row with missing columns: ${JSON.stringify(line.get(0).text)}`);
      continue;
    }
    if (!times.length) {
      warn(`row without time labels skipped: ${JSON.stringify(line.get(1).text.slice(0, 40))}`);
      continue;
    }
    for (let col = 0; col < 6; col++) {
      const spec = specOf(line.get(col + 1));
      for (const t of times) put(col, t, spec, `row ${line.get(0).text.slice(0, 20)}`);
    }
  }
  if (!schedule.some((m) => m.size)) throw new ScrapeError("no programmes extracted");
  return { schedule, dayStart: dayStart ?? 14 * 60, notes };
}

// --------------------------------------------------------------------------- build guide

const hhmm = (m) =>
  `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const toMin = (s) => +s.slice(0, 2) * 60 + +s.slice(3);

export function build({ schedule, dayStart, calendarDay, station, stationId, timezone, source, contact, notesExtra }) {
  const shows = {};
  const days = [];
  const SLOT = 60;
  const colOf = (d) => Math.min(((d % 7) + 7) % 7, 5);

  const register = ([title, cat, rec]) => {
    const id = slug(title);
    const entry = { title, category: CATEGORY_OVERRIDES[id] ?? cat };
    if (rec) entry.recurrence_note = rec;
    if (shows[id] && JSON.stringify(shows[id]) !== JSON.stringify(entry))
      warn(`show id '${id}' defined twice with different data; keeping first`);
    shows[id] ??= entry;
    return id;
  };

  DAYS.forEach(([key, label], d) => {
    let items;
    if (calendarDay) items = [...schedule[colOf(d)]];
    else
      items = [
        ...[...schedule[colOf(d - 1)]].filter(([s]) => s < dayStart),
        ...[...schedule[colOf(d)]].filter(([s]) => s >= dayStart),
      ];
    items.sort((a, b) => a[0] - b[0]);
    const progs = [];
    for (const [start, spec] of items) {
      const id = register(spec);
      const end = start + SLOT;
      const last = progs[progs.length - 1];
      if (last && last.end === start && last.show_id === id) last.end = end; // merge "1ª part" + "2ª part"
      else progs.push({ start, end, show_id: id });
    }
    days.push({
      day: key,
      label,
      programs: progs.map((p) => {
        const e = { start: hhmm(p.start), end: hhmm(p.end), show_id: p.show_id };
        if (p.end === 24 * 60) e.crosses_midnight = true;
        return e;
      }),
    });
  });

  const notes = ["Los horarios de inicio y final de algunos programas pueden variar unos minutos."];
  if (!calendarDay)
    notes.push(
      `La parrilla original empieza a las ${hhmm(dayStart)}; las franjas de 00:00 a ${hhmm(dayStart)} corresponden a la columna del día anterior.`
    );
  notes.push(...notesExtra);

  const guide = {
    version: "2.0",
    station,
    station_id: stationId,
    generator: "scripts/scrape-radiopica.mjs",
    timezone,
    last_updated: new Date().toISOString().slice(0, 10),
    source,
  };
  if (contact) guide.contact = contact;
  guide.notes = notes.join(" ");
  guide.shows = shows;
  guide.days = days;
  return guide;
}

/** Cheap local mirror of the repo rules; the authoritative check is validate-epgs.js. */
export function validate(guide) {
  const problems = [];
  const T = /^([01]\d|2[0-3]):[0-5]\d$/;
  for (const day of guide.days) {
    let prevEnd = null;
    for (const p of day.programs) {
      if (!T.test(p.start) || !T.test(p.end)) problems.push(`${day.day}: bad time ${p.start}-${p.end}`);
      if (!guide.shows[p.show_id]) problems.push(`${day.day}: unknown show_id ${p.show_id}`);
      const s = toMin(p.start);
      const e = toMin(p.end) || 1440;
      if (prevEnd !== null && s < prevEnd) problems.push(`${day.day}: overlap at ${p.start}`);
      if (prevEnd !== null && s > prevEnd) problems.push(`${day.day}: gap ${hhmm(prevEnd)}-${p.start}`);
      prevEnd = e;
    }
    if (!day.programs.length || day.programs[0].start !== "00:00" || prevEnd !== 1440)
      problems.push(`${day.day}: does not cover 00:00-24:00`);
  }
  return problems;
}

// --------------------------------------------------------------------------- report

/**
 * Replace this station's entry in data/epg-report.json (and recompute the
 * summary) so the pipeline report describes the dedicated scrape instead of the
 * generic table extraction it replaced.
 */
function updateReport(reportPath, entry) {
  let report = { generated_at: new Date().toISOString(), stations: [] };
  try {
    report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  } catch {
    /* no report yet */
  }
  const stations = (Array.isArray(report.stations) ? report.stations : []).filter(
    (station) => Number(station.id) !== entry.id
  );
  stations.push(entry);
  stations.sort((a, b) => Number(a.id) - Number(b.id));

  const sum = (field) => stations.reduce((total, station) => total + (station.stats?.[field] || 0), 0);
  const count = (status) => stations.filter((station) => station.status === status).length;
  report.generated_at ??= new Date().toISOString();
  report.stations = stations;
  report.summary = {
    stations: stations.length,
    ok: count("ok"),
    partial: count("partial"),
    failed: count("failed"),
    skipped: count("skipped"),
    extracted: sum("extracted"),
    programmes: sum("kept"),
    shows: sum("uniqueShows"),
    missingTitles: sum("missingTitles"),
    invalidTimes: sum("invalidTimes"),
    duplicates: sum("duplicates"),
    gaps: sum("gapCount"),
    gapMinutes: sum("gapMinutes"),
    overlapsClipped: sum("overlapsClipped"),
  };
  fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  return entry;
}

// --------------------------------------------------------------------------- CLI

async function main(argv) {
  let args;
  try {
    args = parseArgs({
      args: argv,
      options: {
        "station-id": { type: "string" },
        station: { type: "string", default: "Radio Pica" },
        timezone: { type: "string", default: "Europe/Madrid" },
        url: { type: "string", default: URL_DEFAULT },
        html: { type: "string" },
        contact: { type: "string" },
        "calendar-day": { type: "boolean", default: false },
        report: { type: "string", default: "data/epg-report.json" },
        output: { type: "string", short: "o", default: "public/EPGs/radio-pica.json" },
        help: { type: "boolean", short: "h", default: false },
      },
    }).values;
  } catch (e) {
    console.error("error: " + e.message);
    return 2;
  }
  if (args.help || !args["station-id"]) {
    console.error(
      "usage: scrape-radiopica.mjs --station-id N [--station NAME] [--timezone TZ] [--url URL | --html FILE]\n" +
        "                            [--contact EMAIL] [--calendar-day] [--report FILE] [-o FILE|-]"
    );
    return args.help ? 0 : 2;
  }
  const stationId = Number(args["station-id"]);
  if (!Number.isInteger(stationId)) {
    console.error("error: --station-id must be an integer");
    return 2;
  }

  let html, scraped;
  try {
    html = args.html ? decode(fs.readFileSync(args.html)) : await fetchPage(args.url);
    scraped = readGrid(html);
  } catch (e) {
    console.error("error: " + (e.cause?.message ? `${e.message} (${e.cause.message})` : e.message));
    return 2;
  }

  const contact =
    args.contact ?? /mailto:[\s%20]*([\w.+-]+@[\w-]+(?:\.[\w-]+)+)/.exec(html)?.[1] ?? DEFAULT_CONTACT;

  const guide = build({
    ...scraped,
    calendarDay: args["calendar-day"],
    station: args.station,
    stationId,
    timezone: args.timezone,
    source: args.url,
    contact,
    notesExtra: scraped.notes,
  });
  const problems = validate(guide);
  problems.forEach((p) => console.error("error: " + p));
  if (problems.length) return 3;

  const text = JSON.stringify(guide, null, 2) + "\n";
  if (args.output === "-") {
    process.stdout.write(text);
    return 0;
  }

  fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
  fs.writeFileSync(args.output, text, "utf8");
  const n = guide.days.reduce((a, d) => a + d.programs.length, 0);
  console.error(
    `wrote ${args.output} (${Object.keys(guide.shows).length} shows, ${n} programmes, ${warnings.length} warnings)`
  );

  const file = path.basename(args.output);
  const entry = updateReport(args.report, {
    id: stationId,
    name: args.station,
    source: args.url,
    format: "html",
    status: "ok",
    strategy: "radiopica-grid",
    file,
    confidence: 0.95,
    stats: {
      extracted: n,
      kept: n,
      uniqueShows: Object.keys(guide.shows).length,
      missingTitles: 0,
      invalidTimes: 0,
      duplicates: 0,
      overlapsClipped: 0,
      gapCount: 0,
      gapMinutes: 0,
      daysWithPrograms: guide.days.filter((day) => day.programs.length).length,
    },
    warnings: warnings.slice(),
    errors: [],
    diagnostics: [
      `${guide.days.length} days from the graella grid (five-hour cycles; the weekend column covers saturday and sunday)`,
      args["calendar-day"]
        ? "calendar-day mode: each slot belongs to its own column's day"
        : `broadcast day starts at ${hhmm(scraped.dayStart)}; earlier slots come from the previous day's column`,
    ],
    suggested_epg_file: file,
  });
  console.error(`updated ${args.report} (station ${entry.id}: ${entry.status})`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
