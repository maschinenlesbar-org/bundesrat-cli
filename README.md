# bundesrat-cli

[![CI](https://github.com/maschinenlesbar-org/bundesrat-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/maschinenlesbar-org/bundesrat-cli/actions/workflows/ci.yml)
[![Release](https://github.com/maschinenlesbar-org/bundesrat-cli/actions/workflows/release.yml/badge.svg)](https://github.com/maschinenlesbar-org/bundesrat-cli/actions/workflows/release.yml)
[![npm](https://img.shields.io/npm/v/@maschinenlesbar.org/bundesrat-cli)](https://www.npmjs.com/package/@maschinenlesbar.org/bundesrat-cli)

Follow Germany's **Bundesrat** — the chamber of the sixteen Länder — from your
terminal. `bundesrat` is a command-line tool over the Bundesrat's public data
feeds (the data behind the official Bundesrat app): the current plenary sitting's
agenda and its Drucksachen, the members, the seat/vote distribution and more — as
clean JSON you can pipe straight into [`jq`](https://jqlang.github.io/jq/).

- **The current sitting's agenda** — every Tagesordnungspunkt (TOP) with its
  **Drucksache** number, in one command.
- **The members** — all Bundesrat members with party and Land, filterable by
  `--state` / `--party`.
- **No API key** — the feeds are public.
- **Clean JSON output** — pretty by default, `--compact` for scripting, `-o <file>`
  to write to disk.

> Want to use this as a TypeScript library, or curious how it parses the XML feeds
> with zero dependencies? See **[DEVELOPING.md](DEVELOPING.md)**.

## Install

```bash
npm i -g @maschinenlesbar.org/bundesrat-cli
```

This installs the **`bundesrat`** command. Requires **Node.js 20+**. No API key.

Check it works:

```bash
bundesrat session | jq '.title'
```

## Quickstart

```bash
# The current plenary sitting: title + agenda items with their Drucksachen
bundesrat session | jq '{title, tops: [.tops[] | {toptitle, topdrucksache, topheader}]}'

# Every member from Bavaria
bundesrat members --state Bayern | jq -r '.[] | "\(.firstname) \(.name) — \(.party)"'

# All Green members across the Länder
bundesrat members --party grüne | jq length

# Upcoming sitting dates
bundesrat next
```

## Commands

| Command | What it shows |
| --- | --- |
| `session` | Current plenary sitting: title, date and agenda items (TOPs) with their Drucksachen |
| `next` | Upcoming plenary sitting dates |
| `compact` | BundesratKOMPAKT — selected agenda items with summaries |
| `members` | Members of the Bundesrat (`--state <Land>`, `--party <text>`) |
| `composition` | Seat/vote distribution of the Bundesrat (Stimmverteilung) |
| `presidium` | The Präsidium |
| `news` | Current news / press items (Aktuelles) |
| `appointments` | Committee appointments and dates (Termine) |

New to terms like *TOP*, *Drucksache*, *Stimmverteilung* or *Präsidium*? The
**[Glossary](GLOSSARY.md)** decodes every one.

### `members` filters

| Option | Meaning |
| --- | --- |
| `--state <Land>` | Only members of that federal state — case-insensitive, exact Land match (e.g. `Bayern`, `Baden-Württemberg`) |
| `--party <text>` | Only members whose party contains this text — case-insensitive substring (e.g. `grüne`, `CDU`) |

Filtering happens client-side (the feed returns everyone), so both filters compose
and an unmatched filter yields `[]` rather than the full list.

## Output & scripting

Every command prints **JSON to stdout**; diagnostics go to stderr, so piping into
`jq` stays clean.

```bash
# How many agenda items in the current sitting?
bundesrat session | jq '.tops | length'

# Drucksachen on the agenda
bundesrat session | jq -r '.tops[].topdrucksache | select(.)'

# Members grouped by party
bundesrat members | jq -r 'group_by(.party)[] | "\(.[0].party): \(length)"'
```

Use `--compact` for single-line JSON and `-o <file>` to write to a file — both are
**global options** that work before or after the command.

**Exit codes** make the CLI easy to use in scripts:

| Code | Meaning |
| --- | --- |
| `0` | Success (also `--help` / `--version`) |
| `2` | Bad usage / invalid argument (nothing was sent) |
| `4` | Not found (`404` from the server) |
| `6` | Network / transport failure (DNS, connection, timeout, size cap) |
| `1` | Any other error — including a non-XML response (the feed returned the website's HTML shell) |

## Troubleshooting

- **`command not found: bundesrat`** — the global npm bin directory isn't on your
  `PATH`. Run `npm bin -g` to find it and add it, or run via
  `npx @maschinenlesbar.org/bundesrat-cli …`.
- **Exit `1` / "received an HTML page"** — the feed returned the website's HTML
  shell instead of XML (it may have moved). The CLI already adds the required
  `?view=renderXml` render parameter; if this persists, the upstream feed changed.
- **Empty `tops` between sittings** — outside an active sitting the agenda feed can
  be sparse; check `bundesrat next` for the upcoming dates.
- **A field holds HTML** — `detail`/`abstract`/`topdetail` carry HTML fragments
  verbatim (the feed embeds them); strip or render them as you see fit.

## Global options

Given **before or after** the command, e.g. `bundesrat --compact session`:

| Option | Description |
| --- | --- |
| `-V, --version` | Print the version number |
| `-h, --help` | Show help for the program or a command |
| `--compact` | Print JSON on a single line instead of pretty-printed |
| `-o, --output <file>` | Write output to this file instead of stdout |
| `--base-url <url>` | API base URL (default `https://www.bundesrat.de`) |
| `--timeout <ms>` | Per-request timeout (default `30000`) |
| `--user-agent <ua>` | `User-Agent` header value |
| `--max-retries <n>` | Retries for transient `429`/`503` responses (0..10, default `2`) |
| `--max-response-bytes <n>` | Cap response body size in bytes (`0` = unlimited; default 100 MiB) |

## Learn more

- **[SKILLS.md](SKILLS.md)** — Claude Code Agent Skills that drive this CLI.
- **[Usage.md](Usage.md)** — full use-case-driven cookbook.
- **[GLOSSARY.md](GLOSSARY.md)** — every domain term explained.
- **[DEVELOPING.md](DEVELOPING.md)** — TypeScript library usage, the XML parser, architecture, testing, CI.

## Data license

This CLI is a **client** — it accesses data it does not own or redistribute. The
upstream data is © the Bundesrat and licensed **separately from this tool's code**.
See **[DATA_LICENSE.md](DATA_LICENSE.md)**.

> **Bundesrat** — website content is **copyright-protected** (personal use only;
> commercial use / redistribution need permission), so cite "Quelle: Bundesrat"
> and don't republish editorial text or images without asking. The **Drucksachen
> and Plenarprotokolle** are *amtliche Werke* (§ 5 Abs. 2 UrhG) — free to reuse
> **unaltered** and **with a source citation**.

## License

**Dual-licensed** — use it under **either**:

- **[AGPL-3.0-or-later](LICENSE)** (default, free). Note the AGPL's §13 network
  clause: if you run a modified version as a network service, you must offer that
  modified source to the service's users.
- **Commercial license** (paid), for closed-source / proprietary or SaaS use
  without the AGPL's obligations.

See **[LICENSING.md](LICENSING.md)** for details, and **[CONTRIBUTING.md](CONTRIBUTING.md)**
for the contribution policy (this project does not accept external code
contributions). Commercial enquiries: **sebs@2xs.org**.
