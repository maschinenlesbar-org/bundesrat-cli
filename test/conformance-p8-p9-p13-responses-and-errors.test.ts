// Conformance test P8 + P9 + P13 (fix plan 2026-10-06): a body is decoded by its declared
// charset (P8); a 2xx body without the documented shape is a parse error, never data or
// "nothing found" (P9); every rejected input is the library's validation error, never a raw
// TypeError or RangeError (P13). Shared across the *-cli repos; only the adapter differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { HttpResponse } from "../src/client/http.js";

// ---- adapter (per repo) -------------------------------------------------------------
import { BundesratClient as Client, filterMembers } from "../src/client/client.js";
import {
  BundesratError as BaseError,
  BundesratParseError as ParseError,
  BundesratValidationError as ValidationError,
} from "../src/client/errors.js";
import type { Appointment } from "../src/client/types.js";
/** A call whose answer contains a text field, and how to read that field from the result. */
const textCall = (client: Client): Promise<unknown> => client.appointments();
const textBody = (text: string): unknown =>
  `<iOS version="1.0"><list><item><type>Event</type><title>${text}</title></item></list></iOS>`;
const readText = (result: unknown): string => (result as Appointment[])[0]!.title!;
/** How a body goes on the wire: the feed is XML, so the document as it is. */
const serialize = (body: unknown): string => String(body);
/** 2xx bodies the call must reject (error envelopes, empty or wrong shapes). */
const malformedBodies: unknown[] = [
  "null",
  "{}",
  "[]",
  "text",
  "42",
  '<iOS version="1.0"/>',
  '<iOS version="1.0"><item><title>x</title></item></iOS>',
  "<error>boom</error>",
  '<rss version="2.0"><channel><item><title>x</title></item></channel></rss>',
  '<iOS version="1.0"><list><item><title>x</title>',
  '<iOS version="1.0"><list>text</list></iOS>',
  '<iOS version="1.0"><list/><list/></iOS>',
];
/** A transport that never reaches the network: a call that slips past validation fails here. */
const offline = async (): Promise<never> => {
  throw new Error("offline: validation should have rejected this call before any request");
};
/** Library calls with wrong-typed or out-of-range input. */
const badCalls: Array<[string, () => unknown]> = [
  ["members(5)", () => new Client({ transport: offline }).members(5 as never)],
  ["members(null)", () => new Client({ transport: offline }).members(null as never)],
  ["members('Bayern')", () => new Client({ transport: offline }).members("Bayern" as never)],
  ["members([])", () => new Client({ transport: offline }).members([] as never)],
  ["members({ state: 5 })", () => new Client({ transport: offline }).members({ state: 5 as never })],
  ["members({ party: ['SPD'] })", () => new Client({ transport: offline }).members({ party: ["SPD"] as never })],
  ["members({ State: 'Bayern' })", () => new Client({ transport: offline }).members({ State: "Bayern" } as never)],
  ["filterMembers('x', {})", () => filterMembers("x" as never, {})],
  ["filterMembers([null], { state: 'Bayern' })", () => filterMembers([null] as never, { state: "Bayern" })],
  ["filterMembers([], 5)", () => filterMembers([], 5 as never)],
  ["new Client(null)", () => new Client(null as never)],
  ["new Client(5)", () => new Client(5 as never)],
  ["timeoutMs: 'x'", () => new Client({ timeoutMs: "x" as unknown as number })],
  ["timeoutMs: -1", () => new Client({ timeoutMs: -1 })],
  ["maxRetries: 1.5", () => new Client({ maxRetries: 1.5 })],
  ["baseUrl: 5", () => new Client({ baseUrl: 5 as unknown as string })],
  ["userAgent: {}", () => new Client({ userAgent: {} as unknown as string })],
  ["transport: 'x'", () => new Client({ transport: "x" as never })],
  ["sleep: 5", () => new Client({ sleep: 5 as never })],
  ["defaultHeaders: 'x'", () => new Client({ defaultHeaders: "x" as never })],
  ["defaultHeaders: { a: 5 }", () => new Client({ defaultHeaders: { a: 5 } as never })],
];
// --------------------------------------------------------------------------------------

const respond = (body: Buffer, contentType: string) => async (): Promise<HttpResponse> => ({
  status: 200,
  headers: { "content-type": contentType },
  body,
});

test("P8: a body is decoded by its declared charset", async () => {
  const text = "Müller µg/l";
  for (const [charset, encoding] of [["iso-8859-1", "latin1"], ["utf-8", "utf8"]] as const) {
    const body = Buffer.from(serialize(textBody(text)), encoding);
    const client = new Client({ transport: respond(body, `application/json; charset=${charset}`) });
    assert.equal(readText(await textCall(client)), text, charset);
  }
});

test("P9: a 2xx body without the documented shape is a parse error", async () => {
  for (const body of malformedBodies) {
    const client = new Client({ transport: respond(Buffer.from(serialize(body)), "application/json"), maxRetries: 0 });
    await assert.rejects(textCall(client), ParseError, `body ${JSON.stringify(body)}`);
  }
  for (const raw of ["", "<html>maintenance</html>"]) {
    const client = new Client({ transport: respond(Buffer.from(raw), "text/html"), maxRetries: 0 });
    await assert.rejects(textCall(client), BaseError, `raw ${JSON.stringify(raw)}`);
  }
});

test("P13: every rejected input is the validation error, never a raw TypeError", async () => {
  for (const [label, fn] of badCalls) {
    await assert.rejects(async () => fn(), (e: unknown) => e instanceof ValidationError, label);
  }
});
