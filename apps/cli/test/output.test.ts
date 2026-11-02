// The output sink (src/cli/output.ts): rendering, and (with the file seam in io.ts) `-o` and
// `--force`. A write cut short is conformance test P26's.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutputError, renderJson } from "../src/cli/output.js";
import { run } from "../src/cli/run.js";
import { nodeFilesFor, stdoutWriter, type CliDeps, type LinkOwners } from "../src/cli/io.js";
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

test("an answer nested too deeply is a clean error; it suggests --compact only where --compact prints it (D7)", () => {
  // The projected feeds are flat, so no feed answer gets there; the rule is the kit's, for every
  // value. Whether the compact printer manages depends on the Node version (iterative from Node
  // 26) and the stack: probed here, never assumed.
  const value = { x: nested(200_000) };
  let compactPrints = true;
  try {
    JSON.stringify(value);
  } catch {
    compactPrints = false;
  }
  const { deps, out } = makeCli();
  assert.throws(
    () => renderJson(deps, {}, value),
    (err: unknown) =>
      err instanceof OutputError && err.message === `The answer is nested too deeply to pretty-print${compactPrints ? "; try --compact" : ""}.`,
  );
  assert.deepEqual(out, []);
  if (compactPrints) renderJson(deps, { compact: true }, value);
  else {
    assert.throws(
      () => renderJson(deps, { compact: true }, value),
      (err: unknown) => err instanceof OutputError && err.message === "The answer is nested too deeply to print.",
    );
  }
  assert.equal(out.length, compactPrints ? 1 : 0);
});

test("an answer too large to print is called too large, not too deep; the hint only where --compact prints (D7)", (t) => {
  const { deps } = makeCli();
  const real = JSON.stringify;
  // V8's own error for a text past its longest string, stood in for: a real one needs 512 MB.
  const tooLarge = (gap: unknown): boolean => gap === 2 || gap === "big";
  t.mock.method(JSON, "stringify", (value: unknown, replacer: never, gap: unknown) => {
    if (tooLarge(gap) || (gap === undefined && (value as { all?: boolean }).all === true)) throw new RangeError("Invalid string length");
    return real(value, replacer, gap as number);
  });
  assert.throws(() => renderJson(deps, {}, { id: "a1" }), (err: Error) =>
    /^The answer is too large \(more than \d+ characters of JSON\) to pretty-print; try --compact\.$/.test(err.message));
  assert.throws(() => renderJson(deps, {}, { all: true }), (err: Error) =>
    /^The answer is too large \(more than \d+ characters of JSON\) to pretty-print\.$/.test(err.message));
  assert.throws(() => renderJson(deps, { compact: true }, { all: true }), (err: Error) =>
    /^The answer is too large \(more than \d+ characters of JSON\) to print\.$/.test(err.message));
});

test("--compact checks a large flat answer for huge strings without an allocation per value (D7)", (t) => {
  // Object.entries made a [key, value] pair per element: on 48M numbers that took 7 GB and
  // crashed. The walk goes by index and for…in instead; with Object.entries out of reach it
  // still prints.
  const { deps, out } = makeCli();
  t.mock.method(Object, "entries", () => {
    throw new Error("Object.entries called");
  });
  renderJson(deps, { compact: true }, { list: Array.from({ length: 1000 }, (_, i) => ({ name: `a${i}` })), n: [1, 2, [3]] });
  assert.equal(out.length, 1);
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

test("--force to a new path creates the file; through a dangling link it creates the file the link names (D1)", async () => {
  await inTempDir(async (dir) => {
    const fresh = join(dir, "fresh.json");
    assert.equal(await run(["--compact", "-o", fresh, "--force", "members"], makeCli().deps), 0);
    assert.deepEqual(JSON.parse(readFileSync(fresh, "utf8")), ROWS);
    // "--force writes through a symlink", also when the file it points at doesn't exist yet; a
    // relative link is resolved from the link's directory, through a chain of links.
    mkdirSync(join(dir, "sub"));
    symlinkSync("sub/nowhere.json", join(dir, "hop.json"));
    const dangling = join(dir, "dangling.json");
    symlinkSync("hop.json", dangling);
    assert.equal(await run(["--compact", "-o", dangling, "--force", "members"], makeCli().deps), 0);
    assert.ok(lstatSync(dangling).isSymbolicLink(), "the link stays a link");
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "sub", "nowhere.json"), "utf8")), ROWS);
    assert.deepEqual(readdirSync(dir).sort(), ["dangling.json", "fresh.json", "hop.json", "sub"]);
    assert.deepEqual(readdirSync(join(dir, "sub")), ["nowhere.json"], "no temporary file is left");
  });
});

test("a target whose directory can't take the file is a usage error before any request (D5)", async () => {
  await inTempDir(async (dir) => {
    const file = join(dir, "file.json");
    writeFileSync(file, "x");
    const readOnly = join(dir, "ro");
    mkdirSync(readOnly);
    chmodSync(readOnly, 0o555);
    const loop = join(dir, "loop.json");
    symlinkSync("loop.json", loop);
    const danglingIntoMissing = join(dir, "away.json");
    symlinkSync("missing/x.json", danglingIntoMissing);
    const cases: Array<[string[], RegExp]> = [
      [["-o", join(dir, "missing", "x.json")], /the directory ".*missing" does not exist\./],
      [["-o", join(file, "x.json")], /".*file\.json" is not a directory\./],
      [["-o", join(readOnly, "x.json")], /no permission to create files in ".*ro"\./],
      [["-o", danglingIntoMissing, "--force"], /the directory ".*missing" does not exist\./],
      [["-o", loop, "--force"], /too many levels of symbolic links/],
    ];
    try {
      for (const [argv, message] of cases) {
        const cli = makeCli();
        assert.equal(await run([...argv, "members"], cli.deps), 2, argv.join(" "));
        assert.equal(cli.mt.calls.length, 0, `${argv.join(" ")} sent a request`);
        assert.match(cli.err.join("\n"), /^ERROR \[bundesrat\.cli\] Cannot write to "/, argv.join(" "));
        assert.match(cli.err.join("\n"), message, argv.join(" "));
      }
    } finally {
      chmodSync(readOnly, 0o755);
    }
  });
});

test("a file name of up to 255 bytes is written: the temporary name stays within NAME_MAX (D5)", async () => {
  await inTempDir(async (dir) => {
    for (const name of [`${"x".repeat(250)}.json`, `${"ü".repeat(125)}.json`, `${"😀".repeat(62)}.json`]) {
      assert.ok(Buffer.byteLength(name) <= 255, name);
      const path = join(dir, name);
      const cli = makeCli();
      assert.equal(await run(["--compact", "-o", path, "members"], cli.deps), 0, cli.err.join("\n"));
      assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), ROWS);
      assert.equal(await run(["--compact", "-o", path, "--force", "members"], makeCli().deps), 0);
    }
    assert.equal(readdirSync(dir).length, 3, "no temporary file is left");
  });
});

test("a stream target (/dev/null) needs no --force and is written in place (D5)", async () => {
  for (const argv of [["-o", "/dev/null"], ["-o", "/dev/null", "--force"]]) {
    const cli = makeCli();
    assert.equal(await run([...argv, "members"], cli.deps), 0, cli.err.join("\n"));
    assert.equal(cli.mt.calls.length, 1);
    assert.match(cli.err.join("\n"), /^INFO  \[bundesrat\.output\] Wrote \d+ bytes to \/dev\/null$/);
  }
  assert.ok(statSync("/dev/null").isCharacterDevice(), "/dev/null is still the device");
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

test("a write the file system refuses is an ERROR of the output area naming the file, not the temporary one; exit 1", async () => {
  await inTempDir(async (dir) => {
    const sub = join(dir, "gone");
    mkdirSync(sub);
    const path = join(sub, "out.json");
    // The directory is there when -o is checked, and gone when the answer is written.
    const cli = makeCli(() => {
      rmSync(sub, { recursive: true });
      return xmlResponse(MEMBERS);
    });
    assert.equal(await run(["-o", path, "members"], cli.deps), 1);
    assert.equal(cli.err.length, 1);
    assert.match(cli.err[0]!, new RegExp(`^ERROR \\[bundesrat\\.output\\] Could not write to ".*out\\.json": ENOENT: no such file or directory$`));
  });
});

test("stdout to a regular file gets every byte or an error: a short write is never exit 0 (D6)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bundesrat-output-"));
  try {
    const { openSync, closeSync } = await import("node:fs");
    const path = join(dir, "stdout.txt");
    const fd = openSync(path, "w");
    try {
      const errors: Error[] = [];
      const streamed: string[] = [];
      const fake = { fd, write: (text: string) => streamed.push(text), emit: (_event: "error", err: Error) => errors.push(err) };
      // The real writer: every byte reaches the file, none goes through the stream.
      stdoutWriter(fake)("x".repeat(100_000));
      assert.equal(readFileSync(path, "utf8").length, 100_000);
      assert.deepEqual(streamed, []);
      // A write the file system cuts short: the error reaches stdout's "error" event (exit 1 there).
      const efbig = Object.assign(new Error("EFBIG: file too large, write"), { code: "EFBIG" });
      stdoutWriter(fake, () => { throw efbig; })("more");
      assert.deepEqual(errors, [efbig]);
    } finally {
      closeSync(fd);
    }
    // Not a file (a pipe, a terminal): the stream writes it, as before.
    const piped: string[] = [];
    stdoutWriter({ write: (text: string) => piped.push(text), emit: () => true })("data");
    assert.deepEqual(piped, ["data"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("terminal controls are escaped in chunks: the same text as one pass, across chunk edges (D7)", () => {
  const DEL = String.fromCharCode(0x7f);
  const C1 = String.fromCharCode(0x9b);
  const RLO = String.fromCharCode(0x202e);
  // Controls right before, at and after the 64 Ki edges, and a run of them.
  const text = ["a".repeat(65535), DEL, C1, "b".repeat(65534), RLO, DEL.repeat(70000), "ü😀", C1].join("");
  const { deps, out } = makeCli();
  renderJson(deps, { compact: true }, { text });
  const expected = JSON.stringify({ text }).replace(/[\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
  assert.equal(out[0], expected);
  assert.deepEqual(JSON.parse(out[0]!), { text });
});

test("-o refuses a dash-leading value as the next option, before any request; ./-name writes such a file (T13)", async () => {
  for (const argv of [["-o", "--compact", "members"], ["--output=-v", "members"], ["members", "-o", "--force"]]) {
    const cli = makeCli();
    assert.equal(await run(argv, cli.deps), 2, argv.join(" "));
    assert.equal(cli.mt.calls.length, 0, `${argv.join(" ")}: a request was sent`);
    assert.match(cli.err.join("\n"), /^ERROR \[bundesrat\.cli\] .*looks like a missing value — "-[-\w]+" is the next option.*write \.\/-name\./, argv.join(" "));
  }
  await inTempDir(async (dir) => {
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      assert.equal(await run(["--compact", "-o", "./-v", "members"], makeCli().deps), 0);
    } finally {
      process.chdir(cwd);
    }
    assert.deepEqual(readdirSync(dir), ["-v"]);
  });
});

// ---- --force and links another user planted (security audit 2026-10-27) ----------------
// --force follows a link only when the caller or the directory's owner made it, at every hop,
// wherever the directory is sticky or others can write to it (the rule of Linux's
// fs.protected_symlinks): the CLI resolves links by hand, so the kernel never saw a link another
// user planted in /tmp, and the answer replaced any file the caller could. Owners are injected
// (nodeFilesFor), so no test needs a second user or root.

/** The caller, and another user who planted links. */
const ME = 1000;
const OTHER = 1001;
/** /tmp: owned by root, sticky and world-writable. */
const SHARED = { uid: 0, mode: 0o41777 };

/** Owners as a test says: `links` maps a link to its owner (the caller otherwise), `dirs` a directory to its owner and mode (the caller's, 0o40755, otherwise). */
function owners(links: Record<string, number>, dirs: Record<string, { uid: number; mode: number }>): LinkOwners {
  return {
    uid: ME,
    ownerOf: (path, follow) => (follow ? (dirs[path] ?? { uid: ME, mode: 0o40755 }) : { uid: links[path] ?? ME, mode: 0o120777 }),
  };
}

const forceArgv = (file: string, force: boolean): string[] => ["--max-retries", "0", "-o", file, ...(force ? ["--force"] : []), "members"];

async function runWith(files: ReturnType<typeof nodeFilesFor>, argv: string[]): Promise<{ code: number; err: string; requests: HttpRequest[] }> {
  const mt = makeMockTransport(() => xmlResponse(MEMBERS));
  const err: string[] = [];
  const code = await run(argv, {
    io: { out: () => {}, err: (s) => err.push(s) },
    createClient: (opts) => new BundesratClient({ ...opts, transport: mt.transport }),
    files,
  });
  return { code, err: untimed(err.join("\n")), requests: mt.calls };
}

/** A temporary directory with a victim file and a link `out.json` to it. */
function planted(): { dir: string; victim: string; link: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "bundesrat-links-"));
  const victim = join(dir, "victim.txt");
  writeFileSync(victim, "keep me\n");
  const link = join(dir, "out.json");
  symlinkSync(victim, link);
  return { dir, victim, link, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("--force does not follow a link another user made in a shared directory, before any request", async () => {
  const t = planted();
  try {
    // A directory others can write to counts, sticky or not.
    const open = await runWith(nodeFilesFor(owners({ [t.link]: OTHER }, { [t.dir]: { uid: ME, mode: 0o40777 } })), forceArgv(t.link, true));
    assert.equal(open.code, 2, open.err);
    const files = nodeFilesFor(owners({ [t.link]: OTHER }, { [t.dir]: SHARED }));
    const o = await runWith(files, forceArgv(t.link, true));
    assert.equal(o.code, 2, o.err);
    assert.equal(o.requests.length, 0);
    assert.match(o.err, /another user/);
    assert.ok(o.err.includes(t.link), o.err);
    assert.equal(readFileSync(t.victim, "utf8"), "keep me\n");
    // At write time too (a link planted during the request): the write refuses it.
    assert.throws(() => files.write(t.link, Buffer.from("x"), true), /another user/);
    assert.equal(readFileSync(t.victim, "utf8"), "keep me\n");
    assert.ok(lstatSync(t.link).isSymbolicLink());
  } finally {
    t.done();
  }
});

test("--force: the link rule holds at every hop, a dangling last one included", async () => {
  const t = planted();
  try {
    // own link -> a foreign link in the shared directory -> the victim
    const inner = join(t.dir, "inner");
    symlinkSync(t.victim, inner);
    const outer = join(t.dir, "outer.json");
    symlinkSync(inner, outer);
    const chain = await runWith(nodeFilesFor(owners({ [inner]: OTHER }, { [t.dir]: SHARED })), forceArgv(outer, true));
    assert.equal(chain.code, 2, chain.err);
    assert.equal(readFileSync(t.victim, "utf8"), "keep me\n");
    // A foreign dangling link: the file it names is not created.
    const dangling = join(t.dir, "dangling.json");
    const target = join(t.dir, "created-elsewhere.json");
    symlinkSync(target, dangling);
    const d = await runWith(nodeFilesFor(owners({ [dangling]: OTHER }, { [t.dir]: SHARED })), forceArgv(dangling, true));
    assert.equal(d.code, 2, d.err);
    assert.throws(() => statSync(target));
  } finally {
    t.done();
  }
});

test("--force still follows the caller's own links, the directory owner's, and any link in a directory only its owner writes", async () => {
  const cases: Array<[string, (t: ReturnType<typeof planted>) => LinkOwners]> = [
    ["the caller's own link in a shared directory", (t) => owners({}, { [t.dir]: SHARED })],
    ["a link of the shared directory's owner", (t) => owners({ [t.link]: 0 }, { [t.dir]: SHARED })],
    ["another user's link in a directory only its owner writes", (t) => owners({ [t.link]: OTHER }, { [t.dir]: { uid: OTHER, mode: 0o40755 } })],
    ["another user's link where no caller id exists", (t) => ({ ...owners({ [t.link]: OTHER }, { [t.dir]: SHARED }), uid: undefined })],
  ];
  for (const [label, who] of cases) {
    const t = planted();
    try {
      const o = await runWith(nodeFilesFor(who(t)), forceArgv(t.link, true));
      assert.equal(o.code, 0, `${label}: ${o.err}`);
      assert.deepEqual(JSON.parse(readFileSync(t.victim, "utf8")), ROWS, label);
      assert.ok(lstatSync(t.link).isSymbolicLink(), label);
    } finally {
      t.done();
    }
  }
});

test("an -o path that can't be inspected (EACCES) is reported as such, not as an existing file", { skip: process.getuid?.() === 0 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "bundesrat-links-"));
  const closed = join(dir, "closed");
  try {
    mkdirSync(closed);
    const link = join(dir, "out.json");
    symlinkSync(join(closed, "x.json"), link);
    chmodSync(closed, 0o000);
    for (const force of [false, true]) {
      const o = await runWith(nodeFilesFor(), forceArgv(link, force));
      assert.equal(o.code, 2, o.err);
      assert.equal(o.requests.length, 0);
      assert.doesNotMatch(o.err, /Refusing to overwrite existing file/);
      assert.match(o.err, /EACCES|permission/i);
    }
  } finally {
    chmodSync(closed, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});
