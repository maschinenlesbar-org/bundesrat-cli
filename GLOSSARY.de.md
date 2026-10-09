# Glossar

Fach- und technische Begriffe, denen Sie bei der Arbeit mit `bundesrat` begegnen. Die
Referenz der Optionen finden Sie in der **[README](README.md)**, das vollständige
Kochbuch in **[Usage.md](Usage.md)**.

## Der Bundesrat

**Bundesrat.** Eines der Gesetzgebungsorgane des Bundes – die Kammer, über die die
sechzehn **Länder** bei der Gesetzgebung und Verwaltung des Bundes mitwirken. Er ist
*kein* zweites Parlament aus gewählten Abgeordneten: Seine Mitglieder gehören den
Landesregierungen an.

**Land / Länder.** Ein deutsches Bundesland (Plural: Länder). Jedes Land entsendet
Mitglieder in den Bundesrat und verfügt über einen Block von **Stimmen**, gewichtet nach
Einwohnerzahl (je 3–6).

**Mitglied (`members`).** Ein Mitglied einer Landesregierung, das dem Bundesrat angehört.
Jeder Datensatz enthält `honorificTitle`, `firstname`, `name`, `party`, `state` (das
Land), eine `url` und Statusflags: `mitglied` (eines der 69 Mitglieder, je Land so viele,
wie es Stimmen hat), `brmitglied` (ein Mitglied **oder** ein *stellvertretendes Mitglied*;
181 von 193 Datensätzen am 15.09.2026), `bv` (*Bevollmächtigter*), `designiert` (benannt,
noch nicht im Amt) – alle als Strings `"true"`/`"false"`. Der Feed führt Mitglieder,
stellvertretende Mitglieder und Bevollmächtigte; filtern Sie auf `mitglied == "true"`, um
die 69 Mitglieder zu erhalten.

## Plenarsitzungen & Tagesordnung

**Plenarsitzung (`session`).** Eine Plenarsitzung des Bundesrates. Er tagt etwa alle
3–4 Wochen (rund 10-mal im Jahr). `session` liefert die aktuelle bzw. nächste Sitzung
mit ihrer Tagesordnung.

**Tagesordnung.** Die Liste der Punkte, über die eine Sitzung entscheidet. `session`
liefert sie als `tops`.

**TOP (Tagesordnungspunkt) – `top` / `tops`.** Ein einzelner Punkt der Tagesordnung. Jeder
enthält `toptitle` (z. B. „TOP 67“), `topheader` (eine kurze sachliche Bezeichnung),
`topdrucksache` (die zugehörige Drucksachennummer) und `linkedtop` (einen Querverweis).
Leere Felder entfallen, `linkedtop` erscheint also nur, wenn es gesetzt ist. Der Feed führt
die TOPs nicht in numerischer Reihenfolge. Die HTML-Beschreibung des Feeds (`topdetail`)
ist redaktioneller Inhalt und wird nicht ausgegeben.

**Drucksache (`topdrucksache`).** Ein nummeriertes Dokument, z. B. „Drucksache 371/26“ –
das Dokument, um das es in einem TOP geht (ein Gesetz, eine Verordnung, ein Antrag …).
Ein TOP zu mehreren Drucksachen nennt sie alle in einer Zeichenkette, getrennt durch „; “
(„Drucksache 343/26; Drucksache 344/26“); ein TOP ohne Drucksache (ein Verfahrenspunkt)
hat kein `topdrucksache`.
Drucksachen des Bundesrates sind *amtliche Werke* und damit gemeinfrei; mit den Nummern
können Sie das vollständige Dokument auf bundesrat.de oder im DIP nachschlagen.

**Termine (`appointments`).** Ausschusstermine und andere geplante Ereignisse (z. B.
*Umfragen* – schriftliche Verfahren der Ausschüsse nach § 43 GO BR). Ausgegeben als
sachliche Kalendereinträge (`title`, `startdate` sowie `stopdate`/`date`, wenn der Feed sie
setzt – `stopdate` oft, z. B. als Frist einer *Umfrage*). Beide Daten haben deutsches
Format mit optionaler Uhrzeit: „25.09.2026 09:30“ oder „22.09.2026“; eine abgesagte
Sitzung bleibt mit „entfällt“ im Titel in der Liste.

## Inhalte der Feeds, die diese CLI nicht ausgibt

Die Feeds der Bundesrat-App enthalten außerdem die folgenden Inhalte. Es handelt sich um
urheberrechtlich geschützte **redaktionelle Texte oder Bilder**, nicht um offene Daten.
Diese CLI bietet dafür deshalb **keinen Befehl** und entfernt deren redaktionelle Felder,
wo sie in einem ausgegebenen Feed vorkommen (siehe [DATA_LICENSE.md](DATA_LICENSE.md)):

- **Stimmverteilung** – die Verteilung der 69 Stimmen im Bundesrat auf die Länder. Der
  Feed ist im Wesentlichen die offizielle **Grafik** der Zusammensetzung (ein Bild), ohne
  strukturierte Stimmentabelle je Land.
- **Präsidium** – das leitende Gremium des Bundesrates (Präsident:in – ein:e
  Ministerpräsident:in, jährlich wechselnd – und Vizepräsident:innen). Der Feed ist eine
  HTML-Seite samt Foto.
- **BundesratKOMPAKT** – eine redaktionelle Zusammenfassung ausgewählter
  Tagesordnungspunkte mit geschriebenen Kurztexten.
- **Aktuelles** – Presse- und Nachrichtenbeiträge (redaktioneller Text + Pressebilder).
- **Anstehende Plenarsitzungen** – die Seite mit den kommenden Sitzungen; die Termine
  stehen in einem urheberrechtlich geschützten HTML-Fragment, ohne strukturierte
  Datumsfelder.

## Daten & Format

**Feed.** Jeder Befehl entspricht einem XML-Feed von `www.bundesrat.de` – den Daten hinter
der offiziellen iOS-App des Bundesrates. Eine JSON-API gibt es nicht; diese CLI wandelt
das XML für Sie in JSON um und reduziert jedes Ergebnis auf seine offen lizenzierten,
sachlichen Felder.

**`?view=renderXml`.** Der Render-Parameter, mit dem das CMS den **XML-Feed** statt der
**HTML-Seite** der Website liefert. Die CLI ergänzt ihn automatisch; ein Fehler
„received an HTML page“ bedeutet, dass er verloren gegangen ist oder der Feed umgezogen
ist (siehe [DEVELOPING.md](DEVELOPING.md)).

**Redaktionelle Felder (nicht ausgegeben).** Die rohen Feeds enthalten HTML-Fragmente in
CDATA – `detail`, `abstract`, `topdetail`, das Biografie-Feld `detail` der Mitglieder
(Funktion / Lebenslauf / Adresse) – sowie Bildpfade. Das sind urheberrechtlich geschützte
redaktionelle Inhalte, daher **entfernt** die CLI sie; nur sachliche Felder gelangen in
die Ausgabe.

**amtliches Werk (§ 5 UrhG).** Ein amtliches Werk – Gesetze, Verordnungen und hier die
Drucksachen/Plenarprotokolle des Bundesrates – genießt **keinen Urheberrechtsschutz** und
darf daher frei weiterverwendet werden, sofern es **unverändert** bleibt (§ 62) und
**mit Quellenangabe** erscheint (§ 63). Die übrigen Inhalte der Website sind
urheberrechtlich geschützt. Siehe [DATA_LICENSE.md](DATA_LICENSE.md).

## CLI / Technik

**Exit-Codes.** `0` Erfolg · `2` Bedienfehler · `4` nicht gefunden · `6` Netzwerkfehler ·
`1` Sonstiges (inkl. einer Nicht-XML-Antwort bzw. HTML-Hülle). Siehe
[Usage.md](Usage.md#exit-codes).

**Log-Eintrag (log record).** Jede Diagnosezeile, die die CLI nach stderr schreibt: ein
Zeitstempel, eine Stufe (`ERROR`, `WARN`, `INFO`) und ein Thema `bundesrat.<Bereich>`, als
Text (im Stil von log4j) oder mit `--log-format jsonl` als ein JSON-Objekt pro Zeile. Die
Bereiche: `cli` (Bedienfehler, Meldungen von commander, unerwartete Fehler, der Hinweis
bei leerem `--party`-Ergebnis), `api` (die Antworten des Feed-Servers: ein Fehlerstatus
und eine fehlerhafte Antwort — ein Feed, der sich nicht parsen lässt, die HTML-Hülle, die
falsche Form, ein leerer Body), `http` (die Verbindung, die Klartext-Warnung und je Wiederholung eine WARN-Zeile vor dem Warten) und `output`
(die `-o`-Datei, Schreibfehler auf stdout). Ein Eintrag ist immer eine Zeile; Steuerzeichen
darin werden maskiert.

**`--state` vs. `--party`.** `--state` nennt eines der **sechzehn Länder** und passt
**exakt** darauf (ohne Beachtung der Groß-/Kleinschreibung); jeder andere Wert
(`Thueringen`, `Bay`) ist ein Bedienfehler, der die sechzehn Namen aufzählt. `--party`
passt auf eine **Teilzeichenkette** des Parteinamens (ebenfalls ohne Beachtung der
Groß-/Kleinschreibung), sodass `grüne` „BÜNDNIS 90/DIE GRÜNEN“ findet; passt sie auf
niemanden, kommt `[]` mit einem Hinweis auf stderr. Beide ignorieren umgebende Leerzeichen und die
Unicode-Form (ein zerlegter Umlaut passt auch), und ein leerer Wert ist ein Bedienfehler.
Angewendet werden sie von der Bibliothek, nachdem die vollständige Mitgliederliste
abgerufen wurde: `members({ state, party })`, oder `filterMembers(liste, { state, party })`
auf einer bereits abgerufenen Liste.
