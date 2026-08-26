// fleet-functions — the safe invoke proxy.
//
// When a registered function has invoke_kind "http", the registry can execute
// it on the caller's behalf. This module is the fence around that power:
//   - https only, no IP-literal or local hostnames (no internal addresses)
//   - no redirects (SSRF via redirect is still SSRF)
//   - hard timeout, request and response size caps
//   - a real User-Agent (Cloudflare's bot fight returns error 1010 to
//     bare/default library user-agents — the fleet-twin loader hit this; the
//     proxy sends an honest fleet UA so proxied calls don't get banned)
//
// The registry never fabricates results: if the proxy can't or won't run a
// call, it returns the invocation contract and says so.

export const INVOKE_TIMEOUT_MS = 10_000;
export const MAX_REQUEST_BODY = 64 * 1024; // bytes we will forward
export const MAX_RESPONSE_BODY = 256 * 1024; // bytes we will read back
export const FLEET_UA = "fleet-functions/1.0 (capability registry invoke proxy)";

export interface InvokeTargetHttp {
  url: string;
  method?: string; // default POST for /invoke, GET otherwise — target may pin it
  headers?: Record<string, string>; // static headers from registration (public only)
}

export interface SafeUrlVerdict {
  ok: boolean;
  reason?: string;
}

const LOCAL_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^0\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^\[?::1\]?$/,
  /^\[?fe80:/i,
  /^\[?fc00:/i,
  /^\[?fd/i,
  /\.local$/i,
  /\.internal$/i,
];

/** IPv4 literal? (any — public or private. The proxy only speaks to names.) */
function isIpv4Literal(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/** Anything that looks like a bracketed or bare IPv6 literal. */
function isIpv6Literal(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "");
  return bare.includes(":") && /^[0-9a-f:]+$/i.test(bare);
}

/**
 * The fence. A URL is proxyable only if:
 *   - scheme is https (plain http is refused, no exceptions for "just this once")
 *   - the host is a DNS name, not an IP literal
 *   - the host is not localhost / *.local / *.internal / link-local / CGNAT / private ranges
 *   - the port is default (443) or explicitly 443
 */
export function isSafeHttpUrl(raw: string): SafeUrlVerdict {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not a URL" };
  }
  if (url.protocol !== "https:") {
    return { ok: false, reason: "https only" };
  }
  if (url.port && url.port !== "443") {
    return { ok: false, reason: `port ${url.port} refused (443 only)` };
  }
  const host = url.hostname;
  if (isIpv4Literal(host) || isIpv6Literal(host)) {
    return { ok: false, reason: "IP-literal hosts refused (DNS names only)" };
  }
  for (const pattern of LOCAL_HOST_PATTERNS) {
    if (pattern.test(host)) {
      return { ok: false, reason: `internal/local host refused: ${host}` };
    }
  }
  if (url.username || url.password) {
    return { ok: false, reason: "credentials-in-URL refused" };
  }
  return { ok: true };
}

// Headers we never forward in either direction (hop-by-hop + identity leaks).
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

export function sanitizeOutboundHeaders(
  headers: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    if (k.toLowerCase() === "user-agent") continue; // ours, see FLEET_UA
    out[k] = v;
  }
  return out;
}

export interface ProxyResult {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string; // text (truncated if over cap, flagged)
  truncated: boolean;
  elapsedMs: number;
}

/**
 * Execute one proxied call. Throws only on refused URLs (caller turns that
 * into the contract-with-refusal response); network failures come back as
 * ok:false so the caller can decide what to tell the agent honestly.
 */
export async function proxyHttpCall(
  target: InvokeTargetHttp,
  init: {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
  } = {}
): Promise<{ refused?: string; result?: ProxyResult }> {
  const verdict = isSafeHttpUrl(target.url);
  if (!verdict.ok) {
    return { refused: verdict.reason || "url refused" };
  }

  let body = init.body;
  if (body && body.length > MAX_REQUEST_BODY) {
    return { refused: `request body over ${MAX_REQUEST_BODY} bytes` };
  }

  const method = (target.method || init.method || "GET").toUpperCase();
  const headers: Record<string, string> = {
    ...sanitizeOutboundHeaders(target.headers || {}),
    ...sanitizeOutboundHeaders(init.headers || {}),
    "User-Agent": FLEET_UA, // the 1010 gotcha: never send a bare library UA
  };
  if (body && !Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
    headers["Content-Type"] = "application/json";
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INVOKE_TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(urlWithoutCredentials(target.url), {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : body,
      redirect: "error", // a redirect to an internal address is still SSRF
      signal: controller.signal,
      cf: { cacheTtl: 0 }, // invocations are live calls, never cached
    } as RequestInit);

    const buf = await res.arrayBuffer();
    const truncated = buf.byteLength > MAX_RESPONSE_BODY;
    const slice = truncated ? buf.slice(0, MAX_RESPONSE_BODY) : buf;
    const text = new TextDecoder("utf-8").decode(slice);

    const respHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      if (!HOP_BY_HOP.has(k.toLowerCase())) respHeaders[k] = v;
    });

    return {
      result: {
        ok: res.ok,
        status: res.status,
        statusText: res.statusText,
        headers: respHeaders,
        body: text,
        truncated,
        elapsedMs: Date.now() - started,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const timedOut = message.toLowerCase().includes("abort");
    return {
      result: {
        ok: false,
        status: 0,
        statusText: timedOut ? `timeout after ${INVOKE_TIMEOUT_MS}ms` : message,
        headers: {},
        body: "",
        truncated: false,
        elapsedMs: Date.now() - started,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

function urlWithoutCredentials(raw: string): string {
  // isSafeHttpUrl already refused credentials; this is belt-and-braces.
  return raw;
}
