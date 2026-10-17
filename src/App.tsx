import { useEffect, useState } from "react";
import { useHermesVoice } from "./hooks/useHermesVoice";
import { VoiceDeck } from "./components/VoiceDeck";
import { PermissionDialog } from "./components/PermissionDialog";
import { Console } from "./components/Console";
import { SettingsPanel } from "./components/SettingsPanel";
import { AuditPanel, BackendPanel, DiagnosticsPanel, DocsPanel, LogsPanel, SessionsPanel } from "./components/Inspectors";
import { Badge } from "./components/ui";
import { stateCopy } from "./lib/strings";
import type { StateName } from "./lib/stateMachine";
import { cn } from "./utils/cn";

const TABS = [
  { id: "console", label: "Console", icon: "M4 6h16M4 12h10M4 18h13" },
  { id: "backend", label: "Backend", icon: "M5 4h14v6H5zM5 14h14v6H5zM8 7h.01M8 17h.01" },
  { id: "settings", label: "Settings", icon: "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.4-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4.1a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 11a2 2 0 1 1 0 4Z" },
  { id: "sessions", label: "Sessions", icon: "M4 5h16v14H4zM4 9h16M9 9v10" },
  { id: "audit", label: "Audit", icon: "M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6zM9.5 12l2 2 3.5-3.5" },
  { id: "logs", label: "Logs", icon: "M6 4h9l3 3v13H6zM9 11h6M9 15h6" },
  { id: "tests", label: "Tests", icon: "M9 3h6v5l3.5 8a2 2 0 0 1-1.8 2.9H7.3A2 2 0 0 1 5.5 16L9 8z" },
  { id: "docs", label: "Docs", icon: "M7 3h7l4 4v14H7zM14 3v4h4M10 12h6M10 16h6" },
] as const;
type TabId = (typeof TABS)[number]["id"];

const STATE_COLOR: Record<StateName, string> = {
  starting: "#98a2b1",
  idle: "#0b6b60",
  listening: "#0f9c8a",
  transcribing: "#2f4bd8",
  confirmingTranscript: "#7c3aed",
  thinking: "#2f4bd8",
  awaitingPermission: "#a9650a",
  speaking: "#0b6b60",
  cancelling: "#ac2340",
  degraded: "#a9650a",
  error: "#ac2340",
};

function Mark() {
  return (
    <span className="relative flex h-8 w-8 items-center justify-center rounded-[10px] bg-[var(--color-ink)] shadow-[0_4px_12px_-4px_rgba(15,19,25,0.7)]">
      <svg viewBox="0 0 24 24" className="h-4 w-4 text-[#7fe3d1]" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round">
        <rect x="9" y="2.5" width="6" height="11" rx="3" />
        <path d="M5.5 11a6.5 6.5 0 0 0 13 0" />
        <path d="M12 17.5V21" />
      </svg>
      <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-[#0f9c8a] ring-2 ring-white" />
    </span>
  );
}

export default function App() {
  const o = useHermesVoice();
  const [tab, setTab] = useState<TabId>("console");
  const [clock, setClock] = useState(() => new Date());
  const [hintOpen, setHintOpen] = useState(true);

  useEffect(() => {
    const id = setInterval(() => setClock(new Date()), 20000);
    return () => clearInterval(id);
  }, []);

  const stateColor = STATE_COLOR[o.state];
  const routerTone = o.routerBadge === "green" ? "green" : o.routerBadge === "red" ? "rose" : "amber";

  return (
    <div className="app-canvas min-h-screen">
      {/* ------------------------------- top bar ------------------------------ */}
      <header className="sticky top-0 z-30 border-b border-[var(--color-line)] bg-white/85 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-x-4 gap-y-2 px-5 py-2.5">
          <div className="flex items-center gap-2.5">
            <Mark />
            <div className="leading-none">
              <div className="font-display text-[16px] font-800 tracking-[-0.02em] text-[var(--color-ink)]">
                Hermes Voice
              </div>
              <div className="mt-1 font-mono text-[9.5px] uppercase tracking-[0.16em] text-[var(--color-faint)]">voice front-end · v0.2.0</div>
            </div>
          </div>

          <div className="ml-2 hidden items-center gap-2 lg:flex">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-line)] bg-white px-2.5 py-1">
              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: stateColor }} />
              <span className="font-mono text-[10.5px] font-500 text-[var(--color-ink-2)]">{o.state}</span>
            </span>
            <Badge tone={o.backend.reachable ? "green" : "rose"} dot>
              bridge {o.backend.reachable ? "live" : "offline"}
            </Badge>
            <Badge tone={routerTone as "green" | "rose" | "amber"} dot>
              omniroute {o.health?.reachable ? `${o.health.latencyMs}ms` : "down"}
            </Badge>
            <Badge tone={o.bridgeStatus.ok ? "pine" : "amber"}>{o.bridgeId}</Badge>
          </div>

          <div className="ml-auto flex items-center gap-3">
            <span className="hidden font-mono text-[10.5px] tabular text-[var(--color-faint)] md:inline">
              {clock.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })} · {clock.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
            </span>
            <div className="flex overflow-hidden rounded-full border border-[var(--color-line)] bg-white p-[2px]">
              {(["hinglish", "english"] as const).map((l) => (
                <button
                  key={l}
                  onClick={() => o.update("lang", l)}
                  className={cn(
                    "rounded-full px-2.5 py-1 font-mono text-[10px] font-600 uppercase tracking-wide transition-colors",
                    o.settings.lang === l ? "bg-[var(--color-ink)] text-white" : "text-[var(--color-muted)] hover:text-[var(--color-ink)]",
                  )}
                >
                  {l === "hinglish" ? "hing" : "eng"}
                </button>
              ))}
            </div>
          </div>
        </div>
      </header>

      {/* -------------------------------- body -------------------------------- */}
      <div className="mx-auto flex max-w-[1440px] flex-col gap-4 px-5 py-4 lg:flex-row">
        {/* rail */}
        <nav className="-mx-1 flex shrink-0 gap-1 overflow-x-auto px-1 pb-1 lg:mx-0 lg:w-[152px] lg:flex-col lg:overflow-visible lg:pb-0">
          {TABS.map((x) => {
            const count = x.id === "audit" ? o.audit.length + o.backend.audit.length : x.id === "sessions" ? o.sessions.length + o.backend.sessions.length : 0;
            return (
              <button
                key={x.id}
                onClick={() => setTab(x.id)}
                className={cn(
                  "group flex shrink-0 items-center gap-2.5 rounded-xl px-3 py-2.5 text-[12.5px] font-500 transition-all",
                  tab === x.id
                    ? "bg-white text-[var(--color-ink)] shadow-[0_1px_3px_rgba(15,19,25,0.09)] ring-1 ring-[var(--color-line)]"
                    : "text-[var(--color-muted)] hover:bg-white/70 hover:text-[var(--color-ink-2)]",
                )}
              >
                <svg viewBox="0 0 24 24" className={cn("h-4 w-4 shrink-0 transition-colors", tab === x.id ? "text-[var(--color-pine)]" : "text-[var(--color-faint)] group-hover:text-[var(--color-muted)]")} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
                  {x.icon.split(" M").map((seg, i) => (
                    <path key={i} d={(i === 0 ? seg : "M" + seg).trim()} />
                  ))}
                </svg>
                <span className="whitespace-nowrap">{x.label}</span>
                {count > 0 && <span className="ml-auto rounded-full bg-[var(--color-sunken)] px-1.5 font-mono text-[9.5px] text-[var(--color-muted)]">{count}</span>}
              </button>
            );
          })}
          <div className="mt-2 hidden rounded-xl border border-dashed border-[var(--color-line)] px-3 py-2.5 lg:block">
            <div className="label-xs mb-1">state copy</div>
            <div className="font-display text-[13px] font-700 leading-tight" style={{ color: stateColor }}>
              {stateCopy(o.state, o.settings.lang)}
            </div>
          </div>
        </nav>

        {/* main */}
        <main className="flex min-h-[calc(100vh-140px)] min-w-0 flex-1 flex-col gap-4">
          {tab === "console" && <Console o={o} />}
          {tab === "backend" && <BackendPanel o={o} />}
          {tab === "settings" && <SettingsPanel o={o} />}
          {tab === "sessions" && <SessionsPanel o={o} />}
          {tab === "audit" && <AuditPanel o={o} />}
          {tab === "logs" && <LogsPanel o={o} />}
          {tab === "tests" && <DiagnosticsPanel o={o} />}
          {tab === "docs" && <DocsPanel />}
        </main>

        {/* voice deck */}
        <aside className="w-full shrink-0 lg:w-[340px]">
          <div className="lg:sticky lg:top-[70px]">
            <VoiceDeck o={o} onOpenSettings={() => setTab("settings")} />
          </div>
        </aside>
      </div>

      {!o.backend.reachable && hintOpen && (
        <div className="mx-auto max-w-[1440px] px-5">
          <div className="rise mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-[rgba(169,101,10,0.28)] bg-[var(--color-amber-wash)] px-4 py-3">
            <span className="text-[15px]">⚠︎</span>
            <div className="min-w-0 flex-1">
              <div className="font-display text-[13px] font-700 text-[var(--color-amber)]">Local bridge offline — asli kaam tabhi hoga jab ye chale</div>
              <div className="mt-0.5 text-[11.5px] leading-snug text-[#8a5a12]">
                Terminal me chalao: <code className="rounded bg-white/70 px-1.5 py-0.5 font-mono text-[11px] text-[var(--color-ink)]">node server/index.mjs</code> — phir
                {" "}<code className="rounded bg-white/70 px-1.5 py-0.5 font-mono text-[11px] text-[var(--color-ink)]">node scripts/probe-bridge.mjs</code> se live verify karo.
                Abhi mock/simulator mode me flows chalenge, real hermes spawn nahi hoga.
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => setTab("backend")} className="rounded-lg bg-[var(--color-amber)] px-3 py-1.5 text-[11.5px] font-600 text-white transition-colors hover:bg-[#93570a]">
                Backend tab
              </button>
              <button onClick={() => setHintOpen(false)} className="rounded-lg px-2 py-1.5 text-[11.5px] text-[#8a5a12] transition-colors hover:bg-white/60" aria-label="Dismiss hint">
                chhupao
              </button>
            </div>
          </div>
        </div>
      )}

      <footer className="mx-auto max-w-[1440px] px-5 pb-6">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[var(--color-line)] pt-3 font-mono text-[10.5px] text-[var(--color-faint)]">
          <span>hermes = brain · omniroute = provider pool · ye app = voice shell</span>
          <span className="ml-auto">₹0 routes · loopback-only bridge · no telemetry</span>
        </div>
      </footer>

      <PermissionDialog o={o} />
    </div>
  );
}
