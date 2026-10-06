# Beispiele

Echte Beispiele für die Claude-Code-Skills des Plugins `bundesrat`, eines pro Skill: eine
Anfrage, die `bundesrat`-Befehle, die der Skill ausgeführt hat, und Claudes Antwort.

Jedes Beispiel lief am 6. Oktober 2026 mit `bundesrat` 0.2.0 gegen die Live-API.
Die Daten ändern sich, Ihre Ergebnisse werden also abweichen; mit den gezeigten IDs und
Schlüsseln können Sie die Anfragen selbst ausprobieren. Lange Listen sind gekürzt.

Zum Ausprobieren installieren Sie die CLI und das Plugin – siehe [SKILLS.md](SKILLS.md) (englisch).

Skills: [bundesrat-agenda](#bundesrat-agenda) · [bundesrat-members](#bundesrat-members)

## bundesrat-agenda

> Worüber stimmt der Bundesrat in seiner nächsten Sitzung ab, und wann tagen danach die Ausschüsse?

```bash
bundesrat --compact session > session.json
jq '{title, header, items: (.tops | length)}' session.json
jq -r '.tops | sort_by(.toptitle // "" | capture("(?<n>\\d+)(?<s>[a-z]*)") | [(.n | tonumber), .s])[] | "\(.toptitle)\t\(.topdrucksache // "—")\t\(.topheader)"' session.json
jq -r '.tops[].topdrucksache | select(.) | split("; ")[]' session.json | wc -l
bundesrat --compact appointments > appointments.json
jq -r 'map(. + {start: ((.startdate // "" | capture("(?<d>\\d{2})\\.(?<m>\\d{2})\\.(?<y>\\d{4}) ?(?<t>[0-9:]*)") | "\(.y)-\(.m)-\(.d) \(.t)") // "")}) | sort_by(.start)[] | "\(.start)\t\(.title)\t\(.stopdate // "")"' appointments.json
```

Der Feed liefert die TOPs ungeordnet (TOP 20, TOP 48, TOP 46, TOP 53a, …). Deshalb hat der Skill
sie vor der Ausgabe nach Nummer und Buchstabe sortiert. Der Titel lautet noch „Tagesordnung
Entwurf" – die Tagesordnung ist also ein Entwurf. Zwei TOPs haben keine Drucksache (die beiden
Wahlen zu Beginn der Sitzung); keiner nennt mehr als eine, die 54 Drucksachennummern gehören
also je zu einem TOP.

**1069. Sitzung des Bundesrates**, Freitag, 16.10.2026, 9:30 Uhr (Entwurf): 56 Punkte,
54 Drucksachen.

| Art des Punkts | TOPs | Anzahl |
|---|---|---|
| Wahlen (Präsidium, Europakammer, Ausschussvorsitze, Schriftführer) | 1–4 | 4 |
| Vom Bundestag beschlossene Gesetze („Gesetz …") | 5–8 | 4 |
| Gesetzentwürfe („Entwurf …") | 9–10, 26–32 | 9 |
| Entschließungen des Bundesrates | 11–25 | 15 |
| EU-Vorlagen und Mitteilungen | 33–47 | 15 |
| Verordnungen | 48–52 | 5 |
| Benennungen für Beratungsgremien der EU | 53a–53d | 4 |

Einige der Punkte:
- TOP 5 – Drucksache 560/26: Erstes Gesetz zur Änderung des Wissenschaftsfreiheitsgesetzes
- TOP 19 – Drucksache 543/26: Entschließung zum „Recht auf Vergessenwerden" für ehemals an Krebs Erkrankte
- TOP 26 – Drucksache 505/26: Entwurf eines Startchancen- und Qualitätsentwicklungsgesetzes (SCQEG)
- TOP 28 – Drucksache 507/26: Entwurf eines Einkommensteuerreformgesetzes 2027
- TOP 47 – Drucksache 542/26: EU-Verordnungsvorschlag über erschwinglichen Wohnraum
- … 51 weitere

Ausschusstermine (18 Einträge): Die Umfrage 5/26 des Rechtsausschusses (schriftliches
Verfahren) lief vom 02.10. bis 06.10.2026, 10:00 Uhr; die Plenarsitzung folgt am 16.10.2026,
9:30 Uhr. Danach tagen 14 Ausschüsse vom 02.11. bis 06.11.2026; keine Sitzung ist als
ausgefallen („entfällt") markiert. Außerdem stehen die Jahrestagung der Parlamentarischen
Versammlung der NATO (20.–23.11.2026) und die nächste Plenarsitzung am **20.11.2026, 9:30 Uhr**
in der Liste.

Quelle: Bundesrat

Als Nächstes angeboten: die vollständige Liste aller 56 TOPs oder alle Drucksachennummern zum Nachschlagen.

## bundesrat-members

> Wie setzt sich der Bundesrat nach Parteien zusammen, und wer vertritt Thüringen?

```bash
bundesrat --compact members > members.json
jq -r 'group_by(.party)[] | "\(.[0].party): \(length)"' members.json
jq -r 'map({b:.brmitglied,m:.mitglied,bv:.bv}) | group_by(.) | .[] | "\(.[0]) \(length)"' members.json
jq -r '[.[] | select(.mitglied=="true")] | group_by(.state)[] | "\(.[0].state): \(length)"' members.json
jq -r '[.[] | select(.mitglied=="true")] | group_by(.party)[] | "\(.[0].party): \(length)"' members.json
bundesrat --compact members --state Thueringen   # exit 2: "Not a Land; expected one of …, Thüringen."
bundesrat --compact members --state thüringen | jq -r '.[] | "\(.firstname) \(.name)\t\(.party)\t\(.mitglied)\t\(.bv)"'
```

Der Feed liefert 193 Personen: ordentliche Mitglieder, ihre Stellvertretungen und die
Bevollmächtigten der Länder. Eine Zählung nach Partei über alle (CDU 71, SPD 67, …) würde die
Kammer verzerren. Deshalb hat der Skill die Statusflags verglichen. Die 69 Einträge mit
`mitglied == "true"` ergeben pro Land genau die Stimmenverteilung im Bundesrat (je 6 für BW, BY,
NI, NW; 5 für HE; je 3 für HB, HH, MV, SL; 4 für die übrigen), und darauf beruht die Zählung.
`brmitglied == "true"` trifft auf 181 Einträge zu, Stellvertretungen eingeschlossen; 12 Einträge
sind nur Bevollmächtigte. Die ASCII-Schreibweise `Thueringen` ist kein Ländername, deshalb hat
die CLI sie mit der Liste der sechzehn Länder abgelehnt; der Skill hat es mit `thüringen` erneut
ausgeführt.

Ordentliche Mitglieder (69 Sitze) nach Partei:

| Partei | Mitglieder |
|---|---|
| SPD | 25 |
| CDU | 23 |
| BÜNDNIS 90/DIE GRÜNEN | 11 |
| CSU | 4 |
| FREIE WÄHLER | 2 |
| DIE LINKE, FDP, Thüringen.Gerecht, parteilos | je 1 |

Thüringen (4 Stimmen), 11 Einträge:
- Ordentliche Mitglieder: Mario Voigt (CDU), Katja Wolf (Thüringen.Gerecht), Georg Maier (SPD), Stefan Gruhner (CDU)
- Stellvertretende Mitglieder: Christian Tischner, Colette Boos-John, Beate Meißner (CDU); Tilo Kummer, Steffen Schütz (Thüringen.Gerecht); Katharina Schenk (SPD)
- Bevollmächtigter (kein Mitglied): Stephan König (CDU)

Quelle: Bundesrat
