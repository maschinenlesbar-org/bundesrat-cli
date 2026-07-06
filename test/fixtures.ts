// Canned Bundesrat feed responses (XML), trimmed to what the tests assert but
// structurally faithful to the live feeds (see the DEVELOPING.md verify notes).
//
// The members/session/appointments fixtures deliberately include the feeds'
// copyright-protected editorial/image fields (detail, topdetail, imagePath,
// abstract) so the client tests can assert those are projected OUT of the
// surfaced output, leaving only openly-licensed factual fields (DATA_LICENSE.md).

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
      <detail><![CDATA[ <p><strong>Ministerpräsident</strong></p> ]]></detail>
      <imagePath>/iOS/Bilder/oezdemir.jpg</imagePath>
      <imageDate>2025-01-01</imageDate>
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
      <detailImgDates>2026-07-01</detailImgDates>
    </top>
    <top>
      <toptitle>TOP 1</toptitle>
      <topdrucksache>Drucksache 1/26</topdrucksache>
      <topheader>Recht auf Reparatur</topheader>
    </top>
  </list>
</iOS>`;

export const appointmentsXml = `<?xml version="1.0"?>
<iOS version="1.0">
  <list>
    <item>
      <type>Event</type>
      <id>/BR/termine/26/x</id>
      <url>https://www.bundesrat.de/termin.html</url>
      <title>Sitzung des Vermittlungsausschusses</title>
      <startdate>2026-07-15 14:00</startdate>
      <stopdate>2026-07-15 16:00</stopdate>
      <date>03.07.2026 13:41</date>
      <abstract>Der Vermittlungsausschuss ber&#228;t &#8230;</abstract>
      <detail><![CDATA[<p>Editorial <strong>HTML</strong> body</p>]]></detail>
      <imagePath>/iOS/Bilder/termin.jpg</imagePath>
      <imageCaption>Foto: Bundesrat</imageCaption>
    </item>
  </list>
</iOS>`;

/** Generic nested/repeated structure — exercises the XML parser (not a feed). */
export const nestedXml = `<?xml version="1.0"?>
<iOS version="1.0">
  <list>
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

/** The website's HTML shell, returned when ?view=renderXml is lost. */
export const htmlShell = `<!doctype html>
<html lang="de"><head><title>Bundesrat</title></head><body>nope</body></html>`;
