// server/omniroute.mjs — Hermes Voice v1.0 STRICT READ-ONLY OmniRoute client (Spec §0.6 & §1.4).
//
// CRITICAL RULES enforced structurally:
//   • Only GET requests + one non-mutating POST probe (/v1/chat/completions with stream:false)
//   • Never PUT / PATCH / DELETE anything on 127.0.0.1:20128
//   • Never stop, restart, or kill OmniRoute
//   • SQLite inspection uses `sqlite3 -readonly` ONLY on combos & provider metadata (never writes, never reads apiKeys)

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { redact } from "./redact.mjs";

const DEFAULT_SQLITE = join(homedir(), ".9router", "db", "data.sqlite");

export class OmnirouteClient {
  constructor(baseURL, log, sqlitePath = DEFAULT_SQLITE) {
    this.baseURL = String(baseURL).replace(/\/+$/, "");
    this.sqlitePath = sqlitePath;
    this.log = log ?? { info() {}, warn() {}, error() {}, debug() {} };
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

  /** GET /api/health with /health and /v1/models fallback. Never mutates. */
  async health() {
    for (const path of ["/api/health", "/health", "/v1/models"]) {
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
   * Read-only combo discovery:
   *   1. Probes HTTP /api/combos, /v1/combos, /combos
   *   2. Falls back to read-only SQLite inspection of ~/.9router/db/data.sqlite (table `combos`)
   */
  async combos() {
    for (const path of ["/api/combos", "/v1/combos", "/combos"]) {
      try {
        const { status, body } = await this.#get(path, 3500);
        if (status < 200 || status >= 300 || !body || typeof body !== "object") continue;
        const arr = Array.isArray(body) ? body : body.data;
        if (!Array.isArray(arr)) continue;
        return {
          pathUsed: path,
          source: "http",
          combos: arr.map((c) => ({
            name: String(c?.name ?? c?.id ?? "unnamed"),
            models: parseModelsField(c?.models ?? c?.modelList ?? []),
          })),
        };
      } catch {
        /* try next candidate */
      }
    }

    const sqliteRes = await this.inspectSqliteReadOnly();
    if (sqliteRes.available && sqliteRes.combos.length > 0) {
      return {
        pathUsed: `sqlite:${this.sqlitePath}#combos`,
        source: "sqlite-readonly",
        combos: sqliteRes.combos,
      };
    }

    return { pathUsed: null, source: "none", combos: [] };
  }

  /**
   * Strict read-only SQLite inspection of ~/.9router/db/data.sqlite.
   * Uses `sqlite3 -readonly -json` and redacts all returned text.
   * NEVER touches `apiKeys` and NEVER executes any write statement.
   */
  async inspectSqliteReadOnly() {
    if (!this.sqlitePath || !existsSync(this.sqlitePath)) {
      return {
        available: false,
        path: this.sqlitePath,
        reason: "SQLite file not present on this host",
        combos: [],
        providers: [],
      };
    }

    const queryJson = (sql) =>
      new Promise((res) => {
        if (!/^\s*SELECT\b/i.test(sql)) {
          return res({ ok: false, rows: [], err: "blocked non-SELECT query" });
        }
        execFile(
          "sqlite3",
          ["-readonly", "-json", this.sqlitePath, sql],
          { timeout: 4000 },
          (err, stdout) => {
            if (err) return res({ ok: false, rows: [], err: err.message });
            try {
              const rows = JSON.parse(stdout.trim() || "[]");
              return res({ ok: true, rows: Array.isArray(rows) ? rows : [] });
            } catch (e) {
              return res({ ok: false, rows: [], err: e.message });
            }
          },
        );
      });

    const [combosQ, provQ] = await Promise.all([
      queryJson("SELECT * FROM combos LIMIT 50;"),
      queryJson("SELECT id, provider, name, isActive, status, createdAt FROM providerConnections LIMIT 100;"),
    ]);

    const combos = (combosQ.rows || []).map((row) => ({
      name: String(row.name ?? row.comboName ?? row.id ?? "unnamed"),
      models: parseModelsField(row.models ?? row.model_list ?? row.config ?? []),
    }));

    const providers = (provQ.rows || []).map((row) => ({
      id: redact(String(row.id ?? "")),
      provider: redact(String(row.provider ?? "unknown")),
      name: redact(String(row.name ?? "")),
      active: Boolean(row.isActive ?? row.status === "active" ?? true),
      status: redact(String(row.status ?? "ok")),
    }));

    return {
      available: combosQ.ok || provQ.ok,
      path: this.sqlitePath,
      readOnly: true,
      combos,
      providers,
      error: !combosQ.ok && !provQ.ok ? combosQ.err : null,
    };
  }

  /** Non-mutating chat probe. stream:false is mandatory (Spec §3.2). */
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
        return { ok: false, latencyMs: ms, model, error: "non-JSON body — server streamed SSE despite stream:false" };
      }
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - t0, model, error: e.message };
    }
  }
}

function parseModelsField(raw) {
  if (Array.isArray(raw)) return raw.map((x) => (typeof x === "string" ? x : String(x?.model ?? x?.id ?? "")));
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parseModelsField(parsed);
    } catch {
      return raw.split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  return [];
}
