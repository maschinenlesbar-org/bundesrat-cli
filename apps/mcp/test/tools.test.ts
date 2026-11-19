// This server's tools against a mock of the Bundesrat feeds, with the skills' traps as cases.

import { test } from "node:test";
import assert from "node:assert/strict";
import { listTools } from "../src/mcp/server.js";
import { connect } from "./harness.js";
import { bundesrat } from "./helpers.js";

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
    { title: "Finanzausschuss entfällt", startdate: "20.11.2026" },
    { title: "Plenarsitzung", startdate: "27.11.2026 09:30" },
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
  assert.deepEqual((result.structuredContent?.["meetings"] as { title: string; start: string }[]).map((m) => [m.title, m.start]), [["Plenarsitzung", "2026-11-27T09:30"]]);
  assert.equal(result.structuredContent?.["cancelled"], 1);
  await connection.close();
});
