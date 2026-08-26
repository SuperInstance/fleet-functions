// fleet-functions — seed the registry with the real fleet surface.
//
// 55 functions across 5 namespaces:
//   plainsong       30 — the plainsong-mcp tools (descriptions are the real
//                        registry docstrings, extracted from source)
//   cell-cascade    10 — the Differentiation Cascade endpoints
//   scrap-quilt      9 — the Scrapcraft yard sheet endpoints
//   fleet-twin       4 — the fleet's vector memory
//   tapscript-worker 2 — edge notation→MIDI
//
// Usage:  WORKER_URL=https://fleet-functions.casey-digennaro.workers.dev \
//         REGISTER_TOKEN=<token> tsx scripts/seed.ts
//
// The loader is idempotent: /register upserts by ns/name. Retries once on
// 429/5xx. Sends an honest User-Agent — Cloudflare's bot fight answers
// bare library UAs with error 1010 (the fleet-twin loader lesson).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.WORKER_URL || "https://fleet-functions.casey-digennaro.workers.dev";
const TOKEN =
  process.env.REGISTER_TOKEN ||
  (() => {
    try {
      return readFileSync(join(here, "..", ".register-token"), "utf8").trim();
    } catch {
      return "";
    }
  })();

if (!TOKEN) {
  console.error("pass REGISTER_TOKEN or create .register-token");
  process.exit(1);
}

type Fn = Record<string, unknown>;

async function load(): Promise<Fn[]> {
  const plainsong: Fn[] = JSON.parse(readFileSync(join(here, "seeds-plainsong.json"), "utf8"));
  const http: Fn[] = JSON.parse(readFileSync(join(here, "seeds-http.json"), "utf8"));
  return [...plainsong, ...http];
}

async function registerOne(fn: Fn): Promise<{ status: number; body: string }> {
  const doFetch = () =>
    fetch(`${BASE}/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TOKEN}`,
        "User-Agent": "fleet-functions-seed/1.0",
      },
      body: JSON.stringify(fn),
    });

  let res = await doFetch();
  if (res.status === 429 || res.status >= 500) {
    const retryAfter = Number(res.headers.get("Retry-After") || 2);
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    res = await doFetch();
  }
  return { status: res.status, body: await res.text() };
}

async function main() {
  const fns = await load();
  const stats = new Map<string, { created: number; updated: number; failed: number }>();
  let i = 0;
  for (const fn of fns) {
    i++;
    const ns = String(fn.ns);
    const bucket = stats.get(ns) || { created: 0, updated: 0, failed: 0 };
    try {
      const { status, body } = await registerOne(fn);
      const parsed = JSON.parse(body);
      if (status === 201) bucket.created++;
      else if (status === 200) bucket.updated++;
      else {
        bucket.failed++;
        console.error(`  ✗ ${ns}/${fn.name} → ${status}: ${body.slice(0, 160)}`);
      }
    } catch (err) {
      bucket.failed++;
      console.error(`  ✗ ${ns}/${fn.name} → ${String(err).slice(0, 120)}`);
    }
    stats.set(ns, bucket);
    if (i % 10 === 0) console.log(`  … ${i}/${fns.length}`);
  }

  console.log("\nseed complete:");
  let total = 0;
  for (const [ns, s] of stats) {
    console.log(
      `  ${ns.padEnd(16)} +${s.created} new, ~${s.updated} updated${s.failed ? `, ✗${s.failed} FAILED` : ""}`
    );
    total += s.created + s.updated;
  }
  console.log(`  ${total} functions registered against ${BASE}`);
}

main();
