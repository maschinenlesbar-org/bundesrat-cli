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
import type { CliDeps } from "../io.js";
import type { MemberFilter } from "../../client/client.js";
import { action, once, parseNonEmpty, renderJson } from "../shared.js";

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
        const filter: MemberFilter = {};
        if (opts["state"] !== undefined) filter.state = opts["state"] as string;
        if (opts["party"] !== undefined) filter.party = opts["party"] as string;
        renderJson(deps, global, await client.members(filter));
      }),
    );
}
