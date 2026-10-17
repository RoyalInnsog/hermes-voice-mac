// Hermes Voice — core data models (v1.0).
// Mirrors Section 7 of the master spec.

export type Role = "user" | "assistant" | "system";

export interface Utterance {
  id: string;
  timestamp: number;
  role: Role;
  text: string;
  audioDuration: number | null;
  confidence: number | null;
}

export type RiskLevel = "low" | "medium" | "high" | "critical";

export type ApprovalDecision = "allowOnce" | "allowSession" | "deny";

/** Decision plus the evidence channel — the bridge re-validates this server-side. */
export interface ApprovalOutcome {
  decision: ApprovalDecision;
  via: "click" | "voice";
  typedConfirm?: string | null;
}

export interface PermissionRequest {
  id: string;
  taskID: string;
  toolName: string;
  args: Record<string, string>;
  risk: RiskLevel;
  reason: string | null;
  requestedAt: number;
  expiresAt: number;
}

export type AgentEvent =
  | { kind: "thinking"; taskID: string }
  | { kind: "toolCall"; taskID: string; name: string; args: Record<string, string> }
  | { kind: "permissionRequest"; taskID: string; request: PermissionRequest }
  | { kind: "progress"; taskID: string; text: string }
  | { kind: "completed"; taskID: string; text: string }
  | { kind: "failed"; taskID: string; reason: string }
  | { kind: "cancelled"; taskID: string };

export type SessionStatus = "active" | "completed" | "abandoned";

export interface Session {
  schemaVersion: 1;
  id: string;
  startedAt: number;
  endedAt: number | null;
  status: SessionStatus;
  utterances: Utterance[];
}

export interface HealthStatus {
  reachable: boolean;
  latencyMs: number | null;
  version: string | null;
  checkedAt: number;
  detail: string;
}

export interface ModelInfo {
  id: string;
  ownedBy: string | null;
}

export interface ComboInfo {
  name: string;
  models: string[];
}

export interface AuditEntry {
  id: string;
  at: number;
  toolName: string;
  risk: RiskLevel;
  decision: ApprovalDecision | "timeout-deny";
  argsRedacted: string;
  via: "click" | "voice" | "timeout" | "policy";
}

export type Lang = "hinglish" | "english";

export type BridgeMode = "local" | "mock" | "subprocess" | "http";

export interface Settings {
  settingsSchemaVersion: 1;
  lang: Lang;
  // Voice
  sttLocale: "en-IN" | "hi-IN" | "en-US";
  onDeviceSTT: boolean;
  ttsEngine: "webSpeech" | "edgeTTS" | "apple" | "gemini";
  ttsVoiceURI: string | null;
  ttsRate: number;
  ttsPitch: number;
  ttsVolume: number;
  speakProgress: boolean;
  confidenceThreshold: number;
  // Agent
  bridgeMode: BridgeMode;
  bridgeURL: string;
  useBridgeTTS: boolean;
  hermesPath: string;
  hermesWorkingDir: string;
  hermesTimeoutSec: number;
  httpBridgeBaseURL: string;
  // Router
  omnirouteBaseURL: string;
  healthPollSec: number;
  probeModel: string;
  // Permissions
  autoApproveLowRisk: boolean;
  permissionTimeoutSec: number;
  voiceApproval: boolean;
  // Privacy
  saveDebugAudio: boolean;
  redactLogs: boolean;
  // UI
  overlayAutoHideSec: number;
  startupChime: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  settingsSchemaVersion: 1,
  lang: "hinglish",
  sttLocale: "en-IN",
  onDeviceSTT: true,
  ttsEngine: "edgeTTS",
  ttsVoiceURI: null,
  ttsRate: 1,
  ttsPitch: 1,
  ttsVolume: 1,
  speakProgress: true,
  confidenceThreshold: 0.6,
  bridgeMode: "local",
  bridgeURL: "http://127.0.0.1:20130",
  useBridgeTTS: true,
  hermesPath: "/Users/apple/.hermes/hermes-agent/.hermes/bin/hermes",
  hermesWorkingDir: "~/.hermes",
  hermesTimeoutSec: 300,
  httpBridgeBaseURL: "http://127.0.0.1:8080",
  omnirouteBaseURL: "http://127.0.0.1:20128",
  healthPollSec: 60,
  probeModel: "opc/beam-free",
  autoApproveLowRisk: false,
  permissionTimeoutSec: 60,
  voiceApproval: true,
  saveDebugAudio: false,
  redactLogs: true,
  overlayAutoHideSec: 5,
  startupChime: false,
};

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogLine {
  id: string;
  at: number;
  level: LogLevel;
  category: "app" | "audio" | "stt" | "tts" | "agent" | "router" | "permissions" | "state";
  message: string;
}

export function uid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return "id-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
