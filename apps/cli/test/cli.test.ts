import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactionFor, run } from "../src/cli/run.js";
import { buildProgram } from "../src/cli/program.js";
import { forbidRepeatedOptions } from "../src/cli/shared.js";
import { BundesratClient } from "@maschinenlesbar.org/bundesrat-client/internal/client";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "@maschinenlesbar.org/bundesrat-client/internal/http";
import { makeMockTransport, xmlResponse, rawResponse, untimed } from "./helpers.js";
import * as fx from "@maschinenlesbar.org/bundesrat-client/test/fixtures";
import { credentialsIn } from "@maschinenlesbar.org/bundesrat-client/internal/errors";

function makeCli(responder: (req: HttpRequest) => HttpResponse) {
  const out: string[] = [];
  const err: string[] = [];
  const files: Record<string, Buffer> = {};
  const mt = makeMockTransport(responder);
  const deps: CliDeps = {
    io: {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
    },
    createClient: (opts) => new BundesratClient({ ...opts, transport: mt.transport }),
    // An in-memory file system for -o: every path is free.
    files: {
      state: () => "absent",
      parentProblem: () => undefined,
      write: (p, d) => {
        files[p] = d;
      },
    },
  };
  return { deps, out, err, mt, files };
}

test("session renders JSON and hits the session feed with view=renderXml", async () => {
  const cli = makeCli(() => xmlResponse(fx.sessionXml));
  const code = await run(["session"], cli.deps);
  assert.equal(code, 0);
  assert.match(cli.mt.last().url, /plenum_aktuelleSitzung_table\.xml\?view=renderXml/);
  const parsed = JSON.parse(cli.out.join("\n")) as { tops: unknown[] };
  assert.equal(parsed.tops.length, 2);
});

test("members lists everyone by default", async () => {
  const cli = makeCli(() => xmlResponse(fx.membersXml));
  await run(["members"], cli.deps);
  assert.equal((JSON.parse(cli.out.join("\n")) as unknown[]).length, 2);
});

test("members --state filters case-insensitively (exact Land match)", async () => {
  const cli = makeCli(() => xmlResponse(fx.membersXml));
  await run(["members", "--state", "bayern"], cli.deps);
  const rows = JSON.parse(cli.out.join("\n")) as Array<{ name: string }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.name, "Söder");
});

test("members --party filters by substring, case-insensitively", async () => {
  const cli = makeCli(() => xmlResponse(fx.membersXml));
  await run(["members", "--party", "grüne"], cli.deps);
  const rows = JSON.parse(cli.out.join("\n")) as Array<{ name: string }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.name, "Özdemir");
});

test("members --state with no match returns an empty array (not everyone)", async () => {
  const cli = makeCli(() => xmlResponse(fx.membersXml));
  await run(["members", "--state", "Hamburg"], cli.deps);
  assert.deepEqual(JSON.parse(cli.out.join("\n")), []);
});

test("members --state that names no Land is a usage error listing the Länder, before any request", async () => {
  for (const state of ["Thueringen", "Bay", "Baden Württemberg"]) {
    const cli = makeCli(() => xmlResponse(fx.membersXml));
    assert.equal(await run(["members", "--state", state], cli.deps), 2, state);
    assert.match(cli.err.join("\n"), /Not a Land; expected one of Baden-Württemberg, Bayern, .*Thüringen\./);
    assert.equal(cli.mt.calls.length, 0);
  }
});

test("members --party that matches nothing prints [] and a note on stderr naming the filter", async () => {
  const cli = makeCli(() => xmlResponse(fx.membersXml));
  assert.equal(await run(["members", "--party", "Piraten"], cli.deps), 0);
  assert.deepEqual(JSON.parse(cli.out.join("\n")), []);
  assert.match(untimed(cli.err.join("\n")), /^INFO  \[bundesrat\.cli\] no member has a party containing "Piraten"/);
  const quiet = makeCli(() => xmlResponse(fx.membersXml));
  await run(["members", "--state", "Hamburg"], quiet.deps);
  assert.deepEqual(quiet.err, []);
});

test("appointments works and returns projected calendar items (no editorial body)", async () => {
  const cli = makeCli(() => xmlResponse(fx.appointmentsXml));
  const code = await run(["appointments"], cli.deps);
  assert.equal(code, 0);
  const rows = JSON.parse(cli.out.join("\n")) as Array<Record<string, unknown>>;
  assert.equal(rows[0]!["title"], "Sitzung des Vermittlungsausschusses");
  assert.equal(rows[0]!["detail"], undefined);
});

test("the removed editorial commands are no longer registered (exit 2, no request)", async () => {
  for (const cmd of ["news", "composition", "next", "compact", "presidium"]) {
    const cli = makeCli(() => xmlResponse(fx.membersXml));
    assert.equal(await run([cmd], cli.deps), 2, `${cmd} should be an unknown command`);
    assert.equal(cli.mt.calls.length, 0, `${cmd} should make no request`);
  }
});

test("the HTML shell (lost render param) exits 1 with a helpful message", async () => {
  const cli = makeCli(() => rawResponse(fx.htmlShell, "text/html"));
  const code = await run(["session"], cli.deps);
  assert.equal(code, 1);
  assert.match(cli.err.join("\n"), /HTML page/);
});

test("a 404 exits 4", async () => {
  const cli = makeCli(() => rawResponse("<!doctype html>nope", "text/html", 404));
  assert.equal(await run(["members"], cli.deps), 4);
});

test("a server 3xx exits 1 (runtime) with a base-url hint, not usage (2)", async () => {
  const cli = makeCli(() => rawResponse("", "text/html", 302));
  const code = await run(["members"], cli.deps);
  assert.equal(code, 1);
  assert.match(untimed(cli.err.join("\n")), /^ERROR \[bundesrat\.api\] .*\nINFO  \[bundesrat\.api\] the server redirected \(3xx\) — check --base-url/);
});

test("--compact prints single-line JSON", async () => {
  const cli = makeCli(() => xmlResponse(fx.membersXml));
  await run(["members", "--compact"], cli.deps);
  assert.equal(cli.out.length, 1);
});

test("DEL and C1 control characters in server data are escaped in the JSON output", async () => {
  // Numeric character references reach the parsed feed values as the raw characters.
  const controls = String.fromCharCode(0x7f, 0x85, 0x9b) + "2J";
  const xml = `<?xml version="1.0"?>
<iOS version="1.0"><list><employee>
  <name>Rat&#127;&#133;&#155;2J</name>
  <party>&#27;[31m</party>
  <state>Bayern</state>
</employee></list></iOS>`;
  for (const format of [[], ["--compact"]]) {
    const cli = makeCli(() => xmlResponse(xml));
    assert.equal(await run([...format, "members"], cli.deps), 0);
    const text = cli.out.join("\n");
    const raw = [...text].filter((c) => c.charCodeAt(0) < 0x20 ? c !== "\n" : c.charCodeAt(0) >= 0x7f && c.charCodeAt(0) <= 0x9f);
    assert.deepEqual(raw, [], format.join(" "));
    assert.match(text, /Rat\\u007f\\u0085\\u009b2J/);
    assert.deepEqual(JSON.parse(text), [{ name: `Rat${controls}`, party: String.fromCharCode(0x1b) + "[31m", state: "Bayern" }]);
  }
});

test("--output writes to a file and keeps stdout clean", async () => {
  const cli = makeCli(() => xmlResponse(fx.membersXml));
  await run(["--output", "/tmp/out.json", "members"], cli.deps);
  assert.equal(cli.out.length, 0);
  assert.ok(cli.files["/tmp/out.json"]);
  assert.match(untimed(cli.err.join("\n")), /^INFO  \[bundesrat\.output\] Wrote \d+ bytes to \/tmp\/out\.json$/);
});

test("a --output write failure reports a clean error (exit 1), not 'Unexpected error'", async () => {
  const out: string[] = [];
  const err: string[] = [];
  const mt = makeMockTransport(() => xmlResponse(fx.membersXml));
  const deps: CliDeps = {
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    createClient: (opts) => new BundesratClient({ ...opts, transport: mt.transport }),
    files: {
      state: () => "absent",
      parentProblem: () => undefined,
      write: () => {
        throw new Error('Could not write to "/tmp/x": EISDIR: illegal operation on a directory');
      },
    },
  };
  const code = await run(["--output", "/tmp/x", "members"], deps);
  assert.equal(code, 1);
  assert.match(untimed(err.join("\n")), /^ERROR \[bundesrat\.output\] Could not write to "\/tmp\/x": EISDIR/);
  assert.doesNotMatch(err.join("\n"), /Unexpected error/);
  assert.equal(out.length, 0); // nothing leaked to stdout
});

test("a control character in --user-agent is rejected (exit 2), no request", async () => {
  const cli = makeCli(() => xmlResponse(fx.membersXml));
  const code = await run(["members", "--user-agent", "bad\r\nX-Injected: 1"], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
});

test("an empty --base-url is rejected (exit 2), no request", async () => {
  const cli = makeCli(() => xmlResponse(fx.membersXml));
  const code = await run(["--base-url", "", "members"], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
});

test("a non-http --base-url is rejected (exit 2)", async () => {
  const cli = makeCli(() => xmlResponse(fx.membersXml));
  assert.equal(await run(["--base-url", "ftp://x/y", "members"], cli.deps), 2);
});

test("--max-retries above the sane maximum is rejected (exit 2)", async () => {
  const cli = makeCli(() => xmlResponse(fx.membersXml));
  assert.equal(await run(["--max-retries", "1000", "members"], cli.deps), 2);
});

test("--timeout accepts up to the largest timer Node supports", async () => {
  const cli = makeCli(() => xmlResponse(fx.membersXml));
  assert.equal(await run(["--timeout", "2147483647", "members"], cli.deps), 0);
  assert.equal(cli.mt.last().timeoutMs, 2_147_483_647);

  const over = makeCli(() => xmlResponse(fx.membersXml));
  assert.equal(await run(["--timeout", "2147483648", "members"], over.deps), 2);
  assert.equal(over.mt.calls.length, 0);
  assert.match(over.err.join("\n"), /Must be <= 2147483647/);
});

test("a bare invocation prints help and exits 0", async () => {
  const cli = makeCli(() => xmlResponse(fx.membersXml));
  const code = await run([], cli.deps);
  assert.equal(code, 0);
  assert.match(cli.out.join("\n"), /Usage: bundesrat/);
});

test("an unknown command exits 2", async () => {
  const cli = makeCli(() => xmlResponse(fx.membersXml));
  assert.equal(await run(["boguscmd"], cli.deps), 2);
});

test("an XML error envelope is exit 1, not an empty success", async () => {
  const cli = makeCli(() => xmlResponse("<?xml version=\"1.0\"?><error><message>Internal CMS error</message></error>"));
  assert.equal(await run(["--compact", "appointments"], cli.deps), 1);
  assert.deepEqual(cli.out, []);
  assert.match(cli.err.join("\n"), /unexpected response shape: expected an <iOS> root element, got <error>/);
});

test("a --base-url with a query, a fragment or surrounding whitespace is a usage error", async () => {
  for (const [baseUrl, message] of [
    ["http://127.0.0.1:18105/ok?x", /cannot have a query \(\?\) or fragment \(#\)/],
    ["http://127.0.0.1:18105/ok#x", /cannot have a query \(\?\) or fragment \(#\)/],
    ["http://127.0.0.1:18105?", /cannot have a query \(\?\) or fragment \(#\)/],
    [" https://www.bundesrat.de", /cannot have surrounding whitespace/],
    ["https://www.bundesrat.de\t", /cannot have surrounding whitespace/],
  ] as const) {
    const cli = makeCli(() => xmlResponse(fx.membersXml));
    assert.equal(await run(["--base-url", baseUrl, "members"], cli.deps), 2, baseUrl);
    assert.equal(cli.mt.calls.length, 0, baseUrl);
    assert.match(cli.err.join("\n"), message, baseUrl);
  }
});

test("a --base-url with a path prefix still works", async () => {
  const cli = makeCli(() => xmlResponse(fx.membersXml));
  assert.equal(await run(["--base-url", "https://mirror.example/br/", "members"], cli.deps), 0);
  assert.equal(
    cli.mt.last().url,
    "https://mirror.example/br/iOS/SharedDocs/2_Mitglieder/mitglieder_table.xml?view=renderXml",
  );
});

test("a --user-agent with control or non-Latin-1 characters is a usage error, no request", async () => {
  for (const [ua, message] of [
    ["日本", /outside Latin-1/],
    ["a\r\nX-Evil: 1", /control characters/],
  ] as const) {
    const cli = makeCli(() => xmlResponse(fx.sessionXml));
    assert.equal(await run(["--user-agent", ua, "session"], cli.deps), 2, ua);
    assert.equal(cli.mt.calls.length, 0, ua);
    assert.match(cli.err.join("\n"), message, ua);
  }
  const ok = makeCli(() => xmlResponse(fx.sessionXml));
  assert.equal(await run(["--user-agent", "bot\tmüller/1.0", "session"], ok.deps), 0);
  assert.equal(ok.mt.last().headers?.["User-Agent"], "bot\tmüller/1.0");
});

test("a blank --user-agent is a usage error, not a silent fallback to the default", async () => {
  for (const ua of ["", "   "]) {
    const cli = makeCli(() => xmlResponse(fx.sessionXml));
    assert.equal(await run(["--user-agent", ua, "session"], cli.deps), 2, JSON.stringify(ua));
    assert.equal(cli.mt.calls.length, 0);
    assert.match(cli.err.join("\n"), /Expected a non-empty value/);
  }
});

test("-o with a blank path is a usage error; -o - writes to stdout, not a file named '-'", async () => {
  for (const path of ["", " "]) {
    const cli = makeCli(() => xmlResponse(fx.membersXml));
    assert.equal(await run(["-o", path, "members"], cli.deps), 2, JSON.stringify(path));
    assert.equal(cli.mt.calls.length, 0);
    assert.deepEqual(cli.files, {});
    assert.match(cli.err.join("\n"), /Expected a non-empty value/);
  }
  const cli = makeCli(() => xmlResponse(fx.membersXml));
  assert.equal(await run(["--compact", "-o", "-", "members"], cli.deps), 0);
  assert.deepEqual(cli.files, {});
  assert.equal((JSON.parse(cli.out.join("\n")) as unknown[]).length, 2);
  assert.doesNotMatch(cli.err.join("\n"), /Wrote/);
});

test("credentials in --base-url are redacted in error messages but still sent", async () => {
  const cli = makeCli(() => rawResponse("Not found here", "text/plain", 404));
  assert.equal(await run(["--base-url", "http://user:s3cret@127.0.0.1:18105/404", "session"], cli.deps), 4);
  const err = cli.err.join("\n");
  assert.doesNotMatch(err, /s3cret|user:/);
  assert.match(err, /HTTP 404 for GET http:\/\/\*\*\*@127\.0\.0\.1:18105\/404\/iOS\//);
  assert.match(cli.mt.last().url, /^http:\/\/user:s3cret@127\.0\.0\.1:18105\//);
});

test("bidi controls are stripped from stderr error text and escaped in JSON output", async () => {
  const rlo = String.fromCharCode(0x202e);
  const bad = makeCli(() =>
    rawResponse(`${String.fromCharCode(0x1b)}]8;;http://evil${String.fromCharCode(7)}click ${rlo}evil\nError: forged`, "text/plain", 404),
  );
  assert.equal(await run(["session"], bad.deps), 4);
  const err = bad.err.join("\n");
  assert.equal([...err].some((c) => c.charCodeAt(0) === 0x202e || c.charCodeAt(0) === 0x1b), false);
  assert.match(err, /: \]8;;http:\/\/evilclick evil Error: forged$/m);

  const xml = `<iOS><list><employee><name>A&#x202E;B&#x2066;C</name></employee></list></iOS>`;
  const ok = makeCli(() => xmlResponse(xml));
  assert.equal(await run(["--compact", "members"], ok.deps), 0);
  assert.equal(ok.out.join("\n"), '[{"name":"A\\u202eB\\u2066C"}]');
});

test("a parse error names the parser's reason", async () => {
  for (const [body, reason] of [
    [`<iOS>${"<x>".repeat(600)}`, /: XML nesting too deep \(exceeded 512 levels\)$/],
    ["<iOS><list><top><toptitle>TOP 1</toptitle><topheader", /: Unterminated tag <topheader> at offset \d+$/],
  ] as const) {
    const cli = makeCli(() => xmlResponse(body));
    assert.equal(await run(["session"], cli.deps), 1);
    assert.match(untimed(cli.err.join("\n")), /^ERROR \[bundesrat\.api\] GET https:\/\/www\.bundesrat\.de\/iOS\/SharedDocs\/3_Plenum\/plenum_aktuelleSitzung_table\.xml\?view=renderXml: the answer is not valid XML: /);
    assert.match(cli.err.join("\n"), reason);
  }
});

test("--state / --party match a decomposed (NFD) umlaut against the feed's composed one", async () => {
  const cli = makeCli(() => xmlResponse(fx.membersXml));
  assert.equal(await run(["members", "--state", "Baden-Württemberg", "--party", "grüne"], cli.deps), 0);
  const rows = JSON.parse(cli.out.join("\n")) as Array<{ name: string }>;
  assert.deepEqual(rows.map((r) => r.name), ["Özdemir"]);
});

test("a single-value option given twice is a usage error before any request, never last-one-wins (K5)", async () => {
  const cases: Array<[string[], string]> = [
    [["members", "--state", "Bayern", "--state", "Hessen"], "--state"],
    [["members", "--party", "CDU", "--party", "SPD"], "--party"],
    [["--timeout", "1000", "--timeout", "0", "session"], "--timeout"],
    [["session", "--timeout", "1000", "--timeout", "0"], "--timeout"],
    [["--base-url", "https://a.example", "--base-url", "https://b.example", "session"], "--base-url"],
    [["--log-format", "text", "--log-format", "jsonl", "session"], "--log-format"],
    [["--user-agent", "a", "--user-agent", "b", "session"], "--user-agent"],
    [["--max-retries", "1", "--max-retries", "2", "session"], "--max-retries"],
    [["--max-response-bytes", "1", "--max-response-bytes", "2", "session"], "--max-response-bytes"],
    [["-o", "-", "--output", "-", "session"], "--output"],
  ];
  for (const [args, flag] of cases) {
    const cli = makeCli(() => xmlResponse(fx.membersXml));
    assert.equal(await run(args, cli.deps), 2, args.join(" "));
    assert.equal(cli.mt.calls.length, 0, `${args.join(" ")} sent a request`);
    // The record is text, or jsonl where the argv scan already read --log-format jsonl.
    const first = untimed(cli.err[0] ?? "");
    const record = first.startsWith("{") ? (JSON.parse(first) as { level: string; topic: string; msg: string }) : undefined;
    const line = record === undefined ? first : `${record.level} [${record.topic}] ${record.msg}`;
    assert.match(line, new RegExp(`^ERROR \\[bundesrat\\.cli\\] .*${flag} may be given only once\\.$`), args.join(" "));
  }
  // A flag may repeat.
  const cli = makeCli(() => xmlResponse(fx.sessionXml));
  assert.equal(await run(["--compact", "--compact", "session"], cli.deps), 0);
});

test("a command's --help lists the global options too", async () => {
  const cli = makeCli(() => xmlResponse(fx.sessionXml));
  assert.equal(await run(["session", "--help"], cli.deps), 0);
  const help = cli.out.join("\n");
  assert.match(help, /Global Options:/);
  for (const flag of ["--compact", "-o, --output <file>", "--timeout <ms>", "--base-url <url>"]) {
    assert.ok(help.includes(flag), flag);
  }
});

test("the --party note quotes the value at most 500 characters long (L3)", async () => {
  const cli = makeCli(() => xmlResponse(fx.membersXml));
  assert.equal(await run(["members", "--party", "Q".repeat(100_000)], cli.deps), 0);
  const record = cli.err.find((line) => line.includes("no member has a party containing")) ?? "";
  // quoteValue: the "…" after the closing quote, so it doesn't read as part of the value.
  assert.match(record, /containing "Q{500}"… \(--party/);
  assert.ok(record.length < 700, `${record.length}`);
});

test("an a:b@c argument (a User-Agent, an -o path) is neither a credential in the log nor rewritten in the JSON on stdout (L14)", async () => {
  const xml = fx.appointmentsXml.replace("Sitzung des Vermittlungsausschusses", "run:2026-10-09@x");
  const cli = makeCli(() => xmlResponse(xml));
  assert.equal(await run(["--user-agent", "run:2026-10-09@x", "appointments"], cli.deps), 0);
  assert.match(cli.out.join("\n"), /"title": "run:2026-10-09@x"/);
  const written = makeCli(() => xmlResponse(xml));
  assert.equal(await run(["-o", "run:2026-10-09@x.json", "appointments"], written.deps), 0);
  assert.match(untimed(written.err.join("\n")), /^INFO  \[bundesrat\.output\] Wrote \d+ bytes to run:2026-10-09@x\.json$/);
  assert.match(written.files["run:2026-10-09@x.json"]?.toString() ?? "", /"title": "run:2026-10-09@x"/);
  assert.deepEqual(credentialsIn("run:2026-10-09@x"), []);
  assert.deepEqual(credentialsIn("https://alice:pw@host"), ["alice:pw"]);
});

test("commander's output is one record per line, and a run without a command has an ERROR (L5)", async () => {
  // Options but no command: commander shows the help as an error.
  const none = makeCli(() => xmlResponse(fx.membersXml));
  assert.equal(await run(["--compact"], none.deps), 2);
  const lines = none.err.map(untimed);
  assert.equal(lines[0], "ERROR [bundesrat.cli] missing command: `bundesrat <subcommand>`");
  assert.ok(lines.slice(1).every((line) => line.startsWith("INFO  [bundesrat.cli] ") && !line.includes("\\n")), lines.join("\n"));
  assert.ok(lines.some((line) => line === "INFO  [bundesrat.cli] Usage: bundesrat [options] [command]"), lines.join("\n"));

  // An option typo: the suggestion is part of the ERROR, the help one INFO record per line.
  const typo = makeCli(() => xmlResponse(fx.membersXml));
  assert.equal(await run(["members", "--stat", "Bayern"], typo.deps), 2);
  const typoLines = typo.err.map(untimed);
  assert.equal(typoLines[0], "ERROR [bundesrat.cli] unknown option '--stat' (Did you mean --state?)");
  assert.ok(typoLines.slice(1).every((line) => line.startsWith("INFO  [bundesrat.cli] ") && !line.includes("\\n")), typoLines.join("\n"));

  // An unknown help topic is an ERROR too.
  const help = makeCli(() => xmlResponse(fx.membersXml));
  assert.notEqual(await run(["help", "foo"], help.deps), 0);
  assert.match(untimed(help.err[0] ?? ""), /^ERROR \[bundesrat\.cli\] /);
});

test("the log format is the one commander parsed, where an option's value looks like --log-format (L6)", async () => {
  const isJsonl = (line: string): boolean => line.startsWith("{");
  // commander takes "--log-format=jsonl" as the User-Agent: the note is text.
  const ua = makeCli(() => xmlResponse(fx.membersXml));
  assert.equal(await run(["--user-agent", "--log-format=jsonl", "members", "--party", "XYZ"], ua.deps), 0);
  assert.ok(ua.err.length === 1 && !isJsonl(ua.err[0] as string), ua.err.join("\n"));
  // jsonl asked for, then "--log-format" as the value of --user-agent and of -o: jsonl.
  const back = makeCli(() => xmlResponse(fx.membersXml));
  assert.equal(await run(["--log-format", "jsonl", "--user-agent", "--log-format", "members", "--party", "XYZ"], back.deps), 0);
  assert.ok(back.err.length === 1 && isJsonl(back.err[0] as string), back.err.join("\n"));
  // -o refuses the dash-leading value (T13), in the format asked for.
  const output = makeCli(() => xmlResponse(fx.membersXml));
  assert.equal(await run(["--log-format", "jsonl", "-o", "--log-format", "members"], output.deps), 2);
  assert.ok(output.err.length > 0 && output.err.every(isJsonl), output.err.join("\n"));
  assert.equal(output.mt.calls.length, 0);
  // A parse error after such a value is logged in the format commander would have used.
  const parse = makeCli(() => xmlResponse(fx.membersXml));
  assert.equal(await run(["--log-format", "jsonl", "--user-agent", "--log-format", "members", "--bogus"], parse.deps), 2);
  assert.ok(parse.err.length > 0 && parse.err.every(isJsonl), parse.err.join("\n"));
});

test("every -o failure is an ERROR record: before the request of bundesrat.cli (exit 2), after it of bundesrat.output (exit 1) (L8, D5)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bundesrat-l8-"));
  const locked = join(dir, "locked");
  mkdirSync(locked, 0o500);
  try {
    // A directory that is missing or can't take the file is refused before any request (D5).
    const cases: Array<[string, RegExp]> = [[join(dir, "missing", "x"), /the directory ".*missing" does not exist\./]];
    // root writes anywhere; the permission case needs an ordinary user.
    if (process.getuid?.() !== 0) cases.push([join(locked, "x"), /no permission to create files in ".*locked"\./]);
    for (const [path, reason] of cases) {
      const cli = makeCli(() => xmlResponse(fx.membersXml));
      delete cli.deps.files;
      assert.equal(await run(["-o", path, "members"], cli.deps), 2, path);
      assert.equal(cli.mt.calls.length, 0, `${path}: a request was sent`);
      const text = untimed(cli.err.join("\n"));
      assert.match(text, /^ERROR \[bundesrat\.cli\] Cannot write to ".*x": /, path);
      assert.match(text, reason, path);
    }
    // A directory that goes away during the request: the write fails afterwards.
    const gone = join(dir, "gone");
    mkdirSync(gone);
    const cli = makeCli(() => {
      rmSync(gone, { recursive: true });
      return xmlResponse(fx.membersXml);
    });
    delete cli.deps.files;
    assert.equal(await run(["-o", join(gone, "x"), "members"], cli.deps), 1);
    const text = untimed(cli.err.join("\n"));
    assert.match(text, /^ERROR \[bundesrat\.output\] Could not write to ".*x": ENOENT/);
    assert.doesNotMatch(text, /Unexpected error/);
  } finally {
    chmodSync(locked, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an -o refusal names the user's path, never Node's \", open '<path>'\" tail, also when the path holds a line break", async () => {
  for (const path of ["/nonexistent\nZZ/x", "/nonexistent ZZ/x", "/nonexistent\rZZ/x", "/nonexistent/x"]) {
    const cli = makeCli(() => xmlResponse(fx.membersXml));
    delete cli.deps.files;
    assert.equal(await run(["-o", path, "members"], cli.deps), 2);
    assert.equal(cli.err.length, 1, cli.err.join("\n"));
    const msg = untimed(cli.err[0] as string);
    assert.match(msg, /^ERROR \[bundesrat\.cli\] Cannot write to "\/nonexistent.*": the directory "\/nonexistent.*" does not exist\.$/);
    assert.doesNotMatch(msg, /open '/);
  }
});

test("a subcommand's value option does not swallow the program's --log-format, in a parse error too (L6)", async () => {
  // commander takes the program's --log-format out of argv first; --party is left without its value.
  const cli = makeCli(() => xmlResponse(fx.membersXml));
  assert.notEqual(await run(["members", "--party", "--log-format", "jsonl"], cli.deps), 0);
  assert.ok(cli.err.length > 0 && cli.err.every((line) => line.startsWith("{")), cli.err.join("\n"));
  assert.match((JSON.parse(cli.err[0] ?? "") as Record<string, unknown>)["msg"] as string, /--party <name>' argument missing/);
});

test("the npm description names what the CLI shows, not the Stimmverteilung it leaves out (B8)", async () => {
  const { readFileSync } = await import("node:fs");
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { description: string };
  assert.doesNotMatch(pkg.description, /vote|stimmverteilung/i);
  for (const shown of ["agenda", "members", "committee dates"]) assert.ok(pkg.description.includes(shown), shown);
});

test("the skills quote the network-error record as the CLI writes it (B4)", async () => {
  const { readFileSync } = await import("node:fs");
  const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
  const err: string[] = [];
  const code = await run(["--max-retries", "0", "session"], {
    io: { out: () => {}, err: (s) => err.push(s) },
    createClient: (opts) =>
      new BundesratClient({
        ...opts,
        transport: () => {
          throw reset;
        },
      }),
  });
  assert.equal(code, 6);
  const record = untimed(err.join("\n"));
  for (const skill of ["bundesrat-agenda", "bundesrat-members"]) {
    const text = readFileSync(new URL(`../../../../skills/${skill}/SKILL.md`, import.meta.url), "utf8");
    const quoted = /`(ERROR \[bundesrat\.http\][^`]*)`/.exec(text)?.[1];
    assert.ok(quoted !== undefined, `${skill}: no quoted record`);
    const pattern = new RegExp(`^${quoted.split("…").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    assert.match(record, pattern, `${skill} quotes ${quoted}`);
  }
});

// Runs jq as a process (when it is installed): 30 s instead of the suite's 5 s.
test("the documented agenda sort puts every TOP in a defined order, letter-only TOPs too (B7)", { timeout: 30_000 }, async (t) => {
  const { execFileSync } = await import("node:child_process");
  const { readFileSync } = await import("node:fs");
  try {
    execFileSync("jq", ["--version"]);
  } catch {
    return t.skip("jq is not installed");
  }
  const session = { tops: [{ toptitle: "TOP b" }, { toptitle: "TOP a" }, { toptitle: "TOP 10" }, { toptitle: "TOP 2a" }, { toptitle: "TOP 2" }, { toptitle: "TOP 1" }] };
  for (const doc of ["skills/bundesrat-agenda/SKILL.md", "Usage.md"]) {
    const text = readFileSync(new URL(`../../../../${doc}`, import.meta.url), "utf8");
    const recipe = /jq -r '(\.tops \| sort_by\(\.toptitle[^']*)'/.exec(text)?.[1];
    assert.ok(recipe !== undefined, `${doc}: no agenda sort recipe`);
    const lines = execFileSync("jq", ["-r", recipe], { input: JSON.stringify(session), encoding: "utf8" }).trim().split("\n");
    assert.deepEqual(lines.map((line) => line.split("\t")[0]), ["TOP a", "TOP b", "TOP 1", "TOP 2", "TOP 2a", "TOP 10"], doc);
  }
});

test("a boolean that can be switched both ways may be given only once: optional value, or --x / --no-x (T11)", async () => {
  // commander calls no value parser for a bare `--is-open`, so `--is-open false --is-open` turned
  // into true without a word (fragdenstaat-cli); `--x --no-x` keeps the last one the same way.
  // This CLI declares no such option today; the guard is the kit's, checked on a test command.
  const build = () => {
    const program = buildProgram(makeCli(() => xmlResponse("<iOS><list/></iOS>")).deps);
    const seen: unknown[] = [];
    program
      .command("flags")
      .option("--is-open [bool]", "optional value", (value: string) => value === "true")
      .option("--cache", "negatable")
      .option("--no-cache", "negatable")
      .option("--archived", "plain flag")
      .action((opts: Record<string, unknown>) => void seen.push(opts));
    forbidRepeatedOptions(program);
    for (const command of program.commands) command.exitOverride().configureOutput({ writeErr: () => {}, outputError: () => {} });
    program.exitOverride();
    return { program, seen };
  };
  for (const argv of [
    ["--is-open", "false", "--is-open"],
    ["--is-open", "--is-open", "false"],
    ["--is-open", "--is-open"],
    ["--cache", "--no-cache"],
    ["--no-cache", "--no-cache"],
  ]) {
    const { program, seen } = build();
    await assert.rejects(program.parseAsync(["flags", ...argv], { from: "user" }), (err: Error) => /may be given only once/.test(err.message), argv.join(" "));
    assert.deepEqual(seen, [], argv.join(" "));
  }
  for (const [argv, expected] of [
    [["--is-open", "false"], { isOpen: false }],
    [["--is-open"], { isOpen: true }],
    [["--no-cache", "--archived", "--archived"], { cache: false, archived: true }],
  ] as const) {
    const { program, seen } = build();
    await program.parseAsync(["flags", ...argv], { from: "user" });
    assert.deepEqual(seen, [expected], argv.join(" "));
  }
});

test("text replaced with U+FFFD is printed well-formed with one WARN record of bundesrat.api (D2)", async () => {
  const cli = makeCli(() => xmlResponse("<iOS><list><item><title>x&#xD800;y</title></item></list></iOS>"));
  assert.equal(await run(["--compact", "appointments"], cli.deps), 0);
  assert.deepEqual(JSON.parse(cli.out.join("\n")), [{ title: "x�y" }]);
  assert.deepEqual(cli.err.map(untimed), [
    "WARN  [bundesrat.api] GET https://www.bundesrat.de/iOS/v3/02_Termine/termine_table.xml?view=renderXml: 1 character of the answer was not valid text (invalid bytes or a lone surrogate) and replaced with U+FFFD.",
  ]);
});

// T15 of the 2026-10-21 fix round (jobsuche-cli 28be809, ladesaeulenregister-cli 001c48d): a URL
// with a password anywhere in an argument — padded, after a dash, inside a phrase — must never
// reach stderr, neither raw in a refusal, a note or commander's echo nor percent-encoded in the
// request URL of an error record.
test("a password in a URL inside any argument is redacted on stderr, raw or percent-encoded (T15)", async () => {
  const url = "https://bob:s3cretpw@host.example/x";
  const argvs = [
    ["members", "--party", ` ${url}`],
    ["members", "--party", `Grüne ${url}`],
    ["members", "--party", ` -${url}`],
    ["members", "--party", `-${url}`],
    ["members", `--party= ${url}`],
    ["members", "--state", ` ${url}`],
    ["members", "--state", `Bayern ${url}`],
    ["-o", ` -${url}`, "session"],
    ["-o", `-${url}`, "session"],
    [`--output=-${url}`, "session"],
    ["--user-agent", ` ${url}`, "session"],
    ["--user-agent", `agent ${url}\u0001`, "session"],
    ["--base-url", ` ${url}`, "session"],
    ["--base-url", url, "session"],
    [` ${url}`],
    ["session", ` ${url}`],
    ["members", `--bogus= ${url}`],
    ["members", "--party", `x ${url}`, "--bogus"],
  ];
  const answers = [
    () => xmlResponse(fx.membersXml),
    () => rawResponse(Buffer.from("not found"), "text/plain", 404),
    () => rawResponse(Buffer.from("busy"), "text/plain", 503),
  ];
  for (const argv of argvs) {
    for (const answer of answers) {
      const cli = makeCli(answer);
      await run(["--max-retries", "0", ...argv], cli.deps);
      const err = cli.err.join("\n");
      assert.doesNotMatch(err, /s3cretpw|bob%3As3|s3cretpw%40/, `${JSON.stringify(argv)}: ${err}`);
    }
  }
});

test("the search for URLs inside an argument is linear: a 1 MB argument is read at once (T15)", async () => {
  // A pattern retried at every position took ~3 s for 40 000 scheme characters without "://".
  for (const big of ["a".repeat(1 << 20), "a://".repeat(1 << 18), `${"a".repeat(1 << 20)}://bob:s3cretpw@h/`]) {
    const started = performance.now();
    const redaction = redactionFor(["members", "--party", big]);
    redaction.err(`x ${big.slice(-40)}`);
    assert.ok(performance.now() - started < 1000, `${big.slice(0, 8)}…: ${Math.round(performance.now() - started)} ms`);
  }
  // At most 64 URLs inside one argument are read; the first ones are redacted.
  const many = Array.from({ length: 100 }, (_, i) => ` https://u${i}:pw${i}xyz@h/`).join("");
  const err = redactionFor(["members", "--party", many]).err(many);
  assert.ok(!err.includes("pw0xyz") && !err.includes("pw63xyz"), err.slice(0, 200));
});
