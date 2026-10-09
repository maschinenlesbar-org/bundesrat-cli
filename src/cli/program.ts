// Assemble the full commander program. The program is built around an injectable
// CliDeps so the entire CLI can be driven in tests with a mocked client and
// captured output.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command, InvalidArgumentError } from "commander";
import type { CliDeps } from "./io.js";
import { defaultIO } from "./io.js";
import { BundesratClient } from "../client/client.js";
import { DEFAULT_BASE_URL, MAX_RETRIES } from "../client/engine.js";
import { MAX_TIMEOUT_MS } from "../client/http.js";
import { parseBaseUrl, parseBoundedInt, parseHeaderValue, parseIntArg, parseOutputPath } from "./shared.js";
import { registerCommands } from "./commands/feeds.js";
import { DEFAULT_LOG_FORMAT, logFormatProblem } from "./log.js";

/**
 * Single source of truth for the version: read from package.json at runtime
 * rather than duplicating a literal that can silently drift after a release bump.
 * From the compiled location (dist/src/cli/program.js) package.json is three
 * directories up; the same offset holds for the source under src/cli.
 */
function readVersion(): string {
  try {
    const pkgUrl = new URL("../../../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION = readVersion();

/** Default dependencies: real client + real stdout/stderr/filesystem. */
export const defaultDeps: CliDeps = {
  io: defaultIO,
  createClient: (options) => new BundesratClient(options),
};

/** commander value-parser for `--log-format`. */
function parseLogFormat(value: string): string {
  const problem = logFormatProblem(value);
  if (problem !== undefined) throw new InvalidArgumentError(problem);
  return value;
}

export function buildProgram(deps: CliDeps = defaultDeps): Command {
  const program = new Command();

  program
    .name("bundesrat")
    .description(
      "CLI for the Bundesrat's public data feeds (the data behind the official " +
        "Bundesrat iOS app). No API key needed. Surfaces only openly-licensed data: " +
        "`session` shows the current plenary sitting's agenda (TOPs + Drucksachen); " +
        "`members` lists the Bundesrat members (filter by --state/--party); " +
        "`appointments` lists committee dates (Termine). The feeds' copyright " +
        "editorial content (news, summaries, images) is not exposed — see DATA_LICENSE.md.",
    )
    .version(VERSION)
    .option("--base-url <url>", "API base URL", parseBaseUrl, DEFAULT_BASE_URL)
    .option(
      "--timeout <ms>",
      "time limit per request in ms, whole response included (0 = no timeout)",
      parseBoundedInt(0, MAX_TIMEOUT_MS),
    )
    .option("--user-agent <ua>", "User-Agent header value", parseHeaderValue)
    .option(
      "--max-retries <n>",
      "retries for transient 429/503 responses and reset connections (0..10; a 429/503 waits the server's Retry-After, up to 30 s)",
      parseBoundedInt(0, MAX_RETRIES),
    )
    .option(
      "--max-response-bytes <n>",
      "cap response body size in bytes (0 = unlimited; default 100 MiB)",
      parseIntArg,
    )
    .option(
      "--log-format <format>",
      `how errors, warnings and notes are written to stderr: text (log4j style: time, level, [topic], message) or jsonl (one JSON object per line: ts, level, topic, msg); default ${DEFAULT_LOG_FORMAT}`,
      parseLogFormat,
    )
    .option("--compact", "print JSON on a single line instead of pretty-printed")
    .option("-o, --output <file>", "write output to this file instead of stdout (- = stdout)", parseOutputPath)
    .showHelpAfterError()
    // Global options work before or after the command, so list them in each
    // command's --help too. Set before registerCommands: subcommands copy it.
    .configureHelp({ showGlobalOptions: true });

  registerCommands(program, deps);

  return program;
}
