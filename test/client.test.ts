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

test("session() returns title, header and the agenda items", async () => {
  const mt = makeMockTransport(() => xmlResponse(fx.sessionXml));
  const c = new BundesratClient({ transport: mt.transport });
  const s = await c.session();
  assert.equal(pathOf(mt.last().url), FEEDS.session);
  assert.match(s.title!, /^1067\./);
  assert.equal(s.tops.length, 2);
  assert.equal(s.tops[0]!.topdrucksache, "Drucksache 371/26");
});

test("news() returns the content items", async () => {
  const mt = makeMockTransport(() => xmlResponse(fx.newsXml));
  const c = new BundesratClient({ transport: mt.transport });
  const items = await c.news();
  assert.equal(pathOf(mt.last().url), FEEDS.news);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.title, "Ein starkes Europa");
});

test("a single <item> feed still yields an array of one", async () => {
  const mt = makeMockTransport(() => xmlResponse(fx.singleItemXml));
  const c = new BundesratClient({ transport: mt.transport });
  const comp = await c.composition();
  assert.equal(pathOf(mt.last().url), FEEDS.composition);
  assert.equal(comp.length, 1);
  assert.equal(comp[0]!.title, "Zusammensetzung des Bundesrates");
});

test("compact() returns the nested list payload (header + tops)", async () => {
  const mt = makeMockTransport(() => xmlResponse(fx.compactXml));
  const c = new BundesratClient({ transport: mt.transport });
  const list = await c.compact();
  assert.equal(pathOf(mt.last().url), FEEDS.compact);
  const header = list["header"] as Record<string, string>;
  assert.equal(header["titel2"], "1067. Sitzung des Bundesrates");
});

test("presidium(), appointments(), nextSessions() target their feeds", async () => {
  for (const [method, path] of [
    ["presidium", FEEDS.presidium],
    ["appointments", FEEDS.appointments],
    ["nextSessions", FEEDS.nextSessions],
  ] as const) {
    const mt = makeMockTransport(() => xmlResponse(fx.singleItemXml));
    const c = new BundesratClient({ transport: mt.transport });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (c as any)[method]();
    assert.equal(pathOf(mt.last().url), path);
    assert.equal(queryOf(mt.last()).get("view"), "renderXml");
  }
});
