// BundesratClient — a typed client over the Bundesrat's public data feeds (the
// data behind the official Bundesrat iOS app). No auth. Every feed is an XML
// document served by www.bundesrat.de; each `.xml` path must carry the
// `?view=renderXml` render parameter, which this client always adds.
//
// LICENSING: this client exposes **only the openly-licensed data** in the feeds —
// factual/structured fields and official-document (Drucksache) references. The
// feeds' copyright-protected editorial content (HTML detail/biography fragments,
// teaser abstracts, images) and the wholly-editorial feeds (news, BundesratKOMPAKT,
// the Stimmverteilung graphic, the Präsidium/next-sitting HTML pages) are not
// surfaced. Each result is projected down to a whitelist of open fields. See
// DATA_LICENSE.md.
//
//   const c = new BundesratClient();
//   await c.session();       // the current plenary sitting's agenda (TOPs + Drucksachen)
//   await c.members();       // the members of the Bundesrat (names, party, Land)
//   await c.members({ state: "Bayern", party: "csu" });  // filtered by Land / party
//   await c.appointments();  // committee appointments / dates (Termine)

import { RequestEngine, type EngineOptions } from "./engine.js";
import type { XmlObject, XmlValue } from "./xml.js";
import { BundesratParseError, cutForMessage } from "./errors.js";
import { assertValid, knownKeysProblem, nonBlankProblem, stateProblem } from "./validate.js";
import type { AgendaItem, Appointment, Member, Session } from "./types.js";

/** The feed paths (relative to the base URL). All are GET + `?view=renderXml`. */
export const FEEDS = {
  session: "/iOS/SharedDocs/3_Plenum/plenum_aktuelleSitzung_table.xml",
  members: "/iOS/SharedDocs/2_Mitglieder/mitglieder_table.xml",
  appointments: "/iOS/v3/02_Termine/termine_table.xml",
} as const;

const RENDER_QUERY = { view: "renderXml" } as const;

// Whitelists of the openly-licensed fields surfaced per feed. Anything not listed
// here — HTML `detail`/biography fragments, teaser `abstract`s, image paths — is a
// copyright-protected editorial field and is intentionally dropped (DATA_LICENSE.md).
//
// MAINTENANCE: this is a fixed allowlist, so a *new* field the upstream feed starts
// serving is dropped silently — including a genuinely factual one (a member's office,
// an event location, …). When the feeds change, revisit these lists rather than
// assuming new fields flow through. (Confirmed against the live feeds 2026-07-06: no
// factual field is currently lost; everything dropped is editorial/HTML/image.)
const MEMBER_FIELDS = [
  "honorificTitle",
  "firstname",
  "name",
  "party",
  "state",
  "brmitglied",
  "mitglied",
  "bv",
  "designiert",
  "url",
] as const;
const TOP_FIELDS = ["toptitle", "topdrucksache", "topheader", "linkedtop"] as const;
/**
 * Whitelisted fields that may repeat: every occurrence is a reference of its own (a TOP
 * that covers two Drucksachen lists two `<topdrucksache>`s), so the plain texts are joined
 * with {@link REPEAT_SEPARATOR} instead of dropping the field. Any other repeated field is
 * still dropped (see {@link textOf}).
 */
const REPEATABLE_FIELDS: ReadonlySet<string> = new Set(["topdrucksache"]);
/** Joins the occurrences of a {@link REPEATABLE_FIELDS} field: "Drucksache 343/26; Drucksache 344/26". */
export const REPEAT_SEPARATOR = "; ";
const APPOINTMENT_FIELDS = [
  "type",
  "id",
  "url",
  "title",
  "date",
  "dateOfIssue",
  "startdate",
  "stopdate",
  "highlighted",
] as const;

/**
 * Coerce a possibly-single / possibly-missing XML child into an array. A repeated
 * element parses to an array, a single occurrence to one object, and a missing one
 * to `undefined`; this normalises all three so callers always get a list.
 */
export function asArray<T>(value: XmlValue | undefined): T[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]) as unknown as T[];
}

/**
 * The plain text of a whitelisted field, or `undefined` when it is not a single
 * plain-text value. Text with attributes (`<name lang="de">Solo</name>`) gives its
 * text. An element holding markup (`<topheader><p>…</p></topheader>`) or repeated
 * (`<party>A</party><party>B</party>`; `topdrucksache` is joined instead, see
 * {@link REPEATABLE_FIELDS}) gives `undefined`: the allowlist vouches for
 * a field's plain text only, so inline editorial HTML must not pass through as a
 * nested object, and every surfaced field stays the `string` the types promise. Text
 * that holds markup itself (CDATA-wrapped or escaped HTML) gives `undefined` too.
 *
 * Runs of whitespace inside the text (the feed puts a raw newline into some
 * `topheader`s) become one space: these are short one-line labels, and the
 * documented "one line per TOP" recipes rely on that.
 */
function textOf(value: XmlValue | undefined): string | undefined {
  let text: string;
  if (typeof value === "string") text = value;
  else if (!isObject(value)) return undefined;
  else {
    for (const key of Object.keys(value)) {
      if (key !== "#text" && !key.startsWith("@")) return undefined;
    }
    const inner = value["#text"];
    text = typeof inner === "string" ? inner : "";
  }
  // Markup that arrives as text — CDATA-wrapped HTML, the form the feeds use for all
  // their editorial content, or escaped tags (`&lt;p&gt;`) — is dropped like element
  // markup: the parser keeps CDATA verbatim, so `<![CDATA[<div class="abstract">…]]>`
  // in a whitelisted title used to pass as the title's "text".
  return hasMarkup(text) ? undefined : oneLine(text);
}

/**
 * True when `text` contains an HTML/XML tag (`<p>`, `</div>`, `<a href="…">`, `<br/>`),
 * a comment or a CDATA opener. A lone `<` in prose ("a < b", "<5 %") is not a tag. The
 * feeds' factual fields are short labels and references, which never hold one (checked
 * against the live feeds 2026-10-06: all CDATA is in non-whitelisted fields).
 */
function hasMarkup(text: string): boolean {
  return /<\/?[A-Za-z][A-Za-z0-9:-]*(\s[^<>]*)?\/?>|<!--|<!\[CDATA\[/.test(text);
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Project a parsed element down to a whitelist of open, factual keys — dropping
 * every copyright-protected editorial/image field. Only **non-empty plain-text**
 * values are copied (see {@link textOf}), so an absent field, an empty one
 * (`<linkedtop/>`) and one holding markup or repeated all simply don't appear — a
 * consistent "a present key always has a string value" shape for consumers.
 */
function pick<T>(obj: XmlValue, keys: readonly string[]): T {
  const src = isObject(obj) ? obj : {};
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = src[key];
    const text = Array.isArray(value) && REPEATABLE_FIELDS.has(key) ? joinedTextOf(value) : textOf(value);
    if (text !== undefined && text !== "") out[key] = text;
  }
  return out as unknown as T;
}

/**
 * The occurrences of a repeatable field, joined with {@link REPEAT_SEPARATOR}: each must
 * be plain text (see {@link textOf}), or the whole field is dropped, as one with markup
 * is; empty occurrences are skipped. A TOP with two `<topdrucksache>`s used to come out
 * with none, which the docs explain as "a procedural item".
 */
function joinedTextOf(values: readonly XmlValue[]): string | undefined {
  const texts: string[] = [];
  for (const value of values) {
    const text = textOf(value);
    if (text === undefined) return undefined;
    if (text !== "") texts.push(text);
  }
  return texts.join(REPEAT_SEPARATOR);
}

/** A non-null, non-array object (a parsed element with children or attributes). */
function isObject(value: XmlValue | undefined): value is XmlObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shapeError(path: string, expected: string): BundesratParseError {
  return new BundesratParseError(`Unexpected response shape from ${path}: expected ${expected}.`);
}

/**
 * Narrow the members list. The feed always returns everyone, so the filter is
 * applied after the fetch (see {@link filterMembers}).
 */
export interface MemberFilter {
  /**
   * Only members of this Land: one of the sixteen `LAENDER`, ignoring case, Unicode form
   * and surrounding whitespace. Any other value is a BundesratValidationError.
   */
  state?: string;
  /** Only members whose party contains this text, ignoring case, Unicode form and surrounding whitespace. */
  party?: string;
}

/** Case- and normalisation-insensitive form of a filter value or a field. */
function fold(text: string): string {
  return text.normalize("NFC").toLowerCase();
}

/** The keys of a {@link MemberFilter}; any other key is a validation error. */
const MEMBER_FILTER_KEYS = ["state", "party"] as const;

/**
 * Check a {@link MemberFilter}: a plain object with no keys but `state` and `party`
 * (a misspelled `State` used to be ignored, returning everyone); `state` one of the
 * sixteen Länder, `party` a non-blank string. Anything else throws a
 * {@link BundesratValidationError}. `undefined` means "no filter".
 */
function assertMemberFilter(filter: MemberFilter | undefined): MemberFilter {
  if (filter === undefined) return {};
  const f = assertValid("filter", filter, knownKeysProblem(MEMBER_FILTER_KEYS)) as MemberFilter;
  if (f.state !== undefined) assertValid("state", f.state, stateProblem);
  if (f.party !== undefined) assertValid("party", f.party, nonBlankProblem);
  return f;
}

/**
 * Filter members by Land and/or party, the way the `members --state / --party`
 * command does. `state` names one of the sixteen Länder and matches it exactly,
 * `party` matches a substring of the party name; both trim the needle and compare case-insensitively on the NFC form,
 * so a decomposed umlaut (macOS file names, some input methods) matches the feed's
 * composed one. A member without the field never matches. An unknown key, a state
 * that is not a Land, a blank or non-string value, or a `members` that is not an array
 * throws a {@link BundesratValidationError}. Pure: the input is not changed.
 */
export function filterMembers(members: readonly Member[], filter: MemberFilter): Member[] {
  assertValid("members", members, (v) =>
    Array.isArray(v) && v.every((m) => typeof m === "object" && m !== null && !Array.isArray(m))
      ? undefined
      : "Expected an array of member objects.",
  );
  const { state, party } = assertMemberFilter(filter);
  let result = [...members];
  if (state !== undefined) {
    const needle = fold(state.trim());
    result = result.filter((m) => typeof m.state === "string" && fold(m.state) === needle);
  }
  if (party !== undefined) {
    const needle = fold(party.trim());
    result = result.filter((m) => typeof m.party === "string" && fold(m.party).includes(needle));
  }
  return result;
}

/** Options for the client (engine options only — the feeds need no auth). */
export type BundesratClientOptions = EngineOptions;

export class BundesratClient {
  private readonly engine: RequestEngine;

  constructor(options: BundesratClientOptions = {}) {
    this.engine = new RequestEngine(options);
  }

  /**
   * Fetch a feed and return its `<list>` payload as an object. The document must
   * be `<iOS><list>…</list></iOS>`; an empty `<list/>` yields `{}`. Anything else —
   * another root element (an XML error envelope, an XHTML page), no `<list>`, two
   * of them, or text in place of one — throws a BundesratParseError, so a broken
   * feed is never reported as an empty one.
   */
  private async list(path: string): Promise<XmlObject> {
    const doc = await this.engine.getXmlDocument(path, RENDER_QUERY);
    if (doc.root !== "iOS" || !isObject(doc.value)) {
      throw shapeError(path, `an <iOS> root element, got <${cutForMessage(doc.root)}>`);
    }
    const list = doc.value["list"];
    if (list === "") return {};
    if (!isObject(list)) throw shapeError(path, "exactly one <list> element under <iOS>");
    return list;
  }

  /**
   * The members of the Bundesrat (Länder ministers and plenipotentiaries),
   * projected to their factual fields (name, party, Land, membership flags).
   * The optional `filter` narrows the list by Land and/or party (see
   * {@link filterMembers}); an unknown key, a state that is not a Land or a blank
   * value rejects with a BundesratValidationError before any request.
   */
  async members(filter: MemberFilter = {}): Promise<Member[]> {
    const checked = assertMemberFilter(filter);
    const list = await this.list(FEEDS.members);
    const all = asArray<XmlValue>(list["employee"]).map((e) => pick<Member>(e, MEMBER_FIELDS));
    return filterMembers(all, checked);
  }

  /**
   * The current plenary session with its agenda items (TOP numbers and their
   * Drucksachen — the latter *amtliche Werke* under § 5 UrhG).
   */
  async session(): Promise<Session> {
    const list = await this.list(FEEDS.session);
    // The same plain-text rule as every TOP field (pick): text with attributes is
    // kept; markup, a repeat or an empty value leaves the key out.
    const { title, header } = pick<{ title?: string; header?: string }>(list, ["title", "header"]);
    return {
      ...(title !== undefined ? { title } : {}),
      ...(header !== undefined ? { header } : {}),
      tops: asArray<XmlValue>(list["top"]).map((t) => pick<AgendaItem>(t, TOP_FIELDS)),
    };
  }

  /** Committee appointments and dates (Termine), projected to their factual fields. */
  async appointments(): Promise<Appointment[]> {
    const list = await this.list(FEEDS.appointments);
    return asArray<XmlValue>(list["item"]).map((i) => pick<Appointment>(i, APPOINTMENT_FIELDS));
  }
}
