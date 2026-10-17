// src/lib/localBridge.ts — client for the real local bridge (server/index.mjs, v1.0).
//
// Connects to http://127.0.0.1:20130 on macOS and automatically falls back to
// same-origin `/api/*` when served directly by the self-contained server or preview proxy.

import type { AgentBridge, SendContext } from "./agentBridge";
import type { ApprovalOutcome, AuditEntry, ComboInfo, HealthStatus, LogLine, ModelInfo, PermissionRequest, Session } from "./types";

export interface BridgeServerHealth {
  ok: boolean;
  service: string;
  version: string;
  node: string;
  uptimeSec: number;
  pid: number;
  dataDir: string;
  pythonPath?: string;
  hermes: { found: boolean; path?: string; detail: string; command: string[]; argvTemplate: string[]; cwd: string; timeoutSec: number };
  omniroute: HealthStatus & { baseURL: string; probeModel: string; activeComboName?: string; path?: string | null; status?: number | null };
  tts: {
    engines: Record<string, { available: boolean; detail: string; cost: string; pythonPath?: string }>;
    configured: { engine: string; voice: string; rate: string; pythonPath?: string; cacheDir?: string };
  };
  tasks: { live: number; total: number; cap: number; awaitingPermission: number };
  permissions: { timeoutSec: number; autoApproveLowRisk: boolean };
  logging: { level: string; redact: boolean };
  protocol: Record<string, unknown>;
}

export interface ServerTestResult {
  suite: string;
  name: string;
  ok: boolean;
  detail: string;
  ms: number;
}

const START_HINT = "Bridge nahi chal raha. Terminal me: node server/index.mjs  (default http://127.0.0.1:20130)";

export class BridgeClient {
  private useSameOriginFallback = false;

  constructor(public baseURL: string) {}

  public resolveMediaUrl(path: string): string {
    if (this.useSameOriginFallback) return path;
    return this.baseURL.replace(/\/+$/, "") + path;
  }

  private url(path: string, sameOrigin = false) {
    if (sameOrigin || this.useSameOriginFallback) return path;
    return this.baseURL.replace(/\/+$/, "") + path;
  }

  private async req<T>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
    const { timeoutMs = 12000, ...rest } = init ?? {};
    let res: Response;
    try {
      res = await fetch(this.url(path), { ...rest, signal: AbortSignal.timeout(timeoutMs) });
    } catch (primaryErr) {
      // If we are in a browser where 127.0.0.1:20130 is cross-origin or proxied on same origin, try same-origin /api/*
      if (!this.useSameOriginFallback && typeof window !== "undefined" && window.location.origin !== this.baseURL) {
        try {
          res = await fetch(this.url(path, true), { ...rest, signal: AbortSignal.timeout(timeoutMs) });
          if (res.ok || res.status >= 400) {
            this.useSameOriginFallback = true;
          }
        } catch {
          throw primaryErr;
        }
      } else {
        throw primaryErr;
      }
    }

    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* keep text */
    }
    if (!res.ok) {
      const e = body as { error?: string; message?: string; hint?: string };
      throw Object.assign(new Error(e?.message || `HTTP ${res.status}`), { code: e?.error, hint: e?.hint, status: res.status });
    }
    return body as T;
  }

  async health(): Promise<BridgeServerHealth> {
    return this.req<BridgeServerHealth>("/api/health", { timeoutMs: 6000 });
  }

  async selftest(): Promise<{ results: ServerTestResult[]; passed: number; total: number }> {
    return this.req("/api/selftest", { timeoutMs: 120000 });
  }

  async routerHealth(): Promise<HealthStatus & { baseURL?: string }> {
    return this.req("/api/router/health", { timeoutMs: 10000 });
  }

  async routerModels(): Promise<{ models: ModelInfo[] }> {
    return this.req("/api/router/models", { timeoutMs: 15000 });
  }

  async routerCombos(): Promise<{ combos: ComboInfo[]; pathUsed: string | null; note?: string }> {
    return this.req("/api/router/combos", { timeoutMs: 15000 });
  }

  async routerProbe(model: string): Promise<{ ok: boolean; latencyMs: number; model: string; sample?: string; error?: string }> {
    return this.req("/api/router/probe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
      timeoutMs: 40000,
    });
  }

  async createTask(
    utterance: string,
    sessionId: string,
  ): Promise<{ task: { id: string; sessionId: string; status: string; argv?: string[] }; eventsUrl?: string; replyText?: string; taskId?: string }> {
    return this.req("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ utterance, sessionId }),
      timeoutMs: 15000,
    });
  }

  async decide(taskId: string, requestId: string, outcome: ApprovalOutcome): Promise<{ ok: boolean; deliveredToAgent: boolean }> {
    return this.req(`/api/tasks/${taskId}/permissions/${requestId}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(outcome),
      timeoutMs: 8000,
    });
  }

  async cancelTask(taskId: string): Promise<unknown> {
    return this.req(`/api/tasks/${taskId}`, { method: "DELETE", timeoutMs: 8000 });
  }

  async audit(): Promise<{ entries: AuditEntry[]; file: string }> {
    return this.req("/api/audit?limit=500", { timeoutMs: 8000 });
  }

  async sessions(): Promise<{ sessions: Session[] }> {
    return this.req("/api/sessions", { timeoutMs: 8000 });
  }

  async logs(limit = 200): Promise<{ lines: LogLine[] }> {
    return this.req(`/api/logs?limit=${limit}`, { timeoutMs: 8000 });
  }

  async memory(): Promise<{ root: string; files: string[]; available: boolean; note?: string }> {
    return this.req("/api/memory", { timeoutMs: 8000 });
  }

  async memoryFile(path: string): Promise<{ path: string; text: string; bytes: number; readOnly: boolean }> {
    return this.req(`/api/memory/file?path=${encodeURIComponent(path)}`, { timeoutMs: 8000 });
  }

  async tts(
    text: string,
    voice?: string,
    engine?: string,
  ): Promise<
    | { ok: true; url: string; engine: string; bytes: number; ms: number; spokenText: string; cached?: boolean }
    | { ok: false; error: string; message?: string; hint?: string }
  > {
    return this.req("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice, engine }),
      timeoutMs: 45000,
    });
  }

  async patchConfig(patch: Record<string, unknown>): Promise<{ ok: boolean }> {
    return this.req("/api/config", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch), timeoutMs: 8000 });
  }

  /** Streams task events; resolves when the bridge reports the terminal state. */
  async streamEvents(taskId: string, onEvent: (e: ServerEvent) => void, signal: AbortSignal): Promise<void> {
    const res = await fetch(this.url(`/api/tasks/${taskId}/events`), { signal });
    if (!res.ok || !res.body) throw new Error(`SSE failed: HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const frames = buf.split("\n\n");
      buf = frames.pop() ?? "";
      for (const frame of frames) {
        const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
        if (!dataLine) continue;
        try {
          const evt = JSON.parse(dataLine.slice(5).trim()) as ServerEvent;
          onEvent(evt);
          if (evt.type === "exit" || evt.type === "end") {
            await reader.cancel().catch(() => {});
            return;
          }
        } catch {
          /* ignore malformed frame, keep the stream alive */
        }
      }
    }
  }
}

export type ServerEvent =
  | { seq: number; at: number; taskId: string; type: "thinking"; payload: Record<string, never> }
  | { seq: number; at: number; taskId: string; type: "progress"; payload: { text: string; raw?: boolean; parseError?: boolean; warning?: boolean; stream?: boolean; isPing?: boolean; audioUrl?: string | null } }
  | { seq: number; at: number; taskId: string; type: "progressPing"; payload: { text: string; audioUrl?: string | null; engine?: string; pingIndex?: number } }
  | { seq: number; at: number; taskId: string; type: "toolCall"; payload: { name: string; args: Record<string, string> } }
  | { seq: number; at: number; taskId: string; type: "permissionRequest"; payload: { request: PermissionRequest & { timeoutSec?: number } } }
  | { seq: number; at: number; taskId: string; type: "permissionDecision"; payload: { requestId: string; tool: string; decision: string; via: string; deliveredToAgent: boolean; risk?: string } }
  | { seq: number; at: number; taskId: string; type: "completed"; payload: { text: string; degraded?: string } }
  | { seq: number; at: number; taskId: string; type: "failed"; payload: { code: string; reason: string; hint?: string | null } }
  | { seq: number; at: number; taskId: string; type: "cancelled"; payload: Record<string, never> }
  | { seq: number; at: number; taskId: string; type: "exit"; payload: { status: string; durationMs: number } }
  | { seq: number; at: number; taskId: string; type: "end" };

export class LocalBridge implements AgentBridge {
  readonly id = "local" as const;
  readonly label = "Local bridge (server/index.mjs)";
  private cached: { ok: boolean; reason?: string } = { ok: false, reason: START_HINT };

  constructor(public client: BridgeClient) {}

  setStatus(status: { ok: boolean; reason?: string }) {
    this.cached = status;
  }

  available() {
    return this.cached;
  }

  async send(ctx: SendContext): Promise<void> {
    const abort = new AbortController();
    const { task } = await this.client.createTask(ctx.utterance, ctx.sessionId);
    ctx.taskID = task.id;

    const timers = new Map<string, number>();

    await this.client.streamEvents(
      task.id,
      (evt) => {
        switch (evt.type) {
          case "thinking":
            ctx.onEvent({ kind: "thinking", taskID: task.id });
            break;
          case "progressPing":
            ctx.onEvent({ kind: "progress", taskID: task.id, text: `🔊 ${evt.payload.text}` });
            break;
          case "progress":
            if (!evt.payload.isPing) {
              ctx.onEvent({ kind: "progress", taskID: task.id, text: evt.payload.text });
            }
            break;
          case "toolCall":
            ctx.onEvent({ kind: "toolCall", taskID: task.id, name: evt.payload.name, args: evt.payload.args });
            break;
          case "permissionRequest": {
            const req = evt.payload.request;
            const timeoutSec = req.timeoutSec ?? 60;
            const full: PermissionRequest = { ...req, expiresAt: req.expiresAt || Date.now() + timeoutSec * 1000 };
            timers.set(req.id, timeoutSec);
            ctx.onEvent({ kind: "permissionRequest", taskID: task.id, request: full });
            void ctx.requestApproval(full).then(async (outcome) => {
              timers.delete(req.id);
              try {
                await this.client.decide(task.id, req.id, outcome);
              } catch (e) {
                const err = e as Error & { hint?: string };
                ctx.onEvent({
                  kind: "progress",
                  taskID: task.id,
                  text: `⚠︎ decision rejected by bridge: ${err.message}${err.hint ? ` (${err.hint})` : ""}`,
                });
                if (outcome.decision !== "deny") {
                  await this.client.decide(task.id, req.id, { decision: "deny", via: "click" }).catch(() => {});
                }
              }
            });
            break;
          }
          case "permissionDecision":
            ctx.onEvent({
              kind: "progress",
              taskID: task.id,
              text: `${evt.payload.tool} → ${evt.payload.decision} (${evt.payload.via})${evt.payload.deliveredToAgent ? "" : " · not deliverable to agent"}`,
            });
            break;
          case "completed":
            ctx.onEvent({ kind: "completed", taskID: task.id, text: evt.payload.text });
            break;
          case "failed":
            ctx.onEvent({ kind: "failed", taskID: task.id, reason: `[${evt.payload.code}] ${evt.payload.reason}` });
            break;
          case "cancelled":
            ctx.onEvent({ kind: "cancelled", taskID: task.id });
            break;
        }
      },
      abort.signal,
    );

    if (ctx.isCancelled()) await this.client.cancelTask(task.id).catch(() => {});
  }
}

export const BRIDGE_START_HINT = START_HINT;
