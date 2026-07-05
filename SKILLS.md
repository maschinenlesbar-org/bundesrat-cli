# bundesrat-cli — Claude Code Skills

A set of [Claude Code](https://code.claude.com/docs/en/skills) **Agent Skills** for
the **Bundesrat** (Germany's chamber of the sixteen Länder), all powered by the
**[bundesrat](README.md)** CLI over the Bundesrat's public data feeds.

Each skill teaches Claude how to drive the `bundesrat` CLI to answer a specific,
real-world question — "what's on the Bundesrat's agenda?", "who represents Bavaria?",
"latest Bundesrat news?" — and to report the answer with citations rather than
guesswork. They encode the parts that are easy to get wrong (the `.tops[]` agenda
shape, HTML-in-`detail` fields, exact-vs-substring member filters, and the
copyright-vs-*amtliches-Werk* line) so Claude doesn't rediscover them each time.

## Skills

| Skill | What it does | Ask it… |
|---|---|---|
| **bundesrat-agenda** | The current plenary sitting's agenda (TOPs + Drucksachen), and upcoming sitting dates. | "what's on the Bundesrat's agenda?", "which Drucksachen is it voting on?", "when does the Bundesrat next meet?" |
| **bundesrat-members** | Bundesrat members filtered by Land or party, plus the composition and Präsidium. | "who represents Bavaria?", "list the Green members", "who's the Bundesrat president?" |
| **bundesrat-news** | Current news / press items and the committee-appointments feed. | "latest Bundesrat news", "recent press releases", "upcoming committee dates" |

## Requirements

- **[Claude Code](https://code.claude.com/docs/en/overview)** (or any harness that loads
  Agent Skills).
- **The `bundesrat` CLI** installed globally:
  ```bash
  npm i -g @maschinenlesbar.org/bundesrat-cli   # installs the `bundesrat` bin
  ```
- **No API key** — the Bundesrat feeds are public.

## Installation

### Plugin marketplace (recommended)

This repo is a Claude Code **plugin marketplace**, so installation is two commands inside
Claude Code:

```
/plugin marketplace add maschinenlesbar-org/bundesrat-cli
/plugin install bundesrat@bundesrat-skills
```

The first command registers the marketplace; the second installs the `bundesrat`
plugin, which bundles all three skills. Update later with `/plugin marketplace update`.

### Manual (copy the skill folders)

Prefer not to use the marketplace? Copy the skills into your **personal** directory
(available across all your projects):

```bash
git clone https://github.com/maschinenlesbar-org/bundesrat-cli tmp-skills
mkdir -p ~/.claude/skills
cp -R tmp-skills/skills/* ~/.claude/skills/
rm -rf tmp-skills
```

…or into a single project's `.claude/skills/` by swapping `~/.claude/skills` for
`.claude/skills`. Each skill lives in its own directory with a `SKILL.md`, e.g.
`skills/bundesrat-agenda/SKILL.md`. Start a new Claude Code session and the skills are
picked up automatically.

## Usage

You don't normally invoke these by name — Claude auto-selects the right skill from your
request. Just ask in natural language:

> What's on the Bundesrat's agenda this week, and which Drucksachen are involved?

> Who are the Bundesrat members from North Rhine-Westphalia, and their parties?

> Give me the latest three Bundesrat press headlines.

You can also invoke a skill explicitly with its slash command, e.g. `/bundesrat-agenda`.

## How it works

Every skill is a single `SKILL.md` — a short, model-facing playbook describing which
`bundesrat` subcommands to call and how to interpret the JSON. The skills encode the
non-obvious parts of these feeds, for example:

- **the agenda lives under `.tops[]`** — each item has `toptitle`, `topdrucksache`
  (often empty for procedural TOPs — guard it) and `topheader`;
- **`detail`/`abstract`/`topdetail`/`detail1`–`3` are HTML fragments** kept verbatim
  from the feed — strip or render them, and don't reproduce them as freely-licensed
  prose (they are copyright-protected editorial content);
- **member filters differ** — `--state` is an exact Land match, `--party` is a
  case-insensitive substring; both run client-side, so an unmatched filter returns `[]`;
- **status flags are strings** `"true"`/`"false"`, and **dates are German-format**
  strings, not ISO;
- **copyright vs. amtliches Werk** — the Drucksachen/Plenarprotokolle are public-domain
  official works (reuse unaltered, with a source citation); the rest of the content is
  copyright-protected — always cite "Quelle: Bundesrat".

## Contributing

This project does not accept external code contributions (see
[CONTRIBUTING.md](CONTRIBUTING.md)). When adding a skill internally, keep `SKILL.md`
focused, give it a `description` with concrete trigger phrases, and follow the
[official skill format](https://code.claude.com/docs/en/skills).

## License

[AGPL-3.0-or-later](LICENSE) © Sebastian Schürmann. See [LICENSING.md](LICENSING.md) for
the dual-licensing / commercial option.
