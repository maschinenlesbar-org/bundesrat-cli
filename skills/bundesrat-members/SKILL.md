---
name: bundesrat-members
description: >
  Look up the members of the Bundesrat and the chamber's composition, using the
  bundesrat-cli. Trigger when the user asks "who represents Bavaria in the
  Bundesrat?", "list the Green members of the Bundesrat", "who is the current
  Bundesrat president?", "which parties are in the Bundesrat and how many members
  each?", or wants to filter Bundesrat members by federal state (Land) or party, or
  see the seat/vote distribution.
version: 1.0.0
userInvocable: true
---

# Bundesrat Members

The members of the Bundesrat are members of the sixteen Länder governments. This
skill lists and filters them and reports the chamber's composition and Präsidium.

## Tooling

This skill drives the `bundesrat` command. **Before anything else, validate it is available** — run `command -v bundesrat` (or `bundesrat --version`). If it is not on your PATH, STOP and inform the user that the `bundesrat` CLI (`@maschinenlesbar.org/bundesrat-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

**No API key is required** — the Bundesrat feeds are public. The data is © the Bundesrat and **not** openly licensed: cite "Quelle: Bundesrat", and do not republish editorial texts or images without permission; the Drucksachen and Plenarprotokolle are *amtliche Werke* (free to reuse unaltered, with a source citation). See DATA_LICENSE.md. Use `--compact` when piping to `jq`.

## Commands

```bash
bundesrat members [--state <Land>] [--party <text>]   # member records
bundesrat composition                                 # Stimmverteilung composition graphic (not a structured vote table)
bundesrat presidium                                   # the Präsidium (President + Vice-Presidents)
```

Each member has `firstname`, `name`, `party`, `state` (the Land), status flags
`brmitglied` / `mitglied` / `bv` / `designiert` (as `"true"`/`"false"`), and HTML
`detail1`–`detail3` (role / biography / address).

## Filters

- `--state <Land>` — **exact** Land match, case-insensitive (`Bayern`,
  `Baden-Württemberg`, `Nordrhein-Westfalen`).
- `--party <text>` — party name **substring**, case-insensitive (`grüne` matches
  "BÜNDNIS 90/DIE GRÜNEN"; `CDU`, `SPD`, `CSU`, …).

Both apply client-side after fetching the full list, so an unmatched filter returns
`[]` (not everyone).

## Recipes

```bash
# Who represents Bavaria?
bundesrat members --state Bayern | jq -r '.[] | "\(.firstname) \(.name) — \(.party)"'

# All Green members, across the Länder
bundesrat members --party grüne | jq -r '.[] | "\(.name) (\(.state))"'

# Party head-count across the whole chamber
bundesrat members | jq -r 'group_by(.party)[] | "\(.[0].party): \(length)"'

# Who is the Bundesrat President?
bundesrat presidium | jq -r '.[].title'
```

## Traps

- **`--state` is an exact Land match** (not a substring) — use the full Land name.
  `--party` is a substring, so keep it short (`grüne`, not the full party string).
- **Status flags are strings** `"true"`/`"false"`, not booleans — compare as
  strings in `jq` (`select(.brmitglied == "true")`).
- **`detail1`–`detail3` are HTML** (role, biography, address) — strip or render;
  don't treat as plain text, and don't republish biographies/photos without the
  Bundesrat's permission (they are copyright-protected, unlike the members' names
  and party/Land, which are facts).
- **`composition` centres on the official graphic** and its title can be empty —
  it conveys the seat/vote distribution rather than a clean per-Land vote table.
- The plenary agenda → the **bundesrat-agenda** skill; news → **bundesrat-news**.
