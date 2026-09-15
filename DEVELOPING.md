# Developing & integrating

This document covers `bundesrat-cli` as a **TypeScript library**, plus its
architecture, testing and release setup. If you just want to use the command-line
tool, start with the **[README](README.md)** and **[Usage.md](Usage.md)** instead.

The package ships both a CLI (`bundesrat`) and a typed API client
(`BundesratClient`) for the Bundesrat's public data feeds — the data behind the
official Bundesrat iOS app, served by `www.bundesrat.de`.

**Design goals**

- **Zero runtime HTTP dependencies** — built on Node's built-in `http`/`https`
  (no axios, no fetch polyfill) and a **hand-rolled, dependency-free XML parser**
  (no `fast-xml-parser`, no `xmldom`).
- **One small dependency** for the CLI: [`commander`](https://github.com/tj/commander.js).
- **Strongly typed** — typed `Member` / `AgendaItem` / `Session` / `Appointment`
  shapes over the parsed XML, projected to their openly-licensed factual fields.
- **Open data only** — each result is projected down to a whitelist of factual
  fields; the feeds' copyright-protected editorial content (HTML `detail`/biography
  fragments, teaser `abstract`s, images) and the wholly-editorial feeds (news,
  BundesratKOMPAKT, the Stimmverteilung graphic, the Präsidium/next-sitting pages)
  are **not** exposed. See [DATA_LICENSE.md](DATA_LICENSE.md).
- **Well tested** — unit tests on Node's built-in test runner (`node --test`),
  every HTTP response mocked. The XML parser has its own edge-case suite.

## The one thing to know: `?view=renderXml`

The Bundesrat feeds are served by a Government Site Builder CMS. **A plain GET of a
feed URL returns the website's HTML shell, not XML.** You only get XML by appending
the render parameter **`?view=renderXml`**:

```
https://www.bundesrat.de/iOS/SharedDocs/3_Plenum/plenum_aktuelleSitzung_table.xml?view=renderXml
```

The client adds this parameter to every request automatically. If a response ever
comes back as HTML anyway (the feed moved, or a proxy stripped the query), the
engine detects the `<!doctype html>` and throws a `BundesratParseError` with a
plain-language message rather than a cryptic parse failure. The upstream
[bund.dev spec](https://bundesrat.api.bund.dev) documents the paths but the render
parameter is easy to miss — this was confirmed by probing the live endpoints.

## Build from source

```bash
npm install
npm run build        # compiles TypeScript to dist/
```

Run the locally built CLI without a global install:

```bash
node dist/src/cli/index.js --help
# or, after `npm link`:
bundesrat --help
```

## Library usage

```ts
import { BundesratClient, BundesratParseError } from "@maschinenlesbar.org/bundesrat-cli";

const client = new BundesratClient();

const session = await client.session();     // { title, header, tops: [...] }
console.log(session.title, session.tops.length);
for (const top of session.tops) console.log(top.toptitle, top.topdrucksache);

const members = await client.members();      // Member[] (name, party, Land, flags)
const bavaria = members.filter((m) => m.state === "Bayern");

try {
  await client.appointments();               // Appointment[] (title, dates)
} catch (err) {
  if (err instanceof BundesratParseError) console.error(err.message);
}
```

### Client options

```ts
new BundesratClient({
  baseUrl: "https://www.bundesrat.de",
  timeoutMs: 15_000,
  maxRetries: 3,
  maxResponseBytes: 100 << 20, // the default (100 MiB); set to 0 for no limit
  userAgent: "my-app/1.0",
  transport: customTransport,
});
```

### Methods (one per open-data feed)

Only the three feeds that return open data are exposed. Each result is projected to
a whitelist of factual fields (`MEMBER_FIELDS` / `TOP_FIELDS` / `APPOINTMENT_FIELDS`
in `client.ts`); copyright editorial/image fields are dropped.

> **Maintenance:** the whitelists are fixed, so a *new* field the feed later serves is
> dropped silently — including a factual one. Revisit the lists in `client.ts` when the
> upstream feeds change; don't assume new fields flow through.

| Method | Feed | Returns |
|---|---|---|
| `session()` | current plenary sitting | `{ title?, header?, tops: AgendaItem[] }` |
| `members()` | members | `Member[]` (name, party, Land, status flags, url) |
| `appointments()` | Termine | `Appointment[]` (title, dates, url) |

The wholly-editorial feeds (news, BundesratKOMPAKT, Stimmverteilung, Präsidium,
next-sittings) are intentionally **not** methods — their payload is
copyright-protected editorial text or images, not open data (DATA_LICENSE.md).

## The XML parser

[`parseXml`](src/client/xml.ts) turns a feed document into a plain JS value:

- a leaf element → its (entity-decoded, trimmed) text;
- **CDATA content is kept verbatim** — not entity-decoded, not re-parsed (the
  `detail` fields hold HTML fragments in CDATA);
- an element with children → an object keyed by child tag name;
- **repeated siblings of the same name → an array** (a single occurrence stays a
  scalar/object — the client's `asArray` helper normalises 0/1/many);
- attributes → `@name` keys (only `<iOS version="…">` uses one);
- empty / self-closing elements → `""`.

It is deliberately **not** a general-purpose parser (no namespaces, DTDs, or full
mixed-content reconstruction) — just enough for these shallow feeds, and exercised
hard in [`test/xml.test.ts`](test/xml.test.ts).

## Architecture

```
src/
  client/
    xml.ts       # dependency-free XML parser + entity decoder
    types.ts     # Member / AgendaItem / Session / Appointment (open fields only)
    query.ts     # dependency-free query-string builder
    http.ts      # the Transport interface + default node:http/https transport
    engine.ts    # URL building, retry/backoff, XML decode + HTML-shell guard, errors
    errors.ts    # BundesratError / …ApiError / …NetworkError / …ValidationError / …ParseError
    client.ts    # BundesratClient — session/members/appointments + open-field projection
  cli/
    io.ts        # injectable I/O seam (stdout/stderr/file)
    shared.ts    # option parsers, global-option resolver, JSON renderer
    commands/    # feeds.ts — one command per feed (members has --state/--party)
    program.ts   # assembles the commander program from injectable deps
    run.ts       # parses argv -> exit code (no process.exit; testable)
    index.ts     # #! bin shim
```

**Two seams make the whole thing testable in-process (no subprocesses):**
`Transport` (the single HTTP function; tests inject a mock returning canned XML)
and `CliDeps` (a client factory + I/O object; `run.ts` returns an exit code
instead of calling `process.exit`).

### Error types

[`errors.ts`](src/client/errors.ts): `BundesratApiError` (non-2xx, carries
`status`/`detail`, with `isRetryable`/`isNotFound`), `BundesratNetworkError`
(transport failure/timeout), `BundesratParseError` (the body was not XML — usually
the HTML shell), and `BundesratValidationError` (a client-side usage error), all
extending `BundesratError`.

## Testing

```bash
npm test          # builds, then runs `node --test` over dist/test
```

- **`xml.test.ts`** — the XML parser: CDATA verbatim, entity decoding,
  repeated→array, single→scalar, attributes, empty/self-closing, real feed shapes.
- **`query.test.ts`** — query-string serialisation.
- **`http.test.ts`** — the default transport against a real loopback server.
- **`engine.test.ts`** — XML decoding, the HTML-shell guard, `429`/`503` retry,
  error mapping — mocked transport.
- **`client.test.ts`** — per-feed paths, the `view=renderXml` parameter, and the
  `asArray` normalisation — mocked transport.
- **`cli.test.ts`** — command parsing, the `members` `--state`/`--party` filters,
  `--output`, and exit codes — mocked client.

## Continuous integration

GitHub Actions workflows under `.github/workflows/`:

- **ci.yml** — type-check, build and test on Node 20/22/24 for every push and PR.
- **release.yml** — on a `v*` tag: verify the tag matches `package.json`, test,
  `npm pack`, and create a GitHub Release with the tarball.
- **publish.yml** — manual dispatch: publish to npm via OIDC **Trusted
  Publishing** (no stored `NPM_TOKEN`) with provenance.
- **docs.yml** — build the project website (`site/`, English and German) with the TypeDoc API docs
  under `/api/`, and deploy both to GitHub Pages on each `v*` tag.
  TypeDoc runs from the isolated, lockfile-pinned `tools/docs/` toolchain because it
  needs the TypeScript 6 compiler API, which TypeScript 7 no longer ships; locally,
  run `npm ci --prefix tools/docs` once before `npm run docs`.

## Website

The project website — <https://maschinenlesbar-org.github.io/bundesrat-cli/> in English and
<https://maschinenlesbar-org.github.io/bundesrat-cli/de/> in German — is built from `site/`
with [Jekyll](https://jekyllrb.com/), [banira](https://sebs.github.io/banira/) web components
and [Fylgja](https://fylgja.dev/) CSS, and deployed by `docs.yml` together with the TypeDoc API
reference under `/api/`. Its content comes from this repository: the README intro and quick
start, the command tree of the built CLI (`site/scripts/cli-reference.mjs`), `Usage.md`,
`GLOSSARY.md` and its German version `GLOSSARY.de.md`, the skills, and the skill examples in
`EXAMPLE.md` and `EXAMPLE.de.md`. The only repo-specific files are `site/_config.yml` and
`site/_data/project.yml` (the German intro and the access requirements); the rest of `site/` is
identical in every maschinenlesbar.org CLI, so change it in all of them together. When the
README intro changes, update the German intro in `site/_data/project.yml`.

```bash
npm run build                        # the CLI, for the command reference
cd site && npm ci && bundle install  # once (Node >= 22.12, Ruby 3.4, Bundler)
npm run serve                        # http://127.0.0.1:4000/bundesrat-cli/
```

## License

Dual-licensed under **[AGPL-3.0-or-later](LICENSE)** or a commercial license —
see **[LICENSING.md](LICENSING.md)**. This project does **not** accept external
code contributions; see **[CONTRIBUTING.md](CONTRIBUTING.md)**.
