// Shared helpers used across CLI command groups: option parsers, the global
// option resolver, and JSON rendering.

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import { logOf, type CliDeps } from "./io.js";
import { checkOutputTarget } from "./output.js";
import type { BundesratClientOptions } from "@maschinenlesbar.org/bundesrat-client/internal/client";
import { cleartextProblem, DEFAULT_BASE_URL, type RetryEvent } from "@maschinenlesbar.org/bundesrat-client/internal/engine";
import { baseUrlProblem, headerValueProblem, nonBlankProblem, stateProblem } from "@maschinenlesbar.org/bundesrat-client/internal/validate";

/**
 * commander value-parser: a plain base-10 non-negative integer.
 *
 * Uses a strict regex rather than `Number()` coercion, which would otherwise
 * accept empty/whitespace strings (`Number("") === 0`), hex/binary/scientific
 * literals, signs, padding and decimals.
 */
export function parseIntArg(value: string): number {
  if (!/^[0-9]+$/.test(value)) {
    throw new InvalidArgumentError("Expected a non-negative integer.");
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new InvalidArgumentError("Expected a non-negative integer.");
  }
  return n;
}

/** Build a commander value-parser for an integer constrained to [min, max]. */
export function parseBoundedInt(min: number, max: number): (value: string) => number {
  return (value: string) => {
    const n = parseIntArg(value);
    if (n < min) throw new InvalidArgumentError(`Must be >= ${min}.`);
    if (n > max) throw new InvalidArgumentError(`Must be <= ${max}.`);
    return n;
  };
}

/** commander value-parser: a non-empty (after trimming) string — the library's nonBlankProblem. */
export function parseNonEmpty(value: string): string {
  const problem = nonBlankProblem(value);
  if (problem !== undefined) throw new InvalidArgumentError(problem);
  return value;
}

/**
 * commander value-parser for `members --state`: one of the sixteen Länder, the library's
 * {@link stateProblem}. Any other value is a usage error naming the valid ones, instead
 * of an empty list with exit 0.
 */
export function parseState(value: string): string {
  const problem = stateProblem(value);
  if (problem !== undefined) throw new InvalidArgumentError(problem);
  return value;
}

/**
 * commander value-parser for --base-url. The base URL is trusted input, but it must
 * pass the library's {@link baseUrlProblem} (non-blank, no whitespace, `http:`/`https:`
 * only, no query or fragment), so a bad value fails at parse time (exit 2) with a clear
 * message rather than deep in the transport. The CLI keeps no rules of its own.
 */
export function parseBaseUrl(value: string): string {
  const problem = baseUrlProblem(value);
  if (problem !== undefined) throw new InvalidArgumentError(problem);
  return value;
}

/**
 * commander value-parser for a value that ends up in an HTTP header (`--user-agent`).
 * The rule is the library's {@link headerValueProblem} — blank, control characters
 * other than tab, and characters above U+00FF are rejected — so a bad value is a
 * usage error (exit 2) here instead of an opaque failure at request time.
 */
export function parseHeaderValue(value: string): string {
  const problem = headerValueProblem(value);
  if (problem !== undefined) throw new InvalidArgumentError(problem);
  return value;
}

export interface GlobalOptions {
  baseUrl?: string;
  timeout?: number;
  userAgent?: string;
  maxRetries?: number;
  maxResponseBytes?: number;
  compact?: boolean;
  output?: string;
  force?: boolean;
}

/** Translate resolved global CLI options into client options. */
export function toEngineOptions(global: GlobalOptions): BundesratClientOptions {
  const options: BundesratClientOptions = {};
  if (global.baseUrl !== undefined) options.baseUrl = global.baseUrl;
  if (global.timeout !== undefined) options.timeoutMs = global.timeout;
  if (global.userAgent !== undefined) options.userAgent = global.userAgent;
  if (global.maxRetries !== undefined) options.maxRetries = global.maxRetries;
  if (global.maxResponseBytes !== undefined) options.maxResponseBytes = global.maxResponseBytes;
  return options;
}

/**
 * Log a warning (`bundesrat.http`) when the effective base URL is plain `http:` to
 * a host other than loopback (cleartextProblem): requests, and any credentials in the
 * URL, travel unencrypted. Called once per run, after the options are parsed and before
 * the first request; stdout and the exit code are untouched.
 */
export function warnOnCleartext(deps: CliDeps, global: GlobalOptions): void {
  const problem = cleartextProblem(global.baseUrl ?? DEFAULT_BASE_URL);
  if (problem !== undefined) logOf(deps).warn("http", problem);
}

/** `HTTP 503 from host: retry 1 of 3 in 2 s` (host only; whole seconds, ms under 1 s). */
export function retryMessage(event: RetryEvent): string {
  let host: string;
  try {
    host = new URL(event.url).host;
  } catch {
    host = "the server";
  }
  const why = event.status === undefined ? "connection reset" : `HTTP ${event.status}`;
  const wait = event.delayMs < 1000 ? `${event.delayMs} ms` : `${Math.round(event.delayMs / 1000)} s`;
  return `${why} from ${host}: retry ${event.retry} of ${event.maxRetries} in ${wait}`;
}

export interface ActionContext {
  client: ReturnType<CliDeps["createClient"]>;
  global: GlobalOptions;
  /** This command's own parsed options. */
  opts: Record<string, unknown>;
}

/**
 * Wrap an async command action with consistent global-option resolution and
 * client construction. The callback receives a context (client + resolved global
 * options + this command's options) and the command's positional arguments.
 *
 * Commander invokes actions as (arg1, ..., argN, options, command); we slice off
 * the trailing options object and command instance to recover the positionals.
 */
export function action(
  deps: CliDeps,
  fn: (ctx: ActionContext, positionals: string[]) => Promise<void>,
): (...args: unknown[]) => Promise<void> {
  return async (...args: unknown[]) => {
    const command = args[args.length - 1] as Command;
    const positionals = args.slice(0, Math.max(0, args.length - 2)) as string[];
    const global = command.optsWithGlobals() as GlobalOptions;
    // A refused -o target is a usage error before anything else happens.
    checkOutputTarget(deps, global);
    warnOnCleartext(deps, global);
    const options = toEngineOptions(global);
    options.onRetry = (event) => logOf(deps).warn("http", retryMessage(event));
    const client = deps.createClient(options);
    await fn({ client, global, opts: command.opts() }, positionals);
  };
}

/**
 * Make giving a single-value option twice a usage error, on `command` and every subcommand:
 * commander keeps the last value silently, so `--timeout 1000 --timeout 0` switched the timeout
 * off and `--state Bayern --state Hessen` listed Hessen, with nothing telling the user a value
 * was dropped. A repeatable option, declared the commander way with an array default
 * (`.option("--tag <t>", …, collect, [])`; this CLI has none), is left alone: each value adds to
 * the list; so is a plain flag (`--compact --compact` means the same).
 *
 * A boolean that can be switched both ways is guarded too: an optional-value option
 * (`--is-foi [bool]`) and a negatable pair (`--x` / `--no-x`); this CLI has none today. commander
 * calls no value parser for a bare `--is-foi`, so `--is-foi false --is-foi` turned into true
 * silently. Those are counted per attribute from commander's `option:<name>` events, which fire
 * for every occurrence. Call it once on a freshly built program: the check counts per program.
 */
export function forbidRepeatedOptions(command: Command): void {
  const switches = new Set(command.options.filter((o) => o.negate || o.optional).map((o) => o.attributeName()));
  const seen = new Set<string>();
  for (const option of command.options) {
    const attribute = option.attributeName();
    if (switches.has(attribute)) {
      const names = command.options.filter((o) => o.attributeName() === attribute).map((o) => o.long ?? o.short);
      command.on(`option:${option.name()}`, () => {
        if (seen.has(attribute)) command.error(`error: ${names.join(" / ")} may be given only once.`, { code: "commander.optionRepeated" });
        seen.add(attribute);
      });
      continue;
    }
    if (!option.required || option.variadic || Array.isArray(option.defaultValue)) continue;
    const parse = option.parseArg;
    let given = false;
    const guarded = (value: string, previous: unknown): unknown => {
      if (given) throw new InvalidArgumentError(`${option.long ?? option.short} may be given only once.`);
      given = true;
      return parse === undefined ? value : parse(value, previous);
    };
    option.parseArg = guarded as typeof option.parseArg;
  }
  for (const child of command.commands) forbidRepeatedOptions(child);
}
