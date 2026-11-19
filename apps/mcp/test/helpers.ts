// Test helpers of this server's own tests and the adapters of the conformance tests: a mock of
// the Bundesrat's three XML feeds, and the client's transport helpers. The generic harness (a
// connection, a config, a log recorder, the HTTP server) is harness.ts.

import type { HttpResponse } from "@maschinenlesbar.org/bundesrat-client";
import { makeMockTransport, xmlResponse, type MockTransport } from "@maschinenlesbar.org/bundesrat-client/test/helpers";

export * from "@maschinenlesbar.org/bundesrat-client/test/helpers";

/** A JSON answer (an error page the feeds might send). */
export function jsonResponse(body: unknown, status = 200): HttpResponse {
  return { status, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(body)) };
}

const esc = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const element = (name: string, fields: Record<string, string>): string =>
  `<${name}>${Object.entries(fields)
    .map(([k, v]) => `<${k}>${esc(v)}</${k}>`)
    .join("")}</${name}>`;
const feed = (body: string): string => `<?xml version="1.0"?><iOS version="1.0"><list>${body}</list></iOS>`;

export interface World {
  session?: { fields?: Record<string, string>; tops?: Record<string, string>[] };
  members?: Record<string, string>[];
  appointments?: Record<string, string>[];
}

/** The three feeds over `world`; any other path 404. */
export function bundesrat(world: World): MockTransport {
  return makeMockTransport((request) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith("plenum_aktuelleSitzung_table.xml")) {
      const fields = Object.entries(world.session?.fields ?? {})
        .map(([k, v]) => `<${k}>${esc(v)}</${k}>`)
        .join("");
      return xmlResponse(feed(fields + (world.session?.tops ?? []).map((t) => element("top", t)).join("")));
    }
    if (path.endsWith("mitglieder_table.xml")) return xmlResponse(feed((world.members ?? []).map((m) => element("employee", m)).join("")));
    if (path.endsWith("termine_table.xml")) return xmlResponse(feed((world.appointments ?? []).map((a) => element("item", a)).join("")));
    return jsonResponse({ error: "not found" }, 404);
  });
}
