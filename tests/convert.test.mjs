import test from 'node:test'
import assert from 'node:assert/strict'
import {
  dayFromExact,
  hermesPrograms,
  jsonSchedule,
  parseHtml,
  parseLinesForDay,
  ocrTablePrograms,
  pdfProgramsFromBlocks,
  showCardStrategy,
  tabsStrategy,
} from '../scripts/convert-raw-epg.mjs'

test('weekday labels may carry a calendar date', () => {
  assert.equal(dayFromExact('Lun'), 'monday')
  assert.equal(dayFromExact('Lun09.11.2026'), 'monday')
  assert.equal(dayFromExact('Lun 09.11.2026'), 'monday')
  assert.equal(dayFromExact('Mié 11.11.2026'), 'wednesday')
  assert.equal(dayFromExact('Montag, 10.11.'), 'monday')
  assert.equal(dayFromExact('Domingo 15.11.2026'), 'sunday')
  assert.equal(dayFromExact('Programación'), null)
})

test('Hermes schedules map dayOfWeek and decimal hours', () => {
  const payload = [
    { dayOfWeek: 1, hourStart: 8, hourEnd: 9, activity: { name: 'Onda Corta' } },
    { dayOfWeek: 7, hourStart: 23, hourEnd: 1, activity: { name: 'Nocturna' } },
    { dayOfWeek: 2, hourStart: 9, hourEnd: 12, activity: { name: '' } },
  ]
  const { programs } = hermesPrograms(payload)
  assert.deepEqual(programs[0], { day: 'monday', startMin: 480, endMin: 540, title: 'Onda Corta' })
  assert.deepEqual(programs[1], { day: 'sunday', startMin: 1380, endMin: 1500, title: 'Nocturna' })
  assert.equal(programs.length, 2)
  assert.equal(jsonSchedule(payload).adapter, 'hermes')
  assert.equal(jsonSchedule({ schedule: [] }).adapter, 'sapo')
  assert.equal(jsonSchedule([]).adapter, null)
})

test('a clock-only line takes its title from the next line', () => {
  const entries = parseLinesForDay(['07:00', '\r', 'LA MOSCA MAÑANERA', '10:00', '\r', 'BUENOS DÍAS MUNDO'], 'monday')
  assert.equal(entries.length, 2)
  assert.deepEqual(entries[0], { day: 'monday', startMin: 420, endMin: null, title: 'LA MOSCA MAÑANERA' })
  assert.equal(entries[1].startMin, 600)
})

test('day tabs with calendar labels build a full week', () => {
  const labels = [
    ['Lun', '09.11.2026'], ['Mar', '10.11.2026'], ['Mié', '11.11.2026'], ['Jue', '12.11.2026'],
    ['Vie', '13.11.2026'], ['Sáb', '14.11.2026'], ['Dom', '15.11.2026'],
  ]
  const nav = labels.map(([day, date]) => `<li><a href="#${date}"><span class="day">${day}</span><p>${date}</p></a></li>`).join('')
  const panes = labels.map(([, ], index) =>
    `<div class="tv-tab-pane"><table>
      <tr><td class="time">${String(index + 7).padStart(2, '0')}:00</td><td class="title">Mañana ${index}</td></tr>
      <tr><td class="time">${String(index + 10).padStart(2, '0')}:30</td><td class="title">Tarde ${index}</td></tr>
    </table></div>`).join('')
  const dom = parseHtml(`<ul class="nav">${nav}</ul><div class="tv-tab-content">${panes}</div>`)
  const result = tabsStrategy(dom, [])
  assert.equal(new Set(result.programs.map((entry) => entry.day)).size, 7)
  assert.equal(result.programs.length, 14)
})

test('schedule cards that state their own day and hours', () => {
  const dom = parseHtml(`<div>
    <div class="card"><h3>Asi es mi tierra</h3><p>Sábado, Domingo, Lunes</p><p>20 a 21hs.</p><span>Ver</span></div>
    <div class="card"><h3>Andar Bien</h3><p>Miercoles</p><p>19:30hs</p><span>Ver</span></div>
  </div>`)
  const { programs } = showCardStrategy(dom, [])
  assert.equal(programs.length, 4)
  assert.deepEqual(programs.filter((entry) => entry.title === 'Asi es mi tierra').map((entry) => entry.day).sort(), ['monday', 'saturday', 'sunday'])
  assert.deepEqual(programs.find((entry) => entry.title === 'Andar Bien'), { day: 'wednesday', startMin: 1170, endMin: 1230, title: 'Andar Bien' })
})

test('PDF legend blocks below the grid are ignored', () => {
  const weekdays = ['lunedi', 'martedi', 'mercoledi', 'giovedi', 'venerdi', 'sabato', 'domenica']
  const blocks = weekdays.map((text, index) => ({
    text, xMin: 140 + index * 102, xMax: 160 + index * 102, xCenter: 150 + index * 102, yMin: 32,
  }))
  blocks.push({ text: '8:00', xMin: 50, xMax: 70, xCenter: 60, yMin: 50 })
  blocks.push({ text: '9:00', xMin: 50, xMax: 70, xCenter: 60, yMin: 64 })
  blocks.push({ text: '10:00', xMin: 50, xMax: 70, xCenter: 60, yMin: 78 })
  blocks.push({ text: 'ALBA', xMin: 140, xMax: 160, xCenter: 150, yMin: 50 })
  blocks.push({ text: 'GIALLO = INFORMAZIONE', xMin: 140, xMax: 160, xCenter: 150, yMin: 400 })
  const { programs } = pdfProgramsFromBlocks(blocks)
  assert.equal(programs.length, 1)
  assert.equal(programs[0].title, 'ALBA')
})

test('PDF blocks map to day columns and time rows', () => {
  const weekdays = ['lunedi', 'martedi', 'mercoledi', 'giovedi', 'venerdi', 'sabato', 'domenica']
  const blocks = weekdays.map((text, index) => ({
    text,
    xMin: 140 + index * 102,
    xMax: 160 + index * 102,
    xCenter: 150 + index * 102,
    yMin: 32,
  }))
  blocks.push({ text: '8:00', xMin: 50, xMax: 70, xCenter: 60, yMin: 50 })
  blocks.push({ text: '9:00', xMin: 50, xMax: 70, xCenter: 60, yMin: 64 })
  blocks.push({ text: '10:00', xMin: 50, xMax: 70, xCenter: 60, yMin: 78 })
  blocks.push({ text: 'ALBA', xMin: 140, xMax: 160, xCenter: 150, yMin: 50 })
  blocks.push({ text: 'NOVE', xMin: 140, xMax: 160, xCenter: 150, yMin: 64 })
  blocks.push({ text: 'EXIT', xMin: 240, xMax: 260, xCenter: 250, yMin: 64 })

  const { programs, detail } = pdfProgramsFromBlocks(blocks)
  assert.match(detail, /7 day columns/)
  assert.deepEqual(programs, [
    { day: 'monday', startMin: 480, endMin: 540, title: 'ALBA' },
    { day: 'monday', startMin: 540, endMin: 570, title: 'NOVE' },
    { day: 'tuesday', startMin: 540, endMin: 570, title: 'EXIT' },
  ])
})

test('an OCR table maps weekday columns and clock rows', () => {
  const text = [
    'Lunes\tmartes\tmiércoles',
    '00:00\tDistorsionados\tSkachabacha\tSkachabacha',
    'Al Mundo Le Falta Un',
    '10:30\tVoces del Cabildo\tVoces del Cabildo\tTornillo',
  ].join('\n')
  const { programs, detail } = ocrTablePrograms(text)
  assert.equal(programs.length, 6)
  assert.deepEqual(programs[0], { day: 'monday', startMin: 0, title: 'Distorsionados' })
  assert.deepEqual(programs[3], { day: 'monday', startMin: 630, title: 'Voces del Cabildo' })
  assert.match(detail, /3 days, 2 time rows/)
})

test('OCR clock cells tolerate punctuation, dots and trailing text', () => {
  const text = [
    'HORA\tLUNES\tMARTES\tMIÉRCOLES',
    '- 10:00\tUno\tDos\tTres\t10:00',
    '10.00hs\tCuatro',
  ].join('\n')
  const { programs } = ocrTablePrograms(text)
  assert.equal(programs.length, 4)
  assert.ok(programs.every((entry) => entry.startMin === 600))
})

test('OCR wrapped lines merge into the cell above them', () => {
  const text = [
    'LUNES\tMARTES\tMIÉRCOLES',
    '09:30\tINFORMATIVO\tINFORMATIVO\tINFORMATIVO',
    'FARCO\tFARCO\tFARCO',
    '11:00\tALTA\tALTA\tALTA',
  ].join('\n')
  const { programs } = ocrTablePrograms(text)
  assert.equal(programs.length, 6)
  assert.equal(programs[0].title, 'INFORMATIVO FARCO')
  assert.equal(programs[1].title, 'INFORMATIVO FARCO')
})

test('an OCR page without a weekday header yields nothing', () => {
  const { programs, detail } = ocrTablePrograms('10:00\tUno\n11:00\tDos')
  assert.equal(programs.length, 0)
  assert.match(detail, /weekday header/)
})
