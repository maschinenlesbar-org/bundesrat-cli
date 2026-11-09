import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { TextDecoder } from "node:util";
import assert from "node:assert/strict";
import {
  MAX_RETRY_AFTER_MS,
  RequestEngine,
  assertHeaderValue,
  parseRetryAfter,
  sanitizeServerText,
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
  credentialsIn,
  cutText,
  echoedCredentialForms,
  redactUrl,
  redactUrlUserinfo,
  TextBuilder,
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

test("getXml on an empty body reports 'empty response', not a parse failure", async () => {
  const mt = makeMockTransport(() => rawResponse("   ", "application/xml"));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.getXml("/x", { view: "renderXml" }),
    (err) => err instanceof BundesratParseError && /: empty response/.test(err.message),
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
      // that run.ts prints to stderr; whole escape sequences go, so none of their
      // printable rest is left behind, while ordinary text is preserved.
      assert.ok(!hasControl(err.detail ?? ""));
      assert.ok(!hasControl(err.message));
      assert.equal(err.detail, "boomred");
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
    (err) => err instanceof BundesratParseError && /: the answer is not valid XML: /.test(err.message),
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
    (err) => err instanceof BundesratParseError && /: unsupported response charset "x-bogus"/.test(err.message),
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
  await assert.rejects(client.appointments(), (err: Error) => err.message.length < 700 && /got "rx+"…/.test(err.message));
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

test("echoedCredentialForms treats a userinfo without a password as a token (Basic `TOKEN:`)", () => {
  const basic = (pair: string): string => Buffer.from(pair, "utf8").toString("base64");
  assert.deepEqual(echoedCredentialForms("alice:s3cret"), [basic("alice:s3cret"), "alice:s3cret", "s3cret"]);
  assert.deepEqual(echoedCredentialForms("T0ken"), [basic("T0ken:"), "T0ken:", "T0ken"]);
  assert.deepEqual(echoedCredentialForms("T0ken:"), [basic("T0ken:"), "T0ken:", "T0ken"]);
  assert.deepEqual(echoedCredentialForms("T%C3%B6k"), [basic("Tök:"), "Tök:"]); // short: not alone
  assert.deepEqual(echoedCredentialForms(":pw12"), [basic(":pw12"), ":pw12", "pw12"]);
  assert.deepEqual(echoedCredentialForms(""), []);
  assert.deepEqual(echoedCredentialForms(":"), []);
});

test("a token userinfo (no password) a server echoes is scrubbed from the error in every form", async () => {
  const token = "T0kenS3cret";
  const basic = Buffer.from(`${token}:`, "utf8").toString("base64");
  for (const baseUrl of [`https://${token}@mirror.example`, `https://${token}:@mirror.example`]) {
    for (const echo of [`bad token ${token}`, `Authorization: Basic ${basic}`, `user ${token}: unknown`]) {
      const engine = new RequestEngine({
        baseUrl,
        maxRetries: 0,
        transport: makeMockTransport(() => rawResponse(echo, "text/plain", 401)).transport,
      });
      await assert.rejects(engine.getXml("/x"), (err: BundesratApiError) => {
        assert.match(err.message, /^HTTP 401 /);
        for (const text of [err.message, err.body, String(err.detail)]) {
          assert.ok(!text.includes(token) && !text.includes(basic), `${baseUrl} ${echo}: ${text}`);
        }
        return true;
      });
    }
  }
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

test("an answer error names the request: method and URL, userinfo redacted (D9)", async () => {
  const answers: Array<[string, () => ReturnType<typeof rawResponse>]> = [
    ["the answer is not valid XML: ", () => rawResponse("<iOS><list>", "application/xml")],
    ["expected XML but received an HTML page", () => rawResponse("<!doctype html><html></html>", "text/html")],
    ["empty response", () => rawResponse(" ", "application/xml")],
    ["unsupported response charset", () => rawResponse("<a/>", "application/xml; charset=x-bogus")],
  ];
  const base = new URL("https://www.bundesrat.de");
  base.username = "alice";
  base.password = "s3cret";
  for (const [what, respond] of answers) {
    const e = new RequestEngine({ baseUrl: base.href, transport: makeMockTransport(respond).transport });
    await assert.rejects(e.getXml("/feed.xml", { view: "renderXml" }), (err: unknown) => {
      assert.ok(err instanceof BundesratParseError, what);
      assert.ok(err.message.startsWith(`GET ${base.protocol}//***@${base.host}/feed.xml?view=renderXml: `), err.message);
      assert.ok(err.message.includes(what), err.message);
      assert.ok(!err.message.includes("s3cret"), err.message);
      return true;
    });
  }
  // The client's shape errors too.
  const c = new BundesratClient({ transport: makeMockTransport(() => xmlResponse("<error/>")).transport });
  await assert.rejects(c.session(), (err: Error) =>
    err.message === 'GET https://www.bundesrat.de/iOS/SharedDocs/3_Plenum/plenum_aktuelleSitzung_table.xml?view=renderXml: unexpected response shape: expected an <iOS> root element, got "error".');
});

test("an answer longer than V8's longest string is a BundesratParseError naming the request, not a plain Error (B5)", async (t) => {
  // A real one needs a body of 512 MB and more (possible with maxResponseBytes 0): V8's own
  // error is stood in for, for the body marked by its length.
  const huge = Buffer.from("<iOS><list/></iOS>  ");
  const tooLong = Object.assign(new Error("Cannot create a string longer than 0x1fffffe8 characters"), { code: "ERR_STRING_TOO_LONG" });
  const decode = TextDecoder.prototype.decode;
  t.mock.method(TextDecoder.prototype, "decode", function (this: InstanceType<typeof TextDecoder>, input?: Uint8Array, options?: { stream?: boolean }) {
    if (input !== undefined && input.byteLength === huge.length) throw tooLong;
    return decode.call(this, input, options);
  });
  const toString = Buffer.prototype.toString;
  t.mock.method(Buffer.prototype, "toString", function (this: Buffer, ...args: Parameters<Buffer["toString"]>) {
    if (this.length === huge.length && args[0] === "utf8") throw tooLong;
    return toString.apply(this, args);
  });
  const e = new RequestEngine({ maxResponseBytes: 0, transport: makeMockTransport(() => rawResponse(huge, "application/xml")).transport });
  await assert.rejects(e.getXml("/feed.xml", { view: "renderXml" }), (err: unknown) => {
    assert.ok(err instanceof BundesratParseError, String(err));
    assert.equal(
      err.message,
      `GET https://www.bundesrat.de/feed.xml?view=renderXml: the answer is too large to read as text (${huge.length} bytes; the longest string is 536870888 characters).`,
    );
    return true;
  });
  // An error status with such a body is still the API error, without the unreadable body.
  const failing = new RequestEngine({ maxResponseBytes: 0, transport: makeMockTransport(() => rawResponse(huge, "text/plain", 500)).transport });
  await assert.rejects(failing.getXml("/feed.xml"), (err: unknown) => err instanceof BundesratApiError && err.status === 500 && err.body === "");
});

/** Milliseconds `work` takes. */
function elapsed(work: () => unknown): number {
  const start = performance.now();
  work();
  return performance.now() - start;
}

test("redactUrlUserinfo hides every URL's userinfo in one linear pass, however many URLs (B)", () => {
  // The URL regex this replaces (a scheme tried at every word start) takes about 3 s on this.
  assert.ok(elapsed(() => redactUrlUserinfo("a.".repeat(30_000))) < 1000);
  assert.equal(redactUrlUserinfo("a -https://u:p@h/x and x-ftp://v@w?q, mail@example.org"), "a -https://***@h/x and x-ftp://***@w?q, mail@example.org");
  assert.equal(redactUrlUserinfo("1://u:p@h ://u:p@h"), "1://u:p@h ://u:p@h");
  assert.equal(redactUrlUserinfo("https://h/p?u=a@b"), "https://h/p?u=a@b");
  for (const text of ["a".repeat(1_000_000), "a.".repeat(500_000), "://".repeat(100_000), `https://${"u".repeat(1_000_000)}`]) {
    assert.equal(redactUrlUserinfo(text), text);
  }
  const many = redactUrlUserinfo("https://u:p@h ".repeat(100_000));
  assert.equal(many, "https://***@h ".repeat(100_000));
});

test("redactUrlUserinfo hides the userinfo of a URL glued onto the one before it, still linear (B2)", () => {
  // The authority read for the first `://` ends at the `/` of the second; the second URL starts
  // inside it (its scheme is the first one's host, or follows a redacted `@`), so the search goes
  // on after each `://`, not after the authority. The regex this replaces redacted both; the
  // first linear pass missed them.
  assert.equal(redactUrlUserinfo("https://host://u:p@h"), "https://host://***@h");
  assert.equal(redactUrlUserinfo("https://u:p@x://v:q@w"), "https://***@x://***@w");
  assert.equal(redactUrlUserinfo("see https://h.example:/x://u:p@h"), "see https://h.example:/x://***@h");
  assert.equal(redactUrlUserinfo("https://u:p@1://v:q@w"), "https://***@1://v:q@w");
  // Many glued URLs, unredacted and redacted, and long scheme-character runs: one pass each.
  const n = 100_000;
  for (const [text, want] of [
    [`${"a://".repeat(n)}u:p@h`, `${"a://".repeat(n)}***@h`],
    ["x://u:p@".repeat(n), "x://***@".repeat(n)],
    [`${"a.".repeat(500_000)}://u:p@h`, `${"a.".repeat(500_000)}://***@h`],
    [`https://${"a.".repeat(500_000)}://u:p@h`, `https://${"a.".repeat(500_000)}://***@h`],
    ["a:".repeat(500_000), "a:".repeat(500_000)],
  ] as const) {
    let got = "";
    const ms = elapsed(() => (got = redactUrlUserinfo(text)));
    assert.ok(got === want, `${text.slice(0, 40)}…`);
    assert.ok(ms < 1000, `${Math.round(ms)} ms on ${text.slice(0, 40)}…`);
  }
});

test("a TextBuilder joins its pieces in order across batches", () => {
  const b = new TextBuilder();
  const expected: string[] = [];
  for (let i = 0; i < 40_000; i++) {
    b.push(String(i), ",");
    expected.push(String(i), ",");
  }
  assert.equal(b.toString(), expected.join(""));
  assert.equal(new TextBuilder().toString(), "");
});

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

test("sanitizeServerText drops whole escape sequences, not just their control bytes (C)", () => {
  const CSI8 = String.fromCharCode(0x9b);
  const OSC8 = String.fromCharCode(0x9d);
  const ST8 = String.fromCharCode(0x9c);
  for (const [input, expected] of [
    [`line1 ${ESC}]0;title${BEL}rest`, "line1 rest"],
    [`${ESC}]8;;https://evil.example${ESC}\\click${ESC}]8;;${ESC}\\`, "click"],
    [`${ESC}[31mred${ESC}[0m plain`, "red plain"],
    [`${ESC}[1;31;4mbold`, "bold"],
    [`${CSI8}2Jcleared`, "cleared"],
    [`${OSC8}0;t${ST8}ok`, "ok"],
    [`a${ESC}7b${ESC}(Bc`, "abc"],
    // Unterminated: only ESC and its introducer go, the text stays.
    [`keep ${ESC}]0;no terminator here`, "keep 0;no terminator here"],
  ] as const) {
    assert.equal(sanitizeServerText(input), expected, JSON.stringify(input));
  }
});

test("sanitizeServerText drops invisible format characters (zero-width, soft hyphen, BOM) (C)", () => {
  const text = "real\u200b error\u2028Error: forged\u2066x\u2069 \ufeffend\u00ad\u200d\u2060!";
  assert.equal(sanitizeServerText(text), "real error Error: forgedx end!");
  assert.equal(sanitizeServerText("  Cannot GET  /items/details/  Größe  "), "Cannot GET /items/details/ Größe");
});

test("sanitizeServerText reads a bounded prefix and drops what the per-character filter dropped (C)", () => {
  // The filter it replaces, one character at a time: C0 but TAB to CR, DEL, C1 and Cf go.
  const perCharacter = (text: string): string =>
    [...text]
      .filter((ch) => {
        const n = ch.codePointAt(0) ?? 0;
        return (n >= 0x09 && n <= 0x0d) || !(n <= 0x1f || (n >= 0x7f && n <= 0x9f) || /\p{Cf}/u.test(ch));
      })
      .join("")
      .replace(/\s+/g, " ")
      .trim();
  const every = Array.from({ length: 0x3000 }, (_, i) => String.fromCharCode(i)).join("") + "\u{1f600}\u{e0001}\ud800x";
  for (let at = 0; at < every.length; at += 512) {
    const piece = every.slice(at, at + 512).replace(/[\u001b\u0090\u0098\u009b-\u009f]/g, "");
    assert.equal(sanitizeServerText(piece), perCharacter(piece), `from U+${at.toString(16)}`);
  }
  // At most 16 384 units of the text are read, never half a surrogate pair.
  assert.equal(sanitizeServerText("x".repeat(100_000)).length, 16_384);
  assert.equal(sanitizeServerText(`${"x".repeat(16_383)}\u{1f600}`), "x".repeat(16_383));
  // A control string ends at another introducer: the first is dropped by the filter, the second
  // string as a whole. An unterminated run of introducers is linear (100 000 × U+009D took 16 s
  // with the introducers allowed inside a control string).
  const OSC8 = String.fromCharCode(0x9d);
  const ST8 = String.fromCharCode(0x9c);
  assert.equal(sanitizeServerText(`a${OSC8}0;x${OSC8}0;t${ST8}b`), "a0;xb");
  assert.equal(sanitizeServerText(`a${ESC}]0;x${ESC}]0;t${BEL}b`), "a0;xb");
});

// This test starts a process with a small heap: 30 s instead of the suite's 5 s.
const STARTS_A_PROCESS = { timeout: 30_000 };

test("a malformed answer with a 16 MB tag name ends in a parse error within a small heap (C)", STARTS_A_PROCESS, () => {
  // The parser names the tag in its reason, and the engine cleaned all of it before the cut, one
  // `+=` per character: a 16 MB name aborted the process under a 128 MB heap.
  const engine = new URL("../src/engine.js", import.meta.url).href;
  const script =
    `const { RequestEngine } = await import(${JSON.stringify(engine)});` +
    `const body = Buffer.from("<" + "a".repeat(16 * 1024 * 1024));` +
    `const e = new RequestEngine({ transport: async () => ({ status: 200, headers: { "content-type": "application/xml" }, body }) });` +
    `try { await e.getXml("/feed.xml"); } catch (err) { process.stdout.write(err.name + " " + err.message.length); }`;
  const out = execFileSync(process.execPath, ["--max-old-space-size=128", "--input-type=module", "-e", script], { encoding: "utf8" });
  const [name, length] = out.split(" ");
  assert.equal(name, "BundesratParseError", out);
  assert.ok(Number(length) < 1000, out);
});

// Class D of .reviews/2026-10-27-security-audit (portfolio round): the base URL's credentials
// are scrubbed from decoded server text too, and from every value the client quotes from an
// answer, before it is cut.
test("an error body keeps its spelling unless a credential hides behind an escape (D)", async () => {
  const base = "https://alice:s3cret-pw@mirror.example";
  const failed = async (body: string): Promise<BundesratApiError> => {
    const e = new RequestEngine({ baseUrl: base, maxRetries: 0, transport: async () => rawResponse(body, "application/json", 500) });
    const err = await e.getXml("/x").catch((caught: unknown) => caught);
    assert.ok(err instanceof BundesratApiError, String(err));
    return err;
  };
  // No credential, or one spelled as sent: the body as sent (scrubbed), escapes kept.
  assert.equal((await failed('{"m":"caf\\u00e9 \\"x\\""}')).body, '{"m":"caf\\u00e9 \\"x\\""}');
  assert.equal((await failed('{"m":"pw s3cret-pw \\u00e9"}')).body, '{"m":"pw *** \\u00e9"}');
  // Escaped: written again decoded, scrubbed in that spelling; the message's snippet with it.
  const escaped = await failed('{"m":"pw s3cret\\u002dpw \\u00e9"}');
  assert.equal(escaped.body, '{"m":"pw *** é"}');
  assert.equal(escaped.detail, '{"m":"pw *** é"}');
  assert.ok(!escaped.message.includes("s3cret"), escaped.message);
  // Not JSON: nobody decodes it, it stays as sent.
  assert.equal((await failed("pw s3cret\\u002dpw")).body, "pw s3cret\\u002dpw");
});

test("a value quoted from an answer is scrubbed before it is cut, so no part of a credential stays (D)", () => {
  const pw = "s3cret-Pw-long";
  const e = new RequestEngine({ baseUrl: `https://alice:${pw}@mirror.example` });
  for (const at of [0, 490, 495, 499]) {
    const quoted = e.quoteServerValue(`${"x".repeat(at)}${pw}${"y".repeat(600)}`);
    assert.ok(!quoted.includes("s3cret"), `${at}: ${quoted}`);
  }
  assert.equal(new RequestEngine().quoteServerValue('a"b'), '"a\\"b"');
});

test("a token the answer names as its root element, a tag or its charset is scrubbed from the library's error (D)", async () => {
  // Every value of an answer the client quotes into its own errors: the root element's name, the
  // parser's reason (which names a tag) and the declared charset. The CLI redacted them on
  // stderr; a library caller logging err.message saw the token.
  const token = "dummytoken0123456789";
  for (const xml of [
    `<${token}><list/></${token}>`,
    `<iOS><list><${token} a="1"`,
    `<?xml version="1.0" encoding="${token}"?><iOS/>`,
  ]) {
    const client = new BundesratClient({ baseUrl: `https://${token}@mirror.example`, transport: async () => xmlResponse(xml) });
    const err = await client.appointments().catch((caught: unknown) => caught);
    assert.ok(err instanceof BundesratParseError, String(err));
    assert.ok(!err.message.includes(token), err.message);
    assert.ok(err.message.includes("***"), err.message);
  }
});

// Classes F, F3 and F4 of .reviews/2026-10-27-security-audit (portfolio round): the base URL is
// read as WHATWG reads it, by every check and for the request.
test("a base URL with a backslash, or whose scheme is not followed by // and the host, is rejected at construction, never echoing the password (F, F4)", () => {
  // WHATWG ends an http(s) authority at "\\", and repairs `http:host`, `http:/host` and
  // `http:///host` silently into `http://host`: the host requested would not be the one typed.
  const absolute = 'Expected an absolute http(s) URL ("https://" and the host).';
  const backslash = 'A base URL cannot contain a backslash (\\); write "/" instead.';
  for (const [baseUrl, reason] of [
    ["https://alice:s3cret@api.example\\@evil.example", backslash],
    ["https://api.example\\evil", backslash],
    ["https:\\\\alice:s3cret@h.example", backslash],
    ["http:alice:s3cret@h.example", absolute],
    ["https:/alice:s3cret@h.example", absolute],
    ["http:///alice:s3cret@h.example", absolute],
    ["HTTPS:h.example/v1", absolute],
  ] as const) {
    const mt = makeMockTransport(() => xmlResponse(fx.appointmentsXml));
    assert.throws(
      () => new RequestEngine({ transport: mt.transport, baseUrl }),
      (err: unknown) => err instanceof BundesratValidationError && err.message === `Invalid baseUrl: ${reason}` && !err.message.includes("s3cret"),
      baseUrl,
    );
    assert.equal(mt.calls.length, 0, baseUrl);
  }
  // A spelling the parser keeps as typed stays accepted: an upper-case scheme, an explicit port.
  for (const baseUrl of ["HTTPS://h.example/v1", "http://alice:pw@h.example:8080"]) {
    assert.doesNotThrow(() => new RequestEngine({ baseUrl }), baseUrl);
  }
});

test("a base URL typed without its scheme never names its user name or password (F5)", () => {
  for (const baseUrl of ["T0kenS3cret:@h.example", "alice:s3cretPw@h.example", "T0kenS3cret@h.example"]) {
    assert.throws(
      () => new RequestEngine({ baseUrl }),
      (err: unknown) => err instanceof BundesratValidationError && !/t0kens3cret|s3cretpw/i.test(err.message),
      baseUrl,
    );
  }
});

test("requests go to the base URL as it parses: host lower-cased, default port dropped (F)", async () => {
  const mt = makeMockTransport(() => xmlResponse(fx.appointmentsXml));
  await new BundesratClient({ baseUrl: "https://API.Example:443/v1/", transport: mt.transport }).appointments();
  assert.ok(mt.last().url.startsWith("https://api.example/v1/iOS/"), mt.last().url);
});

test("an echo of the request URL as sent is scrubbed, a short password too (F)", async () => {
  // Typed raw; WHATWG sends `p%22%C3%A4` in the URL, which a server echoes.
  const e = new RequestEngine({
    baseUrl: 'https://alice:p"ä@mirror.example',
    maxRetries: 0,
    transport: async (req) => rawResponse(`no access: ${req.url}`, "text/plain", 403),
  });
  const err = await e.getXml("/x").catch((caught: unknown) => caught);
  assert.ok(err instanceof BundesratApiError, String(err));
  for (const text of [err.message, err.detail ?? "", err.body]) {
    assert.ok(!text.includes("p%22%C3%A4@") && !text.includes('p"ä@'), text);
  }
});

test("credentialsIn ends the authority of a special scheme at a backslash, as WHATWG does (F)", () => {
  for (const scheme of ["http", "https", "HTTPS", "ws", "wss", "ftp"]) {
    assert.deepEqual(credentialsIn(`${scheme}://u:p@a.example\\@b.example/x`), ["u:p"], scheme);
    assert.equal(new URL(`${scheme}://u:p@a.example\\@b.example/x`).password, "p", scheme);
  }
  // Another scheme's authority runs on to "/", "?" or "#".
  assert.deepEqual(credentialsIn("foo://u:p@a.example\\@b.example/x"), ["u:p@a.example\\"]);
  assert.deepEqual(credentialsIn("https://u:p@a.example/x\\@y"), ["u:p"]);
});

test("credentialsIn skips the slashes and backslashes WHATWG skips after a special scheme (F3)", () => {
  // `http:///u:pw@h`, `https:\\u:pw@h` and `http:u:pw@h` all carry `u:pw` for WHATWG; read
  // after "://", the userinfo was missed, so a refused --base-url echoed the password in clear.
  for (const value of [
    "http:alice:pw@h.example",
    "http:/alice:pw@h.example",
    "http:///alice:pw@h.example/x",
    "https:////alice:pw@h.example",
    "HTTPS:\\\\alice:pw@h.example",
    "wss:\\/alice:pw@h.example",
    "ftp:alice:pw@h.example",
  ]) {
    assert.deepEqual(credentialsIn(value), ["alice:pw"], value);
    assert.equal(new URL(value).password, "pw", value);
  }
  // Another scheme needs "//" before an authority: `foo:u:p@h` and `foo:///u:p@h` carry none.
  assert.deepEqual(credentialsIn("foo:u:p@h.example"), []);
  assert.deepEqual(credentialsIn("foo:///u:p@h.example"), []);
  assert.equal(new URL("foo:///u:p@h.example").password, "");
});
