// The use cases of the skills against a mock of the feeds, with the skills' traps as cases.

import { test } from "node:test";
import assert from "node:assert/strict";
import { BundesratClient, findMembers, getAgenda, isoFromGerman, listAppointments, topKey } from "../src/index.js";
import { makeMockTransport, xmlResponse } from "./helpers.js";

const feed = (body: string): string => `<?xml version="1.0"?><iOS version="1.0"><list>${body}</list></iOS>`;
/** "Today" for the date tests: 1 September 2026, noon in Germany. */
const SEPTEMBER = new Date("2026-09-01T10:00:00Z");
const client = (path: string, body: string) =>
  new BundesratClient({ transport: makeMockTransport((request) => (new URL(request.url).pathname.endsWith(path) ? xmlResponse(feed(body)) : xmlResponse(feed("")))).transport });

test("getAgenda sorts TOPs by number then letter (a plain sort puts TOP 10 before TOP 2); no-number items first", async () => {
  const body =
    "<title>1069. Sitzung des Bundesrates | Tagesordnung Entwurf</title>" +
    ["TOP 10", "TOP 2b", "TOP a", "TOP 2", "TOP 2a"].map((t) => `<top><toptitle>${t}</toptitle><topheader>H</topheader></top>`).join("");
  const agenda = await getAgenda(client("plenum_aktuelleSitzung_table.xml", body));
  assert.deepEqual(agenda.tops.map((t) => t.top), ["TOP a", "TOP 2", "TOP 2a", "TOP 2b", "TOP 10"]);
  assert.equal(agenda.draft, true);
});

test("getAgenda splits an item's Drucksachen on '; ' and counts them; a procedural item has none", async () => {
  const body =
    "<top><toptitle>TOP 1</toptitle><topdrucksache>Drucksache 343/26; Drucksache 344/26</topdrucksache></top>" +
    "<top><toptitle>TOP 2</toptitle><topheader>Wahl</topheader></top>";
  const agenda = await getAgenda(client("plenum_aktuelleSitzung_table.xml", body));
  assert.deepEqual(agenda.tops[0]?.drucksachen, ["Drucksache 343/26", "Drucksache 344/26"]);
  assert.deepEqual(agenda.tops[1]?.drucksachen, []);
  assert.equal(agenda.drucksachen, 2);
});

test("getAgenda names every Drucksache of an element in full: a list with commas, und or ';', a suffix kept, other text left whole", async () => {
  const tops = [
    "Drucksache 102/26, 103/26",
    "Drucksache 104/26 und 105/26",
    "Drucksache 106/26; 107/26",
    "Drucksache 108/26 (neu)",
    "Drucksachen 109/26, 110/26 (neu)",
    "Unterrichtung, siehe Drucksache 111/26",
  ];
  const body = tops.map((d, i) => `<top><toptitle>TOP ${i + 1}</toptitle><topdrucksache>${d}</topdrucksache></top>`).join("");
  const agenda = await getAgenda(client("plenum_aktuelleSitzung_table.xml", body));
  assert.deepEqual(agenda.tops.map((t) => t.drucksachen), [
    ["Drucksache 102/26", "Drucksache 103/26"],
    ["Drucksache 104/26", "Drucksache 105/26"],
    ["Drucksache 106/26", "Drucksache 107/26"],
    ["Drucksache 108/26 (neu)"],
    ["Drucksache 109/26", "Drucksache 110/26 (neu)"],
    ["Unterrichtung, siehe Drucksache 111/26"],
  ]);
  assert.equal(agenda.drucksachen, 10);
});

test("topKey reads the number and the letter", () => {
  assert.deepEqual(topKey("TOP 67"), [67, ""]);
  assert.deepEqual(topKey("TOP 2b"), [2, "b"]);
  assert.deepEqual(topKey("TOP a"), [-1, "a"]);
});

test("topKey reads the TOP's own number when more follows it: (neu), a range of letters, a second TOP", () => {
  assert.deepEqual(topKey("TOP 3 (neu)"), [3, ""]);
  assert.deepEqual(topKey("TOP 11 - neu -"), [11, ""]);
  assert.deepEqual(topKey("TOP 10a-c"), [10, "a"]);
  assert.deepEqual(topKey("TOP 12/13"), [12, ""]);
  assert.deepEqual(topKey("TOP 7 und 8"), [7, ""]);
  assert.deepEqual(topKey("Zu TOP 3"), [3, ""]);
  assert.deepEqual(topKey("TOP 1 a"), [1, "a"]);
  assert.deepEqual(topKey("TOP"), [-1, ""]);
});

test("getAgenda sorts TOP titles with additions by their numbers, not before TOP 1", async () => {
  const body = ["TOP 11 - neu -", "TOP 3 (neu)", "TOP 1", "TOP 10a-c", "TOP 2", "TOP a"].map((t) => `<top><toptitle>${t}</toptitle></top>`).join("");
  const agenda = await getAgenda(client("plenum_aktuelleSitzung_table.xml", body));
  assert.deepEqual(agenda.tops.map((t) => t.top), ["TOP a", "TOP 1", "TOP 2", "TOP 3 (neu)", "TOP 10a-c", "TOP 11 - neu -"]);
});

test("listAppointments: German dates sort as dates, cancelled ones (entfällt) are counted and left out", async () => {
  const body =
    "<item><title>Sitzung des Finanzausschusses entfällt / Umfrageverfahren</title><startdate>20.09.2026</startdate></item>" +
    "<item><title>Plenarsitzung</title><startdate>25.09.2026 09:30</startdate></item>" +
    "<item><title>Ausschuss</title><startdate>03.10.2026 9:00</startdate><stopdate>03.10.2026 12:00</stopdate></item>" +
    "<item><title>Ohne Datum</title></item>";
  const answer = await listAppointments(client("termine_table.xml", body), { now: SEPTEMBER });
  assert.deepEqual(answer.meetings.map((m) => [m.title, m.start ?? null]), [["Plenarsitzung", "2026-09-25T09:30"], ["Ausschuss", "2026-10-03T09:00"], ["Ohne Datum", null]]);
  assert.equal(answer.cancelled, 1);
  assert.equal(answer.meetings[1]?.end, "2026-10-03T12:00");
  const all = await listAppointments(client("termine_table.xml", body), { includeCancelled: true, now: SEPTEMBER });
  assert.equal(all.meetings[0]?.cancelled, true);
});

test("listAppointments: a date is cancelled by any usual wording, in any Unicode form; a negated one is not", async () => {
  const titles = [
    ["Sitzung entf\u0061\u0308llt", true],
    ["Sitzung ENTFÄLLT", true],
    ["Sitzung abgesagt", true],
    ["Sitzung fällt aus", true],
    ["Die Sitzung findet nicht statt", true],
    ["Sitzung entfallen", true],
    ["Die Sitzung entfällt nicht, sie findet statt", false],
    ["Plenarsitzung", false],
    ["Sitzung verschoben", false],
  ] as const;
  const body = titles.map(([t], i) => `<item><title>${t}</title><startdate>${String(i + 1).padStart(2, "0")}.10.2099</startdate></item>`).join("");
  const answer = await listAppointments(client("termine_table.xml", body), { includeCancelled: true });
  assert.deepEqual(answer.meetings.map((m) => [m.title.normalize("NFC"), m.cancelled]), titles.map(([t, c]) => [t.normalize("NFC"), c]));
});

test("isoFromGerman reads both date forms and refuses others", () => {
  assert.equal(isoFromGerman("22.09.2026"), "2026-09-22");
  assert.equal(isoFromGerman("2026-07-15 14:00"), "2026-07-15T14:00");
  assert.equal(isoFromGerman("bald"), undefined);
});

test("isoFromGerman refuses impossible dates and times, reads seconds and a time zone (as German time)", () => {
  assert.equal(isoFromGerman("31.02.2026 10:00"), undefined);
  assert.equal(isoFromGerman("01.10.2026 25:99"), undefined);
  assert.equal(isoFromGerman("29.02.2028"), "2028-02-29");
  assert.equal(isoFromGerman("29.02.2026"), undefined);
  assert.equal(isoFromGerman("02.10.2026 09:30:00"), "2026-10-02T09:30");
  assert.equal(isoFromGerman("02.10.2026 09:30:15"), "2026-10-02T09:30:15");
  assert.equal(isoFromGerman("2026-10-03T09:30:00+02:00"), "2026-10-03T09:30");
  assert.equal(isoFromGerman("2026-10-03T07:30:00Z"), "2026-10-03T09:30");
  assert.equal(isoFromGerman("2026-12-03T09:30:00+01:00"), "2026-12-03T09:30");
});

test("listAppointments: a date it can't read keeps its text and is counted; an end before its start is no end; dates already over are left out and counted", async () => {
  const body =
    "<item><title>Zukunft</title><startdate>03.10.2026 9:00</startdate></item>" +
    "<item><title>Unmöglich</title><startdate>31.02.2026 10:00</startdate></item>" +
    "<item><title>Rückwärts</title><startdate>25.09.2026 09:30</startdate><stopdate>24.09.2026 12:00</stopdate></item>" +
    "<item><title>Vorbei</title><startdate>01.01.2020</startdate></item>" +
    "<item><title>Läuft noch</title><startdate>30.08.2026</startdate><stopdate>02.09.2026</stopdate></item>" +
    "<item><title>Heute früh</title><startdate>01.09.2026 08:00</startdate></item>";
  const answer = await listAppointments(client("termine_table.xml", body), { now: SEPTEMBER });
  assert.deepEqual(
    answer.meetings.map((m) => [m.title, m.start ?? null, m.end ?? null, m.startText ?? null, m.endText ?? null]),
    [
      ["Läuft noch", "2026-08-30", "2026-09-02", null, null],
      ["Heute früh", "2026-09-01T08:00", null, null, null],
      ["Rückwärts", "2026-09-25T09:30", null, null, "24.09.2026 12:00"],
      ["Zukunft", "2026-10-03T09:00", null, null, null],
      ["Unmöglich", null, null, "31.02.2026 10:00", null],
    ],
  );
  assert.equal(answer.total, 6);
  assert.equal(answer.past, 1);
  assert.equal(answer.unreadable, 2);
});

test("findMembers counts full members only unless deputies are asked for (records are mostly deputies)", async () => {
  const m = (name: string, party: string, mitglied: string) => `<employee><name>${name}</name><party>${party}</party><state>Bayern</state><brmitglied>true</brmitglied><mitglied>${mitglied}</mitglied></employee>`;
  const body = m("A", "CSU", "true") + m("B", "CSU", "false") + m("C", "CSU", "false") + "<employee><name>D</name><party>CSU</party><state>Bayern</state><brmitglied>false</brmitglied><bv>true</bv></employee>";
  const members = await findMembers(client("mitglieder_table.xml", body), { state: "bayern" });
  assert.equal(members.total, 1);
  assert.deepEqual(members.byParty, { CSU: 1 });
  const all = await findMembers(client("mitglieder_table.xml", body), { includeDeputies: true });
  assert.deepEqual(all.people.map((p) => [p.name, p.role]), [["A", "member"], ["B", "deputy"], ["C", "deputy"]]);
});

test("findMembers: a designated successor is listed apart, not counted; the same record twice counts once", async () => {
  const m = (name: string, extra = "") => `<employee><name>${name}</name><party>CSU</party><state>Bayern</state><brmitglied>true</brmitglied><mitglied>true</mitglied>${extra}</employee>`;
  const body = m("A") + m("B") + m("A") + m("C", "<designiert>true</designiert>");
  const members = await findMembers(client("mitglieder_table.xml", body));
  assert.equal(members.total, 2);
  assert.deepEqual(members.people.map((p) => p.name), ["A", "B"]);
  assert.deepEqual(members.byParty, { CSU: 2 });
  assert.deepEqual(members.designated.map((p) => [p.name, p.designated]), [["C", true]]);
});
