// The process-level seams of src/cli/io.ts: what happens to a failed write on stdout or
// stderr (handleOutputErrors), driven with fake streams, no process.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleOutputErrors, nodeFilesFor, stderrAfterStdout } from "../src/cli/io.js";
import { createLogger } from "../src/cli/log.js";

function writeError(code: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`write ${code}`);
  err.code = code;
  return err;
}

function setup() {
  const stdout = new EventEmitter();
  const written: string[] = [];
  const stderr = Object.assign(new EventEmitter(), { write: (text: string) => written.push(text) > 0 });
  const exits: number[] = [];
  const records: string[] = [];
  const log = createLogger({ format: "jsonl", write: (line) => records.push(line), now: () => new Date("2026-01-02T03:04:05.678Z") });
  handleOutputErrors(
    { stdout: stdout as unknown as NodeJS.WriteStream, stderr: stderr as unknown as NodeJS.WriteStream },
    (code) => exits.push(code),
    log,
  );
  return { stdout, stderr, exits, written, records };
}

test("EPIPE on stdout (reader closed early, e.g. | head) exits 0 quietly", () => {
  const s = setup();
  s.stdout.emit("error", writeError("EPIPE"));
  assert.deepEqual(s.exits, [0]);
  assert.deepEqual(s.records, []);
});

test("another stdout write error is an ERROR record of bundesrat.output, in the run's format, and exits 1", () => {
  const s = setup();
  s.stdout.emit("error", writeError("EBADF"));
  assert.deepEqual(s.exits, [1]);
  assert.deepEqual(s.records.map((line) => JSON.parse(line)), [
    { ts: "2026-01-02T03:04:05.678Z", level: "ERROR", topic: "bundesrat.output", msg: "Could not write to stdout: write EBADF" },
  ]);
  assert.deepEqual(s.written, []);
});

test("without a logger, a stdout write error is a text ERROR record on the streams' stderr", () => {
  const stdout = new EventEmitter();
  const written: string[] = [];
  const stderr = Object.assign(new EventEmitter(), { write: (text: string) => written.push(text) > 0 });
  const exits: number[] = [];
  handleOutputErrors({ stdout: stdout as unknown as NodeJS.WriteStream, stderr: stderr as unknown as NodeJS.WriteStream }, (code) => exits.push(code));
  stdout.emit("error", writeError("EBADF"));
  assert.deepEqual(exits, [1]);
  assert.equal(written.length, 1);
  assert.match(written[0] ?? "", /^\S+Z ERROR \[bundesrat\.output\] Could not write to stdout: write EBADF\n$/);
});

test("EPIPE on stderr is ignored, so the run's own exit code stands", () => {
  const s = setup();
  s.stderr.emit("error", writeError("EPIPE"));
  assert.deepEqual(s.exits, []);
});

/** A stdout as far as the hold needs one: a backlog, and the events that end it. */
class FakeStdout extends EventEmitter {
  writableLength = 0;
}

test("stderr waits for stdout: a record is held while stdout has a backlog, and flushed in order (L11)", () => {
  const stdout = new FakeStdout();
  const written: string[] = [];
  const err = stderrAfterStdout(stdout, (text: string) => written.push(text));
  err("first");
  assert.deepEqual(written, ["first"], "no backlog: written at once");
  stdout.writableLength = 65536;
  err("second");
  err("third");
  assert.deepEqual(written, ["first"], "held while stdout has a backlog");
  stdout.writableLength = 0;
  stdout.emit("drain");
  assert.deepEqual(written, ["first", "second", "third"]);
  // Flushed on close and on error too, never lost.
  stdout.writableLength = 10;
  err("fourth");
  stdout.emit("close");
  stdout.writableLength = 10;
  err("fifth");
  stdout.emit("error", new Error("EPIPE"));
  assert.deepEqual(written, ["first", "second", "third", "fourth", "fifth"]);
});

// Class G2 of .reviews/2026-10-27-security-audit (portfolio round): a path classified as a stream
// (a FIFO, a device) and switched to a regular file (through a link) before it is opened was
// appended to without --force, or created.
test("a stream target is written only when the descriptor opened is a stream (G2)", () => {
  const dir = mkdtempSync(join(tmpdir(), "g2-"));
  try {
    const victim = join(dir, "victim.txt");
    writeFileSync(victim, "keep me\n");
    const link = join(dir, "out.json");
    symlinkSync(victim, link);
    const real = nodeFilesFor();
    const switched = { ...real, state: () => "stream" as const };
    assert.throws(() => switched.write(link, Buffer.from("appended\n"), false), /Refusing to overwrite/);
    assert.equal(readFileSync(victim, "utf8"), "keep me\n");
    // A stream path that is gone by then is not created by the open either.
    const gone = join(dir, "gone.json");
    assert.throws(() => switched.write(gone, Buffer.from("x"), false), /Could not write/);
    assert.throws(() => readFileSync(gone));
    // A real stream is still written in place.
    assert.doesNotThrow(() => real.write("/dev/null", Buffer.from("x"), false));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
