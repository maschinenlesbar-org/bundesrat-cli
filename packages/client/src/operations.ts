// The use cases of the skills as library functions, built on the client: each carries the
// traps the skills document, so no caller (the CLI, the MCP server's tools, a library user) has
// to know them.
// - getAgenda: the current plenary agenda in TOP order, the Drucksachen split, each named in full
//   (bundesrat-agenda);
// - listAppointments: the committee dates as ISO times, sorted, cancelled ones marked (bundesrat-agenda);
// - findMembers: the members by Land and party, full members unless deputies or the Länder's
//   plenipotentiaries are asked for (bundesrat-members).

import { filterMembers, type BundesratClient } from "./client.js";
import { BundesratParseError } from "./errors.js";
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
  /** The sitting's day, ISO ("2026-11-20"), read from `when`; absent when it can't be read. */
  date?: string;
  /**
   * True when the sitting's day is before today in Germany: the feed keeps the last sitting until
   * the next agenda is published, so between sittings this is not the next one. Absent without a date.
   */
  past?: boolean;
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

const MONTHS = ["januar", "februar", "märz", "april", "mai", "juni", "juli", "august", "september", "oktober", "november", "dezember"];

/**
 * The day a sitting's date line names, ISO: "am Freitag, dem 20. November 2026, 9:30 Uhr" and
 * "am 20.11.2026" give "2026-11-20"; a day that doesn't exist or no date gives undefined.
 */
export function sittingDate(when: string | undefined): string | undefined {
  const text = (when ?? "").normalize("NFC").toLowerCase();
  const named = /(\d{1,2})\.\s*(januar|februar|märz|april|mai|juni|juli|august|september|oktober|november|dezember)\s+(\d{4})/.exec(text);
  const dotted = /(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(text);
  const [d, m, y] = named !== null ? [Number(named[1]), MONTHS.indexOf(named[2] ?? "") + 1, Number(named[3])] : dotted !== null ? [Number(dotted[1]), Number(dotted[2]), Number(dotted[3])] : [];
  if (d === undefined || m === undefined || y === undefined || !possible(y, m, d)) return undefined;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/**
 * The current plenary sitting's agenda, in TOP order (the feed lists the items out of order), with
 * the sitting's day and whether it is over (`now`, default the clock): between sittings the feed
 * still holds the last one.
 */
export async function getAgenda(client: BundesratClient, input: { now?: Date | undefined } = {}): Promise<Agenda> {
  const session = await client.session();
  const date = sittingDate(session.header);
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
    ...(date === undefined ? {} : { date, past: date < germanToday(input.now) }),
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
  /** The feed's start text when it isn't a date this library reads (no `start` then). */
  startText?: string;
  /** The feed's end text when it isn't a date this library reads, or is before the start (no `end` then). */
  endText?: string;
  /** The title says the meeting doesn't take place ("entfällt", "abgesagt", …; see {@link isCancelled}), e.g. replaced by a written poll. */
  cancelled: boolean;
  url?: string;
}

/** The answer of {@link listAppointments}. */
export interface Appointments {
  /** Every date in the feed. */
  total: number;
  /** How many of them are cancelled. */
  cancelled: number;
  /** How many are over (ended, or started without an end, before today in Germany): never listed. */
  past: number;
  /** How many have a start or end that isn't a date this library reads (kept as `startText`/`endText`). */
  unreadable: number;
  /** Sorted by start; those without a readable start last. */
  meetings: Meeting[];
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** The date and time in Germany at `instant`, as "YYYY-MM-DDTHH:MM". */
function germanTime(instant: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  );
  return `${parts["year"]}-${parts["month"]}-${parts["day"]}T${parts["hour"]}:${parts["minute"]}`;
}

/** Today's date in Germany ("YYYY-MM-DD"). */
export function germanToday(now: Date = new Date()): string {
  return germanTime(now).slice(0, 10);
}

/** True when the day exists (31.02. doesn't) and the time is one of a day. */
function possible(y: number, m: number, d: number, hh = 0, mm = 0, ss = 0): boolean {
  const day = new Date(Date.UTC(y, m - 1, d));
  return day.getUTCFullYear() === y && day.getUTCMonth() === m - 1 && day.getUTCDate() === d && hh < 24 && mm < 60 && ss < 60;
}

/**
 * A feed date as ISO local German time: "25.09.2026 09:30" or "22.09.2026" (the feed's usual
 * German form) and "2026-09-25 09:30" become "2026-09-25T09:30" or "2026-09-22"; seconds are kept
 * when they aren't :00; an ISO time with a zone ("…T09:30:00+02:00", "…Z") is given as the time in
 * Germany. An impossible date or time (31.02., 25:99) and anything else give undefined.
 */
export function isoFromGerman(value: string | undefined): string | undefined {
  const text = (value ?? "").trim();
  const time = "(?:[ T](\\d{1,2}):(\\d{2})(?::(\\d{2}))?)?";
  const german = new RegExp(`^(\\d{2})\\.(\\d{2})\\.(\\d{4})${time}$`).exec(text);
  const iso = new RegExp(`^(\\d{4})-(\\d{2})-(\\d{2})${time}(Z|[+-]\\d{2}:\\d{2})?$`).exec(text);
  if (german === null && iso === null) return undefined;
  const [y, m, d, hh, mm, ss] = german !== null ? [german[3], german[2], german[1], german[4], german[5], german[6]] : [iso?.[1], iso?.[2], iso?.[3], iso?.[4], iso?.[5], iso?.[6]];
  const zone = iso?.[7];
  if (!possible(Number(y), Number(m), Number(d), Number(hh ?? 0), Number(mm ?? 0), Number(ss ?? 0))) return undefined;
  if (zone !== undefined) {
    if (hh === undefined) return undefined;
    const local = germanTime(new Date(`${y}-${m}-${d}T${pad(Number(hh))}:${mm}:${ss ?? "00"}${zone}`));
    return ss === undefined || ss === "00" ? local : `${local}:${ss}`;
  }
  if (hh === undefined) return `${y}-${m}-${d}`;
  return `${y}-${m}-${d}T${pad(Number(hh))}:${mm}${ss === undefined || ss === "00" ? "" : `:${ss}`}`;
}

/**
 * True when a date's title says it doesn't take place: "entfällt" (the feed's usual word, often
 * with "/ Umfrageverfahren"), "entfallen", "abgesagt", "fällt aus", "findet nicht statt", in any
 * case and Unicode form (a decomposed "ä" too). A negated one ("entfällt nicht") is not.
 */
export function isCancelled(title: string): boolean {
  const text = title.normalize("NFC").toLowerCase();
  return /(?:^|[^\p{L}])(?:entf[äa]llt|entfallen|abgesagt|fällt\s+aus|findet\s+nicht\s+statt)(?![\p{L}])(?!\s+nicht(?![\p{L}]))/u.test(text);
}

/** True when ISO time `a` is before `b`: by the minute when both have a time, else by the day. */
function before(a: string, b: string): boolean {
  return a.length > 10 && b.length > 10 ? a < b : a.slice(0, 10) < b.slice(0, 10);
}

/**
 * The committee dates, sorted by start, cancelled ones marked rather than listed as meetings.
 * Dates already over (their end, else their start, before today in Germany: `now`, default the
 * clock) are left out and counted: the feed lists upcoming dates, and an old one left in it is
 * not one. A start or end that isn't a readable date keeps the feed's text (`startText`,
 * `endText`) and is counted (`unreadable`): a feed that changes its date form shows, rather than
 * every meeting silently losing its time. An end before its start is not an end.
 */
export async function listAppointments(client: BundesratClient, input: { includeCancelled?: boolean | undefined; now?: Date | undefined } = {}): Promise<Appointments> {
  const today = germanToday(input.now);
  let unreadable = 0;
  const all = (await client.appointments()).map((a): Meeting => {
    const start = isoFromGerman(a.startdate);
    const read = isoFromGerman(a.stopdate);
    const end = read !== undefined && start !== undefined && before(read, start) ? undefined : read;
    const startText = start === undefined && a.startdate ? a.startdate.trim() : undefined;
    const endText = end === undefined && a.stopdate ? a.stopdate.trim() : undefined;
    if (startText !== undefined || endText !== undefined) unreadable++;
    const title = (a.title ?? "").trim();
    return {
      title,
      ...(start ? { start } : {}),
      ...(end ? { end } : {}),
      ...(startText ? { startText } : {}),
      ...(endText ? { endText } : {}),
      cancelled: isCancelled(title),
      ...(a.url ? { url: a.url } : {}),
    };
  });
  const over = (m: Meeting): boolean => {
    const last = m.end ?? m.start;
    return last !== undefined && last.slice(0, 10) < today;
  };
  const current = all.filter((m) => !over(m));
  const sorted = [...current].sort((a, b) => (a.start === undefined ? 1 : b.start === undefined ? -1 : a.start.localeCompare(b.start)));
  const cancelled = all.filter((m) => m.cancelled).length;
  return {
    total: all.length,
    cancelled,
    past: all.length - current.length,
    unreadable,
    meetings: input.includeCancelled === true ? sorted : sorted.filter((m) => !m.cancelled),
  };
}

/** One person of the Bundesrat. */
export interface Person {
  name: string;
  party?: string;
  state?: string;
  /**
   * member: one of the 69 full members; deputy: a deputy member (stellvertretendes Mitglied);
   * plenipotentiary: a Land's plenipotentiary (Bevollmächtigte:r) who is neither.
   */
  role: "member" | "deputy" | "plenipotentiary";
  /** Designated, not yet in office. */
  designated: boolean;
  url?: string;
}

/** The answer of {@link findMembers}. */
export interface Members {
  /** How many match (after the role filter), designated people not among them. */
  total: number;
  /** Head count per party and per Land of the matches. */
  byParty: Record<string, number>;
  byState: Record<string, number>;
  people: Person[];
  /** Designated people who match (not yet in office: a successor, who would be counted twice), apart. */
  designated: Person[];
}

function person(m: Member): Person {
  const name = [m.honorificTitle, m.firstname, m.name].map((part) => part?.trim()).filter((part) => part).join(" ");
  return {
    name,
    ...(m.party ? { party: m.party.trim() } : {}),
    ...(m.state ? { state: m.state.trim() } : {}),
    role: m.mitglied === "true" ? "member" : m.brmitglied === "true" ? "deputy" : "plenipotentiary",
    designated: m.designiert === "true",
    ...(m.url ? { url: m.url } : {}),
  };
}

/**
 * The members feed as it always is: someone in it, full members among them (`mitglied` "true"), a
 * party and a Land on the records. The Bundesrat always has its 69 members, so a feed without them
 * has changed (an element renamed, the flags written 1/0), and a filter over it would answer "no
 * member matches", which is false: a BundesratParseError says what is missing instead.
 */
function assertMemberFeed(records: readonly Member[]): void {
  const missing =
    records.length === 0
      ? "lists nobody"
      : !records.some((m) => m.mitglied === "true")
        ? 'marks no record as a full member (<mitglied>true</mitglied>)'
        : !records.some((m) => m.party !== undefined)
          ? "gives no record a party (<party>)"
          : !records.some((m) => m.state !== undefined)
            ? "gives no record a Land (<state>)"
            : undefined;
  if (missing !== undefined) throw new BundesratParseError(`The Bundesrat's members feed ${missing}; the feed may have changed.`);
}

/**
 * The members of the Bundesrat, filtered by Land (exact, one of the sixteen) and party (contains).
 * Full members only (`mitglied`), unless `includeDeputies`: the feed's records are mostly deputies,
 * so counting all of them gives party head counts about three times too high. The Länder's
 * plenipotentiaries who are not members (Bevollmächtigte, `bv` only) come with
 * `includePlenipotentiaries`, as role "plenipotentiary". A designated person
 * (not yet in office) is listed apart in `designated` and not counted, and a record the feed repeats
 * counts once, so the full members are never more than the 69 seats.
 */
export async function findMembers(
  client: BundesratClient,
  input: { state?: string | undefined; party?: string | undefined; includeDeputies?: boolean | undefined; includePlenipotentiaries?: boolean | undefined } = {},
  /** Where the feed's records come from (default `client.members()`): a caller that keeps the feed a while passes its own. */
  feed: () => Promise<Member[]> = () => client.members(),
): Promise<Members> {
  const filter = { ...(input.state === undefined ? {} : { state: input.state }), ...(input.party === undefined ? {} : { party: input.party }) };
  filterMembers([], filter); // checks the filter before any request
  const all = await feed();
  assertMemberFeed(all);
  const records = filterMembers(all, filter);
  // The same record twice (the feed has repeated one) is one person.
  const seen = new Set<string>();
  const unique = records.filter((m) => {
    const key = JSON.stringify(Object.entries(m).sort(([a], [b]) => a.localeCompare(b)));
    return seen.has(key) ? false : (seen.add(key), true);
  });
  const asked = (p: Person): boolean => p.role === "member" || (p.role === "deputy" ? input.includeDeputies === true : input.includePlenipotentiaries === true);
  const matches = unique.filter((m) => m.brmitglied === "true" || m.mitglied === "true" || m.bv === "true").map(person).filter(asked);
  const people = matches.filter((p) => !p.designated);
  const count = (key: "party" | "state"): Record<string, number> =>
    people.reduce<Record<string, number>>((acc, p) => {
      const k = p[key] ?? "(none)";
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {});
  return { total: people.length, byParty: count("party"), byState: count("state"), people, designated: matches.filter((p) => p.designated) };
}
