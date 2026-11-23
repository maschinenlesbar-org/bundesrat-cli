// The use cases of the skills as library functions, built on the client: each carries the
// traps the skills document, so no caller (the CLI, the MCP server's tools, a library user) has
// to know them.
// - getAgenda: the current plenary agenda in TOP order, the Drucksachen split, each named in full
//   (bundesrat-agenda);
// - listAppointments: the committee dates as ISO times, sorted, cancelled ones marked (bundesrat-agenda);
// - findMembers: the members by Land and party, full members unless deputies are asked for
//   (bundesrat-members).

import type { BundesratClient } from "./client.js";
import type { AgendaItem, Member } from "./types.js";

/** One agenda item, with its Drucksachen one by one. */
export interface Top {
  /** e.g. "TOP 67", "TOP 2b". */
  top: string;
  /** Short factual label. */
  header?: string;
  /** Each Drucksache of the item ("Drucksache 343/26"); empty for a procedural item. */
  drucksachen: string[];
  linkedTop?: string;
}

/** The answer of {@link getAgenda}. */
export interface Agenda {
  title?: string;
  sitting?: string;
  /** When, as the feed says it ("am Freitag, dem 10. Juli 2026, 9:30 Uhr"). */
  when?: string;
  /** The date the agenda is as of (DD.MM.YYYY). */
  asOf?: string;
  /** True when the title says the agenda is a draft ("Tagesordnung Entwurf"). */
  draft: boolean;
  /** The items in TOP order (number, then letter; items without a number first). */
  tops: Top[];
  /** How many Drucksachen the sitting deals with. */
  drucksachen: number;
}

/**
 * Sort key of a TOP title: [number (-1 without one), letter suffix]. The number is the first one
 * after "TOP", the letter one standing right after it ("TOP 2b", "TOP 1 a", "TOP 10a-c"), so an
 * addition after them ("TOP 3 (neu)", "TOP 11 - neu -", "TOP 12/13", "TOP 7 und 8") doesn't move
 * the item; a title without "TOP" is read the same way from its start.
 */
export function topKey(title: string | undefined): [number, string] {
  const text = (title ?? "").trim();
  const after = /\bTOP\b/i.exec(text);
  const rest = after === null ? text : text.slice(after.index + after[0].length);
  const match = /^\s*(\d*)\s*(?:([a-z])(?![\p{L}]))?/iu.exec(rest);
  const number = match?.[1] ? Number(match[1]) : -1;
  return [number, (match?.[2] ?? "").toLowerCase()];
}

/** A Drucksache number ("343/26", "108/26 (neu)"), after its "Drucksache(n)" word. */
const DRUCKSACHE_NUMBER = /^\d+\/\d+\b/;

/**
 * The Drucksachen of an element, each named in full. The client joins repeated elements with
 * "; "; one element may list several itself ("Drucksache 102/26, 103/26", "Drucksachen 104/26
 * und 105/26", "Drucksache 106/26; 107/26"): when every piece is a number, each becomes
 * "Drucksache <number>", so no bare number stands without its word. Any other text stays whole.
 */
export function splitDrucksachen(text: string | undefined): string[] {
  return (text ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .flatMap((part) => {
      const pieces = part
        .replace(/^Drucksachen?\s+/i, "")
        .split(/\s*(?:,|\bund\b)\s*/)
        .filter((piece) => piece !== "");
      return pieces.length > 0 && pieces.every((piece) => DRUCKSACHE_NUMBER.test(piece)) ? pieces.map((piece) => `Drucksache ${piece}`) : [part];
    });
}

function top(item: AgendaItem): Top {
  const drucksachen = splitDrucksachen(item.topdrucksache);
  return {
    top: (item.toptitle ?? "").trim(),
    ...(item.topheader ? { header: item.topheader.trim() } : {}),
    drucksachen,
    ...(item.linkedtop ? { linkedTop: item.linkedtop.trim() } : {}),
  };
}

/** The current plenary sitting's agenda, in TOP order (the feed lists the items out of order). */
export async function getAgenda(client: BundesratClient): Promise<Agenda> {
  const session = await client.session();
  const tops = session.tops.map(top).sort((a, b) => {
    const [na, sa] = topKey(a.top);
    const [nb, sb] = topKey(b.top);
    return na - nb || sa.localeCompare(sb);
  });
  return {
    ...(session.title ? { title: session.title } : {}),
    ...(session.sitzung ? { sitting: session.sitzung } : {}),
    ...(session.header ? { when: session.header } : {}),
    ...(session.stand ? { asOf: session.stand } : {}),
    draft: /entwurf/i.test(session.title ?? ""),
    tops,
    drucksachen: tops.reduce((n, t) => n + t.drucksachen.length, 0),
  };
}

/** One committee date. */
export interface Meeting {
  title: string;
  /** ISO local time ("2026-09-25T09:30" or a date "2026-09-22"), German time. */
  start?: string;
  end?: string;
  /** The title says the meeting doesn't take place ("entfällt"), e.g. replaced by a written poll. */
  cancelled: boolean;
  url?: string;
}

/** The answer of {@link listAppointments}. */
export interface Appointments {
  total: number;
  cancelled: number;
  /** Sorted by start; those without a readable start last. */
  meetings: Meeting[];
}

/**
 * A feed date as ISO local time: "25.09.2026 09:30" or "22.09.2026" (the feed's usual German form)
 * and "2026-09-25 09:30" become "2026-09-25T09:30" or "2026-09-22"; anything else undefined.
 */
export function isoFromGerman(value: string | undefined): string | undefined {
  const text = (value ?? "").trim();
  const german = text.match(/^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/);
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/);
  if (german === null && iso === null) return undefined;
  const [y, m, d, hh, mm] = german !== null ? [german[3], german[2], german[1], german[4], german[5]] : [iso?.[1], iso?.[2], iso?.[3], iso?.[4], iso?.[5]];
  return hh === undefined ? `${y}-${m}-${d}` : `${y}-${m}-${d}T${hh.padStart(2, "0")}:${mm}`;
}

/** The committee dates, sorted by start, cancelled ones marked rather than listed as meetings. */
export async function listAppointments(client: BundesratClient, input: { includeCancelled?: boolean | undefined } = {}): Promise<Appointments> {
  const all = (await client.appointments()).map((a): Meeting => {
    const start = isoFromGerman(a.startdate);
    const end = isoFromGerman(a.stopdate);
    const title = (a.title ?? "").trim();
    return { title, ...(start ? { start } : {}), ...(end ? { end } : {}), cancelled: /entf[äa]llt/i.test(title), ...(a.url ? { url: a.url } : {}) };
  });
  const sorted = [...all].sort((a, b) => (a.start === undefined ? 1 : b.start === undefined ? -1 : a.start.localeCompare(b.start)));
  const cancelled = all.filter((m) => m.cancelled).length;
  return { total: all.length, cancelled, meetings: input.includeCancelled === true ? sorted : sorted.filter((m) => !m.cancelled) };
}

/** One person of the Bundesrat. */
export interface Person {
  name: string;
  party?: string;
  state?: string;
  /** member: one of the 69 full members; deputy: a deputy member (stellvertretendes Mitglied). */
  role: "member" | "deputy";
  /** Designated, not yet in office. */
  designated: boolean;
  url?: string;
}

/** The answer of {@link findMembers}. */
export interface Members {
  /** How many match (after the role filter). */
  total: number;
  /** Head count per party and per Land of the matches. */
  byParty: Record<string, number>;
  byState: Record<string, number>;
  people: Person[];
}

function person(m: Member): Person {
  const name = [m.honorificTitle, m.firstname, m.name].map((part) => part?.trim()).filter((part) => part).join(" ");
  return {
    name,
    ...(m.party ? { party: m.party.trim() } : {}),
    ...(m.state ? { state: m.state.trim() } : {}),
    role: m.mitglied === "true" ? "member" : "deputy",
    designated: m.designiert === "true",
    ...(m.url ? { url: m.url } : {}),
  };
}

/**
 * The members of the Bundesrat, filtered by Land (exact, one of the sixteen) and party (contains).
 * Full members only (`mitglied`), unless `includeDeputies`: the feed's records are mostly deputies,
 * so counting all of them gives party head counts about three times too high.
 */
export async function findMembers(
  client: BundesratClient,
  input: { state?: string | undefined; party?: string | undefined; includeDeputies?: boolean | undefined } = {},
): Promise<Members> {
  const records = await client.members({ ...(input.state === undefined ? {} : { state: input.state }), ...(input.party === undefined ? {} : { party: input.party }) });
  const people = records.filter((m) => m.brmitglied === "true" || m.mitglied === "true").map(person).filter((p) => input.includeDeputies === true || p.role === "member");
  const count = (key: "party" | "state"): Record<string, number> =>
    people.reduce<Record<string, number>>((acc, p) => {
      const k = p[key] ?? "(none)";
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {});
  return { total: people.length, byParty: count("party"), byState: count("state"), people };
}
