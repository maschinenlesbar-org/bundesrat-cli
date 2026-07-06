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
bundesrat session       # current sitting: { title, header, tops: [ {toptitle, topdrucksache, topheader, linkedtop} ] }
bundesrat appointments  # committee dates (Termine): [ {type, id, url, title, date, startdate, stopdate} ]
```

## Recipes

```bash
# The full agenda, one line per item
bundesrat session | jq -r '.tops[] | "\(.toptitle)\t\(.topdrucksache // "—")\t\(.topheader)"'

# When and what: title, date, and number of items
bundesrat session | jq '{title, header, items: (.tops | length)}'

# Every Drucksache the sitting will deal with
bundesrat session | jq -r '.tops[].topdrucksache | select(.)'

# Upcoming committee dates
bundesrat appointments | jq -r '.[] | "\(.startdate // "")\t\(.title)"'
```

## Traps

- **The agenda is under `.tops[]`**, each with `toptitle` ("TOP 67"),
  `topdrucksache` ("Drucksache 371/26"), `topheader` (short factual label) and
  `linkedtop`. `topdrucksache` can be empty for procedural items — guard with
  `select(.)`.
- **Only open fields are returned.** The agenda item's HTML description (`topdetail`)
  and the appointment's editorial `detail`/`abstract`/image are stripped by the CLI —
  there is no HTML to scrape, and nothing copyright-protected reaches the output.
- **Between sittings the agenda can be sparse or a draft** ("Tagesordnung Entwurf"
  in the title).
- **Cite the source.** Drucksachen are *amtliche Werke* — reference them by number
  with "Quelle: Bundesrat".
- Members of the Bundesrat → the **bundesrat-members** skill.
