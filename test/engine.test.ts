import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_RETRY_AFTER_MS,
  RequestEngine,
  assertHeaderValue,
  parseRetryAfter,
  validateBaseUrl,
  type EngineOptions,
} from "../src/client/engine.js";
import { baseUrlProblem, headerValueProblem } from "../src/client/validate.js";
import {
  BundesratApiError,
  BundesratParseError,
  BundesratValidationError,
  cutForMessage,
  cutText,
  redactUrl,
  toWellFormed,
} from "../src/client/errors.js";
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

for (const baseUrl of ["file:///etc/passwd", "ftp://example.org"]) {
  test(`the engine rejects a non-http(s) base URL (${baseUrl}) before any request`, () => {
    const mt = makeMockTransport(() => xmlResponse(fx.appointmentsXml));
    assert.throws(
      () => new RequestEngine({ baseUrl, transport: mt.transport }),
      (err) =>
        err instanceof BundesratValidationError &&
        err.message === "Invalid baseUrl: Only http: and https: base URLs are supported.",
    );
    assert.equal(mt.calls.length, 0);
  });
}

test("the engine rejects a blank or unparseable base URL with a BundesratValidationError", () => {
  for (const [baseUrl, reason] of [
    ["", "Expected a non-empty URL."],
    ["  ", "Expected a non-empty URL."],
    ["not-a-url", "Expected a valid URL."],
    ["not a url", "A base URL cannot contain whitespace or control characters."],
  ] as const) {
    const mt = makeMockTransport(() => xmlResponse(fx.appointmentsXml));
    assert.throws(
      () => new RequestEngine({ baseUrl, transport: mt.transport }),
      (err) => err instanceof BundesratValidationError && err.message === `Invalid baseUrl: ${reason}`,
      baseUrl,
    );
    assert.equal(mt.calls.length, 0);
  }
});

test("a base URL with a query or fragment is rejected at construction", () => {
  for (const baseUrl of ["https://example.test/?x=1", "https://example.test/#frag", "https://example.test?"]) {
    const mt = makeMockTransport(() => xmlResponse(fx.membersXml));
    assert.throws(
      () => new RequestEngine({ transport: mt.transport, baseUrl }),
      (err: unknown) =>
        err instanceof BundesratValidationError && /cannot have a query \(\?\) or fragment \(#\)/.test(err.message),
      baseUrl,
    );
    assert.equal(mt.calls.length, 0);
  }
});

test("validateBaseUrl returns the value without trailing slashes, or throws", () => {
  assert.equal(validateBaseUrl("https://h.example/br//"), "https://h.example/br");
  assert.equal(validateBaseUrl("http://h.example"), "http://h.example");
  assert.throws(() => validateBaseUrl("ftp://h.example"), BundesratValidationError);
  assert.equal(baseUrlProblem("https://h.example/"), undefined);
  assert.equal(baseUrlProblem(42), "Expected a string.");
});

// ---- Retry-After (exploratory test 2026-09-26, finding 4) ----

function retryingEngine(retryAfter: string | undefined, maxRetries = 2) {
  const delays: number[] = [];
  const mt = makeMockTransport(() => ({
    status: 429,
    headers: {
      "content-type": "text/plain",
      ...(retryAfter === undefined ? {} : { "retry-after": retryAfter }),
    },
    body: Buffer.from("slow down"),
  }));
  const engine = new RequestEngine({
    transport: mt.transport,
    maxRetries,
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  return { engine, mt, delays };
}

test("a 429 with Retry-After in seconds waits that long before each retry", async () => {
  const { engine, mt, delays } = retryingEngine("1");
  await assert.rejects(() => engine.getXml("/x"), (e: unknown) => e instanceof BundesratApiError && e.status === 429);
  assert.equal(mt.calls.length, 3);
  assert.deepEqual(delays, [1000, 1000]);
});

test("without a usable Retry-After the retries back off linearly", async () => {
  for (const header of [undefined, "", "-1", "1.5", "soon", "1e3", "2026-09-26T10:00:00Z"]) {
    const { engine, delays } = retryingEngine(header);
    await assert.rejects(() => engine.getXml("/x"));
    assert.deepEqual(delays, [200, 400], String(header));
  }
});

test("a Retry-After above MAX_RETRY_AFTER_MS is not retried: the error surfaces at once", async () => {
  for (const header of ["31", "99999999999999999999", "Fri, 31 Dec 9999 23:59:59 GMT"]) {
    const { engine, mt, delays } = retryingEngine(header);
    await assert.rejects(() => engine.getXml("/x"), (e: unknown) => e instanceof BundesratApiError && e.status === 429);
    assert.equal(mt.calls.length, 1, header);
    assert.deepEqual(delays, [], header);
  }
});

test("parseRetryAfter reads delay-seconds and IMF-fixdate HTTP-dates", () => {
  const now = Date.parse("Sat, 26 Sep 2026 10:00:00 GMT");
  assert.equal(parseRetryAfter("0", now), 0);
  assert.equal(parseRetryAfter(" 30 ", now), 30_000);
  assert.equal(parseRetryAfter(["2", "9"], now), 2000);
  assert.equal(parseRetryAfter("Sat, 26 Sep 2026 10:00:05 GMT", now), 5000);
  assert.equal(parseRetryAfter("Sat, 26 Sep 2026 09:00:00 GMT", now), 0); // past date: retry now
  for (const bad of [undefined, "", "-1", "+5", "1.5", "1e3", "0x10", "Saturday, 26-Sep-26 10:00:05 GMT"]) {
    assert.equal(parseRetryAfter(bad, now), undefined, String(bad));
  }
  assert.equal(MAX_RETRY_AFTER_MS, 30_000);
});

test("redactUrl hides userinfo; base-URL errors never show the password", () => {
  assert.equal(redactUrl("https://u:pw@h.test/x?y=1"), "https://***@h.test/x?y=1");
  assert.equal(redactUrl("https://h.test/x"), "https://h.test/x");
  assert.equal(redactUrl("not a url"), "not a url");
  assert.throws(
    () => new RequestEngine({ baseUrl: "ftp://u:pw@h.test" }),
    (err: unknown) => err instanceof BundesratValidationError && !/pw/.test(err.message),
  );
  const api = new BundesratApiError({ status: 500, url: "https://u:pw@h.test/x", method: "GET", body: "" });
  assert.equal(api.url, "https://***@h.test/x");
  assert.doesNotMatch(api.message, /pw/);
});

test("out-of-range numeric engine options throw a BundesratValidationError (finding 16)", () => {
  for (const [name, value] of [
    ["maxRetries", Infinity],
    ["maxRetries", 11],
    ["timeoutMs", NaN],
    ["timeoutMs", -5],
    ["timeoutMs", 2 ** 31],
    ["retryDelayMs", 1.5],
    ["retryDelayMs", 30_001],
    ["maxResponseBytes", -1],
  ] as const) {
    assert.throws(
      () => new RequestEngine({ [name]: value }),
      (err: unknown) =>
        err instanceof BundesratValidationError &&
        err.message.startsWith(`Invalid option ${name}: expected an integer from 0 to `),
      `${name}=${value}`,
    );
  }
  assert.doesNotThrow(
    () => new RequestEngine({ maxRetries: 0, timeoutMs: 0, retryDelayMs: 0, maxResponseBytes: 0 }),
  );
  assert.doesNotThrow(() => new RequestEngine({ maxRetries: 10, timeoutMs: 2 ** 31 - 1, retryDelayMs: 30_000 }));
});

// ---- Header values (CLI <-> library parity, finding 3) ----

test("assertHeaderValue returns a valid value and throws BundesratValidationError otherwise", () => {
  assert.equal(assertHeaderValue("userAgent", "my-app/1.0 (müller)\tx"), "my-app/1.0 (müller)\tx");
  for (const bad of ["", "  ", "a\nb", "a\u007fb", "€"]) {
    assert.throws(
      () => assertHeaderValue("userAgent", bad),
      (err: unknown) => err instanceof BundesratValidationError && /^Invalid userAgent: /.test(err.message),
      JSON.stringify(bad),
    );
  }
});

test("headerValueProblem names the reason", () => {
  assert.equal(headerValueProblem("ok"), undefined);
  assert.equal(headerValueProblem(" "), "Expected a non-empty value.");
  assert.equal(headerValueProblem("a\rb"), "Value contains control characters.");
  assert.equal(headerValueProblem("Ā"), "Value contains characters outside Latin-1 (above U+00FF).");
  assert.equal(headerValueProblem(1), "Expected a string.");
});

test("the engine checks userAgent and defaultHeaders at construction, before any request", () => {
  const cases: EngineOptions[] = [
    { userAgent: "" },
    { userAgent: "a\r\nX: 1" },
    { defaultHeaders: { "X-Note": "a\nb" } },
    { defaultHeaders: { "Bad Name": "v" } },
    { defaultHeaders: { "": "v" } },
  ];
  for (const options of cases) {
    const mt = makeMockTransport(() => xmlResponse(fx.membersXml));
    assert.throws(
      () => new RequestEngine({ ...options, transport: mt.transport }),
      BundesratValidationError,
      JSON.stringify(options),
    );
    assert.equal(mt.calls.length, 0);
  }
  // An omitted userAgent still means the default.
  assert.doesNotThrow(() => new RequestEngine({ defaultHeaders: { "X-Note": "ok" } }));
});

test("a body that declares no encoding is decoded by the Content-Type charset", async () => {
  const xml = '<?xml version="1.0"?><iOS><list><item><title>K\u00e4se</title></item></list></iOS>';
  const mt = makeMockTransport(() => rawResponse(Buffer.from(xml, "latin1"), "text/xml; charset=ISO-8859-1"));
  const value = await new RequestEngine({ transport: mt.transport }).getXml("/f.xml");
  assert.deepEqual(JSON.parse(JSON.stringify(value)), { list: { item: { title: "Käse" } } });
});

test("the XML declaration outranks the Content-Type charset, a byte-order mark outranks both", async () => {
  const declared = '<?xml version="1.0" encoding="ISO-8859-1"?><iOS><list><t>K\u00e4se</t></list></iOS>';
  let mt = makeMockTransport(() => rawResponse(Buffer.from(declared, "latin1"), "application/xml;charset=utf-8"));
  assert.deepEqual(JSON.parse(JSON.stringify(await new RequestEngine({ transport: mt.transport }).getXml("/f"))), { list: { t: "Käse" } });
  const plain = '<?xml version="1.0"?><iOS><list><t>K\u00e4se</t></list></iOS>';
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(plain, "utf16le")]);
  mt = makeMockTransport(() => rawResponse(utf16, "application/xml;charset=iso-8859-1"));
  assert.deepEqual(JSON.parse(JSON.stringify(await new RequestEngine({ transport: mt.transport }).getXml("/f"))), { list: { t: "Käse" } });
});

test("an unknown Content-Type charset is a parse error", async () => {
  const mt = makeMockTransport(() => rawResponse("<iOS><list/></iOS>", "application/xml; charset=x-bogus"));
  await assert.rejects(
    () => new RequestEngine({ transport: mt.transport }).getXml("/f.xml"),
    (err) => err instanceof BundesratParseError && /Unsupported response charset "x-bogus"/.test(err.message),
  );
});

test("cutText never cuts inside a surrogate pair; toWellFormed replaces half a character", () => {
  assert.equal(cutText("ab\u{1f600}cd", 3), "ab");
  assert.equal(cutText("ab\u{1f600}cd", 4), "ab\u{1f600}");
  assert.equal(cutText("short", 10), "short");
  assert.equal(toWellFormed("a\ud83d b\ude00 \u{1f600}"), "a\ufffd b\ufffd \u{1f600}");
  // cutForMessage (500) uses it too.
  assert.equal(toWellFormed(cutForMessage("a" + "\u{1f600}".repeat(400))), cutForMessage("a" + "\u{1f600}".repeat(400)));
});

test("a server detail cut at 200 characters keeps the message well-formed", async () => {
  for (const detail of ["\u{1f600}".repeat(300), "a" + "\u{1f600}".repeat(300)]) {
    const e = new RequestEngine({ maxRetries: 0, transport: async () => rawResponse(detail, "text/plain", 500) });
    await assert.rejects(e.getXml("/x"), (err: Error) => {
      assert.equal(toWellFormed(err.message), err.message);
      assert.match(err.message, /…$/);
      return true;
    });
  }
});
