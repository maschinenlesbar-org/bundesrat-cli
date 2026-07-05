// BundesratClient — a typed client over the Bundesrat's public data feeds (the
// data behind the official Bundesrat iOS app). No auth. Every feed is an XML
// document served by www.bundesrat.de; each `.xml` path must carry the
// `?view=renderXml` render parameter, which this client always adds.
//
//   const c = new BundesratClient();
//   await c.session();      // the current plenary sitting's agenda (TOPs + Drucksachen)
//   await c.members();      // the members of the Bundesrat
//   await c.composition();  // the Stimmverteilung composition-graphic page

import { RequestEngine, type EngineOptions } from "./engine.js";
import type { XmlObject, XmlValue } from "./xml.js";
import type { AgendaItem, FeedItem, FeedList, Member, Session } from "./types.js";

/** The feed paths (relative to the base URL). All are GET + `?view=renderXml`. */
export const FEEDS = {
  news: "/iOS/v3/01_Aktuelles/aktuelles_table.xml",
  appointments: "/iOS/v3/02_Termine/termine_table.xml",
  compact: "/iOS/v3/03_Plenum/plenum_kompakt_table.xml",
  session: "/iOS/SharedDocs/3_Plenum/plenum_aktuelleSitzung_table.xml",
  nextSessions: "/iOS/SharedDocs/3_Plenum/plenum_naechsteSitzungen.xml",
  members: "/iOS/SharedDocs/2_Mitglieder/mitglieder_table.xml",
  composition: "/iOS/v3/06_Stimmen/stimmverteilung.xml",
  presidium: "/iOS/v3/05_Bundesrat/Praesidium/bundesrat_praesidium.xml",
} as const;

const RENDER_QUERY = { view: "renderXml" } as const;

/**
 * Coerce a possibly-single / possibly-missing XML child into an array. A repeated
 * element parses to an array, a single occurrence to one object, and a missing one
 * to `undefined`; this normalises all three so callers always get a list.
 */
export function asArray<T>(value: XmlValue | undefined): T[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]) as unknown as T[];
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
  private async list(path: string): Promise<FeedList> {
    const doc = await this.engine.getXml(path, RENDER_QUERY);
    const root = (typeof doc === "object" && !Array.isArray(doc) ? doc : {}) as XmlObject;
    const list = root["list"];
    return (typeof list === "object" && !Array.isArray(list) ? list : {}) as FeedList;
  }

  /** The members of the Bundesrat (Länder ministers and plenipotentiaries). */
  async members(): Promise<Member[]> {
    const list = await this.list(FEEDS.members);
    return asArray<Member>(list["employee"]);
  }

  /** The current plenary session with its agenda items (TOPs and their Drucksachen). */
  async session(): Promise<Session> {
    const list = await this.list(FEEDS.session);
    return {
      ...(typeof list["title"] === "string" ? { title: list["title"] } : {}),
      ...(typeof list["header"] === "string" ? { header: list["header"] } : {}),
      tops: asArray<AgendaItem>(list["top"]),
    };
  }

  /**
   * Upcoming plenary sittings — the "Anstehende Plenarsitzungen" item. The actual
   * dates are inside its HTML `detail` fragment, not in structured fields.
   */
  async nextSessions(): Promise<FeedItem[]> {
    const list = await this.list(FEEDS.nextSessions);
    return asArray<FeedItem>(list["item"]);
  }

  /** "BundesratKOMPAKT" — selected agenda items with summaries (nested structure). */
  async compact(): Promise<FeedList> {
    return this.list(FEEDS.compact);
  }

  /**
   * The Bundesrat composition page (Stimmverteilung) — a reference to the
   * composition graphic, not a structured per-Land vote table.
   */
  async composition(): Promise<FeedItem[]> {
    const list = await this.list(FEEDS.composition);
    return asArray<FeedItem>(list["item"]);
  }

  /** The Präsidium of the Bundesrat. */
  async presidium(): Promise<FeedItem[]> {
    const list = await this.list(FEEDS.presidium);
    return asArray<FeedItem>(list["item"]);
  }

  /** Current news / press items (Aktuelles). */
  async news(): Promise<FeedItem[]> {
    const list = await this.list(FEEDS.news);
    return asArray<FeedItem>(list["item"]);
  }

  /** Committee appointments and dates (Termine). */
  async appointments(): Promise<FeedItem[]> {
    const list = await this.list(FEEDS.appointments);
    return asArray<FeedItem>(list["item"]);
  }
}
