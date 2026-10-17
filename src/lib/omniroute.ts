// Section 6.6 / 10.2 — Omniroute client. READ-ONLY by contract.
// HARD RULE: never stop, restart, reconfigure Omniroute; never mutate combos or the DB.
// Only GET requests + a single non-mutating POST probe to /v1/chat/completions with stream:false.

import type { ComboInfo, HealthStatus, ModelInfo } from "./types";

export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  model: string;
  sample: string;
  error?: string;
}

const TIMEOUT_MS = 8000;

async function getJSON(url: string, signalTimeout = TIMEOUT_MS): Promise<{ status: number; body: unknown; ms: number }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), signalTimeout);
  const t0 = performance.now();
  try {
    const res = await fetch(url, { signal: ctrl.signal, method: "GET", headers: { Accept: "application/json" } });
    const ms = Math.round(performance.now() - t0);
    const text = await res.text();
    let body: unknown = text;
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

export class OmnirouteClient {
  constructor(public baseURL: string) {}

  private url(path: string) {
    return this.baseURL.replace(/\/+$/, "") + path;
  }

  /** GET /api/health with /health fallback. Never mutates. */
  async health(): Promise<HealthStatus> {
    const paths = ["/api/health", "/health"];
    for (const p of paths) {
      try {
        const { status, body, ms } = await getJSON(this.url(p), 4000);
        if (status >= 200 && status < 300) {
          const version =
            typeof body === "object" && body !== null && "version" in (body as Record<string, unknown>)
              ? String((body as Record<string, unknown>).version)
              : null;
          return { reachable: true, latencyMs: ms, version, checkedAt: Date.now(), detail: `${p} → ${status}` };
        }
      } catch {
        /* try next path */
      }
    }
    return {
      reachable: false,
      latencyMs: null,
      version: null,
      checkedAt: Date.now(),
      detail: "no response from /api/health or /health (CORS or process down)",
    };
  }

  /** GET /v1/models */
  async models(): Promise<ModelInfo[]> {
    const { body } = await getJSON(this.url("/v1/models"));
    const data = (body as { data?: Array<{ id: string; owned_by?: string }> })?.data;
    if (!Array.isArray(data)) throw new Error("unexpected /v1/models shape");
    return data.map((m) => ({ id: m.id, ownedBy: m.owned_by ?? null }));
  }

  /** Combo endpoint path is unverified upstream — probe candidates, read-only. TODO-VERIFY */
  async combos(): Promise<{ combos: ComboInfo[]; pathUsed: string | null }> {
    const candidates = ["/api/combos", "/v1/combos", "/combos"];
    for (const p of candidates) {
      try {
        const { status, body } = await getJSON(this.url(p), 4000);
        if (status >= 200 && status < 300 && body && typeof body === "object") {
          const arr = Array.isArray(body) ? body : (body as { data?: unknown[] }).data;
          if (Array.isArray(arr)) {
            return {
              pathUsed: p,
              combos: arr.map((c) => {
                const o = c as Record<string, unknown>;
                return {
                  name: String(o.name ?? o.id ?? "unnamed"),
                  models: Array.isArray(o.models) ? (o.models as unknown[]).map(String) : [],
                };
              }),
            };
          }
        }
      } catch {
        /* next */
      }
    }
    return { combos: [], pathUsed: null };
  }

  /**
   * Non-mutating probe. ALWAYS stream:false — SSE breaks JSON parsing
   * ("Extra data" gotcha from Section 3.2).
   */
  async chatProbe(model: string): Promise<ProbeResult> {
    const payload = { model, messages: [{ role: "user", content: "ping" }], stream: false, max_tokens: 16 };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    const t0 = performance.now();
    try {
      const res = await fetch(this.url("/v1/chat/completions"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      const ms = Math.round(performance.now() - t0);
      const text = await res.text();
      if (!res.ok) return { ok: false, latencyMs: ms, model, sample: "", error: `HTTP ${res.status}: ${text.slice(0, 160)}` };
      let sample = "";
      try {
        const j = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> };
        sample = j.choices?.[0]?.message?.content ?? "";
      } catch {
        return { ok: false, latencyMs: ms, model, sample: text.slice(0, 160), error: "non-JSON body (did the server stream? assert stream:false)" };
      }
      return { ok: true, latencyMs: ms, model, sample: sample.slice(0, 200) };
    } catch (e) {
      return {
        ok: false,
        latencyMs: Math.round(performance.now() - t0),
        model,
        sample: "",
        error: e instanceof Error ? e.message : String(e),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Guard used by tests: the client must never emit a mutating verb. */
export const ALLOWED_METHODS = ["GET", "POST:/v1/chat/completions"] as const;
