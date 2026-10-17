// server/omniroute.mjs — READ-ONLY Omniroute client (spec §6.6 / §10.2).
//
// HARD RULES enforced structurally, not by comment:
//   • the only methods exposed are GET-shaped + one non-mutating probe POST
//   • there is no code path that can PUT/PATCH/DELETE anything
//   • nothing here can stop, restart or reconfigure the gateway
//   • the probe always sends stream:false (SSE would break JSON.parse)
//
// Running this from Node also removes the browser CORS problem that made
// 127.0.0.1:20128 unreachable from the web page.

export class OmnirouteClient {
  constructor(baseURL, log) {
    this.baseURL = String(baseURL).replace(/\/+$/, "");
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

  /** GET /api/health with /health fallback. Never mutates. */
  async health() {
    for (const path of ["/api/health", "/health"]) {
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

  /** TODO-VERIFY: combo endpoint path is undocumented. Read-only candidate probe. */
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
    return { pathUsed: null, combos: [] };
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
