# Data license

> **This tool does not include, host, or redistribute any data.**
> `bundesrat-cli` is a *client*. It only accesses data served live by the
> **Bundesrat** via its public app feeds. That data is the Bundesrat's and is
> governed by **their** terms, summarized below. The license of this CLI's own
> source code is a separate matter — see [LICENSING.md](LICENSING.md).

| | |
|---|---|
| **Data provider** | Bundesrat (Sekretariat des Bundesrates) |
| **API / source** | `https://www.bundesrat.de` app feeds (the data behind the official Bundesrat iOS app) · docs: https://bundesrat.api.bund.dev |
| **Data license** | **Proprietary / restricted — no open licence.** Website content (texts, images) is copyright-protected. |
| **Attribution** | **Required** — cite "Bundesrat" as the source. |
| **Personal use** | Permitted (download / print). |
| **Commercial use & redistribution** | **Generally not permitted without explicit permission** from the Bundesrat or the named rights-holders. |

## The important exception: official documents

The Bundesrat's **Drucksachen** and **Plenarprotokolle** are *amtliche Werke*
under **§ 5 Abs. 2 UrhG** and therefore enjoy **no copyright protection**. They may
be reused freely, subject to:

- **§ 62 UrhG** — the prohibition on alteration (*Änderungsverbot*): reproduce them
  unchanged; and
- **§ 63 UrhG** — the requirement to cite the source (*Quellenangabe*).

This CLI surfaces the **Drucksache numbers** attached to a session's agenda items
(`session` → `topdrucksache`, e.g. "Drucksache 371/26"); the documents themselves
live on `bundesrat.de` and in DIP.

## What the feeds actually return

- **Factual / structured fields** — session titles and dates, TOP numbers,
  Drucksache numbers, member names, parties and Länder — are largely facts you can
  work with, but package them with a "Quelle: Bundesrat" citation.
- **Editorial texts** — the HTML in `detail`/`abstract` fields (news items, member
  biographies, TOP descriptions) and any **images** are copyright-protected
  content: personal use is fine; any publication or commercial reuse needs the
  Bundesrat's permission. **Press images** may be used for parliamentary reporting
  with the credit "Bundesrat/<photographer or agency>", but not for advertising.

## Notes & caveats

- No warranty for accuracy, completeness or availability; the feeds are the app's
  live data and can change without notice.
- When in doubt about anything beyond personal use, ask the Bundesrat first — the
  default here is "permission required", not "open".

## Sources

- https://www.bundesrat.de/DE/service-navi/impressum/impressum-node.html — Impressum / Urheberrecht
- https://www.bundesrat.de/DE/presse/pressebilder/nutzungsbedingungen/nutzungsbedingungen-node.html — press-image terms
- §§ 5 (2), 62, 63 UrhG (Gesetz über Urheberrecht und verwandte Schutzrechte)

---

*Good-faith summary compiled 2026-07-06; not legal advice. The provider's terms
are authoritative and can change — verify at the source before relying on the
data, especially for any commercial or redistribution use.*
