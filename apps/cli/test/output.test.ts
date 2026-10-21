// The output sink (src/cli/output.ts): rendering, and (with the file seam in io.ts) `-o` and
// `--force`. A write cut short is conformance test P26's.

import { test } from "node:test";
import assert from "node:assert/strict";
import { OutputError, renderJson } from "../src/cli/output.js";
import { run } from "../src/cli/run.js";
import type { CliDeps } from "../src/cli/io.js";
import { BundesratClient } from "@maschinenlesbar.org/bundesrat-client/internal/client";
import type { HttpRequest, HttpResponse } from "@maschinenlesbar.org/bundesrat-client/internal/http";
import { makeMockTransport, untimed, xmlResponse } from "./helpers.js";

const MEMBERS = "<iOS><list><employee><name>Söder</name><party>CSU</party><state>Bayern</state></employee></list></iOS>";

function makeCli(responder: (req: HttpRequest) => HttpResponse | Promise<HttpResponse> = () => xmlResponse(MEMBERS)) {
  const out: string[] = [];
  const err: string[] = [];
  const mt = makeMockTransport(responder);
  const deps: CliDeps = {
    io: {
      out: (s) => out.push(s),
      err: (s) => err.push(untimed(s)),
      writeFile: () => {
        throw new Error("no file expected");
      },
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
