# Glossary

Domain and technical terms you meet when using `bundesrat`. For the option
reference see the **[README](README.md)** and the full cookbook in
**[Usage.md](Usage.md)**.

## The Bundesrat

**Bundesrat.** One of Germany's federal legislative bodies — the chamber through
which the sixteen **Länder** (federal states) take part in legislation and
administration at the federal level. It is *not* a second parliament of elected
MPs: its members are members of the Länder governments.

**Land / Länder.** A German federal state (plural Länder). Each Land sends members
to the Bundesrat and holds a bloc of **votes** weighted by population (3–6 each).

**Member (`members`).** A member of a Land government who sits in the Bundesrat.
Each record carries `firstname`, `name`, `party`, `state` (the Land), and status
flags: `brmitglied` (a voting Bundesrat member), `mitglied`, `bv`
(*Bevollmächtigter* — plenipotentiary), `designiert` (designated, not yet in
office) — all as `"true"`/`"false"` strings.

**Präsidium (`presidium`).** The Bundesrat's presiding body: the President
(a Land premier, rotating yearly) and Vice-Presidents.

**Stimmverteilung / composition (`composition`).** The distribution of the 69
Bundesrat votes across the Länder (and, informally, how the current Land
governments line up). The feed centres on the official composition graphic.

## Plenary sittings & agenda

**Plenarsitzung / session (`session`, `next`).** A plenary sitting of the
Bundesrat. It meets roughly every 3–4 weeks (~10 times a year). `session` is the
current/next sitting with its agenda; `next` is the *Anstehende Plenarsitzungen*
page — the upcoming dates are inside the HTML `detail` field, not separate columns.

**Tagesordnung / agenda.** The list of items a sitting will decide. `session`
returns it as `tops`.

**TOP (Tagesordnungspunkt) — `top` / `tops`.** A single agenda item. Each carries
`toptitle` (e.g. "TOP 67"), `topheader` (a short description), `topdrucksache`
(the associated document), and `topdetail` (an HTML fragment with the full text).

**Drucksache (`topdrucksache`).** A numbered printed paper, e.g. "Drucksache
371/26" — the document a TOP is about (a bill, regulation, motion, …). Bundesrat
Drucksachen are *amtliche Werke* (public-domain official works); the numbers let
you look the full document up on bundesrat.de or in DIP.

**BundesratKOMPAKT (`compact`).** An editorial round-up of **selected** agenda
items with short summaries — a curated subset of the full agenda, nested as
`header` + `tops` (each with `subtop`s).

**Termine / appointments (`appointments`).** Committee dates and other scheduled
events (e.g. *Umfragen* — written committee polls under § 43 GO BR).

**Aktuelles / news (`news`).** Current press and news items from the Bundesrat.

## Data & format

**Feed.** Each command maps to one XML feed served by `www.bundesrat.de` — the
data behind the official Bundesrat iOS app. There is no JSON API; this CLI parses
the XML into JSON for you.

**`?view=renderXml`.** The render parameter that makes the CMS return the **XML
feed** rather than the website's **HTML page**. The CLI adds it automatically; a
"received an HTML page" error means it was lost or the feed moved (see
[DEVELOPING.md](DEVELOPING.md)).

**CDATA / `detail` fields.** Several fields (`detail`, `abstract`, `topdetail`,
`detail1`–`detail3`) hold **HTML fragments** embedded verbatim in the XML (CDATA).
They are passed through unchanged — decode/strip them as your use case needs.

**amtliches Werk (§ 5 UrhG).** An "official work" — laws, regulations, and here the
Bundesrat's Drucksachen/Plenarprotokolle — which carries **no copyright**, so it
may be reused freely if left **unaltered** (§ 62) and **with a source citation**
(§ 63). The rest of the website content is copyright-protected. See
[DATA_LICENSE.md](DATA_LICENSE.md).

## CLI / technical

**Exit codes.** `0` success · `2` usage error · `4` not found · `6` network
failure · `1` other (incl. a non-XML/HTML-shell response). See
[Usage.md](Usage.md#exit-codes).

**`--state` vs `--party`.** `--state` matches a Land **exactly** (case-insensitive);
`--party` matches a **substring** of the party name (case-insensitive), so `grüne`
finds "BÜNDNIS 90/DIE GRÜNEN". Both are applied client-side after fetching the full
members list.
