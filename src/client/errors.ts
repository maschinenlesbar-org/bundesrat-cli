// Error types raised by the client. Kept free of any I/O so they are trivial to
// construct in tests and to `instanceof`-check by consumers.

/**
 * Replace the userinfo of a URL (`https://user:secret@host/...`) with `***`, so a
 * credential in a base URL never reaches an error message, a log or CI output.
 * A URL without userinfo, or one that does not parse, is returned unchanged.
 */
export function redactUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.username === "" && parsed.password === "") return url;
  parsed.username = "***";
  parsed.password = "";
  return parsed.href;
}

/** Base class for every error originating from this client. */
export class BundesratError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * The API responded with a non-2xx HTTP status. `detail` holds a short snippet of
 * the response body when a useful textual one is present.
 */
export class BundesratApiError extends BundesratError {
  readonly status: number;
  readonly detail: string | undefined;
  readonly url: string;
  readonly method: string;
  readonly body: string;

  constructor(args: { status: number; url: string; method: string; body: string; detail?: string }) {
    // The URL is shown without userinfo: a credential in --base-url must not leak.
    const url = redactUrl(args.url);
    const detailPart = args.detail ? `: ${args.detail}` : "";
    super(`HTTP ${args.status} for ${args.method} ${url}${detailPart}`);
    this.status = args.status;
    this.url = url;
    this.method = args.method;
    this.body = args.body;
    this.detail = args.detail;
  }

  /** True for HTTP statuses the API treats as transient and retry-able. */
  get isRetryable(): boolean {
    return this.status === 429 || this.status === 503;
  }

  /** True for a transport-level HTTP 404. */
  get isNotFound(): boolean {
    return this.status === 404;
  }
}

/** A transport-level failure (DNS, connection reset, timeout, ...). */
export class BundesratNetworkError extends BundesratError {}

/** A client-side validation error (e.g. an unknown feed name) — no request made. */
export class BundesratValidationError extends BundesratError {}

/**
 * The response body could not be parsed as the expected XML. Most often this means
 * the endpoint returned the website's HTML shell instead of the XML feed (i.e. the
 * `?view=renderXml` render parameter was lost, or the feed moved).
 */
export class BundesratParseError extends BundesratError {}
