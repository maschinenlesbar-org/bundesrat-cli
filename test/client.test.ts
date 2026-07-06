import { test } from "node:test";
import assert from "node:assert/strict";
import { BundesratClient, FEEDS, asArray } from "../src/client/client.js";
import { makeMockTransport, xmlResponse, queryOf } from "./helpers.js";
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

test("only the three open-data feeds are exposed", () => {
  assert.deepEqual(Object.keys(FEEDS).sort(), ["appointments", "members", "session"]);
});
