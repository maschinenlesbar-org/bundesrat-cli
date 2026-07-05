// Response interfaces for the Bundesrat feeds. The feeds are XML (see xml.ts);
// each leaf element is text (or an HTML fragment in a CDATA section, kept as a
// string). The named fields below are the ones the feeds reliably carry — all are
// best-effort strings, and an index signature preserves anything else present.

import type { XmlValue, XmlObject } from "./xml.js";

export type { XmlValue, XmlObject } from "./xml.js";

/** A member of the Bundesrat (from the `<employee>` elements of the members feed). */
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
  /** HTML fragments: role / biography / address. */
  detail1?: string;
  detail2?: string;
  detail3?: string;
  url?: string;
  imagePath?: string;
  imageDate?: string;
  [key: string]: XmlValue | undefined;
}

/** One agenda item (Tagesordnungspunkt) of a plenary session (`<top>`). */
export interface AgendaItem {
  /** e.g. "TOP 67". */
  toptitle?: string;
  /** The associated Drucksache, e.g. "Drucksache 371/26". */
  topdrucksache?: string;
  /** Short description of the item. */
  topheader?: string;
  /** A cross-referenced TOP, when the item is linked to another. */
  linkedtop?: string;
  /** HTML fragment with the detailed description. */
  topdetail?: string;
  detailImgDates?: string;
  [key: string]: XmlValue | undefined;
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

/** A generic content item shared by the news / appointments / info feeds (`<item>`). */
export interface FeedItem {
  /** Content type, e.g. "Basepage" or "Event". */
  type?: string;
  id?: string;
  url?: string;
  title?: string;
  /** Teaser text. */
  abstract?: string;
  /** HTML fragment with the full content. */
  detail?: string;
  /** Publication/update timestamp, e.g. "03.07.2026 13:41" (German format). */
  date?: string;
  dateOfIssue?: string;
  /** For appointments (Termine): start/stop of the event. */
  startdate?: string;
  stopdate?: string;
  description?: string;
  highlighted?: string;
  imagePath?: string;
  imageCaption?: string;
  imageSource?: string;
  [key: string]: XmlValue | undefined;
}

/** The parsed `<list>` payload of a feed, before per-feed normalisation. */
export type FeedList = XmlObject;
