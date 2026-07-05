// Canned Bundesrat feed responses (XML), trimmed to what the tests assert but
// structurally faithful to the live feeds (see the DEVELOPING.md verify notes).

export const membersXml = `<?xml version="1.0"?>
<iOS version="1.0">
  <list>
    <employee>
      <honorificTitle></honorificTitle>
      <firstname>Cem</firstname>
      <name>Özdemir</name>
      <party>BÜNDNIS 90/DIE GRÜNEN</party>
      <state>Baden-Württemberg</state>
      <brmitglied>true</brmitglied>
      <mitglied>true</mitglied>
      <detail1><![CDATA[ <p><strong>Ministerpräsident</strong></p> ]]></detail1>
      <url>https://www.bundesrat.de/x/oezdemir.html</url>
    </employee>
    <employee>
      <firstname>Markus</firstname>
      <name>Söder</name>
      <party>CSU</party>
      <state>Bayern</state>
      <brmitglied>true</brmitglied>
    </employee>
  </list>
</iOS>`;

export const sessionXml = `<?xml version="1.0"?>
<iOS version="1.0">
  <list>
    <title>1067. Sitzung des Bundesrates | Tagesordnung Entwurf</title>
    <header>am Freitag, dem 10. Juli 2026, 9:30 Uhr</header>
    <top>
      <toptitle>TOP 67</toptitle>
      <topdrucksache>Drucksache 371/26</topdrucksache>
      <topheader>Ernennung von Bundesanw&#228;ltinnen</topheader>
      <linkedtop></linkedtop>
      <topdetail><![CDATA[<div class="tabinfo">A &amp; B</div>]]></topdetail>
    </top>
    <top>
      <toptitle>TOP 1</toptitle>
      <topdrucksache>Drucksache 1/26</topdrucksache>
      <topheader>Recht auf Reparatur</topheader>
    </top>
  </list>
</iOS>`;

export const newsXml = `<?xml version="1.0"?>
<iOS version="1.0">
  <list>
    <item>
      <type>Basepage</type>
      <id>/BR/SharedDocs/texte/26/x</id>
      <url>https://www.bundesrat.de/x.html</url>
      <title>Ein starkes Europa</title>
      <abstract>Bundesratspr&#228;sident Bovenschulte &#8230;</abstract>
      <date>03.07.2026 13:41</date>
    </item>
  </list>
</iOS>`;

export const compactXml = `<?xml version="1.0"?>
<iOS version="1.0">
  <list>
    <header>
      <url>https://www.bundesrat.de/1067-pk.html</url>
      <titel1>Ausgew&#228;hlte Tagesordnungspunkte</titel1>
      <titel2>1067. Sitzung des Bundesrates</titel2>
    </header>
    <tops>
      <top>
        <nr>1</nr>
        <title>Recht auf Reparatur</title>
        <subtop><type>a</type><name>N1</name></subtop>
        <subtop><type>b</type><name>N2</name></subtop>
      </top>
    </tops>
  </list>
</iOS>`;

export const singleItemXml = `<?xml version="1.0"?>
<iOS version="1.0">
  <list>
    <item>
      <type>Basepage</type>
      <title>Zusammensetzung des Bundesrates</title>
    </item>
  </list>
</iOS>`;

/** The website's HTML shell, returned when ?view=renderXml is lost. */
export const htmlShell = `<!doctype html>
<html lang="de"><head><title>Bundesrat</title></head><body>nope</body></html>`;
