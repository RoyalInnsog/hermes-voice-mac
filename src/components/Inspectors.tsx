import { useState } from "react";
import type { Orchestrator } from "../hooks/useHermesVoice";
import { Badge, Button, Empty, Panel, SectionTitle, Select, TextField } from "./ui";
import { logger } from "../lib/logger";
import { exportAudit } from "../lib/store";
import { runSelfTests, TEST_COUNT, type TestResult } from "../lib/selfTest";
import { DOCS } from "../docs/content";
import { cn } from "../utils/cn";
import type { AuditEntry, LogLevel, RiskLevel } from "../lib/types";

const RISK_COLOR: Record<RiskLevel, string> = {
  low: "#22c55e",
  medium: "#f59e0b",
  high: "#fb923c",
  critical: "#ef4444",
};
const RISK_BG: Record<RiskLevel, string> = {
  low: "rgba(34, 197, 94, 0.14)",
  medium: "rgba(245, 158, 11, 0.16)",
  high: "rgba(251, 146, 60, 0.16)",
  critical: "rgba(239, 68, 68, 0.18)",
};

/* -------------------------------- Backend -------------------------------- */

const ENDPOINTS: { method: string; path: string; what: string }[] = [
  { method: "GET", path: "/", what: "serves production Vite dist/index.html & static assets" },
  { method: "GET", path: "/api/health", what: "bridge + hermes + omniroute + python edge-tts capability" },
  { method: "POST", path: "/api/tasks", what: "spawn hermes chat -q <query> --format stream-json" },
  { method: "GET", path: "/api/tasks/:id/events", what: "SSE stream of AgentEvents (stream-json + HV_*)" },
  { method: "POST", path: "/api/tasks/:id/permissions/:rid/decision", what: "direct HV_DECISION → child stdin" },
  { method: "DELETE", path: "/api/tasks/:id", what: "cancel process group (SIGTERM → 5s → SIGKILL)" },
  { method: "GET", path: "/api/router/health", what: "read-only proxy to OmniRoute (127.0.0.1:20128)" },
  { method: "GET", path: "/api/router/models", what: "GET /v1/models (read-only)" },
  { method: "GET", path: "/api/router/combos", what: "read-only SQLite ~/.9router/db/data.sqlite + HTTP combos" },
  { method: "POST", path: "/api/router/probe", what: "chat completions probe (stream:false)" },
  { method: "POST", path: "/api/tts", what: "cached edge-tts via venv python (macOS say fallback)" },
  { method: "GET", path: "/api/audit", what: "append-only, redacted permission decisions" },
  { method: "GET", path: "/api/sessions", what: "persisted sessions (100 newest / 30d)" },
  { method: "GET", path: "/api/memory", what: "read-only ~/.hermes/memories (path-jailed)" },
  { method: "GET", path: "/api/logs", what: "redacted bridge logs" },
  { method: "GET", path: "/api/selftest", what: "runs the backend integration test suite live" },
];

const START_CMDS = [
  { label: "Production Self-Contained Server (UI + API on :20130)", cmd: "npm start" },
  { label: "Build macOS Floating App Bundle (dist/Hermes Voice.app)", cmd: "bash scripts/build-macos-app.sh" },
  { label: "Launch Native macOS Floating HUD (420x680 · ⌥Space)", cmd: "npm run hud" },
  { label: "End-to-End v1.0 Verification Suite", cmd: "node scripts/verify-v1.mjs" },
  { label: "Backend Integration Self-Tests", cmd: "node server/selftest.mjs" },
];

export function BackendPanel({ o }: { o: Orchestrator }) {
  const h = o.backend.health;
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).catch(() => {});
    setCopied(text);
    setTimeout(() => setCopied(null), 1600);
  };

  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
      <Panel className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <SectionTitle hint={o.backend.reachable ? `pid ${h?.pid} · uptime ${h?.uptimeSec}s` : "not reachable"}>
              Local Bridge & Runtime Status
            </SectionTitle>
            <div className="flex flex-wrap items-center gap-2">
              <TextField mono value={o.settings.bridgeURL} onChange={(v) => o.update("bridgeURL", v)} className="w-[260px]" />
              <Button variant="primary" onClick={() => void o.refreshBackend()}>
                Connect
              </Button>
              <Button onClick={() => void o.loadBackendData()} disabled={!o.backend.reachable}>
                Load data
              </Button>
            </div>
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <Badge tone={o.backend.reachable ? "green" : "rose"} dot>
              {o.backend.reachable ? `online · v${h?.version ?? "1.0.0"}` : "offline"}
            </Badge>
            <span className="font-mono text-[10.5px] text-[var(--color-muted)]">{o.backend.reason}</span>
          </div>
        </div>

        {h && (
          <div className="mt-3.5 grid grid-cols-2 gap-2.5 md:grid-cols-4">
            {[
              {
                k: "hermes cli",
                v: h.hermes.found ? h.hermes.path?.split("/").pop() ?? "found" : "MISSING",
                sub: h.hermes.path ?? h.hermes.detail,
                tone: h.hermes.found ? "green" : "rose",
              },
              {
                k: "omniroute (RO)",
                v: h.omniroute.reachable ? `${h.omniroute.latencyMs}ms` : "unreachable",
                sub: o.combos.pathUsed ?? h.omniroute.baseURL,
                tone: h.omniroute.reachable ? "green" : "amber",
              },
              {
                k: "edge-tts venv",
                v: h.tts.engines.edge.available ? `ready (${h.tts.engines.edge.version ?? "7.3.1"})` : "missing",
                sub: h.python?.bin ?? h.tts.engines.edge.pythonBin ?? "python3",
                tone: h.tts.engines.edge.available ? "green" : "amber",
              },
              {
                k: "tasks & cache",
                v: `${h.tasks.live}/${h.tasks.cap} tasks · ${h.tts.cacheFiles ?? 0} cached`,
                sub: h.staticDist?.available ? "dist/ served on GET /" : "API mode",
                tone: "gold",
              },
            ].map((x) => (
              <div key={x.k} className="panel-flat px-3 py-2.5">
                <div className="label-xs">{x.k}</div>
                <div
                  className={cn(
                    "mt-0.5 truncate font-mono text-[12px] font-600 tabular",
                    x.tone === "green"
                      ? "text-[#4ade80]"
                      : x.tone === "rose"
                        ? "text-[#f87171]"
                        : x.tone === "amber"
                          ? "text-[#fbbf24]"
                          : "text-[var(--color-gold-bright)]",
                  )}
                >
                  {x.v}
                </div>
                <div className="mt-0.5 truncate font-mono text-[9.5px] text-[var(--color-faint)]" title={x.sub}>
                  {x.sub}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="mt-4 space-y-1.5">
          {START_CMDS.map((c) => (
            <div key={c.cmd} className="flex items-center gap-2 rounded-lg border border-[var(--color-line)] bg-[var(--color-sunken)] px-3 py-2">
              <span className="shrink-0 text-[11.5px] font-500 text-[var(--color-ink-2)]">{c.label}</span>
              <code className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-[var(--color-gold-bright)]">{c.cmd}</code>
              <Button size="xs" variant="ghost" onClick={() => copy(c.cmd)}>
                {copied === c.cmd ? "copied" : "copy"}
              </Button>
            </div>
          ))}
        </div>
        <p className="mt-2.5 text-[11.5px] leading-relaxed text-[var(--color-muted)]">
          Self-contained zero-dependency Node bridge on <span className="font-mono text-[var(--color-ink-2)]">127.0.0.1:20130</span>. Serves{" "}
          <span className="font-mono text-[var(--color-ink-2)]">dist/index.html</span> on <span className="font-mono text-[var(--color-ink-2)]">GET /</span>, caches Edge TTS audio in{" "}
          <span className="font-mono text-[var(--color-ink-2)]">~/.hermes-voice/scratch/tts-cache/</span>, and inspects OmniRoute SQLite strictly read-only.
        </p>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel className="p-4">
          <SectionTitle hint="HTTP & SSE surface">Endpoints</SectionTitle>
          <div className="space-y-1">
            {ENDPOINTS.map((e) => (
              <div key={e.method + e.path} className="flex items-start gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-[var(--color-sunken)]">
                <span
                  className={cn(
                    "mt-[1px] w-[46px] shrink-0 rounded px-1.5 py-[1px] text-center font-mono text-[9.5px] font-600",
                    e.method === "GET"
                      ? "bg-[rgba(34,197,94,0.14)] text-[#4ade80]"
                      : e.method === "POST"
                        ? "bg-[rgba(229,169,60,0.16)] text-[var(--color-gold-bright)]"
                        : "bg-[rgba(239,68,68,0.16)] text-[#f87171]",
                  )}
                >
                  {e.method}
                </span>
                <div className="min-w-0">
                  <div className="truncate font-mono text-[11px] text-[var(--color-ink)]">{e.path}</div>
                  <div className="text-[11px] text-[var(--color-muted)]">{e.what}</div>
                </div>
              </div>
            ))}
          </div>
        </Panel>

        <div className="space-y-4">
          <Panel className="p-4">
            <SectionTitle hint="server-side, live">Backend Integration Self-Tests</SectionTitle>
            <p className="mb-3 text-[11.5px] leading-relaxed text-[var(--color-muted)]">
              Verifies <span className="font-mono text-[var(--color-ink-2)]">--format stream-json</span> parsing, legacy <span className="font-mono text-[var(--color-ink-2)]">HV_*</span> markers, secret redaction, risk matrix, OmniRoute read-only SQLite contract, and real subprocess SSE + direct <span className="font-mono text-[var(--color-ink-2)]">stdin</span> permission round-trips.
            </p>
            <div className="flex items-center gap-2.5">
              <Button
                variant="primary"
                disabled={!o.backend.reachable || running}
                onClick={async () => {
                  setRunning(true);
                  await o.runServerTests();
                  setRunning(false);
                }}
              >
                {running ? "Running…" : "Run backend tests"}
              </Button>
              {o.backend.tests && (
                <Badge tone={o.backend.tests.passed === o.backend.tests.total ? "green" : "rose"} dot>
                  {o.backend.tests.passed}/{o.backend.tests.total} passed
                </Badge>
              )}
            </div>
            {o.backend.tests && (
              <div className="mt-3 max-h-[240px] space-y-1 overflow-y-auto">
                {o.backend.tests.results.map((r) => (
                  <details key={r.suite + r.name} className="rounded-lg border border-[var(--color-line)] bg-[var(--color-sunken)] px-2.5 py-1.5">
                    <summary className="flex cursor-pointer items-center gap-2 text-[11.5px]">
                      <span className={r.ok ? "text-[#4ade80]" : "text-[#f87171]"}>{r.ok ? "✓" : "✗"}</span>
                      <span className="font-mono text-[10px] uppercase text-[var(--color-muted)]">{r.suite}</span>
                      <span className="truncate text-[var(--color-ink)]">{r.name}</span>
                      <span className="ml-auto shrink-0 font-mono text-[10px] tabular text-[var(--color-faint)]">{r.ms}ms</span>
                    </summary>
                    <pre className="mt-1.5 whitespace-pre-wrap border-t border-[var(--color-line-soft)] pt-1.5 font-mono text-[10.5px] leading-relaxed text-[var(--color-ink-2)]">
                      {r.detail}
                    </pre>
                  </details>
                ))}
              </div>
            )}
          </Panel>

          <Panel className="p-4">
            <SectionTitle hint="v1.0 hybrid wire contract">Hermes CLI stream-json & stdin Protocol</SectionTitle>
            <pre className="overflow-auto rounded-xl border border-[var(--color-line)] bg-[var(--color-sunken)] p-3 font-mono text-[10.5px] leading-relaxed text-[var(--color-ink-2)]">
{`$ hermes chat -q "<utterance>" --format stream-json

stdout → {"type":"system","subtype":"init","model":"...","session_id":"..."}
stdout → {"type":"text","text":"streaming response chunk..."}
stdout → {"type":"tool_call","id":"...","name":"shell","arguments":{"command":"..."}}
stdout → {"type":"result","text":"final answer","exit_code":0}

stdin  ← HV_DECISION: {"id":"<permId>","decision":"allowOnce|allowSession|deny"}
         (Direct stdin relay — no SIGSTOP, zero thread deadlock)`}
            </pre>
          </Panel>
        </div>
      </div>

      <Panel className="p-4">
        <SectionTitle hint={o.backend.reachable ? "live tail" : "bridge offline"}>Bridge Logs</SectionTitle>
        <div className="max-h-[260px] overflow-auto rounded-xl border border-[var(--color-line)] bg-[var(--color-sunken)] p-3 font-mono text-[10.5px] leading-relaxed">
          {o.backend.logs.length === 0 ? (
            <span className="text-[var(--color-faint)]">no bridge logs loaded — click "Load data" above</span>
          ) : (
            o.backend.logs.map((l) => (
              <div key={l.id} className="flex gap-2 py-0.5">
                <span className="shrink-0 tabular text-[var(--color-faint)]">{new Date(l.at).toLocaleTimeString([], { hour12: false })}</span>
                <span
                  className={cn(
                    "w-[44px] shrink-0 uppercase",
                    l.level === "error"
                      ? "text-[#f87171]"
                      : l.level === "warn"
                        ? "text-[#fbbf24]"
                        : l.level === "info"
                          ? "text-[var(--color-gold-bright)]"
                          : "text-[var(--color-muted)]",
                  )}
                >
                  {l.level}
                </span>
                <span className="w-[82px] shrink-0 text-[#4ade80]">{l.category}</span>
                <span className="min-w-0 break-all text-[var(--color-ink-2)]">{l.message}</span>
              </div>
            ))
          )}
        </div>
      </Panel>
    </div>
  );
}

/* -------------------------------- Sessions ------------------------------- */

export function SessionsPanel({ o }: { o: Orchestrator }) {
  const [open, setOpen] = useState<string | null>(null);
  const merged = [...o.backend.sessions, ...o.sessions.filter((s) => !o.backend.sessions.some((b) => b.id === s.id))].sort(
    (a, b) => b.startedAt - a.startedAt,
  );

  return (
    <Panel className="min-h-0 flex-1 p-4" title="Sessions" hint={`${merged.length} stored · 100 newest / 30 days`}>
      {merged.length === 0 ? (
        <Empty
          title="Koi session nahi"
          body="Ek task chalao — user aur assistant turns local JSON me save ho jayenge (~/.hermes-voice/sessions me)."
        />
      ) : (
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
          {merged.map((s) => (
            <div key={s.id} className="overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-2)]">
              <button
                onClick={() => setOpen(open === s.id ? null : s.id)}
                className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-[var(--color-sunken)]"
              >
                <Badge tone={s.status === "completed" ? "green" : s.status === "abandoned" ? "rose" : "amber"} dot>
                  {s.status}
                </Badge>
                <span className="font-mono text-[11px] text-[var(--color-gold-bright)]">{s.id.slice(0, 8)}</span>
                <span className="text-[11.5px] text-[var(--color-muted)]">{new Date(s.startedAt).toLocaleString()}</span>
                <span className="ml-auto font-mono text-[11px] tabular text-[var(--color-ink-2)]">{s.utterances.length} turns</span>
                <span className="text-[var(--color-muted)]">{open === s.id ? "▾" : "▸"}</span>
              </button>
              {open === s.id && (
                <pre className="max-h-[280px] overflow-auto border-t border-[var(--color-line-soft)] bg-[var(--color-sunken)] p-3 font-mono text-[10.5px] leading-relaxed text-[var(--color-ink-2)]">
                  {JSON.stringify(s, null, 2)}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

/* --------------------------------- Audit -------------------------------- */

export function AuditPanel({ o }: { o: Orchestrator }) {
  const rows: AuditEntry[] = [...o.backend.audit, ...o.audit.filter((a) => !o.backend.audit.some((b) => b.id === a.id))];
  const download = () => {
    const blob = new Blob([exportAudit(rows)], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "hermes-voice-audit.log";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Panel
      className="min-h-0 flex-1 p-4"
      title="Permission Audit Log"
      hint={`${rows.length} decisions · append-only · redacted`}
      action={
        <>
          <Button size="sm" onClick={download} disabled={rows.length === 0}>
            Export
          </Button>
          <Button size="sm" variant="danger" onClick={o.clearAuditLog} disabled={o.audit.length === 0}>
            Clear local
          </Button>
        </>
      }
    >
      {rows.length === 0 ? (
        <Empty
          title="Abhi koi decision nahi"
          body="Ek task chalao jisme tool permission maange — har allow/deny/timeout yahan redacted args ke saath record hoga."
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          <table className="w-full text-left text-[11.5px]">
            <thead className="sticky top-0 bg-[var(--color-panel)]">
              <tr className="text-[var(--color-muted)]">
                {["Time", "Risk", "Tool", "Decision", "Via", "Args (redacted)"].map((x) => (
                  <th key={x} className="border-b border-[var(--color-line)] py-2 pr-3 font-mono text-[10px] font-600 uppercase tracking-[0.08em]">
                    {x}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id} className="border-b border-[var(--color-line-soft)] align-top transition-colors hover:bg-[var(--color-sunken)]">
                  <td className="py-2 pr-3 font-mono text-[10.5px] tabular text-[var(--color-muted)]">
                    {new Date(e.at).toLocaleTimeString([], { hour12: false })}
                  </td>
                  <td className="py-2 pr-3">
                    <span
                      className="rounded px-1.5 py-[2px] font-mono text-[9.5px] font-600 uppercase"
                      style={{ color: RISK_COLOR[e.risk], backgroundColor: RISK_BG[e.risk] }}
                    >
                      {e.risk}
                    </span>
                  </td>
                  <td className="py-2 pr-3 font-mono text-[var(--color-gold-bright)]">{e.toolName}</td>
                  <td
                    className={cn(
                      "py-2 pr-3 font-mono font-600",
                      String(e.decision).includes("deny") ? "text-[#f87171]" : "text-[#4ade80]",
                    )}
                  >
                    {e.decision}
                  </td>
                  <td className="py-2 pr-3 font-mono text-[10.5px] text-[var(--color-ink-2)]">{e.via}</td>
                  <td className="break-all py-2 font-mono text-[10.5px] text-[var(--color-muted)]">{e.argsRedacted || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

/* --------------------------------- Logs --------------------------------- */

const LEVEL_CLS: Record<string, string> = {
  debug: "text-[var(--color-muted)]",
  info: "text-[var(--color-gold-bright)]",
  warn: "text-[#fbbf24]",
  error: "text-[#f87171]",
};

export function LogsPanel({ o }: { o: Orchestrator }) {
  const [level, setLevel] = useState<LogLevel>("debug");
  const [source, setSource] = useState<"app" | "bridge">("app");
  const rank: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
  const lines = (source === "app" ? o.logs : o.backend.logs).filter((l) => rank[l.level] >= rank[level]);

  return (
    <Panel
      className="min-h-0 flex-1 p-4"
      title="System Logs"
      hint={`${lines.length} lines · redaction ${o.settings.redactLogs ? "ON" : "OFF"}`}
      action={
        <>
          <Select
            value={source}
            onChange={(v) => setSource(v as "app" | "bridge")}
            options={[
              { value: "app", label: "UI process" },
              { value: "bridge", label: "Bridge (server)" },
            ]}
            className="min-w-[130px]"
          />
          <Select
            value={level}
            onChange={(v) => setLevel(v as LogLevel)}
            options={[
              { value: "debug", label: "debug+" },
              { value: "info", label: "info+" },
              { value: "warn", label: "warn+" },
              { value: "error", label: "error only" },
            ]}
            className="min-w-[110px]"
          />
          <Button
            size="sm"
            onClick={() => {
              const blob = new Blob(
                [
                  source === "app"
                    ? logger.export()
                    : o.backend.logs.map((l) => `${new Date(l.at).toISOString()} [${l.level}] ${l.category}: ${l.message}`).join("\n"),
                ],
                { type: "text/plain" },
              );
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `hermes-voice-${source}.log`;
              a.click();
              URL.revokeObjectURL(url);
            }}
          >
            Export
          </Button>
        </>
      }
    >
      <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-[var(--color-line)] bg-[var(--color-sunken)] p-3 font-mono text-[10.5px] leading-relaxed">
        {lines.map((l) => (
          <div key={l.id} className="flex gap-2 py-0.5">
            <span className="shrink-0 tabular text-[var(--color-faint)]">{new Date(l.at).toLocaleTimeString([], { hour12: false })}</span>
            <span className={cn("w-[46px] shrink-0 uppercase", LEVEL_CLS[l.level])}>{l.level}</span>
            <span className="w-[82px] shrink-0 text-[#4ade80]">{l.category}</span>
            <span className="min-w-0 break-all text-[var(--color-ink-2)]">{l.message}</span>
          </div>
        ))}
        {lines.length === 0 && (
          <div className="text-[var(--color-faint)]">
            {source === "bridge" ? "bridge logs load nahi hue — Backend tab me 'Load data' dabao" : "is level pe koi line nahi"}
          </div>
        )}
      </div>
    </Panel>
  );
}

/* ------------------------------ Diagnostics ------------------------------ */

export function DiagnosticsPanel({ o }: { o: Orchestrator }) {
  const [results, setResults] = useState<TestResult[]>([]);
  const [running, setRunning] = useState(false);
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;

  const run = async () => {
    setRunning(true);
    setResults([]);
    setResults(await runSelfTests());
    setRunning(false);
  };

  const grouped = results.reduce<Record<string, TestResult[]>>((acc, r) => {
    (acc[r.suite] ??= []).push(r);
    return acc;
  }, {});

  const caps: [string, boolean, string][] = [
    ["SpeechRecognition (STT + 1.8s silence stop)", o.sttSupported, "en-IN / hi-IN / en-US"],
    ["speechSynthesis / Audio Barge-In", o.ttsSupported, "instant interrupt"],
    ["Self-contained Bridge online (:20130)", o.backend.reachable, "server/index.mjs"],
    ["Hermes CLI binary resolved", Boolean(o.backend.health?.hermes.found), o.backend.health?.hermes.path ?? "bridge"],
    ["OmniRoute gateway reachable (RO)", Boolean(o.health?.reachable), o.combos.pathUsed ?? "127.0.0.1:20128"],
    ["Edge TTS Python venv ready", Boolean(o.backend.health?.tts.engines.edge.available), o.backend.health?.python?.bin ?? "edge-tts 7.3.1"],
    ["macOS `say` fallback ready", Boolean(o.backend.health?.tts.engines.say.available), "say -v Rishi"],
    ["Static dist/ bundle served on GET /", Boolean(o.backend.health?.staticDist?.available), "dist/index.html"],
  ];

  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
      <Panel className="p-4">
        <SectionTitle hint="XCTest-equivalent assertions, in-browser">UI & Protocol Self-Test Suite</SectionTitle>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" onClick={() => void run()} disabled={running}>
            {running ? "Running…" : `Run ${TEST_COUNT} UI tests`}
          </Button>
          {results.length > 0 && (
            <Badge tone={failed === 0 ? "green" : "rose"} dot>
              {passed}/{results.length} passed
            </Badge>
          )}
          <span className="text-[11.5px] text-[var(--color-muted)]">
            state machine · stream-json + HV_* protocol · redaction · risk matrix · Hinglish voice decisions · router read-only contract
          </span>
        </div>
        {results.length > 0 && (
          <div className="mt-4 space-y-3">
            {Object.entries(grouped).map(([suite, rs]) => (
              <div key={suite}>
                <div className="mb-1 flex items-center gap-2">
                  <h4 className="font-mono text-[11px] font-600 uppercase tracking-[0.08em] text-[var(--color-gold-bright)]">{suite}</h4>
                  <span className={cn("font-mono text-[10.5px] tabular", rs.every((r) => r.ok) ? "text-[#4ade80]" : "text-[#f87171]")}>
                    {rs.filter((r) => r.ok).length}/{rs.length}
                  </span>
                </div>
                <div className="space-y-1">
                  {rs.map((r) => (
                    <details key={r.name} className="rounded-lg border border-[var(--color-line)] bg-[var(--color-sunken)] px-2.5 py-1.5">
                      <summary className="flex cursor-pointer items-center gap-2 text-[11.5px]">
                        <span className={r.ok ? "text-[#4ade80]" : "text-[#f87171]"}>{r.ok ? "✓" : "✗"}</span>
                        <span className="truncate text-[var(--color-ink)]">{r.name}</span>
                        <span className="ml-auto shrink-0 font-mono text-[10px] tabular text-[var(--color-faint)]">{r.ms}ms</span>
                      </summary>
                      <pre className="mt-1.5 whitespace-pre-wrap border-t border-[var(--color-line-soft)] pt-1.5 font-mono text-[10.5px] leading-relaxed text-[var(--color-ink-2)]">
                        {r.detail}
                      </pre>
                    </details>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel className="p-4">
        <SectionTitle hint="probed live, never assumed">Runtime Capabilities</SectionTitle>
        <div className="grid gap-2 sm:grid-cols-2">
          {caps.map(([label, ok, note]) => (
            <div key={label} className="flex items-center gap-2.5 rounded-xl border border-[var(--color-line)] bg-[var(--color-sunken)] px-3 py-2">
              <span className={cn("h-2 w-2 shrink-0 rounded-full", ok ? "bg-[#22c55e]" : "bg-[#524d44]")} />
              <span className="min-w-0 flex-1 truncate text-[12px] font-500 text-[var(--color-ink)]">{label}</span>
              <span className={cn("shrink-0 font-mono text-[10px] font-600 uppercase", ok ? "text-[#4ade80]" : "text-[var(--color-muted)]")}>
                {ok ? "ready" : "offline"}
              </span>
              <span className="hidden max-w-[140px] shrink-0 truncate font-mono text-[10px] text-[var(--color-faint)] lg:inline" title={note}>
                {note}
              </span>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

/* ---------------------------------- Docs --------------------------------- */

function renderBody(body: string) {
  const lines = body.split("\n");
  const out: React.ReactNode[] = [];
  let codeBlock: string[] | null = null;

  lines.forEach((line, i) => {
    if (/^ {4}/.test(line) || line.startsWith("```")) {
      if (line.startsWith("```")) {
        if (codeBlock) {
          out.push(
            <pre key={i} className="mb-3 overflow-auto rounded-xl border border-[var(--color-line)] bg-[var(--color-sunken)] p-3 font-mono text-[11px] leading-relaxed text-[var(--color-ink-2)]">
              {codeBlock.join("\n")}
            </pre>,
          );
          codeBlock = null;
        } else codeBlock = [];
        return;
      }
      (codeBlock ??= []).push(line.replace(/^ {4}/, ""));
      return;
    }
    if (codeBlock) {
      out.push(
        <pre key={i} className="mb-3 overflow-auto rounded-xl border border-[var(--color-line)] bg-[var(--color-sunken)] p-3 font-mono text-[11px] leading-relaxed text-[var(--color-ink-2)]">
          {codeBlock.join("\n")}
        </pre>,
      );
      codeBlock = null;
    }

    if (line.startsWith("# "))
      return out.push(
        <h2 key={i} className="mb-2 mt-5 font-display text-[17px] font-800 tracking-tight text-[var(--color-ink)] first:mt-0">
          {line.slice(2)}
        </h2>,
      );
    if (line.startsWith("## "))
      return out.push(
        <h3 key={i} className="mb-1.5 mt-4 font-display text-[14px] font-700 tracking-tight text-[var(--color-gold-bright)]">
          {line.slice(3)}
        </h3>,
      );
    if (line.startsWith("### "))
      return out.push(
        <h4 key={i} className="mb-1 mt-3 font-display text-[13px] font-700 text-[var(--color-ink)]">
          {line.slice(4)}
        </h4>,
      );
    if (line.trim() === "") return out.push(<div key={i} className="h-2" />);
    if (/^\|/.test(line)) return out.push(<div key={i} className="font-mono text-[10.5px] leading-relaxed text-[var(--color-ink-2)]">{line}</div>);

    const parts = line.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, j) => {
      if (part.startsWith("**"))
        return (
          <strong key={j} className="font-600 text-[var(--color-ink)]">
            {part.slice(2, -2)}
          </strong>
        );
      if (part.startsWith("`"))
        return (
          <code key={j} className="rounded bg-[var(--color-sunken)] px-1 py-[1px] font-mono text-[11px] text-[var(--color-gold-bright)]">
            {part.slice(1, -1)}
          </code>
        );
      return part;
    });
    return out.push(
      <p key={i} className="text-[12.5px] leading-relaxed text-[var(--color-ink-2)]">
        {parts}
      </p>,
    );
  });

  const tail = codeBlock as string[] | null;
  if (tail && tail.length)
    out.push(
      <pre key="tail" className="mb-3 overflow-auto rounded-xl border border-[var(--color-line)] bg-[var(--color-sunken)] p-3 font-mono text-[11px] leading-relaxed text-[var(--color-ink-2)]">
        {tail.join("\n")}
      </pre>,
    );
  return out;
}

export function DocsPanel() {
  const [active, setActive] = useState(DOCS[0].id);
  const doc = DOCS.find((d) => d.id === active)!;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 md:flex-row">
      <nav className="flex shrink-0 gap-1.5 overflow-x-auto md:w-[196px] md:flex-col">
        {DOCS.map((d) => (
          <button
            key={d.id}
            onClick={() => setActive(d.id)}
            className={cn(
              "shrink-0 rounded-xl px-3 py-2.5 text-left transition-all",
              active === d.id
                ? "bg-[var(--color-panel-2)] ring-1 ring-[rgba(229,169,60,0.4)]"
                : "hover:bg-[var(--color-sunken)]",
            )}
          >
            <div className={cn("font-mono text-[11px] font-600", active === d.id ? "text-[var(--color-gold-bright)]" : "text-[var(--color-ink-2)]")}>
              {d.title}
            </div>
            <div className="mt-0.5 hidden text-[10.5px] leading-snug text-[var(--color-muted)] md:block">{d.subtitle}</div>
          </button>
        ))}
      </nav>
      <Panel className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="max-w-3xl">{renderBody(doc.body)}</div>
      </Panel>
    </div>
  );
}
