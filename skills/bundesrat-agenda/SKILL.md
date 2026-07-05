---
name: bundesrat-agenda
description: >
  Show what is on the Bundesrat's plenary agenda and when it next meets, using the
  bundesrat-cli. Trigger when the user asks "what is on the Bundesrat's agenda?",
  "which Drucksachen is the Bundesrat voting on this week?", "when does the
  Bundesrat next meet?", "how many items are on the current Tagesordnung?", or wants
  the agenda items (TOPs) of the current plenary sitting with their Drucksachen.
version: 1.0.0
userInvocable: true
---

# Bundesrat Agenda

The Bundesrat (Germany's chamber of the sixteen Länder) meets in plenary roughly
every 3–4 weeks. This skill reports the current sitting's agenda and the upcoming
dates.

## Tooling

This skill drives the `bundesrat` command. **Before anything else, validate it is available** — run `command -v bundesrat` (or `bundesrat --version`). If it is not on your PATH, STOP and inform the user that the `bundesrat` CLI (`@maschinenlesbar.org/bundesrat-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

**No API key is required** — the Bundesrat feeds are public. The data is © the Bundesrat and **not** openly licensed: cite "Quelle: Bundesrat", and do not republish editorial texts or images without permission; the Drucksachen and Plenarprotokolle are *amtliche Werke* (free to reuse unaltered, with a source citation). See DATA_LICENSE.md. Use `--compact` when piping to `jq`.

## Commands

```bash
bundesrat session     # current sitting: { title, header, tops: [ {toptitle, topdrucksache, topheader, topdetail} ] }
bundesrat next        # upcoming plenary sittings (dates are inside the HTML detail)
bundesrat compact     # BundesratKOMPAKT — selected TOPs with editorial summaries (nested)
```

## Recipes

```bash
# The full agenda, one line per item
bundesrat session | jq -r '.tops[] | "\(.toptitle)\t\(.topdrucksache // "—")\t\(.topheader)"'

# When and what: title, date, and number of items
bundesrat session | jq '{title, header, items: (.tops | length)}'

# Every Drucksache the sitting will deal with
bundesrat session | jq -r '.tops[].topdrucksache | select(.)'

# When does the Bundesrat next meet?
bundesrat next | jq -r '.[].detail'   # dates live in the HTML detail fragment
```

## Traps

- **The agenda is under `.tops[]`**, each with `toptitle` ("TOP 67"),
  `topdrucksache` ("Drucksache 371/26"), `topheader` (short description) and
  `topdetail` (an **HTML fragment** — strip or render it, don't treat it as plain
  text). `topdrucksache` can be empty for procedural items — guard with
  `select(.)`.
- **Between sittings the agenda can be sparse or a draft** ("Tagesordnung Entwurf"
  in the title). Use `bundesrat next` for the schedule.
- **`compact` is a curated subset**, not the full agenda, and is nested
  (`header` + `tops` each with `subtop`s) — reach for `session` when the user wants
  the complete Tagesordnung.
- **Cite the source.** Drucksachen are *amtliche Werke* — reference them by number
  with "Quelle: Bundesrat"; don't reproduce the HTML `topdetail` text as if it were
  freely licensed prose.
- Members of the Bundesrat → the **bundesrat-members** skill; news → **bundesrat-news**.
