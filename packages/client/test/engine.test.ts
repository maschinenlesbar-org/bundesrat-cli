import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_RETRY_AFTER_MS,
  RequestEngine,
  assertHeaderValue,
  parseRetryAfter,
  validateBaseUrl,
  type EngineOptions,
} from "../src/engine.js";
import { baseUrlProblem, headerValueProblem } from "../src/validate.js";
import {
  BundesratApiError,
  BundesratNetworkError,
  BundesratParseError,
  BundesratValidationError,
  cutForMessage,
  cutText,
  redactUrl,
  toWellFormed,
} from "../src/errors.js";
import { BundesratClient } from "../src/client.js";
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

test("own messages quote a server value at most 500 characters long (L3)", async () => {
  const root = `r${"x".repeat(5000)}`;
  const client = new BundesratClient({ transport: async () => xmlResponse(`<${root}><list/></${root}>`) });
  await assert.rejects(client.appointments(), (err: Error) => err.message.length < 700 && /got <rx+…>/.test(err.message));
});

test("credentials a server echoes are scrubbed from the error: Basic, user:password, password (L13)", async () => {
  // Node sends the pair UTF-8 encoded (the Authorization header it builds from the URL), so that is the form a server echoes.
  const basic = Buffer.from("alice:pa ss-pw", "utf8").toString("base64");
  const engine = new RequestEngine({
    baseUrl: "https://alice:pa%20ss-pw@mirror.example",
    maxRetries: 0,
    transport: makeMockTransport(() => rawResponse(`no: Basic ${basic} / alice:pa ss-pw / pa ss-pw`, "text/plain", 401)).transport,
  });
  await assert.rejects(engine.getXml("/x"), (err: BundesratApiError) => {
    for (const form of [basic, "alice:pa ss-pw", "pa ss-pw"]) assert.ok(!err.message.includes(form), err.message);
    assert.match(err.message, /no: Basic \*\*\* \/ \*\*\* \/ \*\*\*/);
    for (const form of [basic, "alice:pa ss-pw", "pa ss-pw"]) assert.ok(!err.body.includes(form), err.body);
    return true;
  });
});

test("a timeout, the size cap, a refused connection and a DNS failure name the request (K3)", async () => {
  const url = "GET https://***@feeds.example/iOS/SharedDocs/2_Mitglieder/mitglieder_table.xml?view=renderXml failed: ";
  const thrown = (message: string, code: string): Error => Object.assign(new Error(message), { code });
  const cases: Array<[string, Partial<EngineOptions>, string]> = [
    ["refused", { transport: async () => { throw thrown("connect ECONNREFUSED 127.0.0.1:1", "ECONNREFUSED"); } }, "connect ECONNREFUSED 127.0.0.1:1"],
    ["DNS", { transport: async () => { throw thrown("getaddrinfo ENOTFOUND feeds.example", "ENOTFOUND"); } }, "getaddrinfo ENOTFOUND feeds.example"],
    ["reset", { transport: async () => { throw thrown("socket hang up", "ECONNRESET"); }, maxRetries: 0 }, "socket hang up"],
    ["timeout", { transport: () => new Promise(() => {}), timeoutMs: 20 }, "Request exceeded the 20ms deadline"],
    ["size cap", { transport: async () => xmlResponse("<iOS><list/></iOS>"), maxResponseBytes: 5 }, "Response exceeded the size limit"],
  ];
  for (const [label, options, reason] of cases) {
    const client = new BundesratClient({ baseUrl: "https://user:pa55word@feeds.example", ...options });
    await assert.rejects(client.members(), (err: unknown) => {
      assert.ok(err instanceof BundesratNetworkError, `${label}: ${String(err)}`);
      assert.ok(err.message.startsWith(url + reason), `${label}: ${err.message}`);
      assert.doesNotMatch(err.message, /pa55word/, label);
      if (label !== "size cap") assert.ok(err.cause instanceof Error, `${label}: the original is the cause`);
      return true;
    });
  }
});

test("a header named __proto__ is an ordinary header, never the prototype of the headers read (T12)", async () => {
  // A JavaScript transport may return any object; JSON.parse makes "__proto__" an own key.
  const headers = JSON.parse('{"__proto__":{"content-type":"application/xml;charset=iso-8859-1"}}') as Record<string, string>;
  const body = Buffer.from("<iOS><list><title>ü</title></list></iOS>", "utf8");
  const e = new RequestEngine({ transport: async () => ({ status: 200, headers, body }) });
  // With the prototype set, its Content-Type was read: the UTF-8 body decoded as Latin-1 ("Ã¼").
  assert.deepEqual(JSON.parse(JSON.stringify(await e.getXml("/x"))), { list: { title: "ü" } });
  const fetchLike = new Headers([["__proto__", "x"], ["content-type", "application/xml;charset=iso-8859-1"]]);
  const f = new RequestEngine({ transport: async () => ({ status: 200, headers: fetchLike as unknown as Record<string, string>, body: Buffer.from([0x3c, 0x61, 0x3e, 0xfc, 0x3c, 0x2f, 0x61, 0x3e]) }) });
  assert.equal(await f.getXml("/x"), "ü");
});

test("text that is not valid is replaced with U+FFFD and reported through onWarning, never silently (D2)", async () => {
  const utf16 = (text: string): Buffer => Buffer.from(text, "utf16le");
  const cases: Array<[string, Buffer, string, unknown, number]> = [
    // A reference to a lone surrogate (high alone, low alone); a pair of references, hex or
    // decimal, is the character; an escaped ampersand stays text.
    [
      "lone references",
      Buffer.from("<r><a>x&#xD800;y</a><b>&#xdc00;</b><c>&#xD83D;&#xDE00;</c><e>&#55357;&#56832;</e><d>&amp;#xD800;</d></r>"),
      "application/xml",
      { a: "x�y", b: "�", c: "\u{1f600}", e: "\u{1f600}", d: "&#xD800;" },
      2,
    ],
    // Invalid UTF-8 bytes; a U+FFFD the server sent is not counted.
    ["invalid bytes", Buffer.concat([Buffer.from("<r><a>"), Buffer.from([0xff, 0xc3]), Buffer.from("</a><b>�</b></r>")]), "application/xml", { a: "��", b: "�" }, 2],
    // A byte undefined in the declared single-byte charset.
    ["iso-8859-3", Buffer.concat([Buffer.from('<?xml version="1.0" encoding="iso-8859-3"?><r><a>'), Buffer.from([0xa5]), Buffer.from("</a></r>")]), "application/xml", { a: "�" }, 1],
    // An unpaired surrogate in a UTF-16 document (byte-order mark).
    ["utf-16", Buffer.concat([Buffer.from([0xff, 0xfe]), utf16("<r><a>x"), Buffer.from([0x00, 0xd8]), utf16("y</a></r>")]), "application/xml", { a: "x�y" }, 1],
  ];
  for (const [label, body, type, expected, count] of cases) {
    const warnings: string[] = [];
    const e = new RequestEngine({ onWarning: (m) => warnings.push(m), transport: makeMockTransport(() => rawResponse(body, type)).transport });
    const value = await e.getXml("/feed.xml", { view: "renderXml" });
    assert.deepEqual(JSON.parse(JSON.stringify(value)), expected, label);
    assert.ok(!/[\ud800-\udfff]/u.test(JSON.stringify(value)), `${label}: well-formed`);
    assert.deepEqual(warnings, [
      `GET https://www.bundesrat.de/feed.xml?view=renderXml: ${count} ${count === 1 ? "character" : "characters"} of the answer ${count === 1 ? "was" : "were"} not valid text (invalid bytes or a lone surrogate) and replaced with U+FFFD.`,
    ], label);
  }
  // Valid text: no warning; a throwing hook never fails the request.
  const quiet: string[] = [];
  const ok = new RequestEngine({ onWarning: (m) => quiet.push(m), transport: makeMockTransport(() => xmlResponse("<a>&#xFC;�</a>")).transport });
  assert.equal(await ok.getXml("/x"), "ü�");
  assert.deepEqual(quiet, []);
  const throwing = new RequestEngine({ onWarning: () => { throw new Error("hook"); }, transport: makeMockTransport(() => xmlResponse("<a>&#xD800;</a>")).transport });
  assert.equal(await throwing.getXml("/x"), "�");
  assert.throws(() => new RequestEngine({ onWarning: "log" as unknown as () => void }), BundesratValidationError);
});
