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
//   await c.appointments();  // committee appointments / dates (Termine)

import { RequestEngine, type EngineOptions } from "./engine.js";
import type { XmlObject, XmlValue } from "./xml.js";
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
 * Project a parsed element down to a whitelist of open, factual keys — dropping
 * every copyright-protected editorial/image field. Only defined keys are copied,
 * so absent fields simply don't appear.
 */
function pick<T>(obj: XmlValue, keys: readonly string[]): T {
  const src = (typeof obj === "object" && obj !== null && !Array.isArray(obj) ? obj : {}) as XmlObject;
  const out: Record<string, XmlValue> = {};
  for (const key of keys) {
    const value = src[key];
    if (value !== undefined) out[key] = value;
  }
  return out as unknown as T;
}

/** Options for the client (engine options only — the feeds need no auth). */
export type BundesratClientOptions = EngineOptions;

export class BundesratClient {
  private readonly engine: RequestEngine;

  constructor(options: BundesratClientOptions = {}) {
    this.engine = new RequestEngine(options);
  }

  /**
   * Fetch a feed and return its `<list>` payload as an object. The document root
   * is `<iOS><list>…</list></iOS>`; a feed with no `<list>` yields `{}`.
   */
  private async list(path: string): Promise<XmlObject> {
    const doc = await this.engine.getXml(path, RENDER_QUERY);
    const root = (typeof doc === "object" && !Array.isArray(doc) ? doc : {}) as XmlObject;
    const list = root["list"];
    return (typeof list === "object" && !Array.isArray(list) ? list : {}) as XmlObject;
  }

  /**
   * The members of the Bundesrat (Länder ministers and plenipotentiaries),
   * projected to their factual fields (name, party, Land, membership flags).
   */
  async members(): Promise<Member[]> {
    const list = await this.list(FEEDS.members);
    return asArray<XmlValue>(list["employee"]).map((e) => pick<Member>(e, MEMBER_FIELDS));
  }

  /**
   * The current plenary session with its agenda items (TOP numbers and their
   * Drucksachen — the latter *amtliche Werke* under § 5 UrhG).
   */
  async session(): Promise<Session> {
    const list = await this.list(FEEDS.session);
    return {
      ...(typeof list["title"] === "string" ? { title: list["title"] } : {}),
      ...(typeof list["header"] === "string" ? { header: list["header"] } : {}),
      tops: asArray<XmlValue>(list["top"]).map((t) => pick<AgendaItem>(t, TOP_FIELDS)),
    };
  }

  /** Committee appointments and dates (Termine), projected to their factual fields. */
  async appointments(): Promise<Appointment[]> {
    const list = await this.list(FEEDS.appointments);
    return asArray<XmlValue>(list["item"]).map((i) => pick<Appointment>(i, APPOINTMENT_FIELDS));
  }
}
