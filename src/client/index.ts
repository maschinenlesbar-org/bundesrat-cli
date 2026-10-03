// Public entry point for the API client library.

export { BundesratClient, FEEDS, asArray, filterMembers } from "./client.js";
export type { BundesratClientOptions, MemberFilter } from "./client.js";
export {
  RequestEngine,
  DEFAULT_BASE_URL,
  MAX_RETRIES,
  MAX_RETRY_AFTER_MS,
  assertHeaderValue,
  parseRetryAfter,
} from "./engine.js";
export type { EngineOptions, RawResponse } from "./engine.js";
export { MAX_TIMEOUT_MS, nodeHttpTransport } from "./http.js";
export type { Transport, HttpRequest, HttpResponse } from "./http.js";
export { buildQueryString } from "./query.js";
export { assertValid, headerNameProblem, headerValueProblem, nonBlankProblem } from "./validate.js";
export type { Problem } from "./validate.js";
export type { QueryParams, QueryValue } from "./query.js";
export { parseXml, parseXmlDocument, decodeEntities } from "./xml.js";
export type { XmlValue, XmlObject, XmlDocument } from "./xml.js";
export {
  BundesratError,
  BundesratApiError,
  BundesratNetworkError,
  BundesratValidationError,
  BundesratParseError,
  redactUrl,
} from "./errors.js";

export * from "./types.js";
