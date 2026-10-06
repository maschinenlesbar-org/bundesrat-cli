# bundesrat-cli

[![CI](https://github.com/maschinenlesbar-org/bundesrat-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/maschinenlesbar-org/bundesrat-cli/actions/workflows/ci.yml)
[![Release](https://github.com/maschinenlesbar-org/bundesrat-cli/actions/workflows/release.yml/badge.svg)](https://github.com/maschinenlesbar-org/bundesrat-cli/actions/workflows/release.yml)
[![npm](https://img.shields.io/npm/v/@maschinenlesbar.org/bundesrat-cli)](https://www.npmjs.com/package/@maschinenlesbar.org/bundesrat-cli)

**Website:** [English](https://maschinenlesbar-org.github.io/bundesrat-cli/) · [Deutsch](https://maschinenlesbar-org.github.io/bundesrat-cli/de/) — command reference, guides and API docs

Follow Germany's **Bundesrat** — the chamber of the sixteen Länder — from your
terminal. `bundesrat` is a command-line tool over the Bundesrat's public data
feeds (the data behind the official Bundesrat app): the current plenary sitting's
agenda and its Drucksachen, the members, and committee dates — as clean JSON you
can pipe straight into [`jq`](https://jqlang.github.io/jq/).

- **The current sitting's agenda** — every Tagesordnungspunkt (TOP) with its
  **Drucksache** number, in one command.
- **The members** — all Bundesrat members with party and Land, filterable by
  `--state` / `--party`.
- **Open data only** — the CLI surfaces just the openly-licensed facts (names,
  parties, Länder, TOP/Drucksache numbers, dates). The feeds' copyright editorial
  text and images are deliberately not exposed — see [DATA_LICENSE.md](DATA_LICENSE.md).
- **No API key** — the feeds are public.
- **Clean JSON output** — pretty by default, `--compact` for scripting, `-o <file>`
  to write to disk.

> Want to use this as a TypeScript library, or curious how it parses the XML feeds
> with zero dependencies? See **[DEVELOPING.md](https://github.com/maschinenlesbar-org/bundesrat-cli/blob/main/DEVELOPING.md)**.

## Install

```bash
npm i -g @maschinenlesbar.org/bundesrat-cli
```

This installs the **`bundesrat`** command. Requires **Node.js 22.12+**. No API key.

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

# Committee appointments with their dates
bundesrat appointments | jq -r '.[] | "\(.startdate // "")\t\(.title)"'
```

## Commands

| Command | What it shows |
| --- | --- |
| `session` | Current plenary sitting: title, date and agenda items (TOPs) with their Drucksachen |
| `members` | Members of the Bundesrat (`--state <Land>`, `--party <text>`) |
| `appointments` | Committee appointments and dates (Termine) |

New to terms like *TOP*, *Drucksache* or *Land*? The **[Glossary](https://github.com/maschinenlesbar-org/bundesrat-cli/blob/main/GLOSSARY.md)**
decodes every one.

> **Why only three commands?** The Bundesrat feeds also carry news/press items, the
> BundesratKOMPAKT editorial summaries, the Stimmverteilung graphic, and the
> Präsidium / next-sitting HTML pages. Those return **copyright-protected editorial
> text and images**, not open data, so this CLI doesn't expose them (and strips the
> editorial fields — HTML `detail`, biographies, images — from the three it keeps).
> See [DATA_LICENSE.md](DATA_LICENSE.md).

### `members` filters

| Option | Meaning |
| --- | --- |
| `--state <Land>` | Only members of that federal state — one of the 16 Länder, case-insensitive, exact match (e.g. `Bayern`, `Baden-Württemberg`); any other value is a usage error (exit `2`) that lists them |
| `--party <text>` | Only members whose party contains this text — case-insensitive substring (e.g. `grüne`, `CDU`) |

Filtering happens client-side (the feed returns everyone), so both filters compose
and an unmatched `--party` yields `[]` (with a note on stderr) rather than the full list. Each takes one value;
giving one twice is a usage error (exit `2`) — run the command once per Land instead.

## Output & scripting

Every command prints **JSON to stdout**; diagnostics go to stderr, so piping into
`jq` stays clean.

```bash
# How many agenda items in the current sitting?
bundesrat session | jq '.tops | length'

# Drucksachen on the agenda
bundesrat session | jq -r '.tops[].topdrucksache | select(.) | split("; ")[]'

# Members grouped by party (mitglied marks the 69 members; the rest are deputies and plenipotentiaries)
bundesrat members | jq -r '[.[] | select(.mitglied == "true")] | group_by(.party)[] | "\(.[0].party // "no party given"): \(length)"'
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
| `1` | Any other error — including a response that is not a feed: the website's HTML shell, or XML that isn't `<iOS><list>…</list></iOS>` ("Unexpected response shape") |

## Troubleshooting

- **`command not found: bundesrat`** — the global npm bin directory isn't on your
  `PATH`. It is `$(npm prefix -g)/bin`; add that to your `PATH`, or run via
  `npx @maschinenlesbar.org/bundesrat-cli …`.
- **Exit `1` / "received an HTML page"** — the feed returned the website's HTML
  shell instead of XML (it may have moved). The CLI already adds the required
  `?view=renderXml` render parameter; if this persists, the upstream feed changed.
- **Exit `6` / `read ECONNRESET`** — the server dropped the connection. This
  happens now and then, and a reset is retried like a `429`/`503` (up to
  `--max-retries`, default `2`); exit `6` means every try failed. A refused
  connection, a DNS failure and a timeout are not retried.
- **Empty `tops` between sittings** — outside an active sitting the agenda feed can
  be sparse: `tops` may be `[]` and `session`'s `title`/`header` may be absent
  (both are optional), so guard for them in scripts.
- **A field you expected is missing** — the CLI surfaces only openly-licensed
  factual fields; the feeds' HTML `detail`/`abstract` bodies, biographies and images
  are stripped on purpose (see [DATA_LICENSE.md](DATA_LICENSE.md)).

## Global options

Given **before or after** the command, e.g. `bundesrat --compact session`:

| Option | Description |
| --- | --- |
| `-V, --version` | Print the version number |
| `-h, --help` | Show help for the program or a command |
| `--compact` | Print JSON on a single line instead of pretty-printed |
| `-o, --output <file>` | Write output to this file instead of stdout (`-` = stdout) |
| `--base-url <url>` | API base URL (default `https://www.bundesrat.de`; `http:`/`https:` only, no query, fragment or whitespace; a literal `%` in a password is written `%25`). A `user:password@` in it is sent as Basic auth and shown as `***@` in every message |
| `--timeout <ms>` | Time limit per request, reading the whole response included (default `30000`; `0` = none; at most `2147483647`). It bounds each attempt; the waits between retries come on top |
| `--user-agent <ua>` | `User-Agent` header value |
| `--max-retries <n>` | Retries for transient `429`/`503` responses and reset connections (0..10, default `2`). Each waits 200 ms × attempt, or a `429`/`503`'s `Retry-After` (seconds or HTTP-date) when that is longer; a `Retry-After` above 30 s is not retried, and the error names the requested wait |
| `--max-response-bytes <n>` | Cap response body size in bytes (`0` = unlimited; default 100 MiB) |

A base URL on plain `http:` to a host other than loopback (`localhost`, `127.0.0.0/8`,
`::1`) works, but the CLI writes one line to stderr before the first request, e.g.
`warning: requests to mirror.example are sent unencrypted (http:, not https:)`, or
`warning: the base URL's credentials are sent unencrypted to mirror.example (http:, not https:)`
when it carries a `user:password@` (never printed). stdout, `-o` files and the exit code
are unchanged.

## Learn more

- **[SKILLS.md](https://github.com/maschinenlesbar-org/bundesrat-cli/blob/main/SKILLS.md)** — Claude Code Agent Skills that drive this CLI.
- **[Usage.md](https://github.com/maschinenlesbar-org/bundesrat-cli/blob/main/Usage.md)** — full use-case-driven cookbook.
- **[GLOSSARY.md](https://github.com/maschinenlesbar-org/bundesrat-cli/blob/main/GLOSSARY.md)** — every domain term explained.
- **[DEVELOPING.md](https://github.com/maschinenlesbar-org/bundesrat-cli/blob/main/DEVELOPING.md)** — TypeScript library usage, the XML parser, architecture, testing, CI.

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
