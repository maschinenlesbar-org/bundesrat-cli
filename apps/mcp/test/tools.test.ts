// This server's tools against a mock of the Bundesrat feeds, with the skills' traps as cases.

import { test } from "node:test";
import assert from "node:assert/strict";
import { listTools } from "../src/mcp/server.js";
import { FeedCache, SIZE_HINT, TOOLS } from "../src/mcp/tools.js";
import { connect } from "./harness.js";
import { bundesrat, jsonResponse, makeMockTransport } from "./helpers.js";

const world = bundesrat({
  session: {
    fields: { title: "1069. Sitzung des Bundesrates", header: "am Freitag, dem 27. November 2026, 9:30 Uhr" },
    tops: [
      { toptitle: "TOP 10", topdrucksache: "Drucksache 500/26", topheader: "Gesetz B" },
      { toptitle: "TOP 2", topdrucksache: "Drucksache 343/26; Drucksache 344/26", topheader: "Gesetz A" },
    ],
  },
  members: [
    { firstname: "Markus", name: "Söder", party: "CSU", state: "Bayern", brmitglied: "true", mitglied: "true" },
    { firstname: "Hans", name: "Vertreter", party: "CSU", state: "Bayern", brmitglied: "true", mitglied: "false" },
    { firstname: "Cem", name: "Özdemir", party: "BÜNDNIS 90/DIE GRÜNEN", state: "Baden-Württemberg", brmitglied: "true", mitglied: "true" },
  ],
  appointments: [
    { title: "Finanzausschuss entfällt", startdate: "20.11.2099" },
    { title: "Plenarsitzung", startdate: "27.11.2099 09:30" },
  ],
});

test("three tools, one per question of the skills", () => {
  assert.deepEqual(listTools().map((t) => t.name), ["getAgenda", "listAppointments", "findMembers"]);
});

test("getAgenda: TOPs in order with their Drucksachen one by one", async () => {
  const connection = await connect({ transport: world });
  const result = await connection.call("getAgenda", {});
  const answer = result.structuredContent as { tops: { top: string; drucksachen: string[] }[]; drucksachen: number; draft: boolean };
  assert.deepEqual(answer.tops.map((t) => t.top), ["TOP 2", "TOP 10"]);
  assert.equal(answer.drucksachen, 3);
  assert.equal(answer.draft, false);
  assert.match(String(result.structuredContent?.["licence"]), /Quelle: Bundesrat/);
  await connection.close();
});

test("findMembers: full members only by default; a state is one of the 16 Länder, else a tool error", async () => {
  const connection = await connect({ transport: world });
  const csu = await connection.call("findMembers", { party: "csu" });
  assert.deepEqual((csu.structuredContent?.["people"] as { name: string }[]).map((p) => p.name), ["Markus Söder"]);
  const deputies = await connection.call("findMembers", { party: "csu", includeDeputies: true });
  assert.equal(deputies.structuredContent?.["total"], 2);
  const wrong = await connection.call("findMembers", { state: "Bavaria" });
  assert.equal(wrong.isError, true);
  await connection.close();
});

test("listAppointments: cancelled dates are counted and left out", async () => {
  const connection = await connect({ transport: world });
  const result = await connection.call("listAppointments", {});
  assert.deepEqual((result.structuredContent?.["meetings"] as { title: string; start: string }[]).map((m) => [m.title, m.start]), [["Plenarsitzung", "2099-11-27T09:30"]]);
  assert.equal(result.structuredContent?.["cancelled"], 1);
  await connection.close();
});

test("source is the feed's URL as the request asked for it, with ?view=renderXml (without it bundesrat.de answers its start page)", async () => {
  const connection = await connect({ transport: world });
  for (const [tool, path] of [
    ["getAgenda", "iOS/SharedDocs/3_Plenum/plenum_aktuelleSitzung_table.xml"],
    ["listAppointments", "iOS/v3/02_Termine/termine_table.xml"],
    ["findMembers", "iOS/SharedDocs/2_Mitglieder/mitglieder_table.xml"],
  ] as const) {
    const result = await connection.call(tool, {});
    assert.equal(result.structuredContent?.["source"], `https://www.bundesrat.de/${path}?view=renderXml`, tool);
    assert.ok(world.calls.some((r) => r.url === result.structuredContent?.["source"]), `${tool}: the source is the URL requested`);
  }
  await connection.close();
});

test("listAppointments: dates already over are left out and counted; a date it can't read keeps its text, and the reason says so", async () => {
  const feed = bundesrat({
    appointments: [
      { title: "Vorbei", startdate: "01.01.2020" },
      { title: "Plenarsitzung", startdate: "2099-10-02T09:30:00.000+02:00" },
      { title: "Ausschuss", startdate: "02.10.2099 09:30" },
    ],
  });
  const connection = await connect({ transport: feed });
  const answer = (await connection.call("listAppointments", {})).structuredContent ?? {};
  assert.deepEqual((answer["meetings"] as { title: string; start?: string; startText?: string }[]).map((m) => [m.title, m.start ?? m.startText]), [["Ausschuss", "2099-10-02T09:30"], ["Plenarsitzung", "2099-10-02T09:30:00.000+02:00"]]);
  assert.equal(answer["past"], 1);
  assert.equal(answer["unreadable"], 1);
  assert.match(String(answer["reason"]), /1 date .*startText/);
  const over = await connect({ transport: bundesrat({ appointments: [{ title: "Vorbei", startdate: "01.01.2020" }] }) });
  const empty = (await over.call("listAppointments", {})).structuredContent ?? {};
  assert.equal(empty["status"], "empty");
  assert.match(String(empty["reason"]), /over/);
  await over.close();
  await connection.close();
});

test("findMembers: a Land in another case, Unicode form or padded is taken; an unknown one is a tool error that lists the Länder", async () => {
  const connection = await connect({ transport: world });
  for (const state of ["bayern", "Bayern ", "BAYERN"]) {
    const result = await connection.call("findMembers", { state });
    assert.equal(result.isError, undefined, state);
    assert.deepEqual((result.structuredContent?.["people"] as { name: string }[]).map((p) => p.name), ["Markus Söder"], state);
  }
  const nfd = await connection.call("findMembers", { state: "Baden-Württemberg".normalize("NFD") });
  assert.equal(nfd.structuredContent?.["total"], 1);
  const wrong = await connection.call("findMembers", { state: "Bavaria" });
  assert.equal(wrong.isError, true);
  assert.match(wrong.content[0]?.text ?? "", /Baden-Württemberg, Bayern, Berlin/);
  await connection.close();
});

test("findMembers: a page past the end is empty and says where the matches end", async () => {
  const connection = await connect({ transport: world });
  const result = await connection.call("findMembers", { offset: 2 });
  assert.equal(result.structuredContent?.["status"], "empty");
  assert.deepEqual(result.structuredContent?.["people"], []);
  assert.equal(result.structuredContent?.["total"], 2);
  assert.match(String(result.structuredContent?.["reason"]), /offset 2 is past the 2 matches/);
  await connection.close();
});

test("findMembers: a designated successor comes apart and isn't counted", async () => {
  const feed = bundesrat({
    members: [
      { firstname: "Markus", name: "Söder", party: "CSU", state: "Bayern", brmitglied: "true", mitglied: "true" },
      { firstname: "Neue", name: "Nachfolgerin", party: "CSU", state: "Bayern", brmitglied: "true", mitglied: "true", designiert: "true" },
    ],
  });
  const connection = await connect({ transport: feed });
  const answer = (await connection.call("findMembers", {})).structuredContent ?? {};
  assert.equal(answer["total"], 1);
  assert.deepEqual((answer["designated"] as { name: string }[]).map((p) => p.name), ["Neue Nachfolgerin"]);
  await connection.close();
});

test("findMembers: a Land's plenipotentiary who isn't a member comes with includePlenipotentiaries", async () => {
  const feed = bundesrat({
    members: [
      { firstname: "Markus", name: "Söder", party: "CSU", state: "Bayern", brmitglied: "true", mitglied: "true" },
      { firstname: "Paula", name: "Bevollmächtigte", state: "Bayern", brmitglied: "false", mitglied: "false", bv: "true" },
    ],
  });
  const connection = await connect({ transport: feed });
  assert.equal((await connection.call("findMembers", { includeDeputies: true })).structuredContent?.["total"], 1);
  const answer = (await connection.call("findMembers", { state: "Bayern", includePlenipotentiaries: true })).structuredContent ?? {};
  assert.deepEqual((answer["people"] as { name: string; role: string }[]).map((p) => [p.name, p.role]), [["Markus Söder", "member"], ["Paula Bevollmächtigte", "plenipotentiary"]]);
  await connection.close();
});

test("a feed that changed its shape is a tool error, not 'no member matches'; an agenda whose items list no Drucksache says the feed may have changed", async () => {
  const flags = await connect({ transport: bundesrat({ members: [{ name: "A", party: "SPD", state: "Bayern", brmitglied: "1", mitglied: "1" }] }) });
  const members = await flags.call("findMembers", {});
  assert.equal(members.isError, true);
  assert.match(members.content[0]?.text ?? "", /no record as a full member.*the feed may have changed/);
  await flags.close();
  const tops = Array.from({ length: 6 }, (_, i) => ({ toptitle: `TOP ${i + 1}`, topheader: "Gesetz", topdrs: `Drucksache ${i}/26` }));
  const renamed = await connect({ transport: bundesrat({ session: { fields: { title: "1070. Sitzung" }, tops } }) });
  const agenda = (await renamed.call("getAgenda", {})).structuredContent ?? {};
  assert.equal(agenda["drucksachen"], 0);
  assert.match(String(agenda["reason"]), /None of the 6 items lists a Drucksache.*the feed may have changed/);
  await renamed.close();
});

test("findMembers keeps the members feed a while: another filter or page needs no second download", async () => {
  const feed = bundesrat({ members: [{ firstname: "Markus", name: "Söder", party: "CSU", state: "Bayern", brmitglied: "true", mitglied: "true" }] });
  const connection = await connect({ transport: feed });
  await connection.call("findMembers", {});
  await connection.call("findMembers", { state: "Bayern", offset: 0, limit: 1 });
  await connection.call("findMembers", { party: "csu", includeDeputies: true });
  assert.equal(feed.calls.filter((r) => r.url.includes("mitglieder_table.xml")).length, 1);
  await connection.close();
});

test("FeedCache: an entry is kept for its time, then fetched again; a failed fetch is not kept", async () => {
  let now = 0;
  const cache = new FeedCache<string>(1000, () => now);
  let fetched = 0;
  const key = {};
  const fetch = async (): Promise<string> => `answer ${++fetched}`;
  assert.equal(await cache.get(key, fetch), "answer 1");
  now = 999;
  assert.equal(await cache.get(key, fetch), "answer 1");
  now = 1000;
  assert.equal(await cache.get(key, fetch), "answer 2");
  await assert.rejects(cache.get({}, async () => Promise.reject(new Error("down"))));
  const other = {};
  await assert.rejects(cache.get(other, async () => Promise.reject(new Error("down"))));
  assert.equal(await cache.get(other, fetch), "answer 3");
});

test("a request that times out, a reset or a 5xx ends in a tool error that says to try again shortly", async () => {
  const failing = [
    makeMockTransport(() => Promise.reject(Object.assign(new Error("Request exceeded the 2000ms deadline"), { code: "ETIMEDOUT" }))),
    makeMockTransport(() => jsonResponse({ error: "boom" }, 500)),
  ];
  for (const mock of failing) {
    const connection = await connect({ transport: mock });
    for (const tool of ["getAgenda", "listAppointments", "findMembers"]) {
      const result = await connection.call(tool, {});
      assert.equal(result.isError, true, tool);
      assert.match(result.content[0]?.text ?? "", /\. The Bundesrat's feed is slow or unavailable; try again shortly\.$/, tool);
    }
    await connection.close();
  }
});

test("getAgenda: a long agenda comes a page at a time; total and drucksachen count the whole sitting", async () => {
  const tops = Array.from({ length: 154 }, (_, i) => ({ toptitle: `TOP ${i + 1}`, topheader: `Gesetz zur Änderung des ${i + 1}. Gesetzes über einen langen Titel`, topdrucksache: `Drucksache ${i + 1}/26` }));
  const connection = await connect({ transport: bundesrat({ session: { fields: { title: "1070. Sitzung" }, tops } }), config: { maxResultChars: 8000 } });
  const seen: string[] = [];
  let offset: number | undefined = 0;
  for (let calls = 0; offset !== undefined && calls < 40; calls++) {
    const answer: Record<string, unknown> = (await connection.call("getAgenda", { offset })).structuredContent ?? {};
    assert.equal(answer["total"], 154);
    assert.equal(answer["drucksachen"], 154);
    seen.push(...(answer["tops"] as { top: string }[]).map((t) => t.top));
    offset = answer["nextOffset"] as number | undefined;
  }
  assert.deepEqual(seen, tops.map((t) => t.toptitle));
  const page = (await connection.call("getAgenda", { offset: 10, limit: 5 })).structuredContent ?? {};
  assert.deepEqual((page["tops"] as { top: string }[]).map((t) => t.top), ["TOP 11", "TOP 12", "TOP 13", "TOP 14", "TOP 15"]);
  assert.equal(page["nextOffset"], 15);
  const past = (await connection.call("getAgenda", { offset: 154 })).structuredContent ?? {};
  assert.equal(past["status"], "empty");
  assert.match(String(past["reason"]), /offset 154 is past the 154 items/);
  await connection.close();
});

test("the size advice fits every tool: each option it names is named with the tools that take it, and it doesn't promise a smaller download", () => {
  const schemas = new Map(TOOLS.map((tool) => [tool.name, Object.keys((tool.inputSchema as { properties: Record<string, unknown> }).properties)]));
  const pairs = [...SIZE_HINT.matchAll(/(\w+(?: or \w+)*) \((\w+(?:, \w+)*)\)/g)];
  assert.ok(pairs.length >= 2, SIZE_HINT);
  for (const [, options, tools] of pairs) {
    for (const tool of (tools as string).split(", ")) {
      for (const option of (options as string).split(" or ")) assert.ok(schemas.get(tool)?.includes(option), `${tool} takes no ${option}: ${SIZE_HINT}`);
    }
  }
  const named = new Set(pairs.flatMap(([, options]) => (options as string).split(" or ")));
  for (const option of ["state", "party", "limit", "offset", "includeDeputies", "includeCancelled"]) {
    assert.ok(!new RegExp(`\\b${option}\\b`).test(SIZE_HINT) || named.has(option), `${option} named without its tools: ${SIZE_HINT}`);
  }
  assert.doesNotMatch(SIZE_HINT, /members by state or party\.$/);
  assert.match(SIZE_HINT, /not the download/);
});
