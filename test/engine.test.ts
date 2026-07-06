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
