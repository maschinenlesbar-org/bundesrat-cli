import { test } from "node:test";
import assert from "node:assert/strict";
import { assertValid, type Problem } from "../src/client/validate.js";
import * as lib from "../src/index.js";
import { BundesratError, BundesratValidationError } from "../src/client/errors.js";
import { BundesratClient } from "../src/client/client.js";
import { run } from "../src/cli/run.js";
import type { CliDeps } from "../src/cli/io.js";
import { parity, xmlResponse } from "./helpers.js";
import * as fx from "./fixtures.js";

const nonBlank: Problem<string> = (v) => (v.trim() === "" ? "Expected a non-empty value." : undefined);

test("assertValid returns a valid value unchanged", () => {
  assert.equal(assertValid("state", "Bayern", nonBlank), "Bayern");
});

test("assertValid throws BundesratValidationError 'Invalid <name>: <reason>'", () => {
  assert.throws(
    () => assertValid("state", "  ", nonBlank),
    (err: unknown) =>
      err instanceof BundesratValidationError &&
      err instanceof BundesratError &&
      err.message === "Invalid state: Expected a non-empty value.",
  );
});

test("the validation layer is exported from the package root", () => {
  assert.equal(lib.assertValid, assertValid);
  assert.equal(lib.BundesratValidationError, BundesratValidationError);
});

test("run() maps a BundesratValidationError raised in an action to exit 2, 'Error: <message>'", async () => {
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    io: { out: (s) => out.push(s), err: (s) => err.push(s), writeFile: () => {} },
    createClient: () => {
      throw new BundesratValidationError("Invalid thing: Expected a non-empty value.");
    },
  };
  assert.equal(await run(["members"], deps), 2);
  assert.deepEqual(err, ["Error: Invalid thing: Expected a non-empty value."]);
  assert.deepEqual(out, []);
});

test("parity() runs one input through the CLI and the library on one recording transport", async () => {
  const { cli, lib: l } = await parity(
    ["--compact", "members"],
    (transport) => new BundesratClient({ transport }).members(),
    () => xmlResponse(fx.membersXml),
  );
  assert.equal(cli.code, 0);
  assert.equal(cli.requests.length, 1);
  assert.equal(l.ok, true);
  assert.equal(l.requests.length, 1);
  assert.equal(cli.requests[0]!.url, l.requests[0]!.url);
  assert.deepEqual(JSON.parse(cli.out), l.ok ? l.value : undefined);
});
