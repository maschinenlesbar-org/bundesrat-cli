// CLI <-> library parity: the same input through run() and through the library
// must give the same outcome (2026-10-03 parity report).

import { test } from "node:test";
import assert from "node:assert/strict";
import { BundesratClient } from "@maschinenlesbar.org/bundesrat-client/internal/client";
import { BundesratValidationError } from "@maschinenlesbar.org/bundesrat-client/internal/errors";
import { kitParity, parity, xmlResponse } from "./helpers.js";
import * as fx from "@maschinenlesbar.org/bundesrat-client/test/fixtures";

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

// ---- 2026-10-21, D8 and D10: P24's corpus through the client-side filters ----
// P24 reads the value back from the request, and --state / --party filter the list the feed
// returns: no value is sent. So its corpus runs here, on the members the feed returned.

/** Values every filter refuses (P24's REFUSED): blank, only invisible characters or combining marks, a lone surrogate, a control or format character. */
const REFUSED = [
  "", " ", "\u00a0", "\n\t", "\u3000", "\u200b", "\u00ad", "\u200d", "\ufeff", "\u0301\u0308", " \u200b ",
  "a\u200bb", "M\u00fcl\u00adler", "\u202eabc", "a\u0000b", "a\u001bb", "a\u0085b", "\ud800", "a\udc00b", "x\ud83d",
];
const INVISIBLE = /[\p{Cc}\p{Cf}]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u;

test("members filter: --state and --party refuse a blank, invisible, control or half character on both sides, showing it escaped (D8, D10)", async () => {
  for (const option of ["state", "party"] as const) {
    for (const value of REFUSED) {
      const label = `--${option} ${JSON.stringify(value)}`;
      const o = await kitParity(["members", `--${option}`, value], (transport) => new BundesratClient({ transport }).members({ [option]: value }), () => xmlResponse(fx.membersParityXml));
      assert.equal(o.cli.code, 2, `${label}: CLI exit ${o.cli.code}`);
      assert.deepEqual(o.cli.requests, [], label);
      assert.equal(o.lib.ok, false, `${label}: the library resolved`);
      assert.deepEqual(o.lib.requests, [], label);
      assert.match(o.lib.error?.name ?? "", /ValidationError$/, label);
      const blank = value.replace(/[\s\p{Cc}\p{Cf}\p{M}]/gu, "") === "";
      const ch = INVISIBLE.exec(value.trim())?.[0];
      if (blank || ch === undefined) {
        assert.match(o.lib.error?.message ?? "", /Expected a non-empty value\./, label);
        continue;
      }
      const escape = `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
      assert.ok(o.cli.err.toLowerCase().includes(escape), `${label}: ${o.cli.err}`);
      assert.ok(!o.cli.err.includes(ch), `${label}: the CLI's refusal shows the character raw`);
      assert.ok((o.lib.error?.message ?? "").toLowerCase().includes(escape), `${label}: ${o.lib.error?.message}`);
    }
  }
});

test("members filter: a --party text with joiners, emoji or inner whitespace is accepted alike on both sides (D8)", async () => {
  for (const value of ["Gr\u00fcne", "Gru\u0308ne", "  cdu  ", "a\u200db", "\ud83d\ude00", "a  b", "x".repeat(5000)]) {
    const o = await kitParity(["--compact", "members", "--party", value], (transport) => new BundesratClient({ transport }).members({ party: value }), () => xmlResponse(fx.membersParityXml));
    assert.equal(o.cli.code, 0, `${JSON.stringify(value.slice(0, 20))}: ${o.cli.err}`);
    assert.equal(o.lib.ok, true, JSON.stringify(value.slice(0, 20)));
    assert.deepEqual(JSON.parse(o.cli.out), o.lib.value);
  }
});
