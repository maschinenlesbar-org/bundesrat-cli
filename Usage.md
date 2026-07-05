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
    { "toptitle": "TOP 67", "topdrucksache": "Drucksache 371/26", "topheader": "…", "topdetail": "<div>…</div>" }
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

> `topdetail` (and other `detail` fields elsewhere) contain **HTML fragments** kept
> verbatim from the feed. Use `jq -r` plus a stripper, or render them, as needed.

## `members` — the members of the Bundesrat

```bash
bundesrat members                      # everyone (~190, all Länder)
bundesrat members --state Bayern       # one Land (case-insensitive, exact match)
bundesrat members --party grüne        # party substring, case-insensitive
bundesrat members --state Hessen --party CDU
```

Each member carries `firstname`, `name`, `party`, `state`, the boolean-ish flags
`brmitglied` / `mitglied` / `bv` / `designiert` (as `"true"`/`"false"` strings),
and HTML `detail1`–`detail3` (role / biography / address).

```bash
# Names + parties for a Land
bundesrat members --state "Nordrhein-Westfalen" \
  | jq -r '.[] | "\(.firstname) \(.name) — \(.party)"'

# Party head-count across the whole Bundesrat
bundesrat members | jq -r 'group_by(.party)[] | "\(.[0].party): \(length)"'
```

Filtering is client-side, so an unmatched filter returns `[]` (not the full list).

## The other feeds

```bash
bundesrat next          # upcoming plenary sittings (dates are inside the HTML `detail`)
bundesrat compact        # BundesratKOMPAKT — selected TOPs with summaries (nested)
bundesrat composition    # seat/vote distribution (Stimmverteilung)
bundesrat presidium      # the Präsidium
bundesrat news           # current news / press items (Aktuelles)
bundesrat appointments   # committee appointments and dates (Termine)
```

Most of these return an **array of content items** (`type`, `id`, `url`, `title`,
`abstract`, `date`, and an HTML `detail`). `compact` returns a nested structure
(`header` + `tops` each with `subtop`s).

```bash
# Latest three headlines
bundesrat news | jq -r '.[:3][] | "\(.date)\t\(.title)"'

# Committee dates with start/stop
bundesrat appointments | jq -r '.[] | "\(.startdate // "")\t\(.title)"'
```

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
