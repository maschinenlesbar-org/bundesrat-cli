// The request engine: turns logical (path, query) calls into HTTP GET requests via
// a Transport, applies retry/backoff for transient statuses (429, 503), and decodes
// XML responses. The Bundesrat "API" is the data feed behind the Bundesrat iOS app:
// unauthenticated GETs against www.bundesrat.de whose paths end in `.xml` and must
// carry the `?view=renderXml` render parameter to return XML rather than the
// website's HTML shell.

import {
  MAX_TIMEOUT_MS,
  nodeHttpTransport,
  sizeLimitMessage,
  type HttpRequest,
  type HttpResponse,
  type Transport,
} from "./http.js";
import { buildQueryString, type QueryParams } from "./query.js";
import { parseXmlDocument, type XmlDocument, type XmlValue } from "./xml.js";
import {
  BundesratApiError,
  BundesratError,
  BundesratNetworkError,
  BundesratParseError,
  BundesratValidationError,
  credentialsIn,
  redactCredentials,
} from "./errors.js";
import { assertValid, baseUrlProblem, headerNameProblem, headerValueProblem } from "./validate.js";

export const DEFAULT_BASE_URL = "https://www.bundesrat.de";
const DEFAULT_USER_AGENT = "bundesrat-cli";

export interface RawResponse {
  data: Buffer;
  contentType: string;
  status: number;
}

/**
 * Options for {@link RequestEngine} and the client. The numeric options must be
 * integers within their documented range; anything else (negative, fractional,
 * NaN, Infinity, too large) makes the constructor throw a BundesratValidationError.
 */
export interface EngineOptions {
  /**
   * Base URL of the API. Defaults to https://www.bundesrat.de. A value that breaks
   * a rule of {@link validateBaseUrl} (blank, whitespace or control characters, not
   * http(s), a query or fragment) throws a BundesratValidationError.
   */
  baseUrl?: string;
  /**
   * Swappable transport. Defaults to the built-in node http/https transport. The engine
   * enforces `timeoutMs` and `maxResponseBytes` for any transport, reads its headers in any
   * case (a fetch `Headers` or a `Map` too) and its body as any ArrayBuffer view, and turns
   * whatever it throws into a `BundesratNetworkError`.
   */
  transport?: Transport;
  /**
   * Value of the User-Agent header (default `bundesrat-cli`). A blank value, a
   * control character other than tab, or a character above U+00FF throws a
   * BundesratValidationError.
   */
  userAgent?: string;
  /** Extra headers sent on every request; names and values are checked like `userAgent`. */
  defaultHeaders?: Record<string, string>;
  /**
   * Time limit per request in milliseconds, covering the whole response body, not
   * only idle gaps (0 disables; at most `MAX_TIMEOUT_MS`, 2^31 - 1 ms). Enforced by the
   * engine for every transport: the request's `signal` aborts at the deadline and the
   * call rejects with a BundesratNetworkError.
   */
  timeoutMs?: number;
  /**
   * Number of automatic retries for transient (429/503) responses and reset connections
   * (`ECONNRESET`, `EPIPE`, `ECONNABORTED`, undici's `UND_ERR_SOCKET`), 0..`MAX_RETRIES`
   * (10). A refused connection, a DNS failure and a timeout are not retried. Each retry
   * waits `retryDelayMs * attempt`, or the response's `Retry-After` when that is longer (up
   * to `MAX_RETRY_AFTER_MS`; a longer one is not retried, and the error names the requested
   * wait).
   */
  maxRetries?: number;
  /**
   * Base backoff between retries in milliseconds (grows linearly; default 200). A
   * `Retry-After` can make a wait longer, never shorter. At most `MAX_RETRY_AFTER_MS`.
   */
  retryDelayMs?: number;
  /**
   * Hard cap on response body size in bytes (defends against memory exhaustion
   * from a hostile/buggy endpoint). Defaults to 100 MiB; set to 0 for no limit. The
   * default transport aborts early; for any transport the engine checks the body it
   * gets back.
   */
  maxResponseBytes?: number;
  /** Injectable sleep, primarily for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_RESPONSE_BYTES = 100 * 1024 * 1024;

/**
 * Longest `Retry-After` the engine waits out before retrying a 429/503. When the
 * server asks for longer, the engine does not retry at all and surfaces the error at
 * once, naming the requested wait (`BundesratApiError.retryAfterMs`): retrying early would only land inside the window the server asked us to wait
 * out, and a hostile value must not stall the CLI.
 */
export const MAX_RETRY_AFTER_MS = 30_000;

/** Most automatic retries a caller may ask for (the CLI's --max-retries shares it). */
export const MAX_RETRIES = 10;

/**
 * Read a numeric engine option: `undefined` gives the default; anything but an
 * integer in [0, max] throws. Without this a negative or NaN `timeoutMs` silently
 * disabled the timeout, and `maxRetries: Infinity` retried for ever.
 */
function intOption(name: string, value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new BundesratValidationError(
      `Invalid option ${name}: expected an integer from 0 to ${max}, got ${String(value)}.`,
    );
  }
  return value;
}

/**
 * Check a value bound for an HTTP header (see {@link headerValueProblem}) and
 * return it unchanged; anything else throws a BundesratValidationError naming
 * `name` ("Invalid userAgent: Value contains control characters.").
 */
export function assertHeaderValue(name: string, value: string): string {
  return assertValid(name, value, headerValueProblem);
}

/** Check every name and value of `defaultHeaders`, returning a copy. */
function headerOption(headers: Record<string, string> | undefined): Record<string, string> {
  if (headers === undefined) return {};
  assertValid("defaultHeaders", headers, (v) =>
    typeof v === "object" && v !== null && !Array.isArray(v) ? undefined : "Expected an object of header names to values.",
  );
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    assertValid("defaultHeaders name", name, headerNameProblem);
    out[name] = assertHeaderValue(`defaultHeaders["${name}"]`, value);
  }
  return out;
}

/** An IMF-fixdate (RFC 9110 §5.6.7), the one HTTP-date form senders must generate. */
const IMF_FIXDATE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Parse a `Retry-After` header into a delay in milliseconds (RFC 9110 §10.2.3):
 * either delay-seconds (`"120"`) or an HTTP-date (`"Wed, 21 Oct 2026 07:28:00 GMT"`,
 * turned into the time left from `now`; a date in the past gives 0).
 *
 * Returns `undefined` when the header is absent or malformed — negative (`"-1"`),
 * fractional (`"1.5"`), padded inside, any other date format — so the caller falls
 * back to its own backoff. The strict patterns matter: `Date.parse` alone would
 * read `"1.5"` as a date in 2001 and retry at once.
 */
export function parseRetryAfter(
  header: string | string[] | undefined,
  now: number = Date.now(),
): number | undefined {
  const value = (Array.isArray(header) ? header[0] : header)?.trim();
  if (value === undefined || value === "") return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  if (!IMF_FIXDATE.test(value)) return undefined;
  const when = Date.parse(value);
  return Number.isNaN(when) ? undefined : Math.max(0, when - now);
}

/**
 * True for the Unicode bidirectional formatting characters: ALM (U+061C), LRM/RLM
 * (U+200E/U+200F), the embeddings and overrides U+202A–U+202E and the isolates
 * U+2066–U+2069. A terminal applies them to the text that follows, so an override
 * in server text can reorder what the user sees ("Trojan Source" spoofing).
 */
export function isBidiControl(code: number): boolean {
  return (
    code === 0x061c ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/**
 * Make a string that originates in an attacker-controlled response body — the
 * error `detail` snippet that ends up in a BundesratApiError.message printed to
 * stderr by run.ts — safe to print:
 *
 * - C0 and C1 controls and DEL are dropped, so a hostile / MITM'd /
 *   spoofed-`--base-url` endpoint cannot drive ANSI/OSC escape sequences (display
 *   spoofing, terminal title changes) into the user's terminal.
 * - Bidi formatting characters (isBidiControl) are dropped, so server text cannot
 *   reorder the visible message.
 * - Every run of whitespace — newlines, tabs, U+2028/U+2029 included — becomes one
 *   space and the ends are trimmed, so the text stays on one line and a server
 *   cannot forge a line of its own.
 *
 * This only covers error text: the CLI's JSON output is escaped separately
 * (escapeControlChars in cli/shared.ts), since JSON.stringify alone leaves DEL, C1
 * and bidi characters raw. Written as a code-point filter so no raw control byte
 * ever appears in this source.
 */
export function sanitizeServerText(text: string): string {
  let out = "";
  for (const ch of text) {
    const n = ch.codePointAt(0) ?? 0;
    const whitespaceControl = n >= 0x09 && n <= 0x0d;
    if (!whitespaceControl && (n <= 0x1f || (n >= 0x7f && n <= 0x9f) || isBidiControl(n))) continue;
    out += ch;
  }
  return out.replace(/\s+/g, " ").trim();
}

/** Why `value` is not a usable HttpResponse, or undefined when it is. */
function responseProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return "not an object";
  const r = value as Partial<Record<"status" | "headers" | "body", unknown>>;
  if (typeof r.status !== "number" || !Number.isInteger(r.status) || r.status < 100 || r.status > 599) {
    return "status is not an HTTP status code";
  }
  if (typeof r.headers !== "object" || r.headers === null || Array.isArray(r.headers)) return "headers is not an object";
  if (bodyBytes(r.body) === undefined) return "body is not a Buffer, Uint8Array, other ArrayBuffer view or ArrayBuffer";
  return undefined;
}

/**
 * The response body as a Buffer (a view, no copy): a Buffer, any ArrayBuffer view (a
 * Uint8Array from fetch, a DataView) or an ArrayBuffer/SharedArrayBuffer — checked by internal
 * slot, not `instanceof`, so a value from another realm (a vm context, a Jest test) counts.
 * Undefined for anything else. (A Uint8Array used to be decoded with
 * `Uint8Array#toString`, which ignores the charset: a declared ISO-8859-1 feed lost its
 * umlauts, and an error body became a comma-separated list of byte values.)
 */
function bodyBytes(value: unknown): Buffer | undefined {
  if (Buffer.isBuffer(value)) return value;
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  const tag = Object.prototype.toString.call(value);
  if (tag === "[object ArrayBuffer]" || tag === "[object SharedArrayBuffer]") return Buffer.from(value as ArrayBuffer);
  return undefined;
}

/**
 * The response headers as a plain record with lower-case names. A transport built on
 * `fetch` naturally returns its `Headers` object, which has no plain properties, and a
 * custom one may write `Retry-After` in any case: the engine then saw no Retry-After and
 * retried after its own short backoff, inside the server's window. Such an object
 * (anything with `get` and `forEach`, a `Headers` or a `Map`) is copied into a record; a
 * plain record gets its names lower-cased.
 */
function plainHeaders(headers: object): Record<string, string | string[] | undefined> {
  const h = headers as { get?: unknown; forEach?: unknown };
  if (typeof h.get === "function" && typeof h.forEach === "function") {
    const record: Record<string, string> = {};
    (h.forEach as (cb: (value: unknown, name: unknown) => void) => void).call(headers, (value, name) => {
      record[String(name).toLowerCase()] = String(value);
    });
    return record;
  }
  const record: Record<string, string | string[] | undefined> = {};
  for (const [name, value] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    record[name.toLowerCase()] = value;
  }
  return record;
}

/**
 * Error codes of a connection that broke off mid-request: Node's (`socket hang up` is
 * ECONNRESET) and undici's (`fetch failed` with cause UND_ERR_SOCKET, "other side closed").
 */
const TRANSIENT_NETWORK_CODES = new Set(["ECONNRESET", "EPIPE", "ECONNABORTED", "UND_ERR_SOCKET"]);

/** True when `err` or an error in its `cause` chain has a transient connection code. */
function hasTransientCode(err: unknown, depth = 0): boolean {
  if (typeof err !== "object" || err === null || depth > 4) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && TRANSIENT_NETWORK_CODES.has(code)) return true;
  return hasTransientCode((err as { cause?: unknown }).cause, depth + 1);
}

/**
 * Check a base URL against every rule of {@link baseUrlProblem} — blank,
 * whitespace or control characters, unparseable, a scheme other than
 * `http:`/`https:`, a query or fragment — and return it with trailing slashes
 * stripped. A bad value throws a BundesratValidationError ("Invalid baseUrl:
 * <reason>"): it is a configuration error, not a transport failure. The default
 * transport still gates the scheme per hop, but the engine may be handed a custom
 * transport that does no such check, so the configured value is checked here.
 */
export function validateBaseUrl(raw: string): string {
  return assertValid("baseUrl", raw, baseUrlProblem).replace(/\/+$/, "");
}

/**
 * Whether a body is an HTML page: after any BOM, whitespace, XML declaration,
 * processing instructions and comments, it starts with `<!doctype html` or `<html`.
 * Only the first 4 KiB are looked at, and every skip uses `indexOf`, so this stays
 * cheap whatever the body holds.
 */
function looksLikeHtml(text: string): boolean {
  const head = text.slice(0, 4096);
  let i = 0;
  for (;;) {
    while (i < head.length && (/\s/.test(head[i]!) || head[i] === "\uFEFF")) i += 1;
    const close = head.startsWith("<?", i) ? "?>" : head.startsWith("<!--", i) ? "-->" : undefined;
    if (close === undefined) break;
    const end = head.indexOf(close, i + 2);
    if (end === -1) return false;
    i = end + close.length;
  }
  const rest = head.slice(i, i + 14).toLowerCase();
  return rest.startsWith("<!doctype html") || rest.startsWith("<html");
}

/**
 * Decode an XML body by the encoding its XML declaration names
 * (`<?xml version="1.0" encoding="ISO-8859-1"?>`), UTF-8 when it names none — the
 * XML default. The Content-Type is ignored here too: the CMS labels its feeds
 * inconsistently (see getXml), while the declaration travels with the document.
 * A leading UTF-8 byte-order mark is dropped (TextDecoder does that by default).
 * An encoding TextDecoder doesn't know is a BundesratParseError rather than
 * mojibake.
 */
function decodeXml(body: Buffer, path: string): string {
  const start = body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf ? 3 : 0;
  const head = body.subarray(start, start + 256).toString("latin1");
  const declared = /^\s*<\?xml\s[^>]*?\bencoding\s*=\s*["']([^"']*)["']/.exec(head)?.[1];
  const charset = declared ?? "utf-8";
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    throw new BundesratParseError(
      `Unsupported response charset "${sanitizeServerText(charset)}" from ${path}.`,
    );
  }
  return decoder.decode(body);
}

function htmlPageError(path: string): BundesratParseError {
  return new BundesratParseError(
    `Expected XML from ${path} but received an HTML page — the feed may have moved, ` +
      "or the request lost its ?view=renderXml parameter.",
  );
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class RequestEngine {
  // A real private field (not TypeScript's `private`): util.inspect, console.log and
  // JSON.stringify of a client never show it, so a password in the base URL can't be
  // logged by accident.
  readonly #baseUrl: string;
  /** The base URL's userinfo, raw and percent-decoded, for scrubbing server and transport text. */
  readonly #credentials: string[];
  private readonly transport: Transport;
  private readonly userAgent: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxResponseBytes: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: EngineOptions = {}) {
    // The raw value is checked before the trailing-slash strip, so "https://h/ "
    // cannot slip past it; only an omitted baseUrl selects the default.
    this.#baseUrl = validateBaseUrl(options.baseUrl === undefined ? DEFAULT_BASE_URL : options.baseUrl);
    this.#credentials = credentialsIn(this.#baseUrl).flatMap((raw) => {
      try {
        return [raw, decodeURIComponent(raw)];
      } catch {
        return [raw];
      }
    });
    this.transport = options.transport ?? nodeHttpTransport;
    // Only an omitted userAgent selects the default: a blank one is an error, not
    // a silent fallback, and a malformed one fails here rather than at request time.
    this.userAgent =
      options.userAgent === undefined ? DEFAULT_USER_AGENT : assertHeaderValue("userAgent", options.userAgent);
    this.defaultHeaders = headerOption(options.defaultHeaders);
    this.timeoutMs = intOption("timeoutMs", options.timeoutMs, 30_000, MAX_TIMEOUT_MS);
    this.maxRetries = intOption("maxRetries", options.maxRetries, 2, MAX_RETRIES);
    this.retryDelayMs = intOption("retryDelayMs", options.retryDelayMs, 200, MAX_RETRY_AFTER_MS);
    this.maxResponseBytes = intOption(
      "maxResponseBytes",
      options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      Number.MAX_SAFE_INTEGER,
    );
    this.sleep = options.sleep ?? realSleep;
  }

  /**
   * `text` without the base URL's credentials: server text (an error body that echoes the
   * request URL) and transport text (fetch's "Request cannot be constructed from a URL that
   * includes credentials: <url>") can carry them.
   */
  private scrub(text: string): string {
    return this.#credentials.length === 0 ? text : redactCredentials(text, this.#credentials);
  }

  /**
   * A transport failure as the `cause` of the error the engine raises: the original when its
   * text carries no credentials, otherwise a copy with them scrubbed (message, `code` and the
   * cause chain kept), so logging the error with its causes can't reveal the base URL's
   * password.
   */
  private scrubCause(cause: unknown, depth = 0): unknown {
    if (this.#credentials.length === 0 || depth > 5) return cause;
    if (typeof cause === "string") return this.scrub(cause);
    if (!(cause instanceof Error)) return cause;
    const inner = this.scrubCause(cause.cause, depth + 1);
    const message = this.scrub(cause.message);
    if (message === cause.message && inner === cause.cause && !this.scrub(cause.stack ?? "").includes("***@")) return cause;
    const copy = new Error(message, inner === undefined ? undefined : { cause: inner });
    copy.name = cause.name;
    const code = (cause as { code?: unknown }).code;
    if (code !== undefined) Object.assign(copy, { code });
    return copy;
  }

  /**
   * What the transport threw, as the error the engine raises. The default transport
   * rejects with `BundesratNetworkError` only; an injected one may throw anything (a
   * string, a `TypeError` from fetch). Every failure becomes a `BundesratNetworkError` —
   * a `BundesratError` a caller and the CLI can rely on — with the base URL's credentials
   * scrubbed from its message and cause chain; any other `BundesratError` passes through,
   * and a clean network error stays as it is.
   */
  private transportError(cause: unknown): BundesratError {
    if (cause instanceof BundesratError && !(cause instanceof BundesratNetworkError)) return cause;
    const reason = cause instanceof Error ? cause.message : String(cause);
    const message = sanitizeServerText(this.scrub(reason));
    const scrubbed = this.scrubCause(cause);
    if (cause instanceof BundesratNetworkError && message === cause.message && scrubbed === cause) return cause;
    return new BundesratNetworkError(message, { cause: scrubbed });
  }

  /**
   * Call the transport under the overall deadline (`timeoutMs`): the request gets an
   * AbortSignal that fires at the deadline, and the call rejects then whether the transport
   * stops or not — a custom transport (fetch, a node:http wrapper) that ignores `timeoutMs`
   * can't hang the caller. A synchronous throw becomes a rejection.
   */
  private async callTransport(request: HttpRequest): Promise<HttpResponse> {
    const call = (signal?: AbortSignal): Promise<HttpResponse> =>
      Promise.resolve().then(() => this.transport(signal === undefined ? request : { ...request, signal }));
    if (this.timeoutMs === 0) return call();
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new BundesratNetworkError(`Request exceeded the ${this.timeoutMs}ms deadline`);
        controller.abort(err);
        reject(err);
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([call(controller.signal), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Build a fully-qualified URL from a path and optional query parameters. */
  buildUrl(path: string, query?: QueryParams): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const qs = query ? buildQueryString(query) : "";
    return `${this.#baseUrl}${normalizedPath}${qs ? `?${qs}` : ""}`;
  }

  /**
   * Perform a GET with Accept negotiation and transient-error retries. Redirects
   * are NOT followed — a 3xx surfaces as an error (the canonical host answers
   * directly).
   */
  async request(path: string, query?: QueryParams, accept = "application/xml"): Promise<RawResponse> {
    const url = this.buildUrl(path, query);
    const headers: Record<string, string> = {
      ...this.defaultHeaders,
      Accept: accept,
      "User-Agent": this.userAgent,
    };

    let attempt = 0;
    for (;;) {
      let response: HttpResponse;
      try {
        response = await this.callTransport({
          method: "GET",
          url,
          headers,
          timeoutMs: this.timeoutMs,
          ...(this.maxResponseBytes > 0 ? { maxResponseBytes: this.maxResponseBytes } : {}),
        });
      } catch (cause) {
        // A connection the server (or a gateway) reset is retried like a 503, whichever
        // transport reported it (Node's ECONNRESET, fetch's UND_ERR_SOCKET, anywhere in the
        // cause chain). A refused connection, a DNS failure and a timeout are not: a slow
        // or absent upstream should not be asked again at once.
        if (hasTransientCode(cause) && attempt < this.maxRetries) {
          attempt += 1;
          await this.sleep(this.retryDelayMs * attempt);
          continue;
        }
        throw this.transportError(cause);
      }

      // An injected transport may resolve with anything; a malformed HttpResponse would
      // otherwise surface below as a raw TypeError, outside the error contract.
      const invalid = responseProblem(response);
      if (invalid !== undefined) {
        throw new BundesratNetworkError(`The transport returned an invalid response (${invalid}).`);
      }
      const status = response.status;
      const responseHeaders = plainHeaders(response.headers);
      // fetch gives a Uint8Array; view it as a Buffer (no copy), which the decoder expects.
      const body = bodyBytes(response.body) as Buffer;
      // The size cap holds whatever the transport did: the default one aborts early, a custom
      // one may have read everything.
      if (this.maxResponseBytes > 0 && body.byteLength > this.maxResponseBytes) {
        throw new BundesratNetworkError(sizeLimitMessage(this.maxResponseBytes));
      }
      const retryable = status === 429 || status === 503;
      const retryAfter = retryable ? parseRetryAfter(responseHeaders["retry-after"]) : undefined;
      if (retryable && attempt < this.maxRetries) {
        // Back off linearly (retryDelayMs * attempt). A Retry-After can make the wait longer,
        // never shorter: `Retry-After: 0` or a date in the past turned the retries into a
        // zero-delay burst against a server that had just asked for less load. A Retry-After
        // beyond MAX_RETRY_AFTER_MS is not retried: the error below surfaces at once and
        // names the wait the server asked for.
        if (retryAfter === undefined || retryAfter <= MAX_RETRY_AFTER_MS) {
          attempt += 1;
          const backoff = this.retryDelayMs * attempt;
          await this.sleep(retryAfter === undefined ? backoff : Math.max(retryAfter, backoff));
          continue;
        }
      }

      const contentType = String(responseHeaders["content-type"] ?? "");
      if (status < 200 || status >= 300) {
        const tooLong = retryable && retryAfter !== undefined && retryAfter > MAX_RETRY_AFTER_MS;
        throw this.toApiError(url, status, body, tooLong ? retryAfter : undefined);
      }

      return { data: body, contentType, status };
    }
  }

  /**
   * GET a feed path and parse the XML reply. The Bundesrat feeds require the
   * `view=renderXml` render parameter; without it the server returns its HTML
   * shell, which we detect and reject with a helpful BundesratParseError.
   *
   * NOTE: the response Content-Type is intentionally *ignored*. The Government Site
   * Builder CMS is inconsistent about it (feeds have been seen as `text/plain`,
   * `application/xml`, `text/html`), so we sniff the body — an `<!doctype html>` /
   * `<html>` prefix is the HTML-shell guard — rather than trust the header. Don't
   * "harden" this by validating Content-Type; it would reject valid feeds.
   */
  async getXml(path: string, query?: QueryParams): Promise<XmlValue> {
    return (await this.getXmlDocument(path, query)).value;
  }

  /** Like {@link getXml}, but also returns the root element's name. */
  async getXmlDocument(path: string, query?: QueryParams): Promise<XmlDocument> {
    const res = await this.request(path, query);
    const text = decodeXml(res.data, path);
    if (looksLikeHtml(text)) throw htmlPageError(path);
    // An empty body is not malformed XML — surface it as "empty" rather than the
    // generic parse-failure message so the cause is obvious.
    if (text.trim().length === 0) {
      throw new BundesratParseError(
        `Empty response from ${path} — the feed returned no content (expected XML).`,
      );
    }
    let doc: XmlDocument;
    try {
      doc = parseXmlDocument(text);
    } catch (cause) {
      // Name the parser's reason (nesting too deep, unterminated tag, no root
      // element): run.ts prints only the message, never the cause.
      const reason = sanitizeServerText(cause instanceof Error ? cause.message : String(cause));
      throw new BundesratParseError(`Failed to parse XML response from ${path}: ${reason}`, {
        cause: this.scrubCause(cause),
      });
    }
    // An XHTML page parses as XML; it is still the website, not a feed.
    if (doc.root.toLowerCase() === "html") throw htmlPageError(path);
    return doc;
  }

  private toApiError(url: string, status: number, body: Buffer, retryAfterMs?: number): BundesratApiError {
    // The body is kept on the error (`body`) and may echo the request URL: scrub it.
    const text = this.scrub(body.toString("utf8"));
    // The Bundesrat serves HTML error pages, not a structured envelope; surface a
    // short, whitespace-collapsed snippet only when it is plain (non-HTML) text.
    const snippet = text.trim().replace(/\s+/g, " ");
    let detail =
      snippet.length > 0 && !snippet.startsWith("<")
        ? snippet.length > 200
          ? `${snippet.slice(0, 200)}…`
          : snippet
        : undefined;
    // `detail` came from the response body and lands in an Error.message printed
    // raw to stderr; strip control and bidi characters so a hostile endpoint cannot
    // inject terminal escape sequences or reorder the line.
    if (detail !== undefined) detail = sanitizeServerText(detail);
    return new BundesratApiError({ status, url, method: "GET", body: text, detail, retryAfterMs });
  }
}
