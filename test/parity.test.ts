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

// ---- Finding 3: --user-agent / userAgent ----

test("user agent: a value the CLI rejects is rejected by the library too, with no request", async () => {
  for (const [ua, reason] of [
    ["", "Expected a non-empty value."],
    ["   ", "Expected a non-empty value."],
    ["a\r\nX-Injected: 1", "Value contains control characters."],
    ["a\u007fb", "Value contains control characters."],
    ["a\u0000b", "Value contains control characters."],
    ["agent-€", "Value contains characters outside Latin-1 (above U+00FF)."],
  ] as const) {
    const { cli, lib } = await parity(
      ["--compact", "--user-agent", ua, "session"],
      (transport) => new BundesratClient({ userAgent: ua, transport }).session(),
      () => xmlResponse(fx.sessionXml),
    );
    const label = JSON.stringify(ua);
    assert.equal(cli.code, 2, label);
    assert.ok(cli.err.includes(reason), label);
    assert.equal(cli.requests.length, 0, label);
    assert.ok(!lib.ok && lib.error instanceof BundesratValidationError, label);
    assert.equal((lib as { error: Error }).error.message, `Invalid userAgent: ${reason}`, label);
    assert.equal(lib.requests.length, 0, label);
  }
});

test("user agent: tab and Latin-1 are sent identically by both", async () => {
  for (const ua of ["a\tb", "agent-ä"]) {
    const { cli, lib } = await parity(
      ["--compact", "--user-agent", ua, "session"],
      (transport) => new BundesratClient({ userAgent: ua, transport }).session(),
      () => xmlResponse(fx.sessionXml),
    );
    assert.equal(cli.code, 0, ua);
    assert.ok(lib.ok, ua);
    assert.equal(cli.requests[0]!.headers?.["User-Agent"], ua);
    assert.deepEqual(cli.requests, lib.requests);
  }
});

// ---- Finding 2: base URL with whitespace ----

test("base URL: surrounding or inner whitespace is rejected by both, with no request", async () => {
  const surrounding = "A base URL cannot have surrounding whitespace.";
  const inner = "A base URL cannot contain whitespace or control characters.";
  for (const [baseUrl, reason] of [
    ["https://example.org/ ", surrounding],
    [" https://example.org", surrounding],
    ["https://example.org\n", surrounding],
    ["\thttps://example.org/", surrounding],
    ["https://example.org/a b", inner],
    ["https://exa\tmple.org", inner],
    ["https://example.org/p\r\nq", inner],
  ] as const) {
    const { cli, lib } = await parity(
      ["--compact", "--base-url", baseUrl, "session"],
      (transport) => new BundesratClient({ baseUrl, transport }).session(),
      () => xmlResponse(fx.sessionXml),
    );
    const label = JSON.stringify(baseUrl);
    assert.equal(cli.code, 2, label);
    assert.ok(cli.err.includes(reason), label);
    assert.equal(cli.requests.length, 0, label);
    assert.ok(!lib.ok && lib.error instanceof BundesratValidationError, label);
    assert.equal((lib as { error: Error }).error.message, `Invalid baseUrl: ${reason}`, label);
    assert.equal(lib.requests.length, 0, label);
  }
});

// ---- Finding 4: an invalid base URL is a validation error on both sides ----

test("base URL: every invalid shape is a BundesratValidationError with the CLI's reason", async () => {
  for (const [baseUrl, reason] of [
    ["", "Expected a non-empty URL."],
    ["   ", "Expected a non-empty URL."],
    ["not-a-url", "Expected a valid URL."],
    ["ftp://h.example", "Only http: and https: base URLs are supported."],
    ["file:///etc", "Only http: and https: base URLs are supported."],
    ["https://h.example/?x=1", "A base URL cannot have a query (?) or fragment (#)."],
    ["https://h.example/#f", "A base URL cannot have a query (?) or fragment (#)."],
  ] as const) {
    const { cli, lib } = await parity(
      ["--compact", "--base-url", baseUrl, "members"],
      (transport) => new BundesratClient({ baseUrl, transport }).members(),
      () => xmlResponse(fx.membersXml),
    );
    const label = JSON.stringify(baseUrl);
    assert.equal(cli.code, 2, label);
    assert.ok(cli.err.includes(reason), label);
    assert.equal(cli.requests.length, 0, label);
    assert.ok(!lib.ok && lib.error instanceof BundesratValidationError, label);
    assert.ok(!(lib as { error: unknown }).error?.constructor.name.includes("Network"), label);
    assert.equal((lib as { error: Error }).error.message, `Invalid baseUrl: ${reason}`, label);
    assert.equal(lib.requests.length, 0, label);
  }
});

test("base URL: a valid one with a path prefix gives the identical request", async () => {
  const baseUrl = "https://mirror.example/br/";
  const { cli, lib } = await parity(
    ["--compact", "--base-url", baseUrl, "members"],
    (transport) => new BundesratClient({ baseUrl, transport }).members(),
    () => xmlResponse(fx.membersXml),
  );
  assert.equal(cli.code, 0);
  assert.ok(lib.ok);
  assert.deepEqual(cli.requests, lib.requests);
  assert.equal(
    cli.requests[0]!.url,
    "https://mirror.example/br/iOS/SharedDocs/2_Mitglieder/mitglieder_table.xml?view=renderXml",
  );
});
