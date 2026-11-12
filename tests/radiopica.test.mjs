/**
 * Radio Pica's graella.htm is a single FrontPage table: five-hour cycles, one
 * shared weekend column (rowspan), overlapping colspan rows and a 14:00 day
 * start. The fixture keeps those quirks so a layout regression fails here
 * instead of silently shifting a week of programmes.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { build, readGrid, validate } from '../scripts/scrape-radiopica.mjs'

const HTML = `<!doctype html><html><head><meta charset="iso-8859-1"></head><body>
<table border="1">
<tr>
  <td>hora</td><td>Dilluns</td><td>Dimarts</td><td>Dimecres</td>
  <td>Dijous</td><td>Divendres</td><td>Dissabte i Diumenge</td>
</tr>
<tr>
  <td><b>14.</b><b>00</b></td>
  <td colspan="6"><b>cI. . INICI DE LA PROGRAMACIÓ DIARIA .</b></td>
</tr>
<tr>
  <td>14.01 -<p>19.00 -</p><p>0.00 -</p><p>5.00 -</p><p>10.00 -</p></td>
  <td colspan="6">... . I N F O R M A C I Ó . S I L E N C I A D A . . . I N F O R M A C I Ó N . S I L E N C I A D A</td>
</tr>
<tr>
  <td>0<p>15.00</p><p>20.00</p><p>1.00</p><p>6.00</p><p>11.00</p></td>
  <td><p>PUNK NOT DEAD</p><p>(quincenal -</p><p>***</p><p>BORINOT BORINOT</p><p>(quinzenal -</p></td>
  <td><p>.</p><p>GLOBAL MUSIC</p></td>
  <td>TECHNOWORLD</td>
  <td>ESCARBAT BUM .BUM</td>
  <td>L´ABOCADOR CÒSMIC</td>
  <td rowspan="4">DISSABTE i DIUMENGE Repeticions aleatories dels programes setmanals, i continuïtat musical *** SÁBADO y DOMINGO Repeticiones aleatorias</td>
</tr>
<tr>
  <td>16.00-<p>16.00-</p><p>21.00-</p><p>2.00-</p><p>7.00-</p><p>12.00-</p></td>
  <td>DESCANSAR, ESCOLTAR IMAGINAR....</td>
  <td><p>DEMÉSENLLÀ</p><p>1ª part -</p></td>
  <td><p>BERLIN in FARBEN</p><p>(quincenal -</p><p>***</p><p>ESOMBA</p><p>(quincenal -</p></td>
  <td><p>EL TRASTERO</p><p>(quincenal -</p><p>***</p><p>VINILO VINTAGE</p><p>(quincenal -</p></td>
  <td>LA HORA DEL BLUES</td>
</tr>
<tr>
  <td>17.00-<p>17.00-</p><p>22.00-</p><p>3.00-</p><p>8.00-</p><p>13.00-</p></td>
  <td><p>DONA &amp; MUSIC</p><p>(quincenal -</p><p>***</p><p>DOSSIER</p><p>(quinzenal -</p></td>
  <td><p>DEMÉSENLLÀ</p><p>2ª part -</p></td>
  <td><p>CIENCIA PARA ESCUCHAR</p><p>(quincenal -</p><p>***</p><p>RUBIK</p><p>(quincenal -</p></td>
  <td>OTRAS RADIOS LIBRES</td>
  <td><p>BAJA ESA MÚSICA</p><p>1ª part -</p></td>
</tr>
<tr>
  <td>18.00<p>18.00</p><p>23.00-</p><p>4.00-</p><p>9.00-</p><p>.00-.00-</p></td>
  <td>LES ÀNIMES PERDUDES</td>
  <td>EL CORAZÓN DE LAS TINIEBLAS</td>
  <td><p>A ESTE LADO DE LA TUMBA</p><p>(quinzenal -</p><p>***</p><p>ONES DE CROM</p><p>(quinzenal -</p></td>
  <td>HISTORIA LEIDAS...</td>
  <td><p>BAJA ESA MÚSICA</p><p>2ª part -</p></td>
</tr>
<tr>
  <td>hora</td><td>Lunes</td><td>Martes</td><td>Miércoles</td>
  <td>Jueves</td><td>Viernes</td><td>Sábado y Domingo</td>
</tr>
</table>
</body></html>`

const { schedule, dayStart } = readGrid(HTML)
const guide = build({
  schedule,
  dayStart,
  calendarDay: false,
  station: 'Radio Pica',
  stationId: 10,
  timezone: 'Europe/Madrid',
  source: 'https://www.radiopica.cat/graella.htm',
  contact: null,
  notesExtra: [],
})

const day = (name) => guide.days.find((entry) => entry.day === name)
const at = (name, start) => day(name).programs.find((entry) => entry.start === start)
const title = (showId) => guide.shows[showId].title

test('each row airs on the five clock times listed in the hora cell', () => {
  assert.equal(dayStart, 14 * 60)
  for (const start of [15, 20, 1, 6, 11]) {
    assert.equal(schedule[0].get(start * 60)[0], 'Punk Not Dead / Borinot Borinot')
    assert.equal(schedule[1].get(start * 60)[0], 'Global Music')
  }
  /* A duplicate label in a row ("16.00- 16.00-") must not duplicate the slot. */
  assert.equal(schedule[0].size, 24)
})

test('slots before 14:00 belong to the previous day, so the week covers 24h', () => {
  assert.equal(guide.days.length, 7)
  assert.deepEqual(validate(guide), [])
  assert.equal(at('tuesday', '01:00').show_id, 'punk-not-dead-borinot-borinot')
  assert.equal(at('tuesday', '15:00').show_id, 'global-music')
  assert.equal(at('tuesday', '20:00').show_id, 'global-music')
  assert.equal(day('tuesday').programs.at(-1).crosses_midnight, true)
})

test('fortnightly alternates and split parts are combined, not overlapped', () => {
  const parts = at('tuesday', '16:00')
  assert.equal(parts.show_id, 'demesenlla')
  assert.equal(parts.end, '18:00')
  assert.equal(title('demesenlla'), 'Demésenllà')
  assert.equal(title('berlin-in-farben-esomba'), 'Berlin in Farben / Esomba')
  assert.match(guide.shows['berlin-in-farben-esomba'].recurrence_note, /Quincenal/)
})

test('titles are repaired from the all-caps FrontPage cells', () => {
  assert.equal(title('escarbat-bum-bum'), 'Escarbat Bum Bum')
  assert.equal(title('l-abocador-cosmic'), "L'Abocador Còsmic")
  assert.equal(title('descansar-escoltar-imaginar'), 'Descansar, Escoltar, Imaginar...')
})

test('the shared weekend column is music filler and never borrows weekday shows', () => {
  const weekend = new Set([
    'informacio-silenciada',
    'repeticions-aleatories-i-continuitat-musical',
  ])
  for (const name of ['saturday', 'sunday']) {
    /* Saturday before 14:00 is still Friday's column; the weekend grid starts at 14:00. */
    const shared = day(name).programs.filter((entry) => name === 'sunday' || entry.start >= '14:00')
    assert.deepEqual(new Set(shared.map((entry) => entry.show_id)), weekend)
  }
  assert.equal(at('saturday', '01:00').show_id, 'l-abocador-cosmic')
  assert.equal(at('saturday', '15:00').show_id, 'repeticions-aleatories-i-continuitat-musical')
})

test('the guide declares its own generator so the manifest trusts the report', () => {
  assert.equal(guide.version, '2.0')
  assert.equal(guide.station_id, 10)
  assert.equal(guide.generator, 'scripts/scrape-radiopica.mjs')
  assert.equal(guide.days[0].programs[0].start, '00:00')
})
