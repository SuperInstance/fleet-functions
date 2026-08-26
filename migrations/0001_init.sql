-- fleet-functions — the index of capability.
-- One row per callable function in the agent network.
-- Idempotent by (ns, name): re-registering updates in place.

CREATE TABLE IF NOT EXISTS functions (
  id             TEXT PRIMARY KEY,            -- fn:<ns>:<name> (also the Vectorize vector id)
  name           TEXT NOT NULL,
  ns             TEXT NOT NULL,               -- namespace: plainsong, cell-cascade, scrap-quilt, fleet-twin, ...
  description    TEXT NOT NULL,               -- what it does, in plain words (this is what gets embedded)
  signature_json TEXT NOT NULL,               -- JSON: { params: {name: {type, required, description}}, returns }
  invoke_kind    TEXT NOT NULL CHECK (invoke_kind IN ('http','mcp','manual')),
  invoke_target  TEXT NOT NULL,               -- JSON contract (url+method / transport+command+tool / instructions)
  auth_kind      TEXT NOT NULL DEFAULT 'none' CHECK (auth_kind IN ('none','bearer','env')),
  owner          TEXT NOT NULL DEFAULT 'fleet',
  version        INTEGER NOT NULL DEFAULT 1,
  deprecated     INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  calls_ok       INTEGER NOT NULL DEFAULT 0,
  calls_fail     INTEGER NOT NULL DEFAULT 0,
  UNIQUE(ns, name)
);

CREATE INDEX IF NOT EXISTS idx_functions_ns ON functions(ns);
CREATE INDEX IF NOT EXISTS idx_functions_name ON functions(name);
