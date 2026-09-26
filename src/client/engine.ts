// The request engine: turns logical (path, query) calls into HTTP GET requests via
// a Transport, applies retry/backoff for transient statuses (429, 503), and decodes
// XML responses. The Bundesrat "API" is the data feed behind the Bundesrat iOS app:
// unauthenticated GETs against www.bundesrat.de whose paths end in `.xml` and must
// carry the `?view=renderXml` render parameter to return XML rather than the
// website's HTML shell.

import { nodeHttpTransport, type Transport } from "./http.js";
import { buildQueryString, type QueryParams } from "./query.js";
import { parseXmlDocument, type XmlDocument, type XmlValue } from "./xml.js";
import { BundesratApiError, BundesratNetworkError, BundesratParseError, redactUrl } from "./errors.js";

export const DEFAULT_BASE_URL = "https://www.bundesrat.de";
const DEFAULT_USER_AGENT = "bundesrat-cli";

export interface RawResponse {
  data: Buffer;
  contentType: string;
  status: number;
}

export interface EngineOptions {
  /** Base URL of the API. Defaults to https://www.bundesrat.de */
  baseUrl?: string;
  /** Swappable transport. Defaults to the built-in node http/https transport. */
  transport?: Transport;
  /** Value of the User-Agent header. */
  userAgent?: string;
  /** Extra headers sent on every request. */
  defaultHeaders?: Record<string, string>;
  /**
   * Time limit per request in milliseconds, covering the whole response body, not
   * only idle gaps (0 disables; capped at `MAX_TIMEOUT_MS`, 2^31 - 1 ms).
   */
  timeoutMs?: number;
  /**
   * Number of automatic retries for transient (429/503) responses. Each waits the
   * response's `Retry-After` (up to `MAX_RETRY_AFTER_MS`; a longer one is not
   * retried), or else `retryDelayMs * attempt`.
   */
  maxRetries?: number;
  /** Base backoff between retries in milliseconds (grows linearly); used without a Retry-After. */
  retryDelayMs?: number;
  /**
   * Hard cap on response body size in bytes (defends against memory exhaustion
   * from a hostile/buggy endpoint). Defaults to 100 MiB; set to 0 for no limit.
   */
  maxResponseBytes?: number;
  /** Injectable sleep, primarily for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_RESPONSE_BYTES = 100 * 1024 * 1024;

/**
 * Longest `Retry-After` the engine waits out before retrying a 429/503. When the
 * server asks for longer, the engine does not retry at all and surfaces the error at
 * once: retrying early would only land inside the window the server asked us to wait
 * out, and a hostile value must not stall the CLI.
 */
export const MAX_RETRY_AFTER_MS = 30_000;

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

/**
 * Reject a base URL whose scheme is not http(s), or that has a query or fragment.
 * The default transport already gates the scheme per hop, but the engine is
 * exported as a library and may be handed a custom transport that does no such
 * check, so gate the configured base URL here too (a `file:`/`ftp:` base URL fails
 * fast with a typed error). Feed paths are appended to the base URL as a string,
 * so a `?` or `#` in it would swallow every path: `http://h/?x` requests
 * `/?x/iOS/...` and `http://h/#f` requests `/`.
 */
function assertHttpScheme(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new BundesratNetworkError(`Invalid base URL: ${redactUrl(baseUrl)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BundesratNetworkError(
      `Unsupported protocol "${url.protocol}" in base URL: ${redactUrl(baseUrl)}`,
    );
  }
  if (/[?#]/.test(baseUrl)) {
    throw new BundesratNetworkError(`Base URL must not contain a query or fragment: ${redactUrl(baseUrl)}`);
  }
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

function htmlPageError(path: string): BundesratParseError {
  return new BundesratParseError(
    `Expected XML from ${path} but received an HTML page — the feed may have moved, ` +
      "or the request lost its ?view=renderXml parameter.",
  );
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class RequestEngine {
  private readonly baseUrl: string;
  private readonly transport: Transport;
  private readonly userAgent: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxResponseBytes: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: EngineOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    assertHttpScheme(this.baseUrl);
    this.transport = options.transport ?? nodeHttpTransport;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.defaultHeaders = options.defaultHeaders ?? {};
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 200;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.sleep = options.sleep ?? realSleep;
  }

  /** Build a fully-qualified URL from a path and optional query parameters. */
  buildUrl(path: string, query?: QueryParams): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const qs = query ? buildQueryString(query) : "";
    return `${this.baseUrl}${normalizedPath}${qs ? `?${qs}` : ""}`;
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
      const response = await this.transport({
        method: "GET",
        url,
        headers,
        timeoutMs: this.timeoutMs,
        ...(this.maxResponseBytes > 0 ? { maxResponseBytes: this.maxResponseBytes } : {}),
      });

      const status = response.status;
      const retryable = status === 429 || status === 503;
      if (retryable && attempt < this.maxRetries) {
        // Honour Retry-After; without a usable one, back off linearly. A Retry-After
        // beyond MAX_RETRY_AFTER_MS is not retried: the error below surfaces at once.
        const retryAfter = parseRetryAfter(response.headers["retry-after"]);
        if (retryAfter === undefined || retryAfter <= MAX_RETRY_AFTER_MS) {
          attempt += 1;
          await this.sleep(retryAfter ?? this.retryDelayMs * attempt);
          continue;
        }
      }

      const contentType = String(response.headers["content-type"] ?? "");
      if (status < 200 || status >= 300) {
        throw this.toApiError(url, status, response.body);
      }

      return { data: response.body, contentType, status };
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
    const text = res.data.toString("utf8");
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
      throw new BundesratParseError(`Failed to parse XML response from ${path}`, { cause });
    }
    // An XHTML page parses as XML; it is still the website, not a feed.
    if (doc.root.toLowerCase() === "html") throw htmlPageError(path);
    return doc;
  }

  private toApiError(url: string, status: number, body: Buffer): BundesratApiError {
    const text = body.toString("utf8");
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
    return new BundesratApiError({ status, url, method: "GET", body: text, detail });
  }
}
