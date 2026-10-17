// server/omniroute.mjs — READ-ONLY OmniRoute client + read-only SQLite inspector (spec §6.6 / §10.2).
//
// HARD RULES enforced structurally, not by comment:
//   • the only HTTP methods exposed are GET-shaped + one non-mutating probe POST
//   • there is no code path that can PUT/PATCH/DELETE anything
//   • SQLite inspection uses URI mode=ro (kernel/driver read-only lock-free read)
//   • nothing here can stop, restart or reconfigure the gateway
//   • the probe always sends stream:false (SSE would break JSON.parse)

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolvePython } from "./config.mjs";

const RO_SQLITE_PY = `
import json, sqlite3, sys
db_path = sys.argv[1]
uri = f"file:{db_path}?mode=ro"
con = sqlite3.connect(uri, uri=True, timeout=2.0)
con.row_factory = sqlite3.Row
cur = con.cursor()
tables = [r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
combos = []
providers = []
for t in tables:
    tl = t.lower()
    if "combo" in tl:
        try:
            rows = cur.execute(f"SELECT * FROM \\"{t}\\" LIMIT 100").fetchall()
            for r in rows:
                d = dict(r)
                name = str(d.get("name") or d.get("id") or d.get("slug") or "unnamed")
                raw_models = d.get("models") or d.get("routes") or d.get("targets") or "[]"
                if isinstance(raw_models, str):
                    try:
                        parsed = json.loads(raw_models)
                        models = [str(x.get("model") if isinstance(x, dict) else x) for x in parsed] if isinstance(parsed, list) else [raw_models]
                    except Exception:
                        models = [m.strip() for m in raw_models.split(",") if m.strip()]
                elif isinstance(raw_models, list):
                    models = [str(x) for x in raw_models]
                else:
                    models = []
                combos.append({"name": name, "models": models})
        except Exception:
            pass
    elif "provider" in tl or "account" in tl:
        try:
            rows = cur.execute(f"SELECT * FROM \\"{t}\\" LIMIT 100").fetchall()
            for r in rows:
                d = dict(r)
                providers.append({
                    "id": str(d.get("id") or d.get("name") or d.get("provider") or "provider"),
                    "status": str(d.get("status") or ("enabled" if d.get("enabled", 1) else "disabled")),
                })
        except Exception:
            pass
con.close()
print(json.dumps({"tables": tables, "combos": combos, "providers": providers, "readOnly": True}))
`.trim();

export class OmnirouteClient {
  constructor(baseURL, log, sqlitePath = null) {
    this.baseURL = String(baseURL).replace(/\/+$/, "");
    this.log = log ?? { info() {}, warn() {}, error() {}, debug() {} };
    this.sqlitePath = sqlitePath;
  }

  url(path) {
    return this.baseURL + path;
  }

  async #get(path, timeoutMs = 4000) {
    const t0 = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(this.url(path), {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: ctrl.signal,
      });
      const ms = Date.now() - t0;
      const text = await res.text();
      let body = text;
      try {
        body = JSON.parse(text);
      } catch {
        /* keep raw text */
      }
      return { status: res.status, body, ms };
    } finally {
      clearTimeout(timer);
    }
  }

  /** GET /api/health with /health fallback. Never mutates. */
  async health() {
    for (const path of ["/api/health", "/health"]) {
      try {
        const { status, body, ms } = await this.#get(path, 4000);
        if (status >= 200 && status < 300) {
          const version = body && typeof body === "object" ? (body.version ?? null) : null;
          return {
            reachable: true,
            latencyMs: ms,
            version: version ? String(version) : null,
            checkedAt: Date.now(),
            path,
            status,
          };
        }
      } catch (e) {
        this.log.debug("router", `health probe ${path} failed: ${e.message}`);
      }
    }
    return {
      reachable: false,
      latencyMs: null,
      version: null,
      checkedAt: Date.now(),
      path: null,
      status: null,
    };
  }

  async models() {
    const { status, body } = await this.#get("/v1/models", 8000);
    if (status !== 200) throw new Error(`/v1/models → HTTP ${status}`);
    const data = body?.data;
    if (!Array.isArray(data)) throw new Error("unexpected /v1/models payload shape");
    return data.map((m) => ({ id: String(m.id ?? ""), ownedBy: m.owned_by ?? null }));
  }

  /**
   * Read-only inspection of ~/.9router/db/data.sqlite using SQLite URI `mode=ro`.
   * Never mutates the database or acquires write locks.
   */
  async inspectSqlite(dbPath = this.sqlitePath) {
    if (!dbPath || !existsSync(dbPath)) {
      return { available: false, dbPath: dbPath ?? null, combos: [], providers: [], tables: [], readOnly: true };
    }
    const pyBin = resolvePython();
    return new Promise((resolve) => {
      execFile(pyBin, ["-c", RO_SQLITE_PY, dbPath], { timeout: 4000 }, (err, stdout) => {
        if (err) {
          this.log.debug("router", `sqlite read-only inspect failed: ${err.message}`);
          return resolve({
            available: false,
            dbPath,
            combos: [],
            providers: [],
            tables: [],
            readOnly: true,
            error: err.message,
          });
        }
        try {
          const parsed = JSON.parse(stdout.trim());
          resolve({
            available: true,
            dbPath,
            combos: parsed.combos ?? [],
            providers: parsed.providers ?? [],
            tables: parsed.tables ?? [],
            readOnly: true,
          });
        } catch (e) {
          resolve({
            available: false,
            dbPath,
            combos: [],
            providers: [],
            tables: [],
            readOnly: true,
            error: e.message,
          });
        }
      });
    });
  }

  /** Read-only combo discovery via HTTP endpoints, falling back to read-only SQLite sync if configured. */
  async combos() {
    for (const path of ["/api/combos", "/v1/combos", "/combos"]) {
      try {
        const { status, body } = await this.#get(path, 4000);
        if (status < 200 || status >= 300 || !body || typeof body !== "object") continue;
        const arr = Array.isArray(body) ? body : body.data;
        if (!Array.isArray(arr)) continue;
        return {
          pathUsed: path,
          combos: arr.map((c) => ({
            name: String(c?.name ?? c?.id ?? "unnamed"),
            models: Array.isArray(c?.models) ? c.models.map(String) : [],
          })),
        };
      } catch {
        /* try next candidate */
      }
    }

    if (this.sqlitePath && existsSync(this.sqlitePath)) {
      const sq = await this.inspectSqlite(this.sqlitePath);
      if (sq.available) {
        return {
          pathUsed: `sqlite:${this.sqlitePath}`,
          combos: sq.combos,
          providers: sq.providers,
          readOnly: true,
        };
      }
    }

    return { pathUsed: null, combos: [] };
  }

  /** Non-mutating chat probe. stream:false is mandatory. */
  async chatProbe(model) {
    const t0 = Date.now();
    try {
      const res = await fetch(this.url("/v1/chat/completions"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "ping" }],
          stream: false,
          max_tokens: 16,
        }),
        signal: AbortSignal.timeout(30000),
      });
      const ms = Date.now() - t0;
      const text = await res.text();
      if (!res.ok) return { ok: false, latencyMs: ms, model, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
      try {
        const j = JSON.parse(text);
        return {
          ok: true,
          latencyMs: ms,
          model,
          sample: String(j?.choices?.[0]?.message?.content ?? "").slice(0, 200),
        };
      } catch {
        return {
          ok: false,
          latencyMs: ms,
          model,
          error: "non-JSON body — server streamed SSE despite stream:false",
        };
      }
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - t0, model, error: e.message };
    }
  }
}
