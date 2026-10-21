// Compile-time checks of the exported option types: every optional option takes `undefined`
// (as the runtime already treats it as omitted), so a consumer compiled with
// exactOptionalPropertyTypes can pass `process.env.X` or a filter that may be unset.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BundesratClient, filterMembers } from "../src/index.js";
import { makeMockTransport, xmlResponse } from "./helpers.js";

// Runs the TypeScript compiler over a consumer file.
const STARTS_A_PROCESS = { timeout: 30_000 };
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const INDEX = fileURLToPath(new URL("../src/index.js", import.meta.url));

test("a consumer with the strictest compiler settings can pass undefined for any option", STARTS_A_PROCESS, async () => {
  // Under exactOptionalPropertyTypes, `{ baseUrl: process.env.X }` fails to compile against an
  // option declared `?: string`, although the runtime treats undefined as omitted.
  const dir = mkdtempSync(join(tmpdir(), "bundesrat-types-"));
  try {
    writeFileSync(
      join(dir, "use.ts"),
      [
        `import { BundesratClient, filterMembers, type BundesratClientOptions, type EngineOptions, type MemberFilter } from ${JSON.stringify(INDEX)};`,
        "declare function allUndefined<T>(): { [K in keyof T]-?: undefined };",
        "export const options: EngineOptions = allUndefined<EngineOptions>();",
        "export const clientOptions: BundesratClientOptions = allUndefined<BundesratClientOptions>();",
        "export const filter: MemberFilter = allUndefined<MemberFilter>();",
        "export const client = new BundesratClient({ baseUrl: process.env.BUNDESRAT_BASE_URL, timeoutMs: 15_000 });",
        "export const names = async (): Promise<string[]> =>",
        "  filterMembers(await client.members({ state: process.env.LAND, party: undefined }), filter).map((m) => m.name ?? '');",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
          module: "nodenext",
          moduleResolution: "nodenext",
          target: "es2022",
          noEmit: true,
          skipLibCheck: false,
          types: ["node"],
          typeRoots: [join(ROOT, "node_modules/@types")],
        },
        files: ["use.ts"],
      }),
    );
    const tsc = join(ROOT, "node_modules/typescript/bin/tsc");
    const result = await new Promise<{ code: number; out: string }>((resolve) => {
      execFile(process.execPath, [tsc, "-p", join(dir, "tsconfig.json")], (err, stdout, stderr) =>
        resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: stdout + stderr }),
      );
    });
    assert.equal(result.code, 0, result.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const MEMBERS =
  "<iOS><list><employee><name>Söder</name><party>CSU</party><state>Bayern</state></employee>" +
  "<employee><name>Rhein</name><party>CDU</party><state>Hessen</state></employee></list></iOS>";

test("an option given as undefined means its default, as an omitted one does", async () => {
  const mt = makeMockTransport(() => xmlResponse(MEMBERS));
  const client = new BundesratClient({
    baseUrl: undefined,
    userAgent: undefined,
    defaultHeaders: undefined,
    timeoutMs: undefined,
    maxRetries: undefined,
    retryDelayMs: undefined,
    maxResponseBytes: undefined,
    sleep: undefined,
    onRetry: undefined,
    transport: mt.transport,
  });
  const all = await client.members({ state: undefined, party: undefined });
  assert.equal(all.length, 2);
  assert.equal(mt.last().url, "https://www.bundesrat.de/iOS/SharedDocs/2_Mitglieder/mitglieder_table.xml?view=renderXml");
  assert.equal(mt.last().headers?.["User-Agent"], "bundesrat-cli");
  assert.equal(mt.last().timeoutMs, 30_000);
  assert.equal(mt.last().maxResponseBytes, 100 * 1024 * 1024);
  assert.deepEqual(filterMembers(all, { state: undefined, party: undefined }), all);
});
