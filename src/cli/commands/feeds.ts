// The Bundesrat command group. Each command fetches one public feed and prints
// its parsed JSON, projected to the openly-licensed factual fields (see
// DATA_LICENSE.md). `members` additionally filters client-side by --state /
// --party (the feed itself returns the full list).
//
// Only the feeds that return open data are exposed: `session` (agenda TOPs +
// Drucksachen), `members` (names, party, Land), and `appointments` (Termine dates).
// The wholly-editorial feeds — news, BundesratKOMPAKT, the Stimmverteilung graphic,
// and the Präsidium / next-sitting HTML pages — are intentionally not commands.

import type { Command } from "commander";
import type { CliDeps } from "../io.js";
import type { Member } from "../../client/types.js";
import { action, once, parseNonEmpty, renderJson } from "../shared.js";

/** Case- and normalisation-insensitive form of a filter value or field. */
function fold(text: string): string {
  return text.normalize("NFC").toLowerCase();
}

/** Register a trivial "fetch a feed and render it" command. */
function feedCommand(
  program: Command,
  deps: CliDeps,
  name: string,
  description: string,
  fetch: (client: ReturnType<CliDeps["createClient"]>) => Promise<unknown>,
): void {
  program
    .command(name)
    .description(description)
    .action(action(deps, async ({ client, global }) => renderJson(deps, global, await fetch(client))));
}

export function registerCommands(program: Command, deps: CliDeps): void {
  feedCommand(program, deps, "session", "Current plenary sitting: agenda items (TOPs) with their Drucksachen", (c) =>
    c.session(),
  );
  feedCommand(program, deps, "appointments", "Committee appointments and dates (Termine)", (c) =>
    c.appointments(),
  );

  program
    .command("members")
    .description("Members of the Bundesrat (Länder ministers and plenipotentiaries)")
    .option(
      "--state <land>",
      "only members of this federal state (Land) — exact match, case-insensitive (contrast --party)",
      once(parseNonEmpty),
    )
    .option("--party <name>", "only members whose party contains this text, case-insensitive", once(parseNonEmpty))
    .action(
      action(deps, async ({ client, global, opts }) => {
        let members = await client.members();
        const state = opts["state"] as string | undefined;
        const party = opts["party"] as string | undefined;
        // Filter client-side (the feed returns everyone). Guard the field types so a
        // filter never silently matches nothing due to a non-string field. Both sides
        // are NFC-normalised, so a decomposed umlaut (macOS file names, some input
        // methods) matches the feed's composed one.
        if (state !== undefined) {
          const needle = fold(state.trim());
          members = members.filter((m: Member) => typeof m.state === "string" && fold(m.state) === needle);
        }
        if (party !== undefined) {
          const needle = fold(party.trim());
          members = members.filter(
            (m: Member) => typeof m.party === "string" && fold(m.party).includes(needle),
          );
        }
        renderJson(deps, global, members);
      }),
    );
}
