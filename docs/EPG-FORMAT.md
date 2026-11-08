# RIOTSRADIOS EPG v2 Format Guide

## Overview

The Electronic Program Guide (EPG) tells the RIOTSRADIOS player what's playing on each station, when. This document describes the v2 format that stations should use when submitting their schedules.

## Key Principles

- **Use IDs**: Define each unique program once in the `shows` catalog and reference it by `show_id` in your daily grid. This avoids repeating the same title/category/url every day.
- **Wall-clock times**: Every program has `start` and `end` in 24-hour `"HH:MM"` format. No blocks, no math required.
- **Complete coverage**: List every slot for your broadcast hours, including filler music/off-air periods.

## JSON Structure

```json
{
  "version": "2.0",
  "station": "Station Name",
  "station_id": 1,
  "timezone": "Europe/Madrid",
  "last_updated": "2026-01-15",
  "source": "https://station.org/programacion",
  "contact": "programacion@station.org",
  "notes": "Optional notes about exceptions",
  "metadata": { ... },
  "shows": { ... },
  "days": [ ... ]
}
```

### Required Fields

| Field | Description |
|-------|-------------|
| `version` | Must be `"2.0"` |
| `station` | Human-readable station name |
| `station_id` | Integer matching the station id in `config/stations.csv` |
| `timezone` | IANA timezone (e.g., `Europe/Madrid`, `America/New_York`) |
| `days` | Array of 7 day objects (or fewer if partial schedule) |

### The `shows` Catalog (Recommended)

Define each unique program once:

```json
"shows": {
  "morning-show": {
    "title": "Morning Show",
    "category": "directo",
    "url": "https://...",
    "description": "Live morning program",
    "hosts": "Alice and Bob",
    "recurrence_note": "* Quincenal"
  }
}
```

### Daily Programs

Reference shows by ID:

```json
{
  "day": "monday",
  "label": "Lunes",
  "programs": [
    { "start": "08:00", "end": "10:00", "show_id": "morning-show", "live": true },
    { "start": "10:00", "end": "10:30", "title": "Música", "category": "musica" }
  ]
}
```

**Rules:**
- Use EITHER `show_id` OR `title`+`category` (not both)
- `start` and `end` are required ("HH:MM", 24h format)
- Times must not overlap within a day
- Cover your entire broadcast day (e.g., 00:00-24:00 or your operating hours)

## Validation

1. **Online**: Paste your JSON at [jsonschemavalidator.net](https://www.jsonschemavalidator.net/) and select `epg-schema.json`.
2. **CLI**: Run `node scripts/validate-epgs.js` from this repository.

## Categories

Common category keys and suggested labels:

| Key | Meaning (Spanish) |
|-----|-------------------|
| `musica` | Automated music (filler) |
| `directo` | Live broadcast |
| `podcast` | Pre-recorded / podcast |
| `especial` | Special / monograph |
| `taller` | Workshop / educational |

## Time Format

Use 24-hour format with leading zeros:
- `"00:00"` midnight
- `"13:30"` 1:30 PM
- `"23:59"` one minute before midnight

**Crossing midnight**: For shows ending at 00:00 (next day), use `"end": "00:00"` with `"crosses_midnight": true`. The validator allows this as a special case.

## File Naming

Save the file in `public/EPGs/` using a descriptive name (e.g., `radio-ejemplo.json`), then put that file name in the station's `epg_file` column in `config/stations.csv` (e.g., `99,Radio Ejemplo,ES,Europe/Madrid,...,radio-ejemplo.json`).

Run `node scripts/build-manifest.mjs` after validating. The manifest is what the app reads; it publishes a guide only for enabled stations whose `station_id` matches the config row. Generated guides are canonical; a hand-maintained file is retained only when it is the only guide for that station.

## Quick Example

```json
{
  "version": "2.0",
  "station": "Radio Ejemplo",
  "station_id": 99,
  "timezone": "Europe/Madrid",
  "days": [
    {
      "day": "monday",
      "programs": [
        { "start": "06:00", "end": "09:00", "title": "Música", "category": "musica" },
        { "start": "09:00", "end": "11:00", "show_id": "mañana-show", "live": true },
        { "start": "11:00", "end": "12:00", "title": "Música", "category": "musica" }
      ]
    }
  ],
  "shows": {
    "mañana-show": {
      "title": "Mañana Show",
      "category": "directo",
      "url": "https://ejemplo.org/mañana"
    }
  }
}
```

## Questions?

Email the RIOTSRADIOS maintainer or open a GitHub issue.