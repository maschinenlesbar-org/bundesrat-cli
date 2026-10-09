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
engine detects the `<!doctype html>` / `<html>` (also behind an XML declaration or a
comment, and an XHTML `<html>` root) and throws a `BundesratParseError` with a
plain-language message rather than a cryptic parse failure. Any other XML that is not
`<iOS>` with exactly one `<list>` (an XML error envelope, a bare `<list>`, no `<list>`)
is a `BundesratParseError` too ("Unexpected response shape from <path>: expected …"),
so a broken feed never reads as an empty one; a real empty feed is `<iOS><list/></iOS>`. The upstream
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
import { BundesratClient, BundesratParseError, filterMembers } from "@maschinenlesbar.org/bundesrat-cli";

const client = new BundesratClient();

const session = await client.session();     // { title, header, tops: [...] }
console.log(session.title, session.tops.length);
for (const top of session.tops) console.log(top.toptitle, top.topdrucksache);

const members = await client.members();      // Member[] (name, party, Land, flags)
const bavaria = await client.members({ state: "Bayern" });  // same filter as --state
const greens = filterMembers(members, { party: "grüne" });   // on a list already fetched

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
  maxRetries: 3,               // 429/503 and resets; linear backoff, or a longer Retry-After (<= 30 s)
  maxResponseBytes: 100 << 20, // the default (100 MiB); set to 0 for no limit
  userAgent: "my-app/1.0",
  transport: customTransport,
});
```

`429`/`503` and reset connections (`ECONNRESET`, `EPIPE`, `ECONNABORTED`, undici's
`UND_ERR_SOCKET`, anywhere in the error's `cause` chain) are retried up to `maxRetries`
(`0`–`10` in the CLI); a refused connection, a DNS failure and a timeout are not. Each
retry waits `retryDelayMs * attempt` (200 ms × attempt by default), or a `429`/`503`'s
`Retry-After` — delay-seconds or an IMF-fixdate HTTP-date, parsed by `parseRetryAfter` —
when that is longer. **Retries never burst:** the backoff is the floor, so `Retry-After: 0`
or a date in the past no longer sends the retries back to back. A `Retry-After` longer
than `MAX_RETRY_AFTER_MS` (30 s) is not retried: the `BundesratApiError` surfaces at
once, names the requested wait and carries it as `retryAfterMs`.
`test/conformance-p6-retry-policy.test.ts` checks both.

The engine enforces the transport contract itself, so the limits hold for a custom
transport (a `fetch` wrapper, a raw `node:http` one) too: every call races a deadline of
`timeoutMs` and gets an `AbortSignal` (`HttpRequest.signal`, honoured by the default
transport) that fires then; the body it gets back is checked against `maxResponseBytes`
("Response exceeded the size limit of N bytes (maxResponseBytes; --max-response-bytes on
the CLI)"); headers are read from a plain object in any key case, a fetch `Headers` or a
`Map`; the body may be any ArrayBuffer view (a `Uint8Array` from `fetch`) or an
`ArrayBuffer`, from any realm, and is decoded by the feed's declared encoding like a
`Buffer`; a response without a valid status, headers object or byte body is a
`BundesratNetworkError`. `test/conformance-p5-transport-contract.test.ts` covers it.

The numeric options are validated in the constructor: `timeoutMs` 0..`MAX_TIMEOUT_MS`,
`maxRetries` 0..`MAX_RETRIES` (10), `retryDelayMs` 0..`MAX_RETRY_AFTER_MS`,
`maxResponseBytes` 0..`Number.MAX_SAFE_INTEGER`, integers only. Anything else (NaN,
negative, `Infinity`, fractional) throws a `BundesratValidationError` rather than
silently disabling the timeout or retrying for ever.

`baseUrl` is checked on the raw value, before trailing slashes are stripped, by the
exported `validateBaseUrl` (rule: `baseUrlProblem`, the same one the CLI's `--base-url`
uses). A blank value, surrounding or inner whitespace or control characters (`new URL()`
would hide them while the engine joins the raw string to each feed path, so
`"https://h/ "` would request `/%20/iOS/...`), an unparseable URL, a scheme other than
`http:`/`https:`, a query or fragment, and a `%` in the userinfo that isn't an escape
(Node would fail to decode it for the Authorization header; write `%25`) each throw a
`BundesratValidationError`
(`Invalid baseUrl: <reason>`) — a configuration error, not a `BundesratNetworkError`.
Only an omitted `baseUrl` selects the default.

A `user:password@` in the base URL (a mirror behind a login) never reaches the CLI's
output. `credentialsIn(value)` finds the exact userinfo of a URL, parseable or not, and
`redactCredentials(text, list)` replaces each `secret@` with `***@`; `redactUrl` falls
back to them for a value that doesn't parse. Only a value that starts with a scheme
counts (a bare `a:b@c` is a file name, a party name or a User-Agent as often as a
credential), except as the `--base-url` value, which is read as if it had one.
`run()` starts with `withRedactedOutput(deps, argv)`, which collects the credentials of
every argument (and of the value part of `--opt=value`, `redactionFor`) and redacts
every line printed on stdout and every log record on stderr — commander's usage errors
echo rejected values (`argument '…' is invalid`, `unknown command '…'`, `too many
arguments … got 1: …`). The forms a server echoes a userinfo back in are replaced too:
the `Basic` value and the decoded `user:password` on stdout and stderr, the password
alone (4 characters or more) on stderr only, since it may well occur in the data. The
log replaces them in each record's *message*, before the record is cut and escaped, and
writes it to the raw stderr: the frame (time, level, topic) is never touched, and a
password with DEL, C1 or bidi characters is matched in its raw form.
`test/conformance-p1-cli-redaction.test.ts` checks ten passwords in seven URL shapes at
nine argv positions (the schemeless shape as the `--base-url` value only).

A plain-`http:` base URL gets a warning, not a refusal. `cleartextProblem(baseUrl,
secrets)` (engine, exported) returns one sentence naming the host (`url.host`, never the
userinfo) and what travels unencrypted — the base URL's credentials when it carries
userinfo — or `undefined` for `https:`, an unparseable URL and loopback hosts
(`localhost`, `127.0.0.0/8`, `::1`). The CLI's `action()` wrapper (`shared.ts`,
`warnOnCleartext`) logs it once per run as a `WARN` record of `bundesrat.http` on stderr, after the
options are parsed and before the first request; `--help`, `--version` and usage errors
never get there. `test/conformance-p20-cleartext-warning.test.ts` checks it.

The library keeps them out of what a caller logs, too. The engine holds the base URL in
a real `#private` field (so `console.log(client)`, `util.inspect` and `JSON.stringify`
never show it) next to its userinfo, raw and percent-decoded, and the forms a server
echoes it back in (the `Basic` value, the decoded `user:password`, the password alone
from 4 characters: `echoedCredentialForms`), and scrubs them from error bodies
(`BundesratApiError.body`/`detail`), transport error text and the `cause` chain. `BundesratApiError.url` is the request URL with its userinfo redacted. Whatever
a custom transport throws (a string, fetch's `TypeError` naming the URL) reaches the
caller as a `BundesratNetworkError` with the original, scrubbed, as its `cause`.
`test/conformance-p2-library-redaction.test.ts` checks the client, nine failing
transports and five rejected base URLs.

`userAgent` and every `defaultHeaders` value are checked there too, with the same rule
as the CLI's `--user-agent` (`headerValueProblem`, also exported as
`assertHeaderValue(name, value)`): a blank value, a control character other than tab
(CR/LF would inject a header), DEL or a character above U+00FF throws a
`BundesratValidationError` before any request. Only an omitted `userAgent` selects the
default `bundesrat-cli`. `defaultHeaders` names must be HTTP tokens.

### Methods (one per open-data feed)

Only the three feeds that return open data are exposed. Each result is projected to
a whitelist of factual fields (`MEMBER_FIELDS` / `TOP_FIELDS` / `APPOINTMENT_FIELDS`
in `client.ts`); copyright editorial/image fields are dropped. The whitelist vouches
for a field's **plain text** only: a whitelisted element that holds markup
(`<topheader><p>…</p></topheader>`) or is repeated is dropped too, so inline
editorial HTML never passes as a nested object and every surfaced field is a
string. So is a field whose *text* holds markup — HTML inside CDATA
(`<title><![CDATA[<div class="abstract">…</div>]]></title>`, the form the feeds use for
all their editorial content) or escaped tags (`&lt;p&gt;`): the parser keeps CDATA
verbatim, so this used to pass as the field's text. A lone `<` in prose ("a < b") is not
a tag and stays. The one exception is `topdrucksache` (`REPEATABLE_FIELDS`): a TOP that covers
several Drucksachen repeats it, and each occurrence is a reference of its own, so their
plain texts are joined with `REPEAT_SEPARATOR` (`"; "`) — dropping them made the TOP
look like a procedural item. Attributes on a text element are ignored and its text is kept.

> **Maintenance:** the whitelists are fixed, so a *new* field the feed later serves is
> dropped silently — including a factual one. Revisit the lists in `client.ts` when the
> upstream feeds change; don't assume new fields flow through.

| Method | Feed | Returns |
|---|---|---|
| `session()` | current plenary sitting | `{ title?, header?, tops: AgendaItem[] }` |
| `members(filter?)` | members | `Member[]` (name, party, Land, status flags, url) |
| `appointments()` | Termine | `Appointment[]` (title, dates, url) |

`members({ state, party })` filters the full list the feed returns, exactly as the
CLI's `--state` / `--party` do: `state` names one of the sixteen Länder (`LAENDER`,
rule `stateProblem`) and matches it exactly, `party` a substring of the party name,
both trimmed and compared case-insensitively on the NFC form, and a member without the
field never matches. A key the filter doesn't have (`State`, `states`, a `__proto__` key
from `JSON.parse`), a state that is not a Land (`Thueringen`, `Bay`), and a blank or
non-string value each reject with `BundesratValidationError` before any request
(`Invalid filter: Unknown key "State"; expected one of state, party.`) — the misspelled
key used to be ignored and all 193 members came back. So is an unknown client option
(`timeout` for `timeoutMs`; the known ones are `ENGINE_OPTION_KEYS`). The same rule is
exported as the pure `filterMembers(list, filter)`. The CLI's `--state` uses the same
`stateProblem`, and an empty `--party` result gets a note on stderr, since the feed can't
tell "no such party" from "nobody". `test/conformance-p10-strict-filters.test.ts` checks
unknown keys, unknown Länder, arrays and NaN, and repeated `--state`/`--party` flags.

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

The engine decodes the body by the encoding it is declared in: a byte-order mark (UTF-8,
UTF-16), then the XML declaration's `encoding` (`encoding="ISO-8859-1"`), then the
Content-Type's `charset`, else UTF-8. The declaration comes before the header — the
reverse of RFC 7303 — because the CMS stamps `charset=utf-8` on every feed, so a
document that declares another encoding is the better witness. An encoding
`TextDecoder` doesn't know is a `BundesratParseError`; bytes invalid in the declared
encoding become U+FFFD.

It is deliberately **not** a general-purpose parser (no namespaces, DTDs, or full
mixed-content reconstruction) — just enough for these shallow feeds, and exercised
hard in [`test/xml.test.ts`](test/xml.test.ts).

The tokenizer is a single forward scan that finds every terminator with `indexOf`,
so parsing time is linear in the body size. An unterminated comment, CDATA section,
processing instruction, declaration, tag or attribute value is a parse error, and so
is nesting deeper than 512 levels. (A regex tokenizer once retried each unterminated
`<?` to the end of the input: 500 KB took 21 s.)

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
    validate.ts  # the Problem type + assertValid: input rules shared by library and CLI
    client.ts    # BundesratClient — session/members/appointments + open-field projection
  cli/
    io.ts        # injectable I/O seam (stdout/stderr/file), the logger and the clock
    log.ts       # the stderr log: records with ts, level, topic; --log-format text|jsonl
    shared.ts    # option parsers, global-option resolver, JSON renderer
    commands/    # feeds.ts — one command per feed (members has --state/--party)
    program.ts   # assembles the commander program from injectable deps
    run.ts       # parses argv -> exit code (no process.exit; testable)
    index.ts     # #! bin shim
```

**Closed pipes.** The bin shim installs `handleOutputErrors()` (`io.ts`) before `run()`:
an EPIPE on stdout (`| head`, a `jq` that exits early) exits 0 quietly; an EPIPE on
stderr is ignored, so a failed run keeps its own exit code (`2>&1 | true` must not turn
a usage error into 0); any other output error exits 1.
`test/conformance-p7-pipes-exit-codes.test.ts` runs the built bin for both.

**Two seams make the whole thing testable in-process (no subprocesses):**
`Transport` (the single HTTP function; tests inject a mock returning canned XML)
and `CliDeps` (a client factory + I/O object; `run.ts` returns an exit code
instead of calling `process.exit`).

### Error types

[`errors.ts`](src/client/errors.ts): `BundesratApiError` (non-2xx, carries
`status`/`detail`, with `isRetryable`/`isNotFound`), `BundesratNetworkError`
(transport failure/timeout, and the default transport's per-hop scheme check; a bad
configured `baseUrl` is a `BundesratValidationError` instead), `BundesratParseError` (the body was not a feed — usually
the HTML shell, or XML of the wrong shape), and `BundesratValidationError` (a rejected
input, thrown before any request), all extending `BundesratError`. A wrong-typed input is
that validation error too, never a raw `TypeError`: a non-object filter or options value
(`members("Bayern")`, `members(null)`, `new BundesratClient(null)`), a non-array list for
`filterMembers`, a `transport` or `sleep` that isn't a function. Echoed values and
server text are cut at 500 characters in messages (`cutForMessage`,
`MAX_MESSAGE_VALUE_LENGTH`: an option value, an unexpected root element's name, the
`--party` value the CLI's note quotes), a server's error text at 200, never inside a
surrogate pair (`cutText`), so the message stays well-formed and bounded for a library
caller too; the error's properties keep the full value. `test/conformance-p8-p9-p13-responses-and-errors.test.ts`
checks the declared charset (P8), the feed's document shape (P9) and twenty-one
wrong-typed calls (P13).

### Input validation

The library owns every rule about what a request may contain; the CLI calls the same
functions instead of keeping its own copy. A rule is a pure, exported `Problem`
([`validate.ts`](src/client/validate.ts)): it returns the reason a value is invalid, or
`undefined`. The library enforces it with `assertValid(name, value, problem)`, which
throws `BundesratValidationError` with the message `Invalid <name>: <reason>` before
any request (a constructor throws; a method returning a promise rejects). The CLI's
commander parsers turn the same reason into a usage error (exit 2), and `run.ts` maps a
`BundesratValidationError` raised during an action to exit 2 too, logged as an `ERROR`
record of `bundesrat.cli`.

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
- **`log.test.ts`** — the record helpers of `src/cli/log.ts` on their own
  (`escapeForRecord`, `formatLogRecord`); the CLI-level checks are P23's.
- **`validate.test.ts`** — `assertValid`, the `run.ts` mapping of
  `BundesratValidationError`, and the `parity()` helper (`test/helpers.ts`), which sends
  one input through `run()` and through the library on one recording mock transport so
  a test can assert both give the same outcome.
- **`conformance-*.test.ts`** — the shared checks of the 2026-10-05 fix patterns, the
  same files as in the other `*-cli` repos with only the adapter block at the top
  changed: P1 (no base-URL password in any CLI output), P2 (none in a logged client or
  error), P4 + P19 (base-URL validation; P19 is skipped, no environment variable), P5
  (`timeoutMs`, `maxResponseBytes`, headers, bodies and errors for any transport), P6
  (retry backoff and `Retry-After`), P7 (closed pipes and exit codes, on the built bin),
  P8 + P9 + P13 (declared charset, feed shape, wrong-typed input), P10 (strict filter
  keys and Länder), P12 (`-o -`), P20 (the stderr warning for a plain-`http:` base URL;
  the env-variable and other-secret cases are skipped: no environment variable, no key),
  P21 (the README's relative links: README.md ships to npmjs.com, so a link to a document
  the `files` allowlist leaves out must be an absolute GitHub URL), P23 (the log on
  stderr: record format, `--log-format jsonl`, no secret in either format).

## Continuous integration

GitHub Actions workflows under `.github/workflows/`:

- **ci.yml** — type-check, build and test on Node 22/24 for every push and PR.
- **release.yml** — on a `v*` tag: verify the tag matches `package.json`, test,
  `npm pack`, and create a GitHub Release with the tarball.
- **publish.yml** — manual dispatch from the release tag (`gh workflow run publish.yml --ref vX.Y.Z`; the version is the tag's): publish to npm via OIDC **Trusted
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

## The log on stderr

Every diagnostic line on stderr is a log record (`src/cli/log.ts`): a timestamp, a level
(`ERROR`, `WARN`, `INFO`) and a topic, `bundesrat.<area>`. `--log-format text` (the default)
writes it log4j style, `<ISO 8601 UTC> <LEVEL padded to 5> [<topic>] <message>`;
`--log-format jsonl` writes one JSON object per line with exactly `ts`, `level`, `topic`
and `msg`. A record is always one line: `formatLogRecord` runs `escapeForRecord` over
the message (text) or the whole JSON object (jsonl), which writes CR and LF as `\r`/`\n`,
every other C0 control but TAB, DEL and C1 as `\u00XX`, and U+2028, U+2029 and the bidi
controls as `\uXXXX`, so no text that reaches a record, by whatever path, can split it,
forge another one or steer the terminal. Before that a lone surrogate (half a
character, which jq rejects, stopping the whole stream) becomes U+FFFD (`toWellFormed`),
and a message longer than `MAX_RECORD_MESSAGE` (4000 characters, exported) is cut at a
code point and ends in `… (N more characters)`. The areas are `cli` (usage errors, commander's messages, unexpected errors, the
note on an empty `--party` result, a feed that does not parse), `api` (the server's answers,
and the hint after a 3xx), `http` (the connection, the size-cap hint, the cleartext warning)
and `output` (`Wrote N bytes` after `-o`). Code logs through `logOf(deps)` and never writes
diagnostics with `io.err` directly. `run()` builds the logger from argv before commander
parses it, so commander's own usage errors are records too: its `error: …` an ERROR of
`cli` (a `(Did you mean …?)` line joined to it), the help it shows after one an INFO
record per line, and the program run with options but no command an ERROR "missing
command: `bundesrat <subcommand>`" before that help, so every failed run has an ERROR
record (`writeCommanderErr`). The log is built with the run's redaction
(`withRedactedOutput`), which replaces a secret in the message only, before it
is escaped: the frame is never touched, and a secret is kept out of the log in either
format. `CliDeps.now` makes the
timestamps testable. stdout carries data only. Two lines are left raw, both written
straight to `process.stderr` outside `run()`: the bin shim's `Output error: …`
(`handleOutputErrors`, when stdout itself fails) and its last-resort `Unexpected error: …`
when `run()` itself rejects. Conformance test P23 checks all of this, and its body is
shared across the *-cli repos.
