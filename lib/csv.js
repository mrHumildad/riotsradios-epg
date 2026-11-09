/**
 * Minimal RFC 4180-style CSV parsing for the EPG catalog.
 *
 * Kept dependency-free: the converter, validator and manifest builder all run
 * with plain Node. Quoted fields, escaped quotes, embedded newlines, CRLF and a
 * UTF-8 BOM are supported.
 */

export function parseCsv(text) {
  const input = String(text ?? '').replace(/^\uFEFF/, '')
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false

  const endField = () => { row.push(field); field = '' }
  const endRow = () => { endField(); rows.push(row); row = [] }

  for (let i = 0; i < input.length; i++) {
    const char = input[i]

    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') { field += '"'; i++ }
        else inQuotes = false
      } else {
        field += char
      }
      continue
    }

    if (char === '"') { inQuotes = true; continue }
    if (char === ',') { endField(); continue }
    if (char === '\r') {
      if (input[i + 1] === '\n') continue
      endRow(); continue
    }
    if (char === '\n') { endRow(); continue }
    field += char
  }

  if (field !== '' || row.length > 0) endRow()
  return rows
}

/** Serialize one CSV field, quoting only when RFC 4180 requires it. */
export function formatCsvField(value) {
  const text = String(value ?? '')
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** Serialize one CSV row. */
export function formatCsvRow(values) {
  return values.map(formatCsvField).join(',')
}

/** Serialize a complete CSV document with a trailing newline. */
export function formatCsv(rows) {
  return `${rows.map(formatCsvRow).join('\n')}\n`
}

/** Turn the EPG config CSV into plain objects with a numeric `id`. */
export function parseStationRows(csvString) {
  const rows = parseCsv(csvString)
  if (rows.length === 0) return []
  const headers = rows[0].map((header) => header.trim())

  return rows.slice(1).map((values, index) => {
    const station = { _line: index + 2, _fieldCount: values.length }
    headers.forEach((header, idx) => {
      if (!header) return
      const value = (values[idx] ?? '').trim()
      station[header] = header === 'id' ? Number.parseInt(value, 10) : value
    })
    return station
  })
}
