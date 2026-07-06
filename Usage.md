# Usage

`bundesrat` — a CLI for the Bundesrat's public data feeds. This is the
use-case-driven cookbook; for the option reference see the **[README](README.md)**,
and for domain terms the **[Glossary](GLOSSARY.md)**. No API key is required.

```bash
bundesrat [global options] <command>
```

## Global options

| Option | Description |
|---|---|
| `--base-url <url>` | API base URL (only `http:`/`https:` accepted) |
| `--timeout <ms>` | per-request timeout in ms (0 = no timeout) |
| `--user-agent <ua>` | User-Agent header value |
| `--max-retries <n>` | retries for transient 429/503 responses (0..10) |
| `--max-response-bytes <n>` | cap the response body size in bytes (0 = unlimited; default 100 MiB) |
| `--compact` | print JSON on a single line (for piping to `jq`) |
| `-o, --output <file>` | write output to a file instead of stdout |
| `-V, --version` / `-h, --help` | version / help |

## `session` — the current plenary sitting

The heart of the tool: the current sitting's title, date, and every agenda item
(Tagesordnungspunkt / TOP) with its Drucksache.

```bash
bundesrat session
```

```json
{
  "title": "1067. Sitzung des Bundesrates | Tagesordnung Entwurf",
  "header": "am Freitag, dem 10. Juli 2026, 9:30 Uhr",
  "tops": [
    { "toptitle": "TOP 67", "topdrucksache": "Drucksache 371/26", "topheader": "…", "linkedtop": "" }
  ]
}
```

```bash
# Just the agenda, one line per TOP
bundesrat session | jq -r '.tops[] | "\(.toptitle)\t\(.topdrucksache // "—")\t\(.topheader)"'

# How many agenda items?
bundesrat session | jq '.tops | length'

# Every Drucksache on the agenda
bundesrat session | jq -r '.tops[].topdrucksache | select(.)'
```

> The agenda item's HTML description (`topdetail`) is copyright-protected editorial
> content and is **not** surfaced — only the factual TOP number, Drucksache and
> short header. See [DATA_LICENSE.md](DATA_LICENSE.md).

## `members` — the members of the Bundesrat

```bash
bundesrat members                      # everyone (~190, all Länder)
bundesrat members --state Bayern       # one Land (case-insensitive, exact match)
bundesrat members --party grüne        # party substring, case-insensitive
bundesrat members --state Hessen --party CDU
```

Each member carries `honorificTitle`, `firstname`, `name`, `party`, `state`, a `url`,
and the boolean-ish flags `brmitglied` / `mitglied` / `bv` / `designiert` (as
`"true"`/`"false"` strings). The feed's HTML biography (`detail`) and portrait image
(`imagePath`) are copyright-protected and are **not** surfaced (see
[DATA_LICENSE.md](DATA_LICENSE.md)).

```bash
# Names + parties for a Land
bundesrat members --state "Nordrhein-Westfalen" \
  | jq -r '.[] | "\(.firstname) \(.name) — \(.party)"'

# Party head-count across the whole Bundesrat
bundesrat members | jq -r 'group_by(.party)[] | "\(.[0].party): \(length)"'
```

Filtering is client-side, so an unmatched filter returns `[]` (not the full list).

## `appointments` — committee dates (Termine)

```bash
bundesrat appointments
```

Returns an **array of calendar items** with their factual fields: `type`, `id`,
`url`, `title`, `date`, `startdate` / `stopdate`. (The item's HTML `detail`/`abstract`
body and any image are copyright-protected and are not surfaced.)

```bash
# Committee dates with start/stop
bundesrat appointments | jq -r '.[] | "\(.startdate // "")\t\(.title)"'
```

> **Only open data is exposed.** The Bundesrat feeds also carry news/press items,
> the BundesratKOMPAKT editorial summaries, the Stimmverteilung graphic, and the
> Präsidium / next-sitting HTML pages — all copyright-protected editorial content,
> so this CLI does not provide commands for them. See [DATA_LICENSE.md](DATA_LICENSE.md).

## Scripting recipes

```bash
# Save the current agenda to a file (stdout stays clean; a note goes to stderr)
bundesrat --output agenda.json session

# Session title + agenda size in one compact line
bundesrat --compact session | jq -c '{title, n: (.tops|length)}'

# Which parties are represented, sorted
bundesrat members | jq -r '[.[].party] | unique[]'
```

## Exit codes

| Code | Meaning |
|---|---|
| `0` | success (help/version included); an empty feed also exits 0 |
| `1` | a runtime error — including a non-XML response (the feed returned the website's HTML shell) |
| `2` | usage error (bad flag, unknown command, bad `--base-url`) |
| `4` | HTTP 404 (not found) |
| `6` | network / transport failure (DNS, connection, timeout, response size-cap) |

## Notes

- **The feeds require `?view=renderXml`** to return XML; the CLI adds it for you.
  A `1` exit with "received an HTML page" means the feed changed upstream.
- **Data is © the Bundesrat and not openly licensed** — cite "Quelle: Bundesrat",
  and don't republish editorial texts/images without permission. The Drucksachen
  and Plenarprotokolle are *amtliche Werke* (free, unaltered, with source). See
  [DATA_LICENSE.md](DATA_LICENSE.md).
