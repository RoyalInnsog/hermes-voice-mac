// server/omniroute.mjs — READ-ONLY Omniroute client (spec §6.6 / §10.2, v1.0).
//
// HARD RULES enforced structurally, not by comment:
//   • the only HTTP methods exposed are GET-shaped + one non-mutating probe POST
//   • there is no code path that can PUT/PATCH/DELETE anything
//   • nothing here can stop, restart or reconfigure the gateway
//   • the probe always sends stream:false (SSE would break JSON.parse)
//   • SQLite inspection of ~/.9router/db/data.sqlite is strictly READ-ONLY (mode=ro / -readonly)

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolvePython } from "./config.mjs";

export class OmnirouteClient {
  constructor(baseURL, log, opts = {}) {
    this.baseURL = String(baseURL).replace(/\/+$/, "");
    this.log = log ?? { info() {}, warn() {}, error() {}, debug() {} };
    this.sqlitePath = opts.sqlitePath ?? null;
  }

  url(path) {
    return this.baseURL + path;
  }

  async #get(path, timeoutMs = 4000) {
    const t0 = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(this.url(path), { method: "GET", headers: { Accept: "application/json" }, signal: ctrl.signal });
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

  /** GET /api/health with /health and /v1/models fallback. Never mutates. */
  async health() {
    for (const path of ["/api/health", "/health", "/v1/models"]) {
      try {
        const { status, body, ms } = await this.#get(path, 4000);
        if (status >= 200 && status < 300) {
          const version = body && typeof body === "object" ? (body.version ?? null) : null;
          return { reachable: true, latencyMs: ms, version: version ? String(version) : null, checkedAt: Date.now(), path, status };
        }
      } catch (e) {
        this.log.debug("router", `health probe ${path} failed: ${e.message}`);
      }
    }
    return { reachable: false, latencyMs: null, version: null, checkedAt: Date.now(), path: null, status: null };
  }

  async models() {
    const { status, body } = await this.#get("/v1/models", 8000);
    if (status !== 200) throw new Error(`/v1/models → HTTP ${status}`);
    const data = body?.data;
    if (!Array.isArray(data)) throw new Error("unexpected /v1/models payload shape");
    return data.map((m) => ({ id: String(m.id ?? ""), ownedBy: m.owned_by ?? null }));
  }

  /**
   * Read-only combo discovery via HTTP endpoints with optional read-only SQLite fallback
   * against ~/.9router/db/data.sqlite.
   */
  async combos(opts = {}) {
    for (const path of ["/api/combos", "/v1/combos", "/combos"]) {
      try {
        const { status, body } = await this.#get(path, 4000);
        if (status < 200 || status >= 300 || !body || typeof body !== "object") continue;
        const arr = Array.isArray(body) ? body : body.data ?? body.combos;
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

    const dbPath = opts.sqlitePath ?? this.sqlitePath;
    if (dbPath && existsSync(dbPath)) {
      const sqliteCombos = await this.inspectSqliteReadOnly(dbPath);
      if (sqliteCombos && sqliteCombos.length > 0) {
        return {
          pathUsed: `sqlite:${dbPath} (read-only)`,
          combos: sqliteCombos,
        };
      }
    }

    return { pathUsed: null, combos: [] };
  }

  /**
   * Strict read-only inspection of ~/.9router/db/data.sqlite using URI mode=ro.
   * Never opens the database with write permissions, never acquires write locks.
   */
  async inspectSqliteReadOnly(dbPath = join(homedir(), ".9router/db/data.sqlite")) {
    if (!existsSync(dbPath)) return null;
    const pyBin = resolvePython();
    const pyScript = `
import sqlite3, json, sys
db_path = sys.argv[1]
uri = f"file:{db_path}?mode=ro"
try:
    conn = sqlite3.connect(uri, uri=True, timeout=2.0)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    tables = [r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
    combos = []
    for t in tables:
        tl = t.lower()
        if "combo" in tl or "route" in tl or "model" in tl:
            try:
                rows = cur.execute(f'SELECT * FROM "{t}" LIMIT 50').fetchall()
                for row in rows:
                    d = dict(row)
                    name = d.get("name") or d.get("combo_name") or d.get("id") or d.get("slug")
                    models_raw = d.get("models") or d.get("providers") or d.get("targets") or d.get("model_list") or "[]"
                    if name:
                        try:
                            parsed_m = json.loads(models_raw) if isinstance(models_raw, str) else models_raw
                            if isinstance(parsed_m, list):
                                models = [str(x.get("model") or x.get("id") or x) if isinstance(x, dict) else str(x) for x in parsed_m]
                            else:
                                models = [str(models_raw)]
                        except Exception:
                            models = [s.strip() for s in str(models_raw).split(",") if s.strip()]
                        combos.append({"name": str(name), "models": models})
            except Exception:
                pass
    conn.close()
    print(json.dumps(combos))
except Exception as e:
    print("[]")
`.trim();

    return new Promise((res) => {
      execFile(pyBin, ["-c", pyScript, dbPath], { timeout: 4000 }, (err, stdout) => {
        if (err || !stdout) return res(null);
        try {
          const parsed = JSON.parse(stdout.trim());
          return res(Array.isArray(parsed) ? parsed : null);
        } catch {
          return res(null);
        }
      });
    });
  }

  /** Non-mutating chat probe. stream:false is mandatory. */
  async chatProbe(model) {
    const t0 = Date.now();
    try {
      const res = await fetch(this.url("/v1/chat/completions"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }], stream: false, max_tokens: 16 }),
        signal: AbortSignal.timeout(30000),
      });
      const ms = Date.now() - t0;
      const text = await res.text();
      if (!res.ok) return { ok: false, latencyMs: ms, model, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
      try {
        const j = JSON.parse(text);
        return { ok: true, latencyMs: ms, model, sample: String(j?.choices?.[0]?.message?.content ?? "").slice(0, 200) };
      } catch {
        return { ok: false, latencyMs: ms, model, error: "non-JSON body — server streamed SSE despite stream:false" };
      }
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - t0, model, error: e.message };
    }
  }
}
