// Public entry point for the API client library.

export { BundesratClient, FEEDS, asArray } from "./client.js";
export type { BundesratClientOptions } from "./client.js";
export { RequestEngine, DEFAULT_BASE_URL } from "./engine.js";
export type { EngineOptions, RawResponse } from "./engine.js";
export { nodeHttpTransport } from "./http.js";
export type { Transport, HttpRequest, HttpResponse } from "./http.js";
export { buildQueryString } from "./query.js";
export type { QueryParams, QueryValue } from "./query.js";
export { parseXml, decodeEntities } from "./xml.js";
export type { XmlValue, XmlObject } from "./xml.js";
export {
  BundesratError,
  BundesratApiError,
  BundesratNetworkError,
  BundesratValidationError,
  BundesratParseError,
} from "./errors.js";

export * from "./types.js";
