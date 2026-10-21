// The output sink: everything the CLI writes as data, to stdout or to the `-o` file. One
// place for the rules the maschinenlesbar.org CLIs learned one bug at a time: terminal
// controls escaped, a deep or huge answer printed (or refused) cleanly, `-o` never
// overwriting a file by accident and never leaving half a file behind.

import { BundesratError, BundesratValidationError } from "@maschinenlesbar.org/bundesrat-client/internal/errors";
import { isBidiControl } from "@maschinenlesbar.org/bundesrat-client/internal/engine";
import { isDirectoryMessage, logOf, nodeFiles, refuseOverwrite, type CliDeps } from "./io.js";
import { InvalidArgumentError } from "commander";
import { nonBlankProblem } from "@maschinenlesbar.org/bundesrat-client/internal/validate";

/**
 * Writing the output failed: the `-o` file (a missing directory, a directory, EACCES, …),
 * or an answer too deeply nested to print. Logged as an ERROR of `bundesrat.output`, exit 1.
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
 * directory, and an existing path (a dangling link too) without `--force` are usage errors
 * (exit 2). `-o -` is stdout. The write checks again: a file that appears during the request
 * is not overwritten either (an OutputError then).
 */
export function checkOutputTarget(deps: CliDeps, options: OutputOptions): void {
  if (options.force === true && options.output === undefined) {
    throw new BundesratValidationError("--force needs --output (it only allows overwriting the -o file).");
  }
  const path = fileOf(options);
  if (path === undefined) return;
  const state = (deps.files ?? nodeFiles).state(path);
  if (state === "directory") throw new BundesratValidationError(isDirectoryMessage(path));
  if (state === "exists" && options.force !== true) throw new BundesratValidationError(refuseOverwrite(path));
}

/** The `-o` file, or undefined for stdout (no `-o`, or `-o -`). */
function fileOf(options: OutputOptions): string | undefined {
  return options.output === undefined || options.output === "-" ? undefined : options.output;
}

/**
 * Escape the control characters JSON.stringify leaves raw. It escapes C0 (including
 * ESC) but not DEL or the C1 range U+0080–U+009F, and terminals may act on those —
 * U+009B is the 8-bit form of CSI. Bidi formatting characters (isBidiControl) are
 * escaped too, so feed text cannot visually reorder the output in a terminal. The output is server data, so escape them; the
 * result is equivalent, valid JSON (these characters only occur inside strings).
 * Checked by char code so the source stays free of control bytes.
 */
export function escapeControlChars(json: string): string {
  let result = "";
  let from = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if ((c >= 0x7f && c <= 0x9f) || isBidiControl(c)) {
      result += json.slice(from, i) + "\\u" + c.toString(16).padStart(4, "0");
      from = i + 1;
    }
  }
  return from === 0 ? json : result + json.slice(from);
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

/**
 * JSON.stringify, pretty or compact. An answer nested too deeply (hostile or broken; the
 * projected feeds are flat, but a library value need not be) overflows the stack: an
 * OutputError rather than "Unexpected error: Maximum call stack size exceeded".
 *
 * Compact output takes V8's fast path (no gap) unless the answer holds a huge string: on Node 26
 * the fast path aborts the process ("Zone Allocation failed", exit 134, a native dump on stderr)
 * on a string of some 250 MB that JSON.parse made, while the gap path (an empty gap, the same
 * text) prints it. The fast path stays the default because on Node 26 only it is iterative and
 * prints nesting the gap path refuses (~7,000 levels).
 */
function stringifyJson(value: unknown, compact: boolean): string {
  try {
    if (!compact) return JSON.stringify(value, null, 2);
    return holdsHugeString(value) ? JSON.stringify(value, null, "") : JSON.stringify(value);
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    throw new OutputError(
      compact ? "The answer is nested too deeply to print." : "The answer is nested too deeply to pretty-print; try --compact.",
      { cause: err },
    );
  }
}

/** A string or key this long sends --compact through the gap path: a quarter of where Node 26's fast path aborts. */
const HUGE_STRING_LENGTH = 64 * 1024 * 1024;

/** Whether `value` holds a string or key of HUGE_STRING_LENGTH or more. Iterative, so nesting costs no stack. */
function holdsHugeString(value: unknown): boolean {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const item = stack.pop();
    if (typeof item === "string") {
      if (item.length >= HUGE_STRING_LENGTH) return true;
    } else if (typeof item === "object" && item !== null) {
      for (const [key, element] of Object.entries(item)) {
        if (key.length >= HUGE_STRING_LENGTH) return true;
        if (typeof element === "string" || (typeof element === "object" && element !== null)) stack.push(element);
      }
    }
  }
  return false;
}
