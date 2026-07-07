import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestEngine } from "../src/client/engine.js";
import { BundesratApiError, BundesratParseError } from "../src/client/errors.js";
import { makeMockTransport, xmlResponse, rawResponse } from "./helpers.js";
import * as fx from "./fixtures.js";

test("buildUrl normalises the path and appends the query", () => {
  const e = new RequestEngine({ baseUrl: "https://www.bundesrat.de/" });
  assert.equal(
    e.buildUrl("/iOS/x.xml", { view: "renderXml" }),
    "https://www.bundesrat.de/iOS/x.xml?view=renderXml",
  );
});

test("getXml parses an XML body into a JS value", async () => {
  const mt = makeMockTransport(() => xmlResponse(fx.appointmentsXml));
  const e = new RequestEngine({ transport: mt.transport });
  const v = (await e.getXml("/x", { view: "renderXml" })) as { list: { item: { title: string } } };
  assert.equal(v.list.item.title, "Sitzung des Vermittlungsausschusses");
});

test("getXml sends the Accept: application/xml header and the query", async () => {
  const mt = makeMockTransport(() => xmlResponse(fx.appointmentsXml));
  const e = new RequestEngine({ transport: mt.transport });
  await e.getXml("/x", { view: "renderXml" });
  assert.equal(mt.last().headers?.["Accept"], "application/xml");
  assert.match(mt.last().url, /view=renderXml/);
});

test("getXml rejects the HTML shell with a helpful BundesratParseError", async () => {
  const mt = makeMockTransport(() => rawResponse(fx.htmlShell, "text/html"));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.getXml("/x", { view: "renderXml" }),
    (err) => err instanceof BundesratParseError && /HTML page/.test(err.message),
  );
});

test("getXml on an empty body reports 'Empty response', not a parse failure", async () => {
  const mt = makeMockTransport(() => rawResponse("   ", "application/xml"));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.getXml("/x", { view: "renderXml" }),
    (err) => err instanceof BundesratParseError && /Empty response/.test(err.message),
  );
});

test("a 503 is retried up to maxRetries then surfaces as BundesratApiError", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return rawResponse("busy", "text/plain", 503);
  });
  const e = new RequestEngine({ transport: mt.transport, maxRetries: 2, sleep: async () => {} });
  await assert.rejects(
    () => e.getXml("/x"),
    (err) => err instanceof BundesratApiError && err.status === 503,
  );
  assert.equal(calls, 3); // initial + 2 retries
});

test("a 404 surfaces as a BundesratApiError with status 404", async () => {
  const mt = makeMockTransport(() => rawResponse("<!doctype html>not found", "text/html", 404));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.getXml("/x"),
    (err) => err instanceof BundesratApiError && err.status === 404 && err.isNotFound,
  );
});

test("error detail is stripped of terminal control characters", async () => {
  // Build the hostile snippet from char codes so no raw control byte appears in
  // this source file. ESC + CSI (a C1 control) + BEL interleaved with printable text.
  const ESC = String.fromCharCode(0x1b);
  const BEL = String.fromCharCode(0x07);
  const CSI = String.fromCharCode(0x9b);
  const evil = `boom${ESC}[31mred${BEL}${CSI}2J`;
  // Plain (non-`<`) body so a `detail` snippet is produced.
  const mt = makeMockTransport(() => rawResponse(evil, "text/plain", 500));
  const e = new RequestEngine({ transport: mt.transport, maxRetries: 0 });
  await assert.rejects(
    () => e.getXml("/x"),
    (err) => {
      assert.ok(err instanceof BundesratApiError);
      const hasControl = (s: string): boolean =>
        [...s].some((c) => {
          const n = c.charCodeAt(0);
          return n <= 8 || (n >= 0x0b && n <= 0x1f) || (n >= 0x7f && n <= 0x9f);
        });
      // Control bytes are gone from both the structured detail and the message
      // that run.ts prints to stderr, while printable characters are preserved.
      assert.ok(!hasControl(err.detail ?? ""));
      assert.ok(!hasControl(err.message));
      assert.equal(err.detail, "boom[31mred2J");
      return true;
    },
  );
});

test("a pathologically deep body surfaces as BundesratParseError, not a raw error (BR-01)", async () => {
  // A hostile/MITM'd feed returns a very deeply nested document. Before the depth
  // cap this parsed fine but the downstream JSON.stringify threw an untyped
  // RangeError ("Unexpected error"); now it fails cleanly as a parse error.
  const deep = "<x>".repeat(5000) + "leaf" + "</x>".repeat(5000);
  const mt = makeMockTransport(() => rawResponse(`<iOS>${deep}</iOS>`, "application/xml"));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.getXml("/x", { view: "renderXml" }),
    (err) => err instanceof BundesratParseError && /Failed to parse XML/.test(err.message),
  );
});
