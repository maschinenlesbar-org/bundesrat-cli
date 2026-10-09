// The Bundesrat command group. Each command fetches one public feed and prints
// its parsed JSON, projected to the openly-licensed factual fields (see
// DATA_LICENSE.md). `members` passes --state / --party to the library's
// members(filter), which filters the full list the feed returns.
//
// Only the feeds that return open data are exposed: `session` (agenda TOPs +
// Drucksachen), `members` (names, party, Land), and `appointments` (Termine dates).
// The wholly-editorial feeds — news, BundesratKOMPAKT, the Stimmverteilung graphic,
// and the Präsidium / next-sitting HTML pages — are intentionally not commands.

import type { Command } from "commander";
import { logOf, type CliDeps } from "../io.js";
import type { MemberFilter } from "../../client/client.js";
import { action, once, parseNonEmpty, parseState, renderJson } from "../shared.js";

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
      "only members of this federal state (Land) — one of the 16 Länder, case-insensitive (contrast --party)",
      once(parseState),
    )
    .option("--party <name>", "only members whose party contains this text, case-insensitive", once(parseNonEmpty))
    .action(
      action(deps, async ({ client, global, opts }) => {
        const filter: MemberFilter = {};
        if (opts["state"] !== undefined) filter.state = opts["state"] as string;
        if (opts["party"] !== undefined) filter.party = opts["party"] as string;
        const members = await client.members(filter);
        renderJson(deps, global, members);
        // The feed can't say "no such party": an empty list is all a typo gets. Say so on
        // stderr (stdout stays the plain `[]`), naming the filter.
        if (members.length === 0 && filter.party !== undefined) {
          logOf(deps).info(
            "cli",
            `no member${filter.state !== undefined ? " of that Land" : ""} has a party containing ` +
              `${JSON.stringify(filter.party)} (--party matches a substring of the party name).`,
          );
        }
      }),
    );
}
