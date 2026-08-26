// fleet-functions — the suite. Three payoff journeys first (they are the
// point of the registry), then the fence, then the CRUD truths.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeEnv, call, register, type EnvWithFakes } from "./fakes";
import { isSafeHttpUrl } from "../src/invoke";

const PERCEPTION_AUDIT = {
  name: "perception_audit",
  ns: "plainsong",
  description:
    "Audit a session's sixteen feature channels for ones that cannot steer. Each channel gets its variance across bars and a verdict: DEAD, COUPLED or ALIVE. Counts the real steering dimensions — whether the melody swings and where dynamics are flat is exactly this question.",
  signature: { params: { session: { type: "string", required: true } } },
  invoke_kind: "mcp",
  invoke_target: { transport: "stdio", command: "plainsong-mcp", tool: "perception_audit" },
  owner: "plainsong-mcp",
};

const DIMENSION_STATS = {
  name: "dimension_stats",
  ns: "plainsong",
  description:
    "See one custom dimension of a session: a named annotation row such as Breath or Gaze as count, mean, std and a per-bar series. Where a dynamics row sits flat, this shows the flat.",
  signature: { params: { session: { type: "string", required: true }, row: { type: "string", required: true } } },
  invoke_kind: "mcp",
  invoke_target: { transport: "stdio", command: "plainsong-mcp", tool: "dimension_stats" },
  owner: "plainsong-mcp",
};

const WRITE_PART = {
  name: "ensemble_write_part",
  ns: "plainsong",
  description:
    "Write your voice's part in the band session. Notation is parsed and checked before anything reaches disk. Pass the base_version you read; if the voice moved on, the write is refused and you get the current part to rebase onto. This is how an agent commits to the band.",
  signature: {
    params: {
      session: { type: "string", required: true },
      voice: { type: "string", required: true },
      agent: { type: "string", required: true },
      content: { type: "string", required: true },
      base_version: { type: "integer", required: true },
      summary: { type: "string" },
    },
  },
  invoke_kind: "mcp",
  invoke_target: { transport: "stdio", command: "plainsong-mcp", tool: "ensemble_write_part" },
  owner: "plainsong-mcp",
};

const ENSEMBLE_STATUS = {
  name: "ensemble_status",
  ns: "plainsong",
  description:
    "The short view of a band session: version, voices, who holds what, bar count and whether the merged score still compiles.",
  signature: { params: { session: { type: "string" } } },
  invoke_kind: "mcp",
  invoke_target: { transport: "stdio", command: "plainsong-mcp", tool: "ensemble_status" },
  owner: "plainsong-mcp",
};

const TWIN_QUERY = {
  name: "query",
  ns: "fleet-twin",
  description:
    "Ask the fleet's shared memory: semantic search over everything the fleet knows — writings, memory notes, repo READMEs. Returns ranked chunks with source attribution. How did the pocket lock last time? Ask here.",
  signature: { params: { text: { type: "string", required: true }, topK: { type: "integer" } } },
  invoke_kind: "http",
  invoke_target: { url: "https://fleet-twin.casey-digennaro.workers.dev/query", method: "POST" },
  owner: "fleet-twin",
};

const TWIN_INGEST = {
  name: "ingest",
  ns: "fleet-twin",
  description:
    "Deposit documents into the fleet's shared memory. Bearer-gated; idempotent by doc id.",
  signature: { params: { docs: { type: "array", required: true } } },
  invoke_kind: "http",
  auth_kind: "bearer",
  invoke_target: { url: "https://fleet-twin.casey-digennaro.workers.dev/ingest", method: "POST" },
  owner: "fleet-twin",
};

function seedFleet(env: EnvWithFakes) {
  return Promise.all(
    [PERCEPTION_AUDIT, DIMENSION_STATS, WRITE_PART, ENSEMBLE_STATUS, TWIN_QUERY, TWIN_INGEST].map(
      (fn) => register(env, fn)
    )
  );
}

describe("the contract surface", () => {
  it("GET / lists the endpoints and the honesty doctrine", async () => {
    const env = makeEnv();
    const { status, json } = await call(env, "GET", "/");
    expect(status).toBe(200);
    expect(json.endpoints["POST /register"]).toBeTruthy();
    expect(json.doctrine).toContain("never fabricates");
  });

  it("GET /health reports model, dimensions and the fleet UA", async () => {
    const env = makeEnv();
    const { json } = await call(env, "GET", "/health");
    expect(json.ok).toBe(true);
    expect(json.model).toBe("@cf/baai/bge-base-en-v1.5");
    expect(json.dimensions).toBe(768);
    expect(json.userAgent).toContain("fleet-functions/1.0");
  });
});

describe("register — the ledger", () => {
  it("refuses without the token", async () => {
    const env = makeEnv();
    const { status } = await call(env, "POST", "/register", PERCEPTION_AUDIT);
    expect(status).toBe(401);
  });

  it("creates then updates idempotently (version increments, no duplicate row)", async () => {
    const env = makeEnv();
    const first = await register(env, TWIN_QUERY);
    expect(first.status).toBe(201);
    expect(first.json.status).toBe("created");

    const again = await register(env, { ...TWIN_QUERY, description: TWIN_QUERY.description + " v2." });
    expect(again.status).toBe(200);
    expect(again.json.status).toBe("updated");
    expect(again.json.version).toBe(2);
    expect(env.__d1.tables.functions.filter((r) => r.name === "query").length).toBe(1);
  });

  it("refuses a lazy description — the description IS the index", async () => {
    const env = makeEnv();
    const { status, json } = await register(env, { ...TWIN_QUERY, description: "does it" });
    expect(status).toBe(400);
    expect(json.error).toContain("description");
  });

  it("GET /stats counts by namespace", async () => {
    const env = makeEnv();
    await seedFleet(env);
    const { json } = await call(env, "GET", "/stats");
    expect(json.functions).toBe(6);
    expect(json.byNs["plainsong"]).toBe(4);
    expect(json.byNs["fleet-twin"]).toBe(2);
  });
});

describe("journey 1 — perception: 'see if my melody swings and where dynamics are flat'", () => {
  it("ranks perception_audit and dimension_stats in the top cards", async () => {
    const env = makeEnv();
    await seedFleet(env);
    const { status, json } = await call(env, "POST", "/search", {
      intent: "see if my melody swings and where dynamics are flat",
      topK: 4,
    });
    expect(status).toBe(200);
    const names = json.results.map((r: any) => r.name);
    expect(names).toContain("perception_audit");
    expect(names).toContain("dimension_stats");
    expect(names.indexOf("perception_audit")).toBeLessThan(4);
  });

  it("invoke returns the honest mcp contract (executed: false, with the exact call)", async () => {
    const env = makeEnv();
    await seedFleet(env);
    const { status, json } = await call(env, "POST", "/invoke", {
      name: "perception_audit",
      ns: "plainsong",
      args: { session: "duke-lab-r3" },
    });
    expect(status).toBe(200);
    expect(json.executed).toBe(false);
    expect(json.contract.target.command).toBe("plainsong-mcp");
    expect(json.contract.args.session).toBe("duke-lab-r3");
    expect(json.function.invoke.kind).toBe("mcp");
    // a contract handoff is a success, and it is counted
    expect(json.function.calls.ok).toBe(1);
  });
});

describe("journey 2 — band commit: 'commit my part to the band'", () => {
  it("finds ensemble_write_part (the commit) and ensemble_status", async () => {
    const env = makeEnv();
    await seedFleet(env);
    const { json } = await call(env, "POST", "/search", {
      intent: "commit my part to the band session",
      topK: 3,
    });
    const names = json.results.map((r: any) => r.name);
    expect(names[0]).toBe("ensemble_write_part");
    expect(names).toContain("ensemble_status");
  });

  it("the contract names base_version as required — the honest rebase rule travels with the card", async () => {
    const env = makeEnv();
    await seedFleet(env);
    const { json } = await call(env, "GET", "/fn/plainsong/ensemble_write_part");
    expect(json.signature.params.base_version.required).toBe(true);
    expect(json.description).toContain("refused");
  });
});

describe("journey 3 — twin query: 'what does the fleet remember about…'", () => {
  it("finds fleet-twin query and ACTUALLY proxies it (executed: true)", async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: unknown) =>
      new Response(
        JSON.stringify({ query: "pocket lock", results: [{ docId: "band-log:13", score: 0.71 }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const env = makeEnv();
      await seedFleet(env);
      const search = await call(env, "POST", "/search", {
        intent: "ask the fleet's shared memory how the pocket locked last time",
      });
      expect(search.json.results[0].name).toBe("query");
      expect(search.json.results[0].ns).toBe("fleet-twin");

      const invoked = await call(env, "POST", "/invoke", {
        name: "query",
        ns: "fleet-twin",
        args: { text: "how did the pocket lock last time?", topK: 3 },
      });
      expect(invoked.json.executed).toBe(true);
      expect(invoked.json.upstream.status).toBe(200);
      expect(invoked.json.response.results[0].docId).toBe("band-log:13");
      // the proxy sent the fleet UA (the 1010 lesson) and no cache
      const [sentUrl, sentInit] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(sentUrl).toBe("https://fleet-twin.casey-digennaro.workers.dev/query");
      const sentHeaders = sentInit!.headers as Record<string, string>;
      expect(sentHeaders["User-Agent"]).toContain("fleet-functions/1.0");
      expect(sentHeaders["Content-Type"]).toBe("application/json");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("bearer-auth functions refuse to proxy without the caller's credential", async () => {
    const env = makeEnv();
    await seedFleet(env);
    const { status, json } = await call(env, "POST", "/invoke", {
      name: "ingest",
      ns: "fleet-twin",
      args: { docs: [{ id: "x", text: "y" }] },
    });
    expect(status).toBe(401);
    expect(json.hint).toContain("bearer");
  });
});

describe("the fence — no internal addresses, https only", () => {
  it("isSafeHttpUrl refuses every shape of internal address", () => {
    for (const bad of [
      "http://example.com",              // not https
      "https://localhost/health",
      "https://127.0.0.1:8787/",
      "https://10.0.0.5/x",
      "https://192.168.1.4/x",
      "https://172.16.3.1/x",
      "https://169.254.169.254/latest/meta-data", // cloud metadata
      "https://[::1]:443/",
      "https://box.internal/x",
      "https://printer.local/x",
      "https://good.example.com:8443/x",  // non-443 port
      "https://user:pass@example.com/x",  // credentials in URL
      "https://93.184.216.34/x",          // public IP literal — refused all the same
      "not a url",
    ]) {
      expect(isSafeHttpUrl(bad).ok).toBe(false);
    }
  });

  it("accepts honest public https names", () => {
    for (const good of [
      "https://fleet-twin.casey-digennaro.workers.dev/query",
      "https://cell-cascade.casey-digennaro.workers.dev/health",
      "https://example.com",
      "https://example.com:443/x",
    ]) {
      expect(isSafeHttpUrl(good).ok).toBe(true);
    }
  });

  it("a registered http function pointed inward gets refused, not proxied", async () => {
    const env = makeEnv();
    await register(env, {
      name: "sneaky",
      ns: "test",
      description: "A function that points at the metadata service, for the fence test.",
      invoke_kind: "http",
      invoke_target: { url: "https://169.254.169.254/latest/meta-data" },
    });
    const { status, json } = await call(env, "POST", "/invoke", { name: "sneaky" });
    expect(json.executed).toBe(false);
    expect(json.refused).toBeTruthy();
    expect(json.function.calls.fail).toBe(1);
  });

  it("caps what it forwards", async () => {
    const env = makeEnv();
    await register(env, {
      name: "big-args",
      ns: "test",
      description: "Sends a very large body so the size cap has something to cap.",
      invoke_kind: "http",
      invoke_target: { url: "https://example.com/accept" },
    });
    const { status, json } = await call(env, "POST", "/invoke", {
      name: "big-args",
      args: { blob: "x".repeat(70 * 1024) },
    });
    expect(json.executed).toBe(false);
    expect(json.refused).toContain("bytes");
  });
});

describe("search truths", () => {
  it("ns filter restricts to one namespace", async () => {
    const env = makeEnv();
    await seedFleet(env);
    const { json } = await call(env, "POST", "/search", {
      intent: "write and read the band session",
      ns: "plainsong",
      topK: 10,
    });
    expect(json.results.every((r: any) => r.ns === "plainsong")).toBe(true);
  });

  it("deprecated functions are hidden unless asked for", async () => {
    const env = makeEnv();
    await seedFleet(env);
    await register(env, { ...TWIN_QUERY, deprecated: true });
    // re-registering with deprecated:true updates the vector metadata too
    const hidden = await call(env, "POST", "/search", { intent: "shared memory of the fleet", topK: 10 });
    expect(hidden.json.results.map((r: any) => r.name)).not.toContain("query");
    const shown = await call(env, "POST", "/search", {
      intent: "shared memory of the fleet",
      topK: 10,
      includeDeprecated: true,
    });
    expect(shown.json.results.map((r: any) => r.name)).toContain("query");
  });

  it("unknown function invoke is a clean 404", async () => {
    const env = makeEnv();
    const { status } = await call(env, "POST", "/invoke", { name: "nope" });
    expect(status).toBe(404);
  });
});
