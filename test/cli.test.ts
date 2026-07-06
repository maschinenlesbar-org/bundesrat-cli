import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { BundesratClient } from "../src/client/client.js";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { makeMockTransport, xmlResponse, rawResponse } from "./helpers.js";
import * as fx from "./fixtures.js";

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
  assert.match(cli.err.join("\n"), /redirected \(3xx\)|--base-url/);
});

test("--compact prints single-line JSON", async () => {
  const cli = makeCli(() => xmlResponse(fx.membersXml));
  await run(["members", "--compact"], cli.deps);
  assert.equal(cli.out.length, 1);
});

test("--output writes to a file and keeps stdout clean", async () => {
  const cli = makeCli(() => xmlResponse(fx.membersXml));
  await run(["--output", "/tmp/out.json", "members"], cli.deps);
  assert.equal(cli.out.length, 0);
  assert.ok(cli.files["/tmp/out.json"]);
  assert.match(cli.err.join("\n"), /Wrote \d+ bytes/);
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
