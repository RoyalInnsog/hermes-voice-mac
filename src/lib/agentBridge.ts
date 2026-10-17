// Section 6.5 / 10.1 — Agent Bridge (Hermes adapter boundary).
//
// Three implementations behind one protocol:
//   • MockAgentBridge        — deterministic local simulator (works everywhere, used for flow verification)
//   • SubprocessAgentBridge  — spawns `hermes chat -q ...`  (TODO-VERIFY flags; NOT runnable from a browser)
//   • HTTPAgentBridge        — Hermes ACP / OpenAI-compatible server (TODO-VERIFY existence)
//
// The stdout wire protocol parser below is pure and unit-tested; it is the exact
// parser the native build uses, so the contract is verified even where spawning
// a process is impossible.

import { classifyRisk } from "./risk";
import type { AgentEvent, ApprovalDecision, ApprovalOutcome, BridgeMode, PermissionRequest } from "./types";
import { uid } from "./types";

export interface SendContext {
  utterance: string;
  sessionId: string;
  taskID: string;
  permissionTimeoutSec: number;
  onEvent: (e: AgentEvent) => void;
  requestApproval: (req: PermissionRequest) => Promise<ApprovalOutcome>;
  isCancelled: () => boolean;
}

export interface AgentBridge {
  readonly id: BridgeMode;
  readonly label: string;
  available(): { ok: boolean; reason?: string };
  send(ctx: SendContext): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Wire protocol parser (shared by subprocess bridge + tests)          */
/* ------------------------------------------------------------------ */

export type ParsedLine =
  | { type: "event"; event: AgentEvent }
  | { type: "permission"; request: PermissionRequest }
  | { type: "progress"; text: string }
  | { type: "plain"; text: string }
  | { type: "parseError"; raw: string; error: string };

/**
 * Hermes is expected to emit one JSON object per line prefixed with a marker.
 * Anything unmarked is treated as plain assistant text (graceful fallback —
 * Section 18.16: subprocess stdout parsing is fragile, degrade, never crash).
 */
export function parseHermesLine(line: string, taskID: string): ParsedLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("HV_PROGRESS:")) {
    return { type: "progress", text: trimmed.slice("HV_PROGRESS:".length).trim() };
  }

  if (trimmed.startsWith("HV_PERM:")) {
    const raw = trimmed.slice("HV_PERM:".length).trim();
    try {
      const o = JSON.parse(raw) as { tool?: string; args?: Record<string, string>; reason?: string; risk?: string; id?: string };
      const toolName = String(o.tool ?? "unknown_tool");
      const args = (o.args ?? {}) as Record<string, string>;
      const classified = classifyRisk(toolName, args);
      const risk = (["low", "medium", "high", "critical"] as const).includes(o.risk as never)
        ? (o.risk as PermissionRequest["risk"])
        : classified.risk;
      return {
        type: "permission",
        request: {
          id: o.id ?? uid(),
          taskID,
          toolName,
          args,
          risk,
          reason: o.reason ?? classified.note,
          requestedAt: Date.now(),
          expiresAt: 0, // filled in by PermissionManager using the configured timeout
        },
      };
    } catch (e) {
      return { type: "parseError", raw, error: e instanceof Error ? e.message : String(e) };
    }
  }

  if (trimmed.startsWith("HV_EVENT:")) {
    const raw = trimmed.slice("HV_EVENT:".length).trim();
    try {
      const o = JSON.parse(raw) as Record<string, unknown>;
      const kind = String(o.kind ?? "");
      switch (kind) {
        case "thinking":
          return { type: "event", event: { kind: "thinking", taskID } };
        case "toolCall":
          return {
            type: "event",
            event: { kind: "toolCall", taskID, name: String(o.name ?? "tool"), args: (o.args as Record<string, string>) ?? {} },
          };
        case "progress":
          return { type: "event", event: { kind: "progress", taskID, text: String(o.text ?? "") } };
        case "completed":
          return { type: "event", event: { kind: "completed", taskID, text: String(o.text ?? "") } };
        case "failed":
          return { type: "event", event: { kind: "failed", taskID, reason: String(o.reason ?? "unknown") } };
        case "cancelled":
          return { type: "event", event: { kind: "cancelled", taskID } };
        default:
          return { type: "parseError", raw, error: `unknown event kind "${kind}"` };
      }
    } catch (e) {
      return { type: "parseError", raw, error: e instanceof Error ? e.message : String(e) };
    }
  }

  return { type: "plain", text: trimmed };
}

/** Decision line written back to the child process stdin. */
export function encodeDecision(req: PermissionRequest, decision: ApprovalDecision): string {
  return `HV_DECISION: ${JSON.stringify({ id: req.id, decision })}\n`;
}

/** Exact argv the native build uses. TODO-VERIFY against `hermes chat --help`. */
export function buildHermesArgv(opts: { utterance: string; sessionId: string }): string[] {
  return ["chat", "-q", opts.utterance, "--session", opts.sessionId];
}

/* ------------------------------------------------------------------ */
/* Mock bridge — deterministic scripted agent                          */
/* ------------------------------------------------------------------ */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Step {
  tool?: string;
  args?: Record<string, string>;
  progress?: string;
  needsPermission?: boolean;
}

interface Scenario {
  match: RegExp;
  steps: Step[];
  summary: string;
}

const SCENARIOS: Scenario[] = [
  {
    match: /health|omniroute|router|status/i,
    steps: [
      { progress: "Omniroute health endpoint hit kar raha hoon" },
      { tool: "web_fetch", args: { url: "http://127.0.0.1:20128/api/health" }, needsPermission: true },
      { progress: "Combos read-only padh raha hoon" },
      { tool: "read_file", args: { path: "~/.9router/db/data.sqlite", mode: "read-only" }, needsPermission: true },
    ],
    summary:
      "Omniroute healthy hai, latency 42 ms. 4 combos loaded — KRITI (5 models), FALLBACK-FREE (3), VISION (2), LONGCTX (4). Koi combo edit nahi kiya, sirf read kiya.",
  },
  {
    match: /commit|git|push|repo/i,
    steps: [
      { tool: "git_status", args: { repo: "~/Documents/Projects/hermes-voice-mac" }, needsPermission: true },
      { progress: "Diff summarize kar raha hoon" },
      { tool: "git_commit", args: { message: "feat(voice): overlay + permission flow" }, needsPermission: true },
      { progress: "Push deliberately skip kiya — user approval pending" },
    ],
    summary:
      "3 files staged, local commit ban gaya: feat(voice): overlay + permission flow. Push nahi kiya kyunki tumne approve nahi kiya — ye rule hai.",
  },
  {
    match: /note|likh|write|file|save|draft/i,
    steps: [
      { progress: "Draft bana raha hoon" },
      { tool: "write_file", args: { path: "~/Documents/Projects/notes/jee-plan.md", bytes: "1842" }, needsPermission: true },
    ],
    summary: "Note ~/Documents/Projects/notes/jee-plan.md me save kar diya, 1842 bytes. Overlay me full text hai.",
  },
  {
    match: /delete|remove|clean|purge|rm\b/i,
    steps: [
      { tool: "list_dir", args: { path: "~/.hermes/cache/scratch" }, needsPermission: true },
      { tool: "rm_rf", args: { path: "~/.hermes/cache/scratch/*", recursive: "true" }, needsPermission: true },
    ],
    summary: "Scratch cleanup ka plan ready tha. Jo permission mili wahi execute hua, baaki skip.",
  },
  {
    match: /key|secret|credential|token|password/i,
    steps: [{ tool: "read_credentials", args: { store: "Keychain", item: "gemini_api_key" }, needsPermission: true }],
    summary: "Credential read ka request bana tha. Value kabhi plaintext me show nahi hoti — sirf [REDACTED] status.",
  },
];

const DEFAULT_SCENARIO: Scenario = {
  match: /.*/,
  steps: [
    { progress: "Task plan bana raha hoon" },
    { tool: "read_file", args: { path: "~/.hermes/memories/MEMORY.md" }, needsPermission: true },
    { progress: "Memory context load ho gaya" },
    { tool: "search", args: { query: "latest notes" }, needsPermission: true },
  ],
  summary: "Kaam ho gaya. Context memory se load kiya, plan bana diya. Detail overlay me hai, poora transcript session me save hai.",
};

export class MockAgentBridge implements AgentBridge {
  readonly id: BridgeMode = "mock";
  readonly label = "Mock Hermes (local simulator)";
  available() {
    return { ok: true };
  }

  async send(ctx: SendContext): Promise<void> {
    const scenario = SCENARIOS.find((s) => s.match.test(ctx.utterance)) ?? DEFAULT_SCENARIO;
    ctx.onEvent({ kind: "thinking", taskID: ctx.taskID });
    await sleep(500);

    const denied: string[] = [];

    for (const step of scenario.steps) {
      if (ctx.isCancelled()) {
        ctx.onEvent({ kind: "cancelled", taskID: ctx.taskID });
        return;
      }
      if (step.progress) {
        ctx.onEvent({ kind: "progress", taskID: ctx.taskID, text: step.progress });
        await sleep(600);
      }
      if (step.tool) {
        const args = step.args ?? {};
        const { risk, note } = classifyRisk(step.tool, args);
        if (step.needsPermission) {
          const req: PermissionRequest = {
            id: uid(),
            taskID: ctx.taskID,
            toolName: step.tool,
            args,
            risk,
            reason: note,
            requestedAt: Date.now(),
            expiresAt: Date.now() + ctx.permissionTimeoutSec * 1000,
          };
          ctx.onEvent({ kind: "permissionRequest", taskID: ctx.taskID, request: req });
          const outcome = await ctx.requestApproval(req);
          if (outcome.decision === "deny") {
            denied.push(step.tool);
            ctx.onEvent({ kind: "progress", taskID: ctx.taskID, text: `${step.tool} skip kiya (denied)` });
            await sleep(300);
            continue;
          }
        }
        ctx.onEvent({ kind: "toolCall", taskID: ctx.taskID, name: step.tool, args });
        await sleep(700);
      }
    }

    if (ctx.isCancelled()) {
      ctx.onEvent({ kind: "cancelled", taskID: ctx.taskID });
      return;
    }

    const suffix = denied.length ? ` Denied tools skip kiye: ${denied.join(", ")}.` : "";
    ctx.onEvent({ kind: "completed", taskID: ctx.taskID, text: scenario.summary + suffix });
  }
}

/* ------------------------------------------------------------------ */
/* Subprocess bridge — real path for the native build                  */
/* ------------------------------------------------------------------ */

export class SubprocessAgentBridge implements AgentBridge {
  readonly id: BridgeMode = "subprocess";
  readonly label = "hermes CLI (subprocess)";
  constructor(private cfg: { hermesPath: string; workingDir: string; timeoutSec: number }) {}

  available() {
    return {
      ok: false,
      reason:
        "A web page cannot spawn processes. In the native macOS build this bridge runs " +
        `\`${this.cfg.hermesPath} ${buildHermesArgv({ utterance: "<text>", sessionId: "<id>" }).join(" ")}\`` +
        ` in ${this.cfg.workingDir} with a ${this.cfg.timeoutSec}s timeout. See LIMITATIONS.md → L-1.`,
    };
  }

  async send(): Promise<void> {
    throw new Error(this.available().reason);
  }
}

/* ------------------------------------------------------------------ */
/* HTTP / ACP bridge — only if Hermes exposes a server. TODO-VERIFY    */
/* ------------------------------------------------------------------ */

export class HTTPAgentBridge implements AgentBridge {
  readonly id: BridgeMode = "http";
  readonly label = "Hermes HTTP / ACP";
  constructor(private baseURL: string) {}

  available() {
    return {
      ok: false,
      reason:
        `TODO-VERIFY: no documented Hermes server mode. Probe \`hermes --help | grep -iE "serve|api|acp"\`. ` +
        `If a server exists, point this bridge at ${this.baseURL} and stream SSE. See LIMITATIONS.md → L-2.`,
    };
  }

  async send(): Promise<void> {
    throw new Error(this.available().reason);
  }
}

export function makeBridge(mode: BridgeMode, cfg: { hermesPath: string; workingDir: string; timeoutSec: number; httpBaseURL: string }): AgentBridge {
  switch (mode) {
    case "subprocess":
      return new SubprocessAgentBridge({ hermesPath: cfg.hermesPath, workingDir: cfg.workingDir, timeoutSec: cfg.timeoutSec });
    case "http":
      return new HTTPAgentBridge(cfg.httpBaseURL);
    default:
      return new MockAgentBridge();
  }
}
