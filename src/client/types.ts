// Response interfaces for the Bundesrat feeds. The feeds are XML (see xml.ts);
// each leaf element is text (or an HTML fragment in a CDATA section).
//
// This client deliberately surfaces **only openly-licensed data** — factual /
// structured fields (names, parties, Länder, session titles/dates, TOP numbers,
// Drucksache numbers, appointment dates) and references to official documents.
// The feeds' copyright-protected editorial content — HTML `detail`/biography
// fragments, teaser `abstract`s, and images — is projected out in the client and
// is intentionally absent from these types. See DATA_LICENSE.md for why.

import type { XmlObject } from "./xml.js";

export type { XmlValue, XmlObject } from "./xml.js";

/**
 * A member of the Bundesrat (from the `<employee>` elements of the members feed).
 * Factual fields only; the feed's HTML biography (`detail`) and portrait image
 * (`imagePath`) are copyright-protected editorial content and are not surfaced.
 */
export interface Member {
  /** e.g. "Dr." (often empty). */
  honorificTitle?: string;
  firstname?: string;
  name?: string;
  /** Party, e.g. "BÜNDNIS 90/DIE GRÜNEN". */
  party?: string;
  /** Federal state (Land), e.g. "Baden-Württemberg". */
  state?: string;
  /** "true"/"false": whether the person is a voting Bundesrat member. */
  brmitglied?: string;
  /** "true"/"false": whether the person is a (regular) member. */
  mitglied?: string;
  /** "true"/"false": whether the person is a plenipotentiary (Bevollmächtigter). */
  bv?: string;
  /** "true"/"false": whether the membership is designated (not yet in office). */
  designiert?: string;
  /** Link to the member's page on bundesrat.de (a reference, not content). */
  url?: string;
}

/**
 * One agenda item (Tagesordnungspunkt) of a plenary session (`<top>`). Factual
 * fields only; the feed's HTML `topdetail` description is editorial content and is
 * not surfaced.
 */
export interface AgendaItem {
  /** e.g. "TOP 67". */
  toptitle?: string;
  /** The associated Drucksache, e.g. "Drucksache 371/26" (an *amtliches Werk*). */
  topdrucksache?: string;
  /** Short factual label of the item. */
  topheader?: string;
  /** A cross-referenced TOP, when the item is linked to another. */
  linkedtop?: string;
}

/** A plenary session with its agenda (from the current-session feed). */
export interface Session {
  /** e.g. "1067. Sitzung des Bundesrates | Tagesordnung Entwurf". */
  title?: string;
  /** e.g. "am Freitag, dem 10. Juli 2026, 9:30 Uhr". */
  header?: string;
  /** The agenda items (Tagesordnungspunkte). */
  tops: AgendaItem[];
}

/**
 * A committee appointment / date from the appointments (Termine) feed (`<item>`).
 * Factual calendar fields only; the item's HTML `detail`/`abstract` body and any
 * image are editorial content and are not surfaced.
 */
export interface Appointment {
  /** Content type, e.g. "Event". */
  type?: string;
  id?: string;
  /** Link to the item on bundesrat.de (a reference, not content). */
  url?: string;
  title?: string;
  /** Publication/update timestamp, e.g. "03.07.2026 13:41" (German format). */
  date?: string;
  dateOfIssue?: string;
  /** Start/stop of the event. */
  startdate?: string;
  stopdate?: string;
  highlighted?: string;
}

/** The parsed `<list>` payload of a feed, before per-feed normalisation. */
export type FeedList = XmlObject;
