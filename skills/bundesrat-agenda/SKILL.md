---
name: bundesrat-agenda
description: >
  Show what is on the Bundesrat's plenary agenda and its committee dates, using the
  bundesrat-cli. Trigger when the user asks "what is on the Bundesrat's agenda?",
  "which Drucksachen is the Bundesrat voting on this week?", "how many items are on
  the current Tagesordnung?", "what committee dates are coming up?", or wants the
  agenda items (TOPs) of the current plenary sitting with their Drucksachen.
version: 2.0.0
userInvocable: true
---

# Bundesrat Agenda

The Bundesrat (Germany's chamber of the sixteen Länder) meets in plenary roughly
every 3–4 weeks. This skill reports the current sitting's agenda and the committee
dates (Termine).

## Tooling

This skill drives the `bundesrat` command. **Before anything else, validate it is available** — run `command -v bundesrat` (or `bundesrat --version`). If it is not on your PATH, STOP and inform the user that the `bundesrat` CLI (`@maschinenlesbar.org/bundesrat-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

**No API key is required** — the Bundesrat feeds are public. The CLI surfaces **only openly-licensed data**: factual fields and Drucksache numbers. The Drucksachen and Plenarprotokolle are *amtliche Werke* (free to reuse unaltered, with a source citation); cite "Quelle: Bundesrat". See DATA_LICENSE.md. Use `--compact` when piping to `jq`.

## Commands

```bash
bundesrat session       # current sitting: { title, header, tops: [ {toptitle, topdrucksache, topheader, linkedtop?} ] }
bundesrat appointments  # committee dates (Termine): [ {type, id, url, title, startdate} ]
```

The CLI drops empty fields, so a field with no value is **missing**, never `""`.

## Recipes

```bash
# The full agenda, one line per item, in TOP order (the feed lists them out of order)
bundesrat session \
  | jq -r '.tops | sort_by(.toptitle // "" | capture("(?<n>\\d+)(?<s>[a-z]*)") | [(.n | tonumber), .s])[] | "\(.toptitle)\t\(.topdrucksache // "—")\t\(.topheader)"'

# When and what: title, date, and number of items
bundesrat session | jq '{title, header, items: (.tops | length)}'

# Every Drucksache the sitting will deal with
bundesrat session | jq -r '.tops[].topdrucksache | select(.)'

# Upcoming committee dates, sorted, start as YYYY-MM-DD HH:MM
bundesrat appointments \
  | jq -r 'map(. + {start: ((.startdate // "" | capture("(?<d>\\d{2})\\.(?<m>\\d{2})\\.(?<y>\\d{4}) ?(?<t>[0-9:]*)") | "\(.y)-\(.m)-\(.d) \(.t)") // "")}) | sort_by(.start)[] | "\(.start)\t\(.title)"'
```

## Traps

- **The agenda is under `.tops[]`**, each with `toptitle` ("TOP 67", "TOP 2b"),
  `topdrucksache` ("Drucksache 371/26") and `topheader` (short factual label).
  `linkedtop` (a cross-reference) appears only when set — on 2026-09-15 none of the
  95 TOPs had one. `topdrucksache` may be **missing** on a procedural item — use
  `// "—"` or `select(.)`.
- **TOPs come out of order.** The feed lists them as e.g. TOP 31, TOP 24, TOP 81,
  TOP 40. Sort by the number and letter suffix (recipe above) before presenting the
  agenda; a plain string sort puts "TOP 10" before "TOP 2".
- **Appointment dates are German-format strings** — `startdate` is
  `"25.09.2026 09:30"` (DD.MM.YYYY HH:MM), which doesn't sort as text; convert as in
  the recipe. On 2026-09-15 every appointment had only `type`, `id`, `url`, `title`
  and `startdate`; don't count on `date` or `stopdate`, which the CLI passes through
  only when the feed sets them.
- **Cancelled dates stay in the list.** The title says so: „Sitzung des
  Finanzausschusses entfällt / Umfrageverfahren". Mark titles containing „entfällt"
  as cancelled (a committee that decides by written poll instead holds no meeting)
  rather than listing them as meetings.
- **Only open fields are returned.** The agenda item's HTML description (`topdetail`)
  and the appointment's editorial `detail`/`abstract`/image are stripped by the CLI —
  there is no HTML to scrape, and nothing copyright-protected reaches the output.
- **Between sittings the agenda can be sparse or a draft** ("Tagesordnung Entwurf"
  in the title).
- **Cite the source.** Drucksachen are *amtliche Werke* — reference them by number
  with "Quelle: Bundesrat".
- **A connection reset isn't retried.** The server occasionally drops a connection
  (`Error: read ECONNRESET`, exit `6`). `--max-retries` covers only HTTP 429/503, so
  run the command once more before reporting the feed as unavailable.
- Members of the Bundesrat → the **bundesrat-members** skill.
