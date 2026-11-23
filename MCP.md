# bundesrat-mcp

An [MCP](https://modelcontextprotocol.io/) server for the public feeds of the
[Bundesrat](https://www.bundesrat.de), the German federal council of the 16 Länder: the agenda of
the current plenary sitting with its Drucksachen, the committee dates, and the members by Land and
party, as tools for AI agents. Read-only, no API key, factual fields only.

It is the MCP side of [bundesrat-cli](https://github.com/maschinenlesbar-org/bundesrat-cli),
built on the same typed client, and released with it.

## Install

```bash
npm i -g @maschinenlesbar.org/bundesrat-mcp
```

This installs the **`bundesrat-mcp`** command (Node.js 22.12+). Or run the container
image, for linux/amd64 and linux/arm64, which needs no Node.js:

```bash
docker run -i --rm ghcr.io/maschinenlesbar-org/bundesrat-mcp:latest
```

## Connect a client

The server speaks MCP on stdio by default.

**Claude Code**

```bash
claude mcp add bundesrat -- bundesrat-mcp
# or with the image:
claude mcp add bundesrat -- docker run -i --rm ghcr.io/maschinenlesbar-org/bundesrat-mcp:latest
```

**Claude Desktop** (`claude_desktop_config.json`)

```json
{ "mcpServers": { "bundesrat": { "command": "bundesrat-mcp" } } }
```

**VS Code** (`.vscode/mcp.json`)

```json
{ "servers": { "bundesrat": { "type": "stdio", "command": "bundesrat-mcp" } } }
```

**Over HTTP** (Streamable HTTP, one endpoint `POST /mcp`):

```bash
bundesrat-mcp --transport http            # http://127.0.0.1:3000/mcp
claude mcp add --transport http bundesrat http://127.0.0.1:3000/mcp
```

In a container, publish the port on loopback only:
`docker run --rm -p 127.0.0.1:3000:3000 ghcr.io/maschinenlesbar-org/bundesrat-mcp:latest --transport http --host 0.0.0.0 --allowed-hosts localhost,127.0.0.1`.

For scripts and shared configs, pin a release and its digest from the
[release notes](https://github.com/maschinenlesbar-org/bundesrat-cli/releases) instead of
`latest`: `…/bundesrat-mcp:<version>@sha256:<digest>`. Check an image's provenance with
`gh attestation verify oci://ghcr.io/maschinenlesbar-org/bundesrat-mcp:<version> --repo maschinenlesbar-org/bundesrat-cli`.

## Tools

| Tool | What it answers |
|---|---|
| `getAgenda` | The current plenary sitting's agenda in TOP order, each item with its Drucksachen; whether it is still a draft. |
| `listAppointments` | The Bundesrat's and its committees' dates, sorted, as ISO times; cancelled dates counted and left out. |
| `findMembers` | The members by Land and party with head counts; full members only unless deputies are asked for. |

Every tool only reads. An answer is JSON (`structuredContent` and the same as text), with the
`source` it came from and the data licence. A failure is a tool error that says what to change.

## Options

```
--transport <stdio|http>   stdio (default), or Streamable HTTP on POST /mcp
--host <address>           HTTP: the address to listen on (default 127.0.0.1)
--port <n>                 HTTP: the port (default 3000)
--allowed-hosts <list>     HTTP: Host header names to answer (default localhost,127.0.0.1,[::1])
--allowed-origins <list>   HTTP: browser origins allowed to call, exactly (https://app.example.org); none by default
--auth-token-file <path>   HTTP: a file with the bearer token every request must send (mode 600, 32+ characters)
--base-url <url>           API base URL (default https://www.bundesrat.de)
--timeout <ms>             per upstream request (default 30000)
--call-timeout <ms>        per tool call, retries included (default 45000)
--max-result-chars <n>     cap on one tool result's JSON (default 25000)
--max-pages <n>            pages a tool reads per list and call (default 10)
--user-agent <ua>          User-Agent header value (Latin-1, one line)
--log-format <text|jsonl>  the log records on stderr (default text)
```

## What it does and doesn't do

- **Read-only.** No tool changes anything, here or upstream.
- **No authentication** on HTTP unless you give one. It listens on loopback by default; it checks
  the `Host` header and, from a browser, the `Origin` (only the origins given with
  `--allowed-origins`, matched exactly) against DNS rebinding and other web pages; a page on one
  of those origins gets CORS (its preflight answered, the answers readable). With
  `--auth-token-file <path>` every request must send `Authorization: Bearer <token>` (the file holds
  one token of at least 32 characters, mode 600, owned by the user the server runs as, a regular
  file (a FIFO is refused at once, never waited on); read once at start; `(umask 077; openssl rand
  -hex 32 > mcp-token)` makes one); anything else is answered 401.
  Exposed beyond localhost (it logs a warning then), it belongs behind a proxy that authenticates or
  at least terminates TLS.
- **Gentle with the upstream.** One server process sends at most 2 requests at a time and 120 a
  minute to the API, pauses on HTTP 429 (as long as its Retry-After asks, at most 30 s), and stops
  a tool call after its deadline (a tool that has read part of its answer by then may answer with
  that part, and says so). A request those limits would hold longer than it or its call may
  wait is not sent: the call fails at once, naming the limit and when to ask again (and the log says
  so).
- **Results are data.** Text from the API, keys included, is cleaned (control, bidi and
  zero-width characters removed), but it is still other people's text: a model can be told things
  in it. The server can't act on that (it has no tool that writes), but other tools in the same session could.
- **Stops cleanly.** On `docker stop` (SIGTERM) or Ctrl-C the HTTP server takes no new
  connection and lets calls in flight answer for up to 5 s, then exits 143 (130); a second signal
  ends it at once. On stdio a signal ends it at once; when stdin ends, it first answers the
  requests it has read (each within its call deadline), then exits.
- **In a container** it needs at least 12 processes and threads (`--pids-limit`) and about
  256 MB of memory.
- **Logs** go to stderr, one record per line; stdout carries only the protocol. A call that fails
  upstream or reaches its deadline leaves a WARN record naming the tool.
- **Never installs anything.**

## Licence

Code: AGPL-3.0-or-later or commercial
([LICENSING.md](https://github.com/maschinenlesbar-org/bundesrat-cli/blob/main/LICENSING.md)).
Data: the Bundesrat's Drucksachen and Plenarprotokolle are official works (§ 5 UrhG): reuse them
unchanged and cite "Quelle: Bundesrat". The rest of bundesrat.de is copyright-protected; the
server returns factual fields only, and running it as a service for others may need the
Bundesrat's permission ([DATA_LICENSE.md](https://github.com/maschinenlesbar-org/bundesrat-cli/blob/main/DATA_LICENSE.md)).
Every result carries this note in its `licence` field.
