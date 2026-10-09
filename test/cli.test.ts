import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { BundesratClient } from "../src/client/client.js";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { makeMockTransport, xmlResponse, rawResponse, untimed } from "./helpers.js";
import * as fx from "./fixtures.js";
import { credentialsIn } from "../src/client/errors.js";

function makeCli(responder: (req: HttpRequest) => HttpResponse) {
  const out: string[] = [];
  const err: string[] = [];
  const files: Record<string, Buffer> = {};
  const mt = makeMockTransport(responder);
  const deps: CliDeps = {
    io: {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      writeFile: (p, d) => {
        files[p] = d;
      },
    },
    createClient: (opts) => new BundesratClient({ ...opts, transport: mt.transport }),
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
    io: {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      writeFile: () => {
        const e = new Error("EISDIR: illegal operation on a directory, open '/tmp'");
        throw e;
      },
    },
    createClient: (opts) => new BundesratClient({ ...opts, transport: mt.transport }),
  };
  const code = await run(["--output", "/tmp", "members"], deps);
  assert.equal(code, 1);
  assert.match(err.join("\n"), /Could not write to \/tmp: EISDIR/);
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
  assert.match(cli.err.join("\n"), /Unexpected response shape .*expected an <iOS> root element, got <error>/);
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
    assert.match(untimed(cli.err.join("\n")), /^ERROR \[bundesrat\.cli\] Failed to parse XML response from \/iOS\/SharedDocs\/3_Plenum\/plenum_aktuelleSitzung_table\.xml: /);
    assert.match(cli.err.join("\n"), reason);
  }
});

test("--state / --party match a decomposed (NFD) umlaut against the feed's composed one", async () => {
  const cli = makeCli(() => xmlResponse(fx.membersXml));
  assert.equal(await run(["members", "--state", "Baden-Württemberg", "--party", "grüne"], cli.deps), 0);
  const rows = JSON.parse(cli.out.join("\n")) as Array<{ name: string }>;
  assert.deepEqual(rows.map((r) => r.name), ["Özdemir"]);
});

test("repeating --state or --party is a usage error, not a silent last-one-wins", async () => {
  for (const args of [
    ["members", "--state", "Bayern", "--state", "Hessen"],
    ["members", "--party", "CDU", "--party", "SPD"],
  ]) {
    const cli = makeCli(() => xmlResponse(fx.membersXml));
    assert.equal(await run(args, cli.deps), 2, args.join(" "));
    assert.equal(cli.mt.calls.length, 0);
    assert.match(cli.err.join("\n"), /Given more than once; this option takes a single value\./);
  }
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
  assert.match(record, /containing "Q{500}…" \(--party/);
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
  const output = makeCli(() => xmlResponse(fx.membersXml));
  assert.equal(await run(["--log-format", "jsonl", "-o", "--log-format", "members"], output.deps), 0);
  assert.ok(output.err.length === 1 && isJsonl(output.err[0] as string), output.err.join("\n"));
  // A parse error after such a value is logged in the format commander would have used.
  const parse = makeCli(() => xmlResponse(fx.membersXml));
  assert.equal(await run(["--log-format", "jsonl", "--user-agent", "--log-format", "members", "--bogus"], parse.deps), 2);
  assert.ok(parse.err.length > 0 && parse.err.every(isJsonl), parse.err.join("\n"));
});
