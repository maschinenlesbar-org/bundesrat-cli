// CLI <-> library parity: the same input through run() and through the library
// must give the same outcome (2026-10-03 parity report).

import { test } from "node:test";
import assert from "node:assert/strict";
import { BundesratClient } from "../src/client/client.js";
import { BundesratValidationError } from "../src/client/errors.js";
import { parity, xmlResponse } from "./helpers.js";
import * as fx from "./fixtures.js";

const names = (rows: unknown): string[] => (rows as Array<{ name: string }>).map((r) => r.name);

// ---- Finding 1: members --state / --party ----

test("members filter: the CLI and members(filter) return the same members", async () => {
  const nfd = (s: string) => s.normalize("NFD");
  for (const [args, filter, expected] of [
    [["--state", "Bayern"], { state: "Bayern" }, ["Söder", "Upper"]],
    [["--state", "bayern"], { state: "bayern" }, ["Söder", "Upper"]],
    [["--state", " Bayern "], { state: " Bayern " }, ["Söder", "Upper"]],
    [["--state", "Baden-Württemberg"], { state: "Baden-Württemberg" }, ["Kretschmann", "Decomp"]],
    [["--state", nfd("Baden-Württemberg")], { state: nfd("Baden-Württemberg") }, ["Kretschmann", "Decomp"]],
    [["--party", "grüne"], { party: "grüne" }, ["Kretschmann"]],
    [["--party", nfd("GRÜNE")], { party: nfd("GRÜNE") }, ["Kretschmann"]],
    [["--party", " cdu "], { party: " cdu " }, ["Decomp", "Rhein"]],
    [["--state", "Hessen", "--party", "cdu"], { state: "Hessen", party: "cdu" }, ["Rhein"]],
    [["--state", "Hamburg"], { state: "Hamburg" }, []],
  ] as const) {
    const { cli, lib } = await parity(
      ["--compact", "members", ...args],
      (transport) => new BundesratClient({ transport }).members(filter),
      () => xmlResponse(fx.membersParityXml),
    );
    const label = args.join(" ");
    assert.equal(cli.code, 0, label);
    assert.ok(lib.ok, label);
    assert.deepEqual(names(JSON.parse(cli.out)), expected, label);
    assert.deepEqual(names(lib.value), expected, label);
    assert.deepEqual(cli.requests.map((r) => r.url), lib.requests.map((r) => r.url), label);
  }
});

test("members filter: a blank --state / --party is rejected by both, with no request", async () => {
  for (const [args, filter] of [
    [["--state", ""], { state: "" }],
    [["--state", "   "], { state: "   " }],
    [["--party", ""], { party: "" }],
    [["--party", " \t "], { party: " \t " }],
  ] as const) {
    const { cli, lib } = await parity(
      ["--compact", "members", ...args],
      (transport) => new BundesratClient({ transport }).members(filter),
      () => xmlResponse(fx.membersParityXml),
    );
    const label = JSON.stringify(filter);
    assert.equal(cli.code, 2, label);
    assert.match(cli.err, /Expected a non-empty value\./, label);
    assert.equal(cli.requests.length, 0, label);
    assert.equal(lib.ok, false, label);
    assert.ok(!lib.ok && lib.error instanceof BundesratValidationError, label);
    assert.match(String((lib as { error: Error }).error.message), /^Invalid (state|party): Expected a non-empty value\.$/);
    assert.equal(lib.requests.length, 0, label);
  }
});
