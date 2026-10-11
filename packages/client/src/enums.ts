// Closed value sets of the feeds, for validating filters before anything is fetched.

/**
 * The sixteen Länder, spelled as the members feed spells them in `<state>` (checked
 * against the live feed 2026-10-06: every one of the 193 records carries one of these).
 * Art. 51 GG fixes the Bundesrat's membership to the Länder governments, so a `state`
 * filter outside this list can only ever match nothing.
 */
export const LAENDER = [
  "Baden-Württemberg",
  "Bayern",
  "Berlin",
  "Brandenburg",
  "Bremen",
  "Hamburg",
  "Hessen",
  "Mecklenburg-Vorpommern",
  "Niedersachsen",
  "Nordrhein-Westfalen",
  "Rheinland-Pfalz",
  "Saarland",
  "Sachsen",
  "Sachsen-Anhalt",
  "Schleswig-Holstein",
  "Thüringen",
] as const;

/** One of the sixteen {@link LAENDER}. */
export type Land = (typeof LAENDER)[number];
