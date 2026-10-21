// The output sink (src/cli/output.ts): rendering, and (with the file seam in io.ts) `-o` and
// `--force`. A write cut short is conformance test P26's.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutputError, renderJson } from "../src/cli/output.js";
import { run } from "../src/cli/run.js";
import type { CliDeps } from "../src/cli/io.js";
import { BundesratClient } from "@maschinenlesbar.org/bundesrat-client/internal/client";
import type { HttpRequest, HttpResponse } from "@maschinenlesbar.org/bundesrat-client/internal/http";
import { makeMockTransport, untimed, xmlResponse } from "./helpers.js";

const MEMBERS = "<iOS><list><employee><name>Söder</name><party>CSU</party><state>Bayern</state></employee></list></iOS>";
const ROWS = [{ name: "Söder", party: "CSU", state: "Bayern" }];
const APPOINTMENTS = "<iOS><list><item><type>Event</type><title>Ein \u001b[31mroter\u009b Termin \u202e</title></item></list></iOS>";

function makeCli(responder: (req: HttpRequest) => HttpResponse | Promise<HttpResponse> = () => xmlResponse(MEMBERS)) {
  const out: string[] = [];
  const err: string[] = [];
  const mt = makeMockTransport(responder);
  const deps: CliDeps = {
    io: {
      out: (s) => out.push(s),
      err: (s) => err.push(untimed(s)),
    },
    createClient: (opts) => new BundesratClient({ ...opts, transport: mt.transport }),
  };
  return { deps, out, err, mt };
}

/** An array nested `depth` levels deep, built without recursion. */
function nested(depth: number): unknown {
  let value: unknown = [];
  for (let i = 0; i < depth; i++) value = [value];
  return value;
}

test("pretty-printing an answer nested too deeply is a clean error that suggests --compact", () => {
  // The projected feeds are flat, so no feed answer gets there; the rule is the kit's, for every value.
  const { deps, out } = makeCli();
  assert.throws(
    () => renderJson(deps, {}, { x: nested(200_000) }),
    (err: unknown) => err instanceof OutputError && err.message === "The answer is nested too deeply to pretty-print; try --compact.",
  );
  assert.deepEqual(out, []);
});

test("--compact takes the gap path only for an answer holding a huge string, the fast path otherwise", (t) => {
  // On Node 26 V8's fast stringifier (no gap) aborts the process on a ~250 MB string that
  // JSON.parse made ("Zone Allocation failed", exit 134); the gap path prints it. Only the fast
  // path is iterative there, though, and prints nesting the gap path refuses at ~7,000 levels.
  // So the path is chosen per answer. Too big a body for this suite: this pins the calls.
  const { deps, out } = makeCli();
  const stringify = t.mock.method(JSON, "stringify", () => '"stub"');
  const huge = "x".repeat(64 * 1024 * 1024);
  renderJson(deps, { compact: true }, { id: "a1", text: huge });
  renderJson(deps, { compact: true }, { id: "a1", x: [[["Rede"]]], text: huge.slice(1) });
  renderJson(deps, { compact: true }, { [huge]: 1 });
  renderJson(deps, { compact: true }, [[huge]]);
  renderJson(deps, {}, { id: "a1" });
  const calls = stringify.mock.calls.map((call) => call.arguments);
  stringify.mock.restore();
  assert.deepEqual(calls.map((args) => (args.length >= 3 ? args[2] : "none")), ["", "none", "", "", 2]);
  assert.deepEqual(out, ['"stub"', '"stub"', '"stub"', '"stub"', '"stub"']);
});

test("the CLI prints a feed with --compact on one line, pretty without", async () => {
  const compact = makeCli();
  assert.equal(await run(["--compact", "members"], compact.deps), 0);
  assert.deepEqual(compact.out, ['[{"name":"Söder","party":"CSU","state":"Bayern"}]']);
  const pretty = makeCli();
  assert.equal(await run(["members"], pretty.deps), 0);
  assert.equal(pretty.out.join("\n"), JSON.stringify([{ name: "Söder", party: "CSU", state: "Bayern" }], null, 2));
});

/** Run `body` with a fresh temp directory that is always removed. */
async function inTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "bundesrat-output-"));
  try {
    await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("-o writes what stdout would show, plus a newline, and says so in an INFO record", async () => {
  await inTempDir(async (dir) => {
    const shown = makeCli(() => xmlResponse(APPOINTMENTS));
    assert.equal(await run(["appointments"], shown.deps), 0);
    const path = join(dir, "appointments.json");
    const cli = makeCli(() => xmlResponse(APPOINTMENTS));
    assert.equal(await run(["-o", path, "appointments"], cli.deps), 0);
    const written = readFileSync(path, "utf8");
    assert.equal(written, `${shown.out.join("\n")}\n`);
    assert.doesNotMatch(written, /[\u001b\u009b\u202e]/, "control characters are escaped in the file too");
    assert.deepEqual(cli.out, []);
    assert.deepEqual(cli.err, [`INFO  [bundesrat.output] Wrote ${Buffer.byteLength(written)} bytes to ${path}`]);
    assert.deepEqual(readdirSync(dir), ["appointments.json"], "no temporary file is left");
  });
});

test("-o - prints to stdout and creates no file, --force or not", async () => {
  await inTempDir(async (dir) => {
    const cli = makeCli();
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      assert.equal(await run(["--compact", "-o", "-", "members"], cli.deps), 0);
      assert.equal(await run(["--compact", "-o", "-", "--force", "members"], cli.deps), 0);
    } finally {
      process.chdir(cwd);
    }
    assert.equal(cli.out.length, 2);
    assert.deepEqual(cli.err, []);
    assert.deepEqual(readdirSync(dir), []);
  });
});

test("a refused -o target is a usage error before any request", async () => {
  await inTempDir(async (dir) => {
    const existing = join(dir, "existing.json");
    writeFileSync(existing, "keep");
    const dangling = join(dir, "dangling.json");
    symlinkSync(join(dir, "nowhere"), dangling);
    const sub = join(dir, "sub");
    mkdirSync(sub);
    const cases: Array<[string[], string]> = [
      [["-o", "", "members"], "Expected a non-empty value."],
      [["-o", "  ", "members"], "Expected a non-empty value."],
      [["--force", "members"], "--force needs --output (it only allows overwriting the -o file)."],
      [["-o", existing, "members"], `Refusing to overwrite existing file "${existing}"; pass --force to overwrite.`],
      [["-o", dangling, "members"], `Refusing to overwrite existing file "${dangling}"; pass --force to overwrite.`],
      [["-o", sub, "members"], `"${sub}" is a directory; give a file path to --output.`],
      [["-o", sub, "--force", "members"], `"${sub}" is a directory; give a file path to --output.`],
    ];
    for (const [argv, message] of cases) {
      const cli = makeCli();
      assert.equal(await run(argv, cli.deps), 2, argv.join(" "));
      assert.equal(cli.mt.calls.length, 0, `${argv.join(" ")} sent a request`);
      assert.ok(cli.err.some((line) => line.startsWith("ERROR [bundesrat.cli]") && line.includes(message)), `${argv.join(" ")}: ${cli.err.join(" | ")}`);
    }
    assert.equal(readFileSync(existing, "utf8"), "keep");
    assert.deepEqual(readdirSync(dir).sort(), ["dangling.json", "existing.json", "sub"]);
  });
});

test("--force replaces an existing file, keeps its mode, and writes through a symlink", async () => {
  await inTempDir(async (dir) => {
    const path = join(dir, "out.json");
    writeFileSync(path, "old");
    chmodSync(path, 0o600);
    assert.equal(await run(["--compact", "-o", path, "--force", "members"], makeCli().deps), 0);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), ROWS);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const link = join(dir, "latest.json");
    symlinkSync(path, link);
    assert.equal(await run(["--compact", "-o", link, "--force", "members", "--party", "nobody"], makeCli().deps), 0);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), []);
    assert.deepEqual(readdirSync(dir).sort(), ["latest.json", "out.json"]);
  });
});

test("--force to a new path creates the file; over a dangling link it replaces the link with the file", async () => {
  await inTempDir(async (dir) => {
    const fresh = join(dir, "fresh.json");
    assert.equal(await run(["--compact", "-o", fresh, "--force", "members"], makeCli().deps), 0);
    assert.deepEqual(JSON.parse(readFileSync(fresh, "utf8")), ROWS);
    const dangling = join(dir, "dangling.json");
    symlinkSync(join(dir, "nowhere"), dangling);
    assert.equal(await run(["--compact", "-o", dangling, "--force", "members"], makeCli().deps), 0);
    assert.deepEqual(JSON.parse(readFileSync(dangling, "utf8")), ROWS);
    assert.deepEqual(readdirSync(dir).sort(), ["dangling.json", "fresh.json"]);
  });
});

test("a file that appears during the request is not overwritten: exit 1, an ERROR of the output area", async () => {
  await inTempDir(async (dir) => {
    const path = join(dir, "race.json");
    const cli = makeCli(() => {
      writeFileSync(path, "theirs");
      return xmlResponse(MEMBERS);
    });
    assert.equal(await run(["-o", path, "members"], cli.deps), 1);
    assert.equal(readFileSync(path, "utf8"), "theirs");
    assert.deepEqual(cli.err, [`ERROR [bundesrat.output] Refusing to overwrite existing file "${path}"; pass --force to overwrite.`]);
    assert.deepEqual(readdirSync(dir), ["race.json"]);
  });
});

test("a write the file system refuses is an ERROR of the output area naming the file, exit 1", async () => {
  await inTempDir(async (dir) => {
    const path = join(dir, "missing-dir", "out.json");
    const cli = makeCli();
    assert.equal(await run(["-o", path, "members"], cli.deps), 1);
    assert.equal(cli.err.length, 1);
    assert.match(cli.err[0]!, new RegExp(`^ERROR \\[bundesrat\\.output\\] Could not write to ".*out\\.json": ENOENT: no such file or directory$`));
  });
});
