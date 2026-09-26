import { test } from "node:test";
import assert from "node:assert/strict";
import { BundesratClient, FEEDS, asArray } from "../src/client/client.js";
import { BundesratNetworkError, BundesratParseError } from "../src/client/errors.js";
import { makeMockTransport, xmlResponse, rawResponse, queryOf } from "./helpers.js";
import * as fx from "./fixtures.js";

function pathOf(url: string): string {
  return new URL(url).pathname;
}

test("asArray normalises missing / single / repeated children", () => {
  assert.deepEqual(asArray(undefined), []);
  assert.deepEqual(asArray("x"), ["x"]);
  assert.deepEqual(asArray(["a", "b"]), ["a", "b"]);
});

test("members() hits the members feed with view=renderXml and returns Member[]", async () => {
  const mt = makeMockTransport(() => xmlResponse(fx.membersXml));
  const c = new BundesratClient({ transport: mt.transport });
  const members = await c.members();
  assert.equal(pathOf(mt.last().url), FEEDS.members);
  assert.equal(queryOf(mt.last()).get("view"), "renderXml");
  assert.equal(members.length, 2);
  assert.equal(members[0]!.name, "Özdemir");
  assert.equal(members[1]!.party, "CSU");
});

test("members() surfaces only open factual fields — biography HTML and images are stripped", () => {
  return (async () => {
    const mt = makeMockTransport(() => xmlResponse(fx.membersXml));
    const c = new BundesratClient({ transport: mt.transport });
    const m = (await c.members())[0]! as Record<string, unknown>;
    // Open facts are kept…
    assert.equal(m["name"], "Özdemir");
    assert.equal(m["party"], "BÜNDNIS 90/DIE GRÜNEN");
    assert.equal(m["state"], "Baden-Württemberg");
    assert.equal(m["url"], "https://www.bundesrat.de/x/oezdemir.html");
    // …copyright editorial/image fields are projected out.
    assert.equal(m["detail"], undefined);
    assert.equal(m["imagePath"], undefined);
    assert.equal(m["imageDate"], undefined);
  })();
});

test("session() returns title, header and agenda items (facts + Drucksachen only)", async () => {
  const mt = makeMockTransport(() => xmlResponse(fx.sessionXml));
  const c = new BundesratClient({ transport: mt.transport });
  const s = await c.session();
  assert.equal(pathOf(mt.last().url), FEEDS.session);
  assert.match(s.title!, /^1067\./);
  assert.equal(s.tops.length, 2);
  const top = s.tops[0]! as Record<string, unknown>;
  assert.equal(top["topdrucksache"], "Drucksache 371/26");
  assert.equal(top["topheader"], "Ernennung von Bundesanwältinnen");
  // The HTML detail description and image dates are stripped.
  assert.equal(top["topdetail"], undefined);
  assert.equal(top["detailImgDates"], undefined);
});

test("appointments() hits its feed and surfaces only factual calendar fields", async () => {
  const mt = makeMockTransport(() => xmlResponse(fx.appointmentsXml));
  const c = new BundesratClient({ transport: mt.transport });
  const items = await c.appointments();
  assert.equal(pathOf(mt.last().url), FEEDS.appointments);
  assert.equal(queryOf(mt.last()).get("view"), "renderXml");
  assert.equal(items.length, 1);
  const it = items[0]! as Record<string, unknown>;
  assert.equal(it["title"], "Sitzung des Vermittlungsausschusses");
  assert.equal(it["startdate"], "2026-07-15 14:00");
  assert.equal(it["stopdate"], "2026-07-15 16:00");
  // Editorial body + image are stripped.
  assert.equal(it["abstract"], undefined);
  assert.equal(it["detail"], undefined);
  assert.equal(it["imagePath"], undefined);
  assert.equal(it["imageCaption"], undefined);
});

test("empty leaf fields are omitted, consistent with absent ones", async () => {
  const mt = makeMockTransport(() => xmlResponse(fx.sessionXml));
  const c = new BundesratClient({ transport: mt.transport });
  const s = await c.session();
  // top[0] carries <linkedtop></linkedtop> (empty); top[1] has no <linkedtop> at
  // all — both omit the key, rather than one being "" and the other absent.
  assert.equal((s.tops[0] as Record<string, unknown>)["linkedtop"], undefined);
  assert.equal((s.tops[1] as Record<string, unknown>)["linkedtop"], undefined);
});

test("only the three open-data feeds are exposed", () => {
  assert.deepEqual(Object.keys(FEEDS).sort(), ["appointments", "members", "session"]);
});

for (const baseUrl of ["file:///etc/passwd", "ftp://example.org"]) {
  test(`the client rejects a non-http(s) base URL (${baseUrl}) with a custom transport`, () => {
    const mt = makeMockTransport(() => xmlResponse(fx.appointmentsXml));
    assert.throws(
      () => new BundesratClient({ baseUrl, transport: mt.transport }),
      (err) => err instanceof BundesratNetworkError && /Unsupported protocol/.test(err.message),
    );
    assert.equal(mt.calls.length, 0);
  });
}

// --- Wrong-shaped XML is an error, not an empty result (exploratory test 2026-09-26, finding 2) ---

test("a document that is not <iOS><list>…</list></iOS> is a BundesratParseError", async () => {
  for (const [body, message] of [
    ['<?xml version="1.0"?><error><code>500</code><message>CMS error</message></error>', /expected an <iOS> root element, got <error>\./],
    ["<list><top><toptitle>1</toptitle></top></list>", /expected an <iOS> root element, got <list>\./],
    ["<iOS><foo/></iOS>", /expected exactly one <list> element under <iOS>\./],
    ["<iOS><list><a>1</a></list><list><a>2</a></list></iOS>", /expected exactly one <list> element under <iOS>\./],
    ["<iOS><list>just text</list></iOS>", /expected exactly one <list> element under <iOS>\./],
    ["<iOS>text</iOS>", /expected an <iOS> root element, got <iOS>\./],
  ] as const) {
    const mt = makeMockTransport(() => xmlResponse(body));
    const c = new BundesratClient({ transport: mt.transport });
    await assert.rejects(
      c.session(),
      (err: unknown) =>
        err instanceof BundesratParseError &&
        err.message.startsWith(`Unexpected response shape from ${FEEDS.session}: `) &&
        message.test(err.message),
      body,
    );
  }
});

test("a genuinely empty feed (<iOS><list/></iOS>) is still an empty result", async () => {
  for (const body of ['<iOS version="1.0"><list/></iOS>', "<iOS><list>  </list></iOS>"]) {
    const mt = makeMockTransport(() => xmlResponse(body));
    const c = new BundesratClient({ transport: mt.transport });
    assert.deepEqual(await c.members(), []);
    assert.deepEqual(await c.session(), { tops: [] });
    assert.deepEqual(await c.appointments(), []);
  }
});

test("an XHTML page, or HTML behind a declaration or comment, is reported as an HTML page", async () => {
  for (const body of [
    '<?xml version="1.0"?><!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0//EN" "x"><html><body>Wartung</body></html>',
    "<!-- cms --><!DOCTYPE html><html><body>maintenance</body></html>",
    '<?xml version="1.0"?>\n<!-- a -->\n<HTML><body>x</body></HTML>',
    '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>x</p></body></html>',
  ]) {
    const mt = makeMockTransport(() => xmlResponse(body));
    const c = new BundesratClient({ transport: mt.transport });
    await assert.rejects(
      c.members(),
      (err: unknown) => err instanceof BundesratParseError && /received an HTML page/.test(err.message),
      body,
    );
  }
});

// --- Allowlist projects plain text only (exploratory test 2026-09-26, finding 5) ---

test("a whitelisted field holding markup or repeated is dropped; text with attributes keeps its text", async () => {
  const members =
    "<iOS><list>" +
    "<employee><name><b>Bold</b></name><state>Bayern</state></employee>" +
    "<employee><name>Dr. <i>X</i> Y</name><state>Bayern</state></employee>" +
    '<employee><name lang="de">Solo</name><party>CDU</party><state>Bayern</state></employee>' +
    "<employee><name>A</name><party>CDU</party><party>CSU</party></employee>" +
    "</list></iOS>";
  const mt = makeMockTransport(() => xmlResponse(members));
  const rows = await new BundesratClient({ transport: mt.transport }).members();
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), [
    { state: "Bayern" },
    { state: "Bayern" },
    { name: "Solo", party: "CDU", state: "Bayern" },
    { name: "A" },
  ]);
});

test("inline (non-CDATA) editorial HTML in topheader does not pass the allowlist", async () => {
  const session =
    '<iOS><list><top><toptitle a="1>2">TOP 1</toptitle>' +
    "<topheader><p>Editorial <b>HTML</b> body</p></topheader></top></list></iOS>";
  const mt = makeMockTransport(() => xmlResponse(session));
  const s = await new BundesratClient({ transport: mt.transport }).session();
  assert.deepEqual(JSON.parse(JSON.stringify(s)), { tops: [{ toptitle: "TOP 1" }] });
});

test("session title/header follow the same plain-text rule as TOP fields (finding 6)", async () => {
  for (const [body, expected] of [
    ["<iOS><list><title>A</title><title>B</title><header>H</header></list></iOS>", { header: "H", tops: [] }],
    ['<iOS><list><title lang="de">T</title><header/></list></iOS>', { title: "T", tops: [] }],
    ["<iOS><list><title><b>T</b></title><top><toptitle>X</toptitle><toptitle>Y</toptitle></top></list></iOS>", { tops: [{}] }],
  ] as const) {
    const mt = makeMockTransport(() => xmlResponse(body));
    const s = await new BundesratClient({ transport: mt.transport }).session();
    assert.deepEqual(JSON.parse(JSON.stringify(s)), expected, body);
  }
});

test("whitespace runs inside a field collapse to one space (topheader newline, finding 15)", async () => {
  const session =
    "<iOS><list><title>1067. Sitzung\n  des Bundesrates</title><top><toptitle>TOP a</toptitle>" +
    "<topheader>Die humanitäre Hilfe der EU; \nJOIN(2026) 25 final</topheader></top></list></iOS>";
  const mt = makeMockTransport(() => xmlResponse(session));
  const s = await new BundesratClient({ transport: mt.transport }).session();
  assert.equal(s.title, "1067. Sitzung des Bundesrates");
  assert.equal(s.tops[0]!.topheader, "Die humanitäre Hilfe der EU; JOIN(2026) 25 final");
});

test("the XML declaration's encoding is honoured (a Latin-1 feed is not mojibake, finding 17)", async () => {
  const latin1 = Buffer.from(
    '<?xml version="1.0" encoding="ISO-8859-1"?><iOS><list><employee><name>Müller</name>' +
      "<state>Thüringen</state></employee></list></iOS>",
    "latin1",
  );
  const mt = makeMockTransport(() => rawResponse(latin1, "application/xml;charset=utf-8"));
  const rows = await new BundesratClient({ transport: mt.transport }).members();
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), [{ name: "Müller", state: "Thüringen" }]);

  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("<iOS><list><employee><name>Ä</name></employee></list></iOS>")]);
  const mt2 = makeMockTransport(() => rawResponse(bom, "text/plain"));
  assert.deepEqual(JSON.parse(JSON.stringify(await new BundesratClient({ transport: mt2.transport }).members())), [{ name: "Ä" }]);

  const unknown = makeMockTransport(() => xmlResponse('<?xml version="1.0" encoding="x-klingon"?><iOS><list/></iOS>'));
  await assert.rejects(
    new BundesratClient({ transport: unknown.transport }).members(),
    (err: unknown) => err instanceof BundesratParseError && /Unsupported response charset "x-klingon" from /.test(err.message),
  );
});
