# Examples

Real examples for the Claude Code skills of the `bundesrat` plugin, one per skill: a request,
the `bundesrat` commands the skill ran, and the answer Claude gave.

Every example ran against the live API on 15 September 2026 with `bundesrat` 0.0.6.
The data changes, so your results will differ; the ids and keys shown work for trying the
requests yourself. Long lists are shortened.

To try them, install the CLI and the plugin — see [SKILLS.md](SKILLS.md).

Skills: [bundesrat-agenda](#bundesrat-agenda) · [bundesrat-members](#bundesrat-members)

## bundesrat-agenda

> What is the Bundesrat voting on at its next sitting, and when do the committees meet after that?

```bash
bundesrat --compact session | jq '{title, header, items: (.tops | length)}'   # Error: read ECONNRESET, retried
bundesrat --compact session > session.json
jq '{title, header, items: (.tops | length)}' session.json
jq -r '.tops | sort_by(.toptitle | capture("TOP (?<n>[0-9]+)(?<s>[a-z]*)") | [(.n|tonumber), .s]) | .[] | "\(.toptitle)\t\(.topdrucksache // "—")\t\(.topheader)"' session.json
bundesrat --compact appointments | jq -r '.[] | "\(.startdate // "")\t\(.title)"'
```

The first request hit a connection reset and went through on the retry. The feed lists the
TOPs out of order (TOP 5, TOP 10, TOP 37, TOP 2b, …), so the skill sorted them by number
before reporting. The title still says "Tagesordnung Entwurf", so the agenda is a draft.

**1068. Sitzung des Bundesrates**, Friday 25 September 2026, 9:30 (draft agenda): 95 items,
each with a Drucksache.

| Kind of item | TOPs | Count |
|---|---|---|
| Laws passed by the Bundestag ("Gesetz …") | 3–12 | 10 |
| Federal budget 2027: Haushaltsgesetz, Finanzplan 2026–2030, Haushaltsbegleitgesetz | 2a–2c | 3 |
| Draft laws ("Entwurf eines Gesetzes …") | 26–63 | 38 |
| Bundesrat resolutions (Entschließungen) | 13–25 | 13 |
| Ordinances and administrative rules | 9b, 74–84 | 12 |
| EU proposals and communications | 64a–73 | 11 |
| Elections, nominations, BVerfG proceedings | 1, 85a–89 | 8 |

Some of the items:
- TOP 4 — Drucksache 491/26: Gesetz zur Einführung eines antragslosen Kindergeldes
- TOP 5 — Drucksache 493/26: Sportfördergesetz (SpoFöG)
- TOP 35 — Drucksache 447/26: Entwurf eines Jahressteuergesetzes 2026
- TOP 39 — Drucksache 453/26: Entwurf eines Gesetzes zur Reform des Nachrichtendienstrechts
- TOP 62 — Drucksache 476/26: draft law ratifying the EU–Mercosur partnership agreement of 17 January 2026
- … 90 more

Committee dates (20 listed): 14 committee meetings from 28.09. to 02.10.2026. Three of them are
cancelled: Digitales und Staatsmodernisierung ("entfällt"), and Finanzen and Städtebau
("entfällt / Umfrageverfahren", decided by written procedure). The next plenary sitting follows
on **16.10.2026, 9:30**, and the committees meet again from 02.11.2026.

Quelle: Bundesrat

Next steps offered: the full list of all 95 TOPs, or every Drucksache number for a follow-up lookup.

## bundesrat-members

> How is the Bundesrat made up by party, and who represents Thüringen?

```bash
bundesrat --compact members > members.json
jq -r 'group_by(.party)[] | "\(.[0].party): \(length)"' members.json
jq -r 'map({b:.brmitglied,m:.mitglied,bv:.bv}) | group_by(.) | .[] | "\(.[0]) \(length)"' members.json
jq -r '[.[] | select(.mitglied=="true")] | group_by(.state)[] | "\(.[0].state): \(length)"' members.json
jq -r '[.[] | select(.mitglied=="true")] | group_by(.party)[] | "\(.[0].party): \(length)"' members.json
bundesrat --compact members --state thüringen | jq -r '.[] | "\(.firstname) \(.name)\t\(.party)\t\(.mitglied)\t\(.bv)"'
```

The feed returns 193 people: full members, their deputies and the Länder plenipotentiaries.
Counting by party over all of them (CDU 71, SPD 67, …) would overstate the chamber. So the skill
compared the status flags. The 69 records with `mitglied == "true"` add up per Land to the
Bundesrat's seat split (6 each for BW, BY, NI, NW; 5 for HE; 3 each for HB, HH, MV, SL; 4 for
the rest), and the count used those. `brmitglied == "true"` covers 181 records, deputies included.

Full members (69 seats), by party:

| Party | Members |
|---|---|
| SPD | 25 |
| CDU | 23 |
| BÜNDNIS 90/DIE GRÜNEN | 11 |
| CSU | 4 |
| FREIE WÄHLER | 2 |
| DIE LINKE, FDP, Thüringen.Gerecht, parteilos | 1 each |

Thüringen (4 votes), 11 records:
- Full members: Mario Voigt (CDU), Katja Wolf (Thüringen.Gerecht), Georg Maier (SPD), Stefan Gruhner (CDU)
- Deputies: Christian Tischner, Colette Boos-John, Beate Meißner (CDU); Tilo Kummer, Steffen Schütz (Thüringen.Gerecht); Katharina Schenk (SPD)
- Plenipotentiary (not a member): Stephan König (CDU)

Quelle: Bundesrat
