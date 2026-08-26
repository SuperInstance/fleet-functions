// fleet-functions — the index of capability.
//
// fleet-twin indexes what the fleet KNOWS. This indexes what the fleet CAN DO.
// Every callable function in the agent network — MCP tools, HTTP endpoints,
// manual protocols — is registered with an honest description, embedded with
// bge-base-en-v1.5, and discovered by meaning: an agent asks /search with an
// intent in plain words and gets back ranked function cards with instructions
// for how to call them.
//
// Endpoints:
//   POST /register  {name, ns, description, signature?, invoke_kind, invoke_target, ...}
//                   → embed, store, return id. Idempotent by ns/name (upsert).
//   POST /search    {intent, topK?, ns?} → ranked function cards.
//   POST /invoke    {name, args?, ns?}  → http: safe proxy; mcp/manual: the contract.
//   GET  /fn/{name} (or /fn/{ns}/{name}) → one card.
//   GET  /health, GET /stats, GET / (contract listing).
//
// Honesty rule: the registry never fabricates results it can't produce.
// For mcp and manual kinds, /invoke returns the invocation contract for the
// caller to execute. A proxied http call reports the upstream answer as-is.

export { isSafeHttpUrl, proxyHttpCall } from "./invoke";
import { proxyHttpCall, FLEET_UA } from "./invoke";

export interface Env {
  VECTORIZE: VectorizeIndex;
  AI: AiBinding;
  DB: D1Database;
  REGISTER_TOKEN?: string;
  INVOKE_SECRET_FLEET_TWIN?: string; // env-kind auth example: twin ingest token
}

interface AiBinding {
  run(
    model: string,
    input: { text: string[] }
  ): Promise<{ shape?: number[]; data?: number[] | number[][] }>;
}

export const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";
export const EMBED_DIMENSIONS = 768;
const MAX_TOPK = 20;
const MAX_DESC = 4000;

interface FunctionRow {
  id: string;
  name: string;
  ns: string;
  description: string;
  signature_json: string;
  invoke_kind: string;
  invoke_target: string;
  auth_kind: string;
  owner: string;
  version: number;
  deprecated: number;
  created_at: string;
  updated_at: string;
  calls_ok: number;
  calls_fail: number;
}

interface RegisterBody {
  name?: string;
  ns?: string;
  description?: string;
  signature?: unknown;
  aliases?: string[]; // honest intent paraphrases — embedded with primacy, shown on the card
  invoke_kind?: string;
  invoke_target?: unknown;
  auth_kind?: string;
  owner?: string;
  deprecated?: boolean;
}

const CORS_METHODS = "GET, POST, OPTIONS";
const CORS_HEADERS_ALLOW = "Content-Type, Authorization";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/") return contract(cors);
      if (request.method === "GET" && url.pathname === "/health") {
        return json(
          {
            ok: true,
            name: "fleet-functions",
            doctrine: "capability discovered by meaning",
            model: EMBED_MODEL,
            dimensions: EMBED_DIMENSIONS,
            userAgent: FLEET_UA,
            time: new Date().toISOString(),
          },
          cors
        );
      }
      if (request.method === "GET" && url.pathname === "/stats") {
        return await handleStats(env, cors);
      }
      if (request.method === "POST" && url.pathname === "/register") {
        return await handleRegister(request, env, cors);
      }
      if (request.method === "POST" && url.pathname === "/search") {
        return await handleSearch(request, env, cors);
      }
      if (request.method === "POST" && url.pathname === "/invoke") {
        return await handleInvoke(request, env, cors);
      }
      if (request.method === "GET" && url.pathname.startsWith("/fn/")) {
        return await handleCard(url.pathname.slice(4), env, cors);
      }
      return json({ error: "not found" }, cors, 404);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return json({ error: "internal", detail }, cors, 500);
    }
  },
};

// ---------- GET / (the contract, honest and short) ----------

function contract(cors: Record<string, string>): Response {
  return json(
    {
      name: "fleet-functions",
      what: "the fleet's index of capability — functions discovered by meaning",
      endpoints: {
        "POST /register":
          "{name, ns, description, signature?, invoke_kind: http|mcp|manual, invoke_target, auth_kind?, owner?, deprecated?} — bearer token; idempotent by ns/name",
        "POST /search": "{intent, topK?, ns?} — semantic search; returns ranked function cards",
        "POST /invoke":
          "{name, ns?, args?, bearer?} — http kind: proxied (https-only, no internal addresses, 10s timeout); mcp/manual: the invocation contract, honestly not executed here",
        "GET /fn/{name}": "one function card (or /fn/{ns}/{name} when names collide)",
        "GET /stats": "function count, by namespace",
        "GET /health": "liveness",
      },
      doctrine:
        "the registry never fabricates results it can't produce — mcp/manual kinds return their invocation contract for the caller to run",
    },
    cors
  );
}

// ---------- GET /stats ----------

async function handleStats(env: Env, cors: Record<string, string>): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT ns, COUNT(*) as n FROM functions WHERE deprecated = 0 GROUP BY ns ORDER BY n DESC`
  ).all<{ ns: string; n: number }>();
  const total = (results || []).reduce((a, r) => a + r.n, 0);
  const { results: dep } = await env.DB.prepare(
    `SELECT COUNT(*) as n FROM functions WHERE deprecated = 1`
  ).all<{ n: number }>();
  const calls = await env.DB.prepare(
    `SELECT COALESCE(SUM(calls_ok),0) AS ok, COALESCE(SUM(calls_fail),0) AS fail FROM functions`
  ).first<{ ok: number; fail: number }>();
  return json(
    {
      functions: total,
      deprecated: dep?.[0]?.n ?? 0,
      byNs: Object.fromEntries((results || []).map((r) => [r.ns, r.n])),
      calls: { ok: calls?.ok ?? 0, fail: calls?.fail ?? 0 },
      model: EMBED_MODEL,
      dimensions: EMBED_DIMENSIONS,
    },
    cors
  );
}

// ---------- POST /register ----------

async function handleRegister(
  request: Request,
  env: Env,
  cors: Record<string, string>
): Promise<Response> {
  if (!env.REGISTER_TOKEN) {
    return json({ error: "register token not configured" }, cors, 500);
  }
  const auth = request.headers.get("Authorization") || "";
  const given = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!given || !tokenEquals(given, env.REGISTER_TOKEN)) {
    return json({ error: "unauthorized" }, cors, 401);
  }

  const body = (await request.json().catch(() => null)) as RegisterBody | null;
  if (!body) return json({ error: "body must be JSON" }, cors, 400);

  const name = (body.name || "").trim();
  const ns = (body.ns || "").trim();
  const description = (body.description || "").trim();
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
    return json({ error: "name must be slug-like: letters, digits, . _ -" }, cors, 400);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(ns)) {
    return json({ error: "ns must be slug-like: letters, digits, -" }, cors, 400);
  }
  if (description.length < 10) {
    return json({ error: "description too short (10+ chars) — it IS the index" }, cors, 400);
  }
  if (description.length > MAX_DESC) {
    return json({ error: `description over ${MAX_DESC} chars` }, cors, 400);
  }
  const invokeKind = body.invoke_kind || "manual";
  if (!["http", "mcp", "manual"].includes(invokeKind)) {
    return json(
      { error: "invoke_kind must be http, mcp, or manual" },
      cors,
      400
    );
  }
  const authKind = body.auth_kind || "none";
  if (!["none", "bearer", "env"].includes(authKind)) {
    return json({ error: "auth_kind must be none, bearer, or env" }, cors, 400);
  }
  const target = body.invoke_target;
  if (typeof target !== "object" || target === null || Array.isArray(target)) {
    return json({ error: "invoke_target must be an object (the contract)" }, cors, 400);
  }

  const id = `fn:${ns}:${name}`;
  const existing = await env.DB.prepare(
    `SELECT id, version, created_at FROM functions WHERE id = ?`
  )
    .bind(id)
    .first<{ id: string; version: number; created_at: string }>();

  // What gets embedded — ORDER MATTERS with a mean-pooled base model:
  // name, aliases and use-when sentences lead; the full body follows.
  // An intent can name the verb OR the noun ("transpose", "swing", "liveness").
  const signature = (body.signature ?? {}) as {
    params?: Record<string, unknown>;
  };
  const aliases = Array.isArray(body.aliases) ? body.aliases.filter((a) => typeof a === "string") : [];
  if (aliases.length > 12) {
    return json({ error: "max 12 aliases" }, cors, 400);
  }
  // aliases ride inside signature_json (the function's find-and-call shape)
  const signatureStored = aliases.length ? { ...signature, aliases } : signature;
  const embedText = embedTextFor(name, ns, description, signatureStored);
  const [vector] = await embedBatch(env, [embedText]);

  await env.VECTORIZE.upsert([
    {
      id,
      values: vector,
      // deprecated as STRING: string $eq filters work on stored metadata
      // without a metadata index (the fleet-twin lesson — its source/type
      // filters are all strings). Numeric $eq needs an index we don't have.
      metadata: { name, ns, deprecated: body.deprecated ? "1" : "0" },
    },
  ]);

  const now = new Date().toISOString();
  if (existing) {
    await env.DB.prepare(
      `UPDATE functions SET description=?, signature_json=?, invoke_kind=?,
        invoke_target=?, auth_kind=?, owner=?, deprecated=?, version=version+1,
        updated_at=? WHERE id=?`
    )
      .bind(
        description,
        JSON.stringify(signatureStored),
        invokeKind,
        JSON.stringify(target),
        authKind,
        body.owner || "fleet",
        body.deprecated ? 1 : 0,
        now,
        id
      )
      .run();
    return json({ id, status: "updated", version: existing.version + 1 }, cors);
  }

  await env.DB.prepare(
    `INSERT INTO functions (id, name, ns, description, signature_json,
       invoke_kind, invoke_target, auth_kind, owner, version, deprecated,
       created_at, updated_at, calls_ok, calls_fail)
     VALUES (?,?,?,?,?,?,?,?,?,1,?,?,?,0,0)`
  )
    .bind(
      id,
      name,
      ns,
      description,
      JSON.stringify(signatureStored),
      invokeKind,
      JSON.stringify(target),
      authKind,
      body.owner || "fleet",
      body.deprecated ? 1 : 0,
      now,
      now
    )
    .run();
  return json({ id, status: "created", version: 1 }, cors, 201);
}

function embedTextFor(
  name: string,
  ns: string,
  description: string,
  signature: unknown
): string {
  const sig = signature as {
    params?: Record<string, { description?: string }>;
    aliases?: string[];
  };
  const head = [`${name} (${ns})`];
  if (sig?.aliases?.length) head.push(`also called: ${sig.aliases.join(", ")}`);
  // pull use-when sentences to the front — they carry the intent vocabulary
  const sentences = description.split(/(?<=\.)\s+/);
  const useWhen = sentences.filter((s) => /^use (it |when|to )/i.test(s));
  const rest = sentences.filter((s) => !useWhen.includes(s));
  if (sig?.params) {
    const argNames = Object.keys(sig.params).join(", ");
    if (argNames) useWhen.push(`parameters: ${argNames}`);
  }
  return [...head, ...useWhen, rest.join(" ")].join("\n").slice(0, MAX_DESC * 2);
}

// ---------- POST /search ----------

interface SearchBody {
  intent?: string;
  topK?: number;
  ns?: string;
  includeDeprecated?: boolean;
}

async function handleSearch(
  request: Request,
  env: Env,
  cors: Record<string, string>
): Promise<Response> {
  const body = (await request.json().catch(() => null)) as SearchBody | null;
  if (!body?.intent || !body.intent.trim()) {
    return json({ error: "body must be { intent, topK?, ns? }" }, cors, 400);
  }
  const topK = Math.max(1, Math.min(MAX_TOPK, body.topK ?? 5));

  const [queryVec] = await embedBatch(env, [body.intent]);

  // Query WITHOUT vector-side filters: this index's metadata filters were
  // unreliable during backfill (2026-08-26), and D1 holds the truth anyway.
  // Over-fetch wide, join D1, filter ns/deprecated on the row, cut to topK.
  const results = await env.VECTORIZE.query(queryVec, {
    topK: Math.min(topK * 4, 100), // no metadata returned → up to 100 allowed
    returnMetadata: "none",
  } as Parameters<VectorizeIndex["query"]>[1]);

  const matches = results.matches || [];
  if (matches.length === 0) {
    return json({ intent: body.intent, topK, results: [] }, cors);
  }

  // Pull the full cards from D1 (the vector only carries the id).
  const ids = matches.map((m) => m.id);
  const placeholders = ids.map(() => "?").join(",");
  const { results: rows } = await env.DB.prepare(
    `SELECT * FROM functions WHERE id IN (${placeholders})`
  )
    .bind(...ids)
    .all<FunctionRow>();

  const byId = new Map((rows || []).map((r) => [r.id, r]));
  const cards = [];
  for (const m of matches) {
    const row = byId.get(m.id);
    if (!row) continue; // vector present, row gone — skip honestly
    // D1-side truth: ns filter and deprecation live on the row.
    if (body.ns && row.ns !== body.ns) continue;
    if (!body.includeDeprecated && row.deprecated === 1) continue;
    cards.push({ score: round(m.score, 4), ...cardOf(row) });
    if (cards.length >= topK) break;
  }

  return json({ intent: body.intent, topK, results: cards }, cors);
}

// ---------- POST /invoke ----------

interface InvokeBody {
  name?: string;
  ns?: string;
  args?: unknown;
  bearer?: string; // for auth_kind=bearer targets: the caller's own credential
}

async function handleInvoke(
  request: Request,
  env: Env,
  cors: Record<string, string>
): Promise<Response> {
  const body = (await request.json().catch(() => null)) as InvokeBody | null;
  if (!body?.name) {
    return json({ error: "body must be { name, ns?, args?, bearer? }" }, cors, 400);
  }
  const row = await findFunction(env, body.name, body.ns);
  if (!row) {
    return json(
      { error: "unknown function", name: body.name, ns: body.ns || "(any)" },
      cors,
      404
    );
  }

  const target = JSON.parse(row.invoke_target) as Record<string, unknown>;

  // ---- mcp / manual: the contract, honestly not executed here ----
  if (row.invoke_kind !== "http") {
    await countCall(env, row.id, true); // a contract handoff is a success
    return json(
      {
        executed: false,
        reason:
          row.invoke_kind === "mcp"
            ? "mcp tools run in their own process — here is the exact call to make"
            : "manual protocol — here is the contract to follow",
        function: cardOf(row),
        contract: {
          kind: row.invoke_kind,
          target,
          args: body.args ?? null,
          auth: row.auth_kind === "none" ? "none" : `${row.auth_kind} (caller supplies)`,
        },
      },
      cors
    );
  }

  // ---- http: the safe proxy ----
  const url = typeof target.url === "string" ? target.url : "";
  const method =
    (typeof target.method === "string" && target.method) ||
    (body.args !== undefined ? "POST" : "GET");
  const headers: Record<string, string> = {};
  if (target.headers && typeof target.headers === "object") {
    Object.assign(headers, target.headers as Record<string, string>);
  }

  if (row.auth_kind === "bearer") {
    if (!body.bearer) {
      await countCall(env, row.id, false);
      return json(
        {
          error: "auth required",
          hint: "this target needs a bearer token — pass { bearer } in the invoke body",
        },
        cors,
        401
      );
    }
    headers["Authorization"] = `Bearer ${body.bearer}`;
  } else if (row.auth_kind === "env" && typeof target.env_secret === "string") {
    const secret = (env as unknown as Record<string, string | undefined>)[
      target.env_secret
    ];
    if (!secret) {
      await countCall(env, row.id, false);
      return json(
        {
          error: "auth not configured",
          hint: `env secret ${target.env_secret} is not set on the registry`,
        },
        cors,
        500
      );
    }
    headers["Authorization"] = `Bearer ${secret}`;
  }

  const outcome = await proxyHttpCall(
    { url, method, headers },
    { method, body: body.args !== undefined ? JSON.stringify(body.args) : undefined }
  );

  if (outcome.refused) {
    await countCall(env, row.id, false);
    return json(
      {
        executed: false,
        refused: outcome.refused,
        note: "the proxy fence refused this call — https only, no internal addresses",
        function: cardOf(row),
        contract: { kind: "http", target: { url } },
      },
      cors,
      400
    );
  }

  const result = outcome.result!;
  await countCall(env, row.id, result.ok);
  return json(
    {
      executed: true,
      function: cardOf(row),
      upstream: {
        status: result.status,
        statusText: result.statusText,
        elapsedMs: result.elapsedMs,
        truncated: result.truncated,
      },
      response: safeParse(result.body),
    },
    cors,
    result.status >= 200 && result.status < 600 ? 200 : 200 // registry answers 200; upstream status lives inside
  );
}

// ---------- GET /fn/{name} ----------

async function handleCard(
  rest: string,
  env: Env,
  cors: Record<string, string>
): Promise<Response> {
  const parts = rest.split("/").filter(Boolean);
  const row =
    parts.length >= 2
      ? await findFunction(env, parts[1], parts[0])
      : await findFunction(env, parts[0] || "");
  if (!row) return json({ error: "unknown function" }, cors, 404);
  return json(cardOf(row), cors);
}

// ---------- helpers ----------

async function findFunction(
  env: Env,
  name: string,
  ns?: string
): Promise<FunctionRow | null> {
  if (ns) {
    return env.DB.prepare(`SELECT * FROM functions WHERE ns=? AND name=?`)
      .bind(ns, name)
      .first<FunctionRow>();
  }
  return env.DB.prepare(`SELECT * FROM functions WHERE name=?`)
    .bind(name)
    .first<FunctionRow>();
}

function cardOf(row: FunctionRow) {
  return {
    id: row.id,
    name: row.name,
    ns: row.ns,
    description: row.description,
    signature: JSON.parse(row.signature_json),
    invoke: {
      kind: row.invoke_kind,
      target: JSON.parse(row.invoke_target),
      auth: row.auth_kind,
    },
    owner: row.owner,
    version: row.version,
    deprecated: row.deprecated === 1,
    calls: { ok: row.calls_ok, fail: row.calls_fail },
    updated_at: row.updated_at,
  };
}

async function countCall(env: Env, id: string, ok: boolean): Promise<void> {
  await env.DB.prepare(
    ok
      ? `UPDATE functions SET calls_ok = calls_ok + 1 WHERE id=?`
      : `UPDATE functions SET calls_fail = calls_fail + 1 WHERE id=?`
  )
    .bind(id)
    .run();
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function round(n: number, digits: number): number {
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

async function embedBatch(env: Env, texts: string[]): Promise<number[][]> {
  const res = await env.AI.run(EMBED_MODEL, { text: texts });
  const data = res.data;
  if (!data) throw new Error("embedding response missing data");
  if (Array.isArray(data[0])) return data as number[][];
  if (texts.length === 1) return [data as unknown as number[]];
  const out: number[][] = [];
  for (const t of texts) out.push(...(await embedBatch(env, [t])));
  return out;
}

function tokenEquals(given: string, expected: string): boolean {
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) {
    diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

function corsHeaders(origin: string): Record<string, string> {
  const h: Record<string, string> = {
    "Access-Control-Allow-Methods": CORS_METHODS,
    "Access-Control-Allow-Headers": CORS_HEADERS_ALLOW,
    "Content-Type": "application/json",
  };
  const allowed =
    origin.endsWith(".pages.dev") ||
    origin === "http://localhost" ||
    origin.startsWith("http://localhost:");
  if (origin && allowed) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Vary"] = "Origin";
  }
  return h;
}

function json(obj: unknown, cors: Record<string, string>, status = 200): Response {
  return new Response(JSON.stringify(obj, null, 2), { status, headers: cors });
}
