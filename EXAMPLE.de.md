# Beispiele

Echte Beispiele für die Claude-Code-Skills des Plugins `bundesrat`, eines pro Skill: eine
Anfrage, die `bundesrat`-Befehle, die der Skill ausgeführt hat, und Claudes Antwort.

Jedes Beispiel lief am 15. September 2026 mit `bundesrat` 0.0.6 gegen die Live-API.
Die Daten ändern sich, Ihre Ergebnisse werden also abweichen; mit den gezeigten IDs und
Schlüsseln können Sie die Anfragen selbst ausprobieren. Lange Listen sind gekürzt.

Zum Ausprobieren installieren Sie die CLI und das Plugin – siehe [SKILLS.md](SKILLS.md) (englisch).

Skills: [bundesrat-agenda](#bundesrat-agenda) · [bundesrat-members](#bundesrat-members)

## bundesrat-agenda

> Worüber stimmt der Bundesrat in seiner nächsten Sitzung ab, und wann tagen danach die Ausschüsse?

```bash
bundesrat --compact session | jq '{title, header, items: (.tops | length)}'   # Error: read ECONNRESET, wiederholt
bundesrat --compact session > session.json
jq '{title, header, items: (.tops | length)}' session.json
jq -r '.tops | sort_by(.toptitle | capture("TOP (?<n>[0-9]+)(?<s>[a-z]*)") | [(.n|tonumber), .s]) | .[] | "\(.toptitle)\t\(.topdrucksache // "—")\t\(.topheader)"' session.json
bundesrat --compact appointments | jq -r '.[] | "\(.startdate // "")\t\(.title)"'
```

Die erste Anfrage brach mit einem Verbindungsabbruch ab, die Wiederholung klappte. Der Feed
liefert die TOPs ungeordnet (TOP 5, TOP 10, TOP 37, TOP 2b, …). Deshalb hat der Skill sie vor
der Ausgabe nach Nummer sortiert. Der Titel lautet noch „Tagesordnung Entwurf" – die
Tagesordnung ist also ein Entwurf.

**1068. Sitzung des Bundesrates**, Freitag, 25.09.2026, 9:30 Uhr (Entwurf): 95 Punkte, jeder
mit einer Drucksache.

| Art des Punkts | TOPs | Anzahl |
|---|---|---|
| Vom Bundestag beschlossene Gesetze („Gesetz …") | 3–12 | 10 |
| Bundeshaushalt 2027: Haushaltsgesetz, Finanzplan 2026–2030, Haushaltsbegleitgesetz | 2a–2c | 3 |
| Gesetzentwürfe („Entwurf eines Gesetzes …") | 26–63 | 38 |
| Entschließungen des Bundesrates | 13–25 | 13 |
| Verordnungen und Verwaltungsvorschriften | 9b, 74–84 | 12 |
| EU-Vorlagen und Mitteilungen | 64a–73 | 11 |
| Wahlen, Benennungen, Verfahren vor dem BVerfG | 1, 85a–89 | 8 |

Einige der Punkte:
- TOP 4 – Drucksache 491/26: Gesetz zur Einführung eines antragslosen Kindergeldes
- TOP 5 – Drucksache 493/26: Sportfördergesetz (SpoFöG)
- TOP 35 – Drucksache 447/26: Entwurf eines Jahressteuergesetzes 2026
- TOP 39 – Drucksache 453/26: Entwurf eines Gesetzes zur Reform des Nachrichtendienstrechts
- TOP 62 – Drucksache 476/26: Gesetzentwurf zum Partnerschaftsabkommen EU–Mercosur vom 17.01.2026
- … 90 weitere

Ausschusstermine (20 Einträge): 14 Ausschusssitzungen vom 28.09. bis 02.10.2026. Drei davon
fallen aus: Digitales und Staatsmodernisierung („entfällt") sowie Finanzen und Städtebau
(„entfällt / Umfrageverfahren", also schriftliches Verfahren). Die nächste Plenarsitzung folgt
am **16.10.2026, 9:30 Uhr**, die Ausschüsse tagen wieder ab 02.11.2026.

Quelle: Bundesrat

Als Nächstes angeboten: die vollständige Liste aller 95 TOPs oder alle Drucksachennummern zum Nachschlagen.

## bundesrat-members

> Wie setzt sich der Bundesrat nach Parteien zusammen, und wer vertritt Thüringen?

```bash
bundesrat --compact members > members.json
jq -r 'group_by(.party)[] | "\(.[0].party): \(length)"' members.json
jq -r 'map({b:.brmitglied,m:.mitglied,bv:.bv}) | group_by(.) | .[] | "\(.[0]) \(length)"' members.json
jq -r '[.[] | select(.mitglied=="true")] | group_by(.state)[] | "\(.[0].state): \(length)"' members.json
jq -r '[.[] | select(.mitglied=="true")] | group_by(.party)[] | "\(.[0].party): \(length)"' members.json
bundesrat --compact members --state thüringen | jq -r '.[] | "\(.firstname) \(.name)\t\(.party)\t\(.mitglied)\t\(.bv)"'
```

Der Feed liefert 193 Personen: ordentliche Mitglieder, ihre Stellvertretungen und die
Bevollmächtigten der Länder. Eine Zählung nach Partei über alle (CDU 71, SPD 67, …) würde die
Kammer verzerren. Deshalb hat der Skill die Statusflags verglichen. Die 69 Einträge mit
`mitglied == "true"` ergeben pro Land genau die Stimmenverteilung im Bundesrat (je 6 für BW, BY,
NI, NW; 5 für HE; je 3 für HB, HH, MV, SL; 4 für die übrigen), und darauf beruht die Zählung.
`brmitglied == "true"` trifft auf 181 Einträge zu, Stellvertretungen eingeschlossen.

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
