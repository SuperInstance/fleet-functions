// In-memory fakes for D1, Vectorize, and the AI binding — honest enough to
// test the three journeys in-process. The embedding fake is deterministic:
// it hashes tokens into a 768-d space, so "swing/dynamics" language lands
// near descriptions that share its words. Not semantic, but stable — which
// is what ranking-order tests need.

import type { Env } from "../src/worker";

export type EnvWithFakes = Env & {
  __d1: ReturnType<typeof fakeD1>;
  __vec: ReturnType<typeof fakeVectorize>;
};

// ---------- deterministic fake embeddings ----------

const DIM = 768;

function hashVec(text: string): number[] {
  const v = new Array(DIM).fill(0);
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) || [];
  for (const tok of tokens) {
    let h = 2166136261;
    for (let i = 0; i < tok.length; i++) {
      h ^= tok.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const idx = Math.abs(h) % DIM;
    const sign = (Math.abs(h >> 5) & 1) === 1 ? 1 : -1;
    v[idx] += sign;
  }
  const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

function cosine(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// ---------- fake AI ----------

export function fakeAI() {
  return {
    async run(_model: string, input: { text: string[] }) {
      return { data: input.text.map(hashVec) };
    },
  };
}

// ---------- fake Vectorize ----------

interface StoredVector {
  id: string;
  values: number[];
  metadata: Record<string, unknown>;
}

export function fakeVectorize() {
  const store = new Map<string, StoredVector>();
  return {
    store,
    async upsert(vectors: StoredVector[]) {
      for (const v of vectors) store.set(v.id, { ...v });
    },
    async query(
      vector: number[],
      opts: { topK?: number; filter?: Record<string, unknown>; returnMetadata?: string } = {}
    ) {
      const topK = opts.topK ?? 5;
      let all = [...store.values()];
      if (opts.filter) {
        for (const [key, clause] of Object.entries(opts.filter)) {
          const eq = (clause as { $eq?: unknown }).$eq;
          all = all.filter((v) => v.metadata[key] === eq);
        }
      }
      const scored = all
        .map((v) => ({ id: v.id, score: cosine(vector, v.values), metadata: v.metadata }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
      return { matches: scored };
    },
  };
}

// ---------- fake D1 (just enough of the .prepare/.bind/.first/.all/.run API) ----------

interface Row { [col: string]: unknown }

export function fakeD1() {
  const tables: Record<string, Row[]> = { functions: [] };
  let idCounter = 0;

  function materialize(sql: string, binds: unknown[]): { rows: Row[]; action: string } {
    // Ultra-small SQL interpreter for the exact statements the worker issues.
    if (sql.startsWith("INSERT INTO functions")) {
      // 12 binds: id,name,ns,desc,sig,kind,target,auth,owner,deprecated,created,updated
      tables.functions.push({
        id: binds[0], name: binds[1], ns: binds[2], description: binds[3],
        signature_json: binds[4], invoke_kind: binds[5], invoke_target: binds[6],
        auth_kind: binds[7], owner: binds[8], version: 1, deprecated: binds[9],
        created_at: binds[10], updated_at: binds[11], calls_ok: 0, calls_fail: 0,
      });
      return { rows: [], action: "insert" };
    }
    if (sql.startsWith("UPDATE functions SET calls_ok")) {
      const row = tables.functions.find((r) => r.id === binds[0]);
      if (row) row.calls_ok = (row.calls_ok as number) + 1;
      return { rows: [], action: "count-ok" };
    }
    if (sql.startsWith("UPDATE functions SET calls_fail")) {
      const row = tables.functions.find((r) => r.id === binds[0]);
      if (row) row.calls_fail = (row.calls_fail as number) + 1;
      return { rows: [], action: "count-fail" };
    }
    if (sql.startsWith("UPDATE functions SET description")) {
      const row = tables.functions.find((r) => r.id === binds[9]);
      if (row) {
        row.description = binds[0];
        row.signature_json = binds[1];
        row.invoke_kind = binds[2];
        row.invoke_target = binds[3];
        row.auth_kind = binds[4];
        row.owner = binds[5];
        row.deprecated = binds[6];
        row.updated_at = binds[7];
        row.version = (row.version as number) + 1;
      }
      return { rows: [], action: "update" };
    }
    if (sql.startsWith("SELECT * FROM functions WHERE ns=? AND name=?")) {
      return { rows: tables.functions.filter((r) => r.ns === binds[0] && r.name === binds[1]), action: "select" };
    }
    if (sql.startsWith("SELECT * FROM functions WHERE name=?")) {
      return { rows: tables.functions.filter((r) => r.name === binds[0]), action: "select" };
    }
    if (sql.startsWith("SELECT * FROM functions WHERE id IN")) {
      const ids = binds as string[];
      return { rows: tables.functions.filter((r) => ids.includes(r.id as string)), action: "select" };
    }
    if (sql.startsWith("SELECT id, version, created_at FROM functions WHERE id")) {
      return { rows: tables.functions.filter((r) => r.id === binds[0]), action: "select" };
    }
    if (sql.includes("GROUP BY ns")) {
      const byNs: Record<string, number> = {};
      for (const r of tables.functions) {
        if (r.deprecated !== 1) byNs[r.ns as string] = (byNs[r.ns as string] || 0) + 1;
      }
      return {
        rows: Object.entries(byNs).map(([ns, n]) => ({ ns, n })),
        action: "select",
      };
    }
    if (sql.includes("SUM(calls_ok)")) {
      const ok = tables.functions.reduce((a, r) => a + (r.calls_ok as number), 0);
      const fail = tables.functions.reduce((a, r) => a + (r.calls_fail as number), 0);
      return { rows: [{ ok, fail }], action: "select" };
    }
    if (sql.includes("deprecated = 1")) {
      return { rows: [{ n: tables.functions.filter((r) => r.deprecated === 1).length }], action: "select" };
    }
    throw new Error(`fakeD1: unsupported SQL: ${sql.slice(0, 80)}`);
  }

  return {
    tables,
    prepare(sql: string) {
      idCounter += 1;
      let binds: unknown[] = [];
      return {
        bind(...args: unknown[]) {
          binds = args;
          return this;
        },
        async first<T>() {
          const { rows } = materialize(sql, binds);
          return (rows[0] as T) || null;
        },
        async all<T>() {
          const { rows } = materialize(sql, binds);
          return { results: rows as T[] };
        },
        async run() {
          materialize(sql, binds);
          return { success: true };
        },
      };
    },
  };
}

export function makeEnv(overrides: Partial<Env> = {}): Env & {
  __d1: ReturnType<typeof fakeD1>;
  __vec: ReturnType<typeof fakeVectorize>;
} {
  const d1 = fakeD1();
  const vec = fakeVectorize();
  const env = {
    DB: d1 as unknown as D1Database,
    VECTORIZE: vec as unknown as VectorizeIndex,
    AI: fakeAI() as unknown as Env["AI"],
    REGISTER_TOKEN: "test-token",
    ...overrides,
  } as Env;
  return Object.assign(env, { __d1: d1, __vec: vec });
}

// ---------- request helper ----------

import worker from "../src/worker";

export async function call(
  env: Env,
  method: string,
  path: string,
  body?: unknown,
  token?: string
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await worker.fetch(
    new Request(`https://fleet-functions.test${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
    env
  );
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, json: parsed };
}

export async function register(env: Env, fn: Record<string, unknown>) {
  return call(env, "POST", "/register", fn, "test-token");
}
