import { useState } from "react";
import type { Orchestrator } from "../hooks/useHermesVoice";
import { Badge, Button, Empty, Panel, SectionTitle, Select, TextField } from "./ui";
import { logger } from "../lib/logger";
import { exportAudit } from "../lib/store";
import { runSelfTests, TEST_COUNT, type TestResult } from "../lib/selfTest";
import { DOCS } from "../docs/content";
import { cn } from "../utils/cn";
import type { AuditEntry, LogLevel, RiskLevel } from "../lib/types";

const RISK_COLOR: Record<RiskLevel, string> = { low: "#0b6b60", medium: "#a9650a", high: "#b4441a", critical: "#ac2340" };
const RISK_BG: Record<RiskLevel, string> = { low: "var(--color-pine-wash)", medium: "var(--color-amber-wash)", high: "#fbe9e0", critical: "var(--color-rose-wash)" };

/* -------------------------------- Backend -------------------------------- */

const ENDPOINTS: { method: string; path: string; what: string }[] = [
  { method: "GET", path: "/api/health", what: "bridge + hermes + omniroute + tts capability" },
  { method: "POST", path: "/api/tasks", what: "spawn the agent, returns taskId" },
  { method: "GET", path: "/api/tasks/:id/events", what: "SSE stream of AgentEvents" },
  { method: "POST", path: "/api/tasks/:id/permissions/:rid/decision", what: "decision → child stdin" },
  { method: "DELETE", path: "/api/tasks/:id", what: "cancel (SIGTERM → SIGKILL)" },
  { method: "GET", path: "/api/router/health", what: "read-only proxy to Omniroute" },
  { method: "GET", path: "/api/router/models", what: "GET /v1/models" },
  { method: "GET", path: "/api/router/combos", what: "read-only combo discovery" },
  { method: "POST", path: "/api/router/probe", what: "chat completions, stream:false" },
  { method: "POST", path: "/api/tts", what: "edge-tts → audio file (say fallback)" },
  { method: "GET", path: "/api/audit", what: "append-only, redacted decisions" },
  { method: "GET", path: "/api/sessions", what: "persisted sessions (100 / 30d)" },
  { method: "GET", path: "/api/memory", what: "read-only ~/.hermes/memories" },
  { method: "GET", path: "/api/logs", what: "redacted bridge logs" },
  { method: "GET", path: "/api/selftest", what: "runs the backend test suite live" },
];

const START_CMDS = [
  { label: "Real Hermes (jab CLI ready ho)", cmd: "node server/index.mjs" },
  { label: "Simulated agent (aaj hi verify karo)", cmd: 'HV_HERMES_CMD="node server/fake-hermes.mjs" node server/index.mjs' },
  { label: "Live end-to-end probe", cmd: "node scripts/probe-bridge.mjs" },
  { label: "Backend test suite", cmd: "node server/selftest.mjs" },
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
            <SectionTitle hint={o.backend.reachable ? `pid ${h?.pid} · uptime ${h?.uptimeSec}s` : "not reachable"}>Local bridge connection</SectionTitle>
            <div className="flex items-center gap-2">
              <TextField mono value={o.settings.bridgeURL} onChange={(v) => o.update("bridgeURL", v)} className="w-[280px]" />
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
              {o.backend.reachable ? `online · v${h?.version}` : "offline"}
            </Badge>
            <span className="font-mono text-[10.5px] text-[var(--color-faint)]">{o.backend.reason}</span>
          </div>
        </div>

        {h && (
          <div className="mt-3.5 grid grid-cols-2 gap-2.5 md:grid-cols-4">
            {[
              { k: "hermes binary", v: h.hermes.found ? h.hermes.path?.split("/").pop() ?? "found" : "MISSING", tone: h.hermes.found ? "green" : "rose" },
              { k: "omniroute", v: h.omniroute.reachable ? `${h.omniroute.latencyMs}ms` : "unreachable", tone: h.omniroute.reachable ? "green" : "amber" },
              { k: "edge-tts", v: h.tts.engines.edge.available ? "ready" : "missing", tone: h.tts.engines.edge.available ? "green" : "amber" },
              { k: "tasks", v: `${h.tasks.live} live / cap ${h.tasks.cap}`, tone: "slate" },
            ].map((x) => (
              <div key={x.k} className="panel-flat px-3 py-2">
                <div className="label-xs">{x.k}</div>
                <div className={cn("mt-0.5 truncate font-mono text-[12px] font-600", x.tone === "green" ? "text-[var(--color-pine)]" : x.tone === "rose" ? "text-[var(--color-rose)]" : x.tone === "amber" ? "text-[var(--color-amber)]" : "text-[var(--color-ink)]")}>
                  {x.v}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="mt-4 space-y-1.5">
          {START_CMDS.map((c) => (
            <div key={c.cmd} className="flex items-center gap-2 rounded-lg border border-[var(--color-line)] bg-[var(--color-sunken)] px-3 py-2">
              <span className="shrink-0 text-[11.5px] font-500 text-[var(--color-muted)]">{c.label}</span>
              <code className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-[var(--color-ink)]">{c.cmd}</code>
              <Button size="xs" variant="ghost" onClick={() => copy(c.cmd)}>
                {copied === c.cmd ? "copied" : "copy"}
              </Button>
            </div>
          ))}
        </div>
        <p className="mt-2.5 text-[11.5px] leading-relaxed text-[var(--color-muted)]">
          Bridge zero-dependency hai (sirf Node ≥18). Data <span className="font-mono">{h?.dataDir ?? "~/.hermes-voice"}</span> me jaata hai — audit.jsonl append-only,
          sessions/*.json, logs/. Loopback-only bind, non-loopback peer ko 403.
        </p>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel className="p-4">
          <SectionTitle hint="HTTP surface">Endpoints</SectionTitle>
          <div className="space-y-1">
            {ENDPOINTS.map((e) => (
              <div key={e.method + e.path} className="flex items-start gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-[var(--color-sunken)]">
                <span
                  className={cn(
                    "mt-[1px] shrink-0 rounded px-1.5 py-[1px] font-mono text-[9.5px] font-600",
                    e.method === "GET" ? "bg-[var(--color-pine-wash)] text-[var(--color-pine)]" : e.method === "POST" ? "bg-[#e7ebfd] text-[var(--color-indigo-ink)]" : "bg-[var(--color-rose-wash)] text-[var(--color-rose)]",
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
            <SectionTitle hint="server-side, live">Backend self-tests</SectionTitle>
            <p className="mb-3 text-[11.5px] leading-relaxed text-[var(--color-muted)]">
              Protocol parsing, redaction, risk matrix, Omniroute read-only contract, store jail — aur <span className="font-600 text-[var(--color-ink-2)]">real integration tests</span> jo
              fake-hermes ko spawn karke SSE + stdin permission round-trip chalate hain.
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
                  <details key={r.suite + r.name} className="rounded-lg border border-[var(--color-line-soft)] bg-white px-2.5 py-1.5">
                    <summary className="flex cursor-pointer items-center gap-2 text-[11.5px]">
                      <span className={r.ok ? "text-[var(--color-pine)]" : "text-[var(--color-rose)]"}>{r.ok ? "✓" : "✗"}</span>
                      <span className="font-mono text-[10px] uppercase text-[var(--color-faint)]">{r.suite}</span>
                      <span className="truncate text-[var(--color-ink-2)]">{r.name}</span>
                      <span className="ml-auto shrink-0 font-mono text-[10px] text-[var(--color-faint)]">{r.ms}ms</span>
                    </summary>
                    <pre className="mt-1.5 whitespace-pre-wrap border-t border-[var(--color-line-soft)] pt-1.5 font-mono text-[10.5px] leading-relaxed text-[var(--color-muted)]">{r.detail}</pre>
                  </details>
                ))}
              </div>
            )}
          </Panel>

          <Panel className="p-4">
            <SectionTitle hint="wire contract">Hermes stdout / stdin protocol</SectionTitle>
            <pre className="overflow-auto rounded-xl border border-[var(--color-line)] bg-[#0f1319] p-3 font-mono text-[10.5px] leading-relaxed text-[#c8d3e0]">
{`HV_EVENT:    {"kind":"thinking|toolCall|progress|completed|failed|cancelled", ...}
HV_PERM:     {"tool":"shell","args":{...},"reason":"...","risk"?}
HV_PROGRESS: <free text>
<unmarked>   → plain assistant text (graceful fallback)

stdin  ←  HV_DECISION: {"id":"<permId>","decision":"allowOnce|allowSession|deny"}

TODO-VERIFY: \`hermes chat --help\` — agar Hermes ye markers emit nahi
kar sakta to permission interception available nahi (LIMITATIONS L-2).`}
            </pre>
          </Panel>
        </div>
      </div>

      <Panel className="p-4">
        <SectionTitle hint={o.backend.reachable ? "live tail" : "bridge offline"}>Bridge logs</SectionTitle>
        <div className="max-h-[260px] overflow-auto rounded-xl border border-[var(--color-line)] bg-[#0f1319] p-3 font-mono text-[10.5px] leading-relaxed">
          {o.backend.logs.length === 0 ? (
            <span className="text-[#5d6b7d]">no bridge logs loaded — "Load data" dabao</span>
          ) : (
            o.backend.logs.map((l) => (
              <div key={l.id} className="flex gap-2">
                <span className="shrink-0 text-[#5d6b7d]">{new Date(l.at).toLocaleTimeString([], { hour12: false })}</span>
                <span className={cn("w-[42px] shrink-0 uppercase", l.level === "error" ? "text-[#ff8fa3]" : l.level === "warn" ? "text-[#ffc46b]" : l.level === "info" ? "text-[#7fd6c5]" : "text-[#8f9bad]")}>{l.level}</span>
                <span className="w-[76px] shrink-0 text-[#b6a6ff]">{l.category}</span>
                <span className="min-w-0 break-all text-[#c8d3e0]">{l.message}</span>
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
  const merged = [...o.backend.sessions, ...o.sessions.filter((s) => !o.backend.sessions.some((b) => b.id === s.id))].sort((a, b) => b.startedAt - a.startedAt);

  return (
    <Panel className="min-h-0 flex-1 p-4" title="Sessions" hint={`${merged.length} stored · 100 newest / 30 days`}>
      {merged.length === 0 ? (
        <Empty title="Koi session nahi" body="Ek task chalao — user aur assistant turns local JSON me save ho jayenge (bridge online ho to ~/.hermes-voice/sessions me)." />
      ) : (
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
          {merged.map((s) => (
            <div key={s.id} className="overflow-hidden rounded-xl border border-[var(--color-line)] bg-white">
              <button onClick={() => setOpen(open === s.id ? null : s.id)} className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-[var(--color-sunken)]">
                <Badge tone={s.status === "completed" ? "green" : s.status === "abandoned" ? "rose" : "amber"}>{s.status}</Badge>
                <span className="font-mono text-[11px] text-[var(--color-muted)]">{s.id.slice(0, 8)}</span>
                <span className="text-[11.5px] text-[var(--color-faint)]">{new Date(s.startedAt).toLocaleString()}</span>
                <span className="ml-auto font-mono text-[11px] text-[var(--color-muted)]">{s.utterances.length} turns</span>
                <span className="text-[var(--color-faint)]">{open === s.id ? "▾" : "▸"}</span>
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
      title="Permission audit log"
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
        <Empty title="Abhi koi decision nahi" body="Ek task chalao jisme tool permission maange — har allow/deny/timeout yahan redacted args ke saath record hoga." />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          <table className="w-full text-left text-[11.5px]">
            <thead className="sticky top-0 bg-white">
              <tr className="text-[var(--color-faint)]">
                {["Time", "Risk", "Tool", "Decision", "Via", "Args (redacted)"].map((x) => (
                  <th key={x} className="border-b border-[var(--color-line)] py-2 pr-3 font-mono text-[10px] font-500 uppercase tracking-[0.08em]">
                    {x}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id} className="border-b border-[var(--color-line-soft)] align-top transition-colors hover:bg-[var(--color-sunken)]">
                  <td className="py-2 pr-3 font-mono text-[10.5px] tabular text-[var(--color-faint)]">{new Date(e.at).toLocaleTimeString([], { hour12: false })}</td>
                  <td className="py-2 pr-3">
                    <span className="rounded px-1.5 py-[2px] font-mono text-[9.5px] font-600 uppercase" style={{ color: RISK_COLOR[e.risk], backgroundColor: RISK_BG[e.risk] }}>
                      {e.risk}
                    </span>
                  </td>
                  <td className="py-2 pr-3 font-mono text-[var(--color-indigo-ink)]">{e.toolName}</td>
                  <td className={cn("py-2 pr-3 font-mono font-500", String(e.decision).includes("deny") ? "text-[var(--color-rose)]" : "text-[var(--color-pine)]")}>{e.decision}</td>
                  <td className="py-2 pr-3 text-[var(--color-muted)]">{e.via}</td>
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

const LEVEL_CLS: Record<string, string> = { debug: "text-[var(--color-faint)]", info: "text-[var(--color-indigo-ink)]", warn: "text-[var(--color-amber)]", error: "text-[var(--color-rose)]" };

export function LogsPanel({ o }: { o: Orchestrator }) {
  const [level, setLevel] = useState<LogLevel>("debug");
  const [source, setSource] = useState<"app" | "bridge">("app");
  const rank: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
  const lines = (source === "app" ? o.logs : o.backend.logs).filter((l) => rank[l.level] >= rank[level]);

  return (
    <Panel
      className="min-h-0 flex-1 p-4"
      title="Logs"
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
              const blob = new Blob([source === "app" ? logger.export() : o.backend.logs.map((l) => `${new Date(l.at).toISOString()} [${l.level}] ${l.category}: ${l.message}`).join("\n")], { type: "text/plain" });
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
          <div key={l.id} className="flex gap-2">
            <span className="shrink-0 tabular text-[var(--color-faint)]">{new Date(l.at).toLocaleTimeString([], { hour12: false })}</span>
            <span className={cn("w-[46px] shrink-0 uppercase", LEVEL_CLS[l.level])}>{l.level}</span>
            <span className="w-[82px] shrink-0 text-[var(--color-pine)]">{l.category}</span>
            <span className="min-w-0 break-all text-[var(--color-ink-2)]">{l.message}</span>
          </div>
        ))}
        {lines.length === 0 && <div className="text-[var(--color-faint)]">{source === "bridge" ? "bridge logs load nahi hue — Backend tab me 'Load data'" : "is level pe koi line nahi"}</div>}
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
    ["SpeechRecognition (STT)", o.sttSupported, "browser"],
    ["speechSynthesis (TTS)", o.ttsSupported, "browser"],
    ["Local bridge online", o.backend.reachable, "server/index.mjs"],
    ["Agent binary resolved", Boolean(o.backend.health?.hermes.found), "bridge"],
    ["Omniroute reachable", Boolean(o.health?.reachable), "bridge → 20128"],
    ["edge-tts installed", Boolean(o.backend.health?.tts.engines.edge.available), "pip install edge-tts"],
    ["Agent bridge usable", o.bridgeStatus.ok, o.bridgeId],
    ["Process spawning (in page)", false, "impossible in a browser — bridge does it"],
    ["Keychain", false, "native build only"],
    ["OS-level global hotkey", false, "native build only"],
  ];

  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
      <Panel className="p-4">
        <SectionTitle hint="XCTest-equivalent assertions, in-browser">UI logic test suite</SectionTitle>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" onClick={() => void run()} disabled={running}>
            {running ? "Running…" : `Run ${TEST_COUNT} tests`}
          </Button>
          {results.length > 0 && (
            <Badge tone={failed === 0 ? "green" : "rose"} dot>
              {passed}/{results.length} passed
            </Badge>
          )}
          <span className="text-[11.5px] text-[var(--color-muted)]">state machine · redaction · risk matrix · wire protocol · router read-only contract · retention</span>
        </div>
        {results.length > 0 && (
          <div className="mt-4 space-y-3">
            {Object.entries(grouped).map(([suite, rs]) => (
              <div key={suite}>
                <div className="mb-1 flex items-center gap-2">
                  <h4 className="font-mono text-[11px] font-600 uppercase tracking-[0.08em] text-[var(--color-ink-2)]">{suite}</h4>
                  <span className={cn("font-mono text-[10.5px]", rs.every((r) => r.ok) ? "text-[var(--color-pine)]" : "text-[var(--color-rose)]")}>
                    {rs.filter((r) => r.ok).length}/{rs.length}
                  </span>
                </div>
                <div className="space-y-1">
                  {rs.map((r) => (
                    <details key={r.name} className="rounded-lg border border-[var(--color-line-soft)] bg-white px-2.5 py-1.5">
                      <summary className="flex cursor-pointer items-center gap-2 text-[11.5px]">
                        <span className={r.ok ? "text-[var(--color-pine)]" : "text-[var(--color-rose)]"}>{r.ok ? "✓" : "✗"}</span>
                        <span className="truncate text-[var(--color-ink-2)]">{r.name}</span>
                        <span className="ml-auto shrink-0 font-mono text-[10px] text-[var(--color-faint)]">{r.ms}ms</span>
                      </summary>
                      <pre className="mt-1.5 whitespace-pre-wrap border-t border-[var(--color-line-soft)] pt-1.5 font-mono text-[10.5px] leading-relaxed text-[var(--color-muted)]">{r.detail}</pre>
                    </details>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel className="p-4">
        <SectionTitle hint="probed, never assumed">Runtime capabilities</SectionTitle>
        <div className="grid gap-2 sm:grid-cols-2">
          {caps.map(([label, ok, note]) => (
            <div key={label} className="flex items-center gap-2.5 rounded-xl border border-[var(--color-line)] bg-white px-3 py-2">
              <span className={cn("h-2 w-2 shrink-0 rounded-full", ok ? "bg-[var(--color-pine-bright)]" : "bg-[#c9d1dc]")} />
              <span className="min-w-0 flex-1 truncate text-[12px] font-500 text-[var(--color-ink-2)]">{label}</span>
              <span className={cn("shrink-0 font-mono text-[10px] uppercase", ok ? "text-[var(--color-pine)]" : "text-[var(--color-faint)]")}>{ok ? "yes" : "no"}</span>
              <span className="hidden shrink-0 truncate font-mono text-[10px] text-[var(--color-faint)] lg:inline">{note}</span>
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
            <pre key={i} className="mb-3 overflow-auto rounded-xl border border-[#1d2530] bg-[#0f1319] p-3 font-mono text-[11px] leading-relaxed text-[#c8d3e0]">
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
        <pre key={i} className="mb-3 overflow-auto rounded-xl border border-[#1d2530] bg-[#0f1319] p-3 font-mono text-[11px] leading-relaxed text-[#c8d3e0]">
          {codeBlock.join("\n")}
        </pre>,
      );
      codeBlock = null;
    }

    if (line.startsWith("# ")) return out.push(<h2 key={i} className="mb-2 mt-5 font-display text-[17px] font-800 tracking-tight text-[var(--color-ink)] first:mt-0">{line.slice(2)}</h2>);
    if (line.startsWith("## ")) return out.push(<h3 key={i} className="mb-1.5 mt-4 font-display text-[14px] font-700 tracking-tight text-[var(--color-pine)]">{line.slice(3)}</h3>);
    if (line.startsWith("### ")) return out.push(<h4 key={i} className="mb-1 mt-3 font-display text-[13px] font-700 text-[var(--color-indigo-ink)]">{line.slice(4)}</h4>);
    if (line.trim() === "") return out.push(<div key={i} className="h-2" />);
    if (/^\|/.test(line)) return out.push(<div key={i} className="font-mono text-[10.5px] leading-relaxed text-[var(--color-ink-2)]">{line}</div>);

    const parts = line.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, j) => {
      if (part.startsWith("**")) return <strong key={j} className="font-600 text-[var(--color-ink)]">{part.slice(2, -2)}</strong>;
      if (part.startsWith("`")) return <code key={j} className="rounded bg-[var(--color-sunken)] px-1 py-[1px] font-mono text-[11px] text-[var(--color-amber)]">{part.slice(1, -1)}</code>;
      return part;
    });
    return out.push(<p key={i} className="text-[12.5px] leading-relaxed text-[var(--color-ink-2)]">{parts}</p>);
  });

  const tail = codeBlock as string[] | null;
  if (tail && tail.length)
    out.push(
      <pre key="tail" className="mb-3 overflow-auto rounded-xl border border-[#1d2530] bg-[#0f1319] p-3 font-mono text-[11px] leading-relaxed text-[#c8d3e0]">
        {tail.join("\n")}
      </pre>,
    );
  return out;
}

export function DocsPanel() {
  const [active, setActive] = useState(DOCS[0].id);
  const doc = DOCS.find((d) => d.id === active)!;
  return (
    <div className="flex min-h-0 flex-1 gap-4">
      <nav className="w-[188px] shrink-0 space-y-1.5">
        {DOCS.map((d) => (
          <button
            key={d.id}
            onClick={() => setActive(d.id)}
            className={cn(
              "w-full rounded-xl px-3 py-2.5 text-left transition-all",
              active === d.id ? "bg-white shadow-[0_1px_3px_rgba(15,19,25,0.08)] ring-1 ring-[var(--color-line)]" : "hover:bg-white/60",
            )}
          >
            <div className={cn("font-mono text-[11px] font-600", active === d.id ? "text-[var(--color-pine)]" : "text-[var(--color-ink-2)]")}>{d.title}</div>
            <div className="mt-0.5 text-[10.5px] leading-snug text-[var(--color-muted)]">{d.subtitle}</div>
          </button>
        ))}
      </nav>
      <Panel className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="max-w-3xl">{renderBody(doc.body)}</div>
      </Panel>
    </div>
  );
}
