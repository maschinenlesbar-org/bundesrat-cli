# Examples

Real examples for the Claude Code skills of the `bundesrat` plugin, one per skill: a request,
the `bundesrat` commands the skill ran, and the answer Claude gave.

Every example ran against the live API on 6 October 2026 with `bundesrat` 0.2.0.
The data changes, so your results will differ; the ids and keys shown work for trying the
requests yourself. Long lists are shortened.

To try them, install the CLI and the plugin — see [SKILLS.md](SKILLS.md).

Skills: [bundesrat-agenda](#bundesrat-agenda) · [bundesrat-members](#bundesrat-members)

## bundesrat-agenda

> What is the Bundesrat voting on at its next sitting, and when do the committees meet after that?

```bash
bundesrat --compact session > session.json
jq '{title, header, items: (.tops | length)}' session.json
jq -r '.tops | sort_by(.toptitle // "" | capture("(?<n>\\d+)(?<s>[a-z]*)") | [(.n | tonumber), .s])[] | "\(.toptitle)\t\(.topdrucksache // "—")\t\(.topheader)"' session.json
jq -r '.tops[].topdrucksache | select(.) | split("; ")[]' session.json | wc -l
bundesrat --compact appointments > appointments.json
jq -r 'map(. + {start: ((.startdate // "" | capture("(?<d>\\d{2})\\.(?<m>\\d{2})\\.(?<y>\\d{4}) ?(?<t>[0-9:]*)") | "\(.y)-\(.m)-\(.d) \(.t)") // "")}) | sort_by(.start)[] | "\(.start)\t\(.title)\t\(.stopdate // "")"' appointments.json
```

The feed lists the TOPs out of order (TOP 20, TOP 48, TOP 46, TOP 53a, …), so the skill sorted
them by number and letter before reporting. The title still says "Tagesordnung Entwurf", so the
agenda is a draft. Two TOPs have no Drucksache (the two elections that open the sitting); none
lists more than one, so the 54 Drucksache numbers are one per TOP.

**1069. Sitzung des Bundesrates**, Friday 16 October 2026, 9:30 (draft agenda): 56 items,
54 Drucksachen.

| Kind of item | TOPs | Count |
|---|---|---|
| Elections (Präsidium, Europakammer, committee chairs, Schriftführer) | 1–4 | 4 |
| Laws passed by the Bundestag ("Gesetz …") | 5–8 | 4 |
| Draft laws ("Entwurf …") | 9–10, 26–32 | 9 |
| Bundesrat resolutions (Entschließungen) | 11–25 | 15 |
| EU proposals and communications | 33–47 | 15 |
| Ordinances | 48–52 | 5 |
| Nominations to EU advisory bodies | 53a–53d | 4 |

Some of the items:
- TOP 5 — Drucksache 560/26: Erstes Gesetz zur Änderung des Wissenschaftsfreiheitsgesetzes
- TOP 19 — Drucksache 543/26: resolution on a "right to be forgotten" for former cancer patients
- TOP 26 — Drucksache 505/26: Entwurf eines Startchancen- und Qualitätsentwicklungsgesetzes (SCQEG)
- TOP 28 — Drucksache 507/26: Entwurf eines Einkommensteuerreformgesetzes 2027
- TOP 47 — Drucksache 542/26: EU proposal for a regulation on affordable housing
- … 51 more

Committee dates (18 listed): the Rechtsausschuss's written poll (Umfrage 5/26) ran from 02.10.
to 06.10.2026, 10:00; the plenary sitting follows on 16.10.2026, 9:30. After it, 14 committees
meet from 02.11. to 06.11.2026; none is marked cancelled ("entfällt"). Also listed: the NATO
Parliamentary Assembly's annual session (20.–23.11.2026) and the next plenary sitting on
**20.11.2026, 9:30**.

Quelle: Bundesrat

Next steps offered: the full list of all 56 TOPs, or every Drucksache number for a follow-up lookup.

## bundesrat-members

> How is the Bundesrat made up by party, and who represents Thüringen?

```bash
bundesrat --compact members > members.json
jq -r 'group_by(.party)[] | "\(.[0].party): \(length)"' members.json
jq -r 'map({b:.brmitglied,m:.mitglied,bv:.bv}) | group_by(.) | .[] | "\(.[0]) \(length)"' members.json
jq -r '[.[] | select(.mitglied=="true")] | group_by(.state)[] | "\(.[0].state): \(length)"' members.json
jq -r '[.[] | select(.mitglied=="true")] | group_by(.party)[] | "\(.[0].party): \(length)"' members.json
bundesrat --compact members --state Thueringen   # exit 2: "Not a Land; expected one of …, Thüringen."
bundesrat --compact members --state thüringen | jq -r '.[] | "\(.firstname) \(.name)\t\(.party)\t\(.mitglied)\t\(.bv)"'
```

The feed returns 193 people: full members, their deputies and the Länder plenipotentiaries.
Counting by party over all of them (CDU 71, SPD 67, …) would overstate the chamber. So the skill
compared the status flags. The 69 records with `mitglied == "true"` add up per Land to the
Bundesrat's seat split (6 each for BW, BY, NI, NW; 5 for HE; 3 each for HB, HH, MV, SL; 4 for
the rest), and the count used those. `brmitglied == "true"` covers 181 records, deputies included;
12 records are plenipotentiaries only. The ASCII spelling `Thueringen` is not a Land name, so
the CLI refused it with the list of the sixteen; the skill ran again with `thüringen`.

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
