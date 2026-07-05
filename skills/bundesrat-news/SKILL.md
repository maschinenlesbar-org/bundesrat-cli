---
name: bundesrat-news
description: >
  Get the latest Bundesrat news and committee appointments, using the bundesrat-cli.
  Trigger when the user asks "what is the latest news from the Bundesrat?", "recent
  Bundesrat press releases", "what committee dates are coming up?", "any Bundesrat
  Termine this week?", or wants the current Aktuelles items or the Termine
  (committee appointments and events) feed.
version: 1.0.0
userInvocable: true
---

# Bundesrat News & Appointments

This skill surfaces the Bundesrat's current news/press items and its committee
appointments feed.

## Tooling

This skill drives the `bundesrat` command. **Before anything else, validate it is available** — run `command -v bundesrat` (or `bundesrat --version`). If it is not on your PATH, STOP and inform the user that the `bundesrat` CLI (`@maschinenlesbar.org/bundesrat-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

**No API key is required** — the Bundesrat feeds are public. The data is © the Bundesrat and **not** openly licensed: cite "Quelle: Bundesrat", and do not republish editorial texts or images without permission; the Drucksachen and Plenarprotokolle are *amtliche Werke* (free to reuse unaltered, with a source citation). See DATA_LICENSE.md. Use `--compact` when piping to `jq`.

## Commands

```bash
bundesrat news           # current news / press items (Aktuelles)
bundesrat appointments   # committee appointments and dates (Termine)
```

Both return an array of items with `type`, `id`, `url`, `title`, `abstract`,
`date`/`dateOfIssue`, and an HTML `detail`. Termine items additionally carry
`startdate` / `stopdate`.

## Recipes

```bash
# The latest five headlines with dates
bundesrat news | jq -r '.[:5][] | "\(.date)\t\(.title)"'

# One headline + its teaser + link
bundesrat news | jq -r '.[0] | "\(.title)\n\(.abstract)\n\(.url)"'

# Upcoming committee dates
bundesrat appointments | jq -r '.[] | "\(.startdate // .date // "")\t\(.title)"'
```

## Traps

- **Items are already newest-first** in the feed; take `.[:N]` for the latest N —
  don't assume you must sort.
- **`abstract` is a plain teaser; `detail` is HTML** — summarise from `abstract`
  and `title`; strip `detail` if you need the body, and don't reproduce it verbatim
  as freely-licensed text (it is copyright-protected editorial content).
- **Dates are German-format strings** ("03.07.2026 13:41"), not ISO — parse
  accordingly if you compute ranges.
- **Always link and cite.** Each item has a `url` on bundesrat.de; present it with
  "Quelle: Bundesrat".
- The plenary agenda → the **bundesrat-agenda** skill; members / composition →
  the **bundesrat-members** skill.
