// The request engine: turns logical (path, query) calls into HTTP GET requests via
// a Transport, applies retry/backoff for transient statuses (429, 503), and decodes
// XML responses. The Bundesrat "API" is the data feed behind the Bundesrat iOS app:
// unauthenticated GETs against www.bundesrat.de whose paths end in `.xml` and must
// carry the `?view=renderXml` render parameter to return XML rather than the
// website's HTML shell.

import { nodeHttpTransport, type Transport } from "./http.js";
import { buildQueryString, type QueryParams } from "./query.js";
import { parseXml, type XmlValue } from "./xml.js";
import { BundesratApiError, BundesratParseError } from "./errors.js";

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
  /** Per-request timeout in milliseconds (0 disables). */
  timeoutMs?: number;
  /** Number of automatic retries for transient (429/503) responses. */
  maxRetries?: number;
  /** Base backoff between retries in milliseconds (grows linearly). */
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
        attempt += 1;
        await this.sleep(this.retryDelayMs * attempt);
        continue;
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
   */
  async getXml(path: string, query?: QueryParams): Promise<XmlValue> {
    const res = await this.request(path, query);
    const text = res.data.toString("utf8");
    const head = text.trimStart().slice(0, 200).toLowerCase();
    if (head.startsWith("<!doctype html") || head.startsWith("<html")) {
      throw new BundesratParseError(
        `Expected XML from ${path} but received an HTML page — the feed may have moved, ` +
          "or the request lost its ?view=renderXml parameter.",
      );
    }
    // An empty body is not malformed XML — surface it as "empty" rather than the
    // generic parse-failure message so the cause is obvious.
    if (text.trim().length === 0) {
      throw new BundesratParseError(
        `Empty response from ${path} — the feed returned no content (expected XML).`,
      );
    }
    try {
      return parseXml(text);
    } catch (cause) {
      throw new BundesratParseError(`Failed to parse XML response from ${path}`, { cause });
    }
  }

  private toApiError(url: string, status: number, body: Buffer): BundesratApiError {
    const text = body.toString("utf8");
    // The Bundesrat serves HTML error pages, not a structured envelope; surface a
    // short, whitespace-collapsed snippet only when it is plain (non-HTML) text.
    const snippet = text.trim().replace(/\s+/g, " ");
    const detail =
      snippet.length > 0 && !snippet.startsWith("<")
        ? snippet.length > 200
          ? `${snippet.slice(0, 200)}…`
          : snippet
        : undefined;
    return new BundesratApiError({ status, url, method: "GET", body: text, detail });
  }
}
