// The output sink: everything the CLI writes as data, to stdout or to the `-o` file. One
// place for the rules the maschinenlesbar.org CLIs learned one bug at a time: terminal
// controls escaped, a deep or huge answer printed (or refused) cleanly, `-o` never
// overwriting a file by accident and never leaving half a file behind.

import { constants } from "node:buffer";
import { BundesratError, BundesratValidationError } from "@maschinenlesbar.org/bundesrat-client/internal/errors";
import { isBidiControl } from "@maschinenlesbar.org/bundesrat-client/internal/engine";
import { isDirectoryMessage, logOf, nodeFiles, refuseOverwrite, type CliDeps } from "./io.js";
import { InvalidArgumentError } from "commander";
import { nonBlankProblem } from "@maschinenlesbar.org/bundesrat-client/internal/validate";

/**
 * Writing the output failed: the `-o` file (a full disk, a file that appeared during the
 * request, EACCES), or an answer too deeply nested or too large to print. Logged as an ERROR
 * of `bundesrat.output`, exit 1.
 */
export class OutputError extends BundesratError {}

/**
 * commander value-parser for `-o, --output <file>`. A blank or whitespace-only path
 * is a usage error: `-o ""` used to print to stdout silently and `-o " "` created a
 * file named " ". `-` is kept as is and means stdout (see {@link renderJson}), the
 * usual convention, rather than a file named "-".
 */
export function parseOutputPath(value: string): string {
  const problem = nonBlankProblem(value);
  if (problem !== undefined) throw new InvalidArgumentError(problem);
  return value;
}

/** The global options that decide where and how a result is written. */
export interface OutputOptions {
  compact?: boolean | undefined;
  output?: string | undefined;
  force?: boolean | undefined;
}

/**
 * Check `-o` before any request, so a refused target costs none: `--force` without `-o`, a
 * directory, an existing path (a dangling link too) without `--force`, and a file whose directory
 * is missing or not writable are usage errors (exit 2). A stream (`/dev/null`, a FIFO,
 * `/dev/stdout`, `>(…)`) needs no `--force`: it is written in place, and nothing in it can be
 * lost. `-o -` is stdout. The write checks again: a file that appears during the request is not
 * overwritten either (an OutputError then).
 */
export function checkOutputTarget(deps: CliDeps, options: OutputOptions): void {
  if (options.force === true && options.output === undefined) {
    throw new BundesratValidationError("--force needs --output (it only allows overwriting the -o file).");
  }
  const path = fileOf(options);
  if (path === undefined) return;
  const files = deps.files ?? nodeFiles;
  const state = files.state(path);
  if (state === "directory") throw new BundesratValidationError(isDirectoryMessage(path));
  if (state === "stream") return;
  if (state === "exists" && options.force !== true) throw new BundesratValidationError(refuseOverwrite(path));
  const problem = files.parentProblem(path, options.force === true);
  if (problem !== undefined) throw new BundesratValidationError(problem);
}

/** The `-o` file, or undefined for stdout (no `-o`, or `-o -`). */
function fileOf(options: OutputOptions): string | undefined {
  return options.output === undefined || options.output === "-" ? undefined : options.output;
}

/**
 * Write a JSON result: pretty by default, compact with `--compact`, to stdout or to the `-o`
 * file (with an INFO record of `bundesrat.output` saying how many bytes went where, so stdout
 * stays clean for a pipe). The file holds exactly what stdout would show, plus a newline, and
 * is written atomically (`OutputFiles.write`): a write cut short leaves the old file as it was.
 */
export function renderJson(deps: CliDeps, options: OutputOptions, value: unknown): void {
  const text = escapeControlChars(stringifyJson(value, options.compact === true));
  const path = fileOf(options);
  if (path === undefined) return deps.io.out(text);
  const data = Buffer.from(`${text}\n`, "utf8");
  try {
    (deps.files ?? nodeFiles).write(path, data, options.force === true);
  } catch (cause) {
    // A bad -o path (a missing directory, no permission, a full disk, a file that appeared
    // meanwhile) is the user's or the system's, not an internal fault: a clean OutputError
    // (bundesrat.output), never the "Unexpected error" path.
    throw new OutputError(cause instanceof Error ? cause.message : String(cause), { cause });
  }
  logOf(deps).info("output", `Wrote ${data.length} bytes to ${path}`);
}

/** The longest string V8 makes (2^29 - 24 characters on 64-bit): a longer JSON text can't be printed at once. */
const MAX_TEXT_LENGTH = constants.MAX_STRING_LENGTH;

/**
 * JSON.stringify, pretty or compact. Printing can fail two ways, both an OutputError (exit 1)
 * that names the cause, never "Unexpected error":
 * - an answer nested too deeply (hostile or broken) overflows the stack: "nested too deeply";
 * - a text longer than V8's longest string ("Invalid string length"): "too large to print".
 * "try --compact" is added only when the compact form of this very answer prints: it is probed,
 * not assumed, because whether compact output survives deep nesting depends on the Node version
 * (on Node 26 only the fast path is iterative) and on the machine's stack.
 *
 * Compact output takes V8's fast path (no gap) unless the answer holds a huge string: on Node 26
 * the fast path aborts the process ("Zone Allocation failed", exit 134, a native dump on stderr)
 * on a string of some 250 MB that JSON.parse made, while the gap path (an empty gap, the same
 * text) prints it. The fast path stays the default because on Node 26 only it is iterative and
 * prints nesting the gap path refuses (~7,000 levels).
 */
function stringifyJson(value: unknown, compact: boolean): string {
  try {
    return compact ? stringifyCompact(value) : JSON.stringify(value, null, 2);
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    const deep = /call stack/i.test(err.message);
    const cause = deep ? "nested too deeply" : `too large (more than ${MAX_TEXT_LENGTH} characters of JSON)`;
    const hint = !compact && compactPrints(value) ? "; try --compact" : "";
    throw new OutputError(`The answer is ${cause} to ${compact ? "print" : "pretty-print"}${hint}.`, { cause: err });
  }
}

/** Compact JSON: the fast path, or the gap path for an answer holding a huge string. */
function stringifyCompact(value: unknown): string {
  return holdsHugeString(value) ? JSON.stringify(value, null, "") : JSON.stringify(value);
}

/** Whether `--compact` prints this answer on this runtime (the hint after a failed pretty-print). */
function compactPrints(value: unknown): boolean {
  try {
    return stringifyCompact(value).length <= MAX_TEXT_LENGTH;
  } catch {
    return false;
  }
}

/** A string or key this long sends --compact through the gap path: a quarter of where Node 26's fast path aborts. */
const HUGE_STRING_LENGTH = 64 * 1024 * 1024;

/**
 * Whether `value` holds a string or key of HUGE_STRING_LENGTH or more. Iterative, so nesting
 * costs no stack, linear, and without an allocation per value: an array is walked by index, an
 * object by `for…in` (own keys only: an answer's objects have none inherited), and only nested
 * objects and arrays are kept for later. (`Object.entries` made a pair per element: on an array
 * of 48M numbers that took 7 GB and crashed.)
 */
function holdsHugeString(value: unknown): boolean {
  if (typeof value === "string") return value.length >= HUGE_STRING_LENGTH;
  const pending: object[] = [];
  if (typeof value === "object" && value !== null) pending.push(value);
  for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
    if (Array.isArray(item)) {
      for (let i = 0; i < item.length; i++) {
        const element: unknown = item[i];
        if (typeof element === "string") {
          if (element.length >= HUGE_STRING_LENGTH) return true;
        } else if (typeof element === "object" && element !== null) pending.push(element);
      }
      continue;
    }
    const record = item as Record<string, unknown>;
    for (const key in record) {
      if (key.length >= HUGE_STRING_LENGTH) return true;
      const element = record[key];
      if (typeof element === "string") {
        if (element.length >= HUGE_STRING_LENGTH) return true;
      } else if (typeof element === "object" && element !== null) pending.push(element);
    }
  }
  return false;
}

/** True for a UTF-16 unit `escapeControlChars` writes as `\uXXXX`. */
function escaped(c: number): boolean {
  return (c >= 0x7f && c <= 0x9f) || isBidiControl(c);
}

/** How many input characters `escapeControlChars` turns into one piece of output at a time. */
const ESCAPE_CHUNK = 1 << 16;

/**
 * Escape the characters JSON.stringify leaves raw although a terminal acts on them. It
 * escapes C0 (including ESC) but not DEL, the C1 range U+0080–U+009F (U+009B is the 8-bit
 * form of CSI) or the bidi formatting characters (isBidiControl), which reorder the text that
 * follows. The output is server data, so escape them; the result is equivalent, valid JSON
 * (these characters only occur inside strings). Checked by char code so the source stays
 * free of control bytes.
 *
 * Each such character becomes six, so the output is measured first: one longer than V8's
 * longest string is an OutputError ("too large to print"), before anything is built. Then the
 * output is built in chunks of ESCAPE_CHUNK characters, each made flat at once, and joined
 * once: one `+=` per character made a rope of 100 M pieces on an answer of DEL characters, and
 * the process died of a heap out-of-memory crash.
 */
function escapeControlChars(json: string): string {
  let count = 0;
  for (let i = 0; i < json.length; i++) if (escaped(json.charCodeAt(i))) count++;
  if (count === 0) return json;
  const length = json.length + 5 * count;
  if (length > MAX_TEXT_LENGTH) {
    throw new OutputError(`The answer is too large to print (${length} characters once its control characters are escaped).`);
  }
  const chunks: string[] = [];
  for (let start = 0; start < json.length; start += ESCAPE_CHUNK) {
    const end = Math.min(start + ESCAPE_CHUNK, json.length);
    const parts: string[] = [];
    let from = start;
    for (let i = start; i < end; i++) {
      const c = json.charCodeAt(i);
      if (!escaped(c)) continue;
      parts.push(json.slice(from, i), "\\u" + c.toString(16).padStart(4, "0"));
      from = i + 1;
    }
    parts.push(json.slice(from, end));
    chunks.push(parts.join(""));
  }
  return chunks.join("");
}
