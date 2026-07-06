---
name: bundesrat-members
description: >
  Look up the members of the Bundesrat, using the bundesrat-cli. Trigger when the
  user asks "who represents Bavaria in the Bundesrat?", "list the Green members of
  the Bundesrat", "which parties are in the Bundesrat and how many members each?",
  or wants to filter Bundesrat members by federal state (Land) or party.
version: 2.0.0
userInvocable: true
---

# Bundesrat Members

The members of the Bundesrat are members of the sixteen Länder governments. This
skill lists and filters them by Land or party.

## Tooling

This skill drives the `bundesrat` command. **Before anything else, validate it is available** — run `command -v bundesrat` (or `bundesrat --version`). If it is not on your PATH, STOP and inform the user that the `bundesrat` CLI (`@maschinenlesbar.org/bundesrat-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

**No API key is required** — the Bundesrat feeds are public. The CLI surfaces **only openly-licensed data**: a member's name, party, Land and status flags are facts; the feed's biography and portrait are copyright-protected and are not returned. Cite "Quelle: Bundesrat". See DATA_LICENSE.md. Use `--compact` when piping to `jq`.

## Command

```bash
bundesrat members [--state <Land>] [--party <text>]   # member records
```

Each member has `honorificTitle`, `firstname`, `name`, `party`, `state` (the Land),
a `url`, and status flags `brmitglied` / `mitglied` / `bv` / `designiert` (as
`"true"`/`"false"`). The feed's HTML biography and portrait image are stripped (not
surfaced).

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

# Only the voting Bundesrat members
bundesrat members | jq '[.[] | select(.brmitglied == "true")] | length'
```

## Traps

- **`--state` is an exact Land match** (not a substring) — use the full Land name.
  `--party` is a substring, so keep it short (`grüne`, not the full party string).
- **Status flags are strings** `"true"`/`"false"`, not booleans — compare as
  strings in `jq` (`select(.brmitglied == "true")`).
- **Only facts are returned.** Names, party and Land are facts; the feed's HTML
  biography (`detail`) and photo (`imagePath`) are copyright-protected and are stripped
  by the CLI, so there's nothing to scrape or republish.
- The plenary agenda and committee dates → the **bundesrat-agenda** skill.
