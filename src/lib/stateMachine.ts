// Section 9 — AppStateMachine with validated transitions.
// Invalid transitions are logged and ignored (never thrown at the user).

export type StateName =
  | "starting"
  | "idle"
  | "listening"
  | "transcribing"
  | "confirmingTranscript"
  | "thinking"
  | "awaitingPermission"
  | "speaking"
  | "cancelling"
  | "degraded"
  | "error";

export const TRANSITIONS: Record<StateName, StateName[]> = {
  starting: ["idle", "degraded", "error"],
  idle: ["listening", "degraded", "error", "thinking", "speaking"],
  listening: ["transcribing", "idle", "error"],
  transcribing: ["confirmingTranscript", "thinking", "idle", "error"],
  confirmingTranscript: ["thinking", "idle", "listening"],
  thinking: ["awaitingPermission", "speaking", "idle", "error", "cancelling"],
  awaitingPermission: ["thinking", "speaking", "idle", "error", "cancelling"],
  speaking: ["idle", "listening", "error"],
  cancelling: ["idle", "error"],
  degraded: ["idle", "error", "listening"],
  error: ["idle", "degraded"],
};

export function canTransition(from: StateName, to: StateName): boolean {
  if (from === to) return true; // self-transition = state payload refresh, always allowed
  return (TRANSITIONS[from] ?? []).includes(to);
}

export interface TransitionResult {
  ok: boolean;
  from: StateName;
  to: StateName;
  reason?: string;
}

export function attempt(from: StateName, to: StateName): TransitionResult {
  if (canTransition(from, to)) return { ok: true, from, to };
  return { ok: false, from, to, reason: `invalid transition ${from} -> ${to}` };
}

export const STATE_BADGE: Record<StateName, { color: string; ring: string }> = {
  starting: { color: "bg-slate-400", ring: "ring-slate-400/30" },
  idle: { color: "bg-slate-500", ring: "ring-slate-500/30" },
  listening: { color: "bg-sky-400", ring: "ring-sky-400/40" },
  transcribing: { color: "bg-cyan-400", ring: "ring-cyan-400/40" },
  confirmingTranscript: { color: "bg-violet-400", ring: "ring-violet-400/40" },
  thinking: { color: "bg-indigo-400", ring: "ring-indigo-400/40" },
  awaitingPermission: { color: "bg-amber-400", ring: "ring-amber-400/40" },
  speaking: { color: "bg-emerald-400", ring: "ring-emerald-400/40" },
  cancelling: { color: "bg-orange-400", ring: "ring-orange-400/40" },
  degraded: { color: "bg-yellow-400", ring: "ring-yellow-400/40" },
  error: { color: "bg-rose-500", ring: "ring-rose-500/40" },
};
