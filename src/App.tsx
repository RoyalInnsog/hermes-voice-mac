import { useEffect, useState } from "react";
import { useHermesVoice } from "./hooks/useHermesVoice";
import { VoiceDeck } from "./components/VoiceDeck";
import { PermissionDialog } from "./components/PermissionDialog";
import { Console } from "./components/Console";
import { SettingsPanel } from "./components/SettingsPanel";
import {
  AuditPanel,
  BackendPanel,
  DiagnosticsPanel,
  DocsPanel,
  LogsPanel,
  SessionsPanel,
} from "./components/Inspectors";
import { Badge, Button } from "./components/ui";
import { stateCopy } from "./lib/strings";
import type { StateName } from "./lib/stateMachine";
import { cn } from "./utils/cn";

const TABS = [
  { id: "console", label: "Console", icon: "M4 6h16M4 12h10M4 18h13" },
  { id: "backend", label: "Backend", icon: "M5 4h14v6H5zM5 14h14v6H5zM8 7h.01M8 17h.01" },
  {
    id: "settings",
    label: "Settings",
    icon: "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.4-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4.1a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 11a2 2 0 1 1 0 4Z",
  },
  { id: "sessions", label: "Sessions", icon: "M4 5h16v14H4zM4 9h16M9 9v10" },
  { id: "audit", label: "Audit", icon: "M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6zM9.5 12l2 2 3.5-3.5" },
  { id: "logs", label: "Logs", icon: "M6 4h9l3 3v13H6zM9 11h6M9 15h6" },
  { id: "tests", label: "Tests", icon: "M9 3h6v5l3.5 8a2 2 0 0 1-1.8 2.9H7.3A2 2 0 0 1 5.5 16L9 8z" },
  { id: "docs", label: "Docs", icon: "M7 3h7l4 4v14H7zM14 3v4h4M10 12h6M10 16h6" },
] as const;
type TabId = (typeof TABS)[number]["id"];

const STATE_COLOR: Record<StateName, string> = {
  starting: "#9a9080",
  idle: "#e5a93c",
  listening: "#f2be5c",
  transcribing: "#38bdf8",
  confirmingTranscript: "#c084fc",
  thinking: "#e5a93c",
  awaitingPermission: "#f59e0b",
  speaking: "#2dd4bf",
  cancelling: "#f43f5e",
  degraded: "#f59e0b",
  error: "#f43f5e",
};

function Mark() {
  return (
    <span className="relative flex h-8 w-8 items-center justify-center rounded-[10px] border border-[rgba(229,169,60,0.35)] bg-[#1a1712] shadow-[0_4px_14px_-4px_rgba(229,169,60,0.45)]">
      <svg
        viewBox="0 0 24 24"
        className="h-4 w-4 text-[#e5a93c]"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.85}
        strokeLinecap="round"
      >
        <rect x="9" y="2.5" width="6" height="11" rx="3" />
        <path d="M5.5 11a6.5 6.5 0 0 0 13 0" />
        <path d="M12 17.5V21" />
      </svg>
      <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-[#2dd4bf] ring-2 ring-[#0e0d0b]" />
    </span>
  );
}

export default function App() {
  const o = useHermesVoice();
  const [tab, setTab] = useState<TabId>("console");
  const [drawerOpen, setDrawerOpen] = useState<boolean>(() => {
    return typeof window !== "undefined" ? window.innerWidth >= 680 : true;
  });
  const [clock, setClock] = useState(() => new Date());
  const [hintOpen, setHintOpen] = useState(true);

  useEffect(() => {
    const id = setInterval(() => setClock(new Date()), 20000);
    return () => clearInterval(id);
  }, []);

  const stateColor = STATE_COLOR[o.state];
  const routerTone = o.routerBadge === "green" ? "green" : o.routerBadge === "red" ? "rose" : "amber";
  const ttsReady = o.backend.health?.tts.engines.edge.available;

  return (
    <div className="app-canvas min-h-screen text-[var(--color-ink)]">
      {/* ------------------------------- top bar ------------------------------ */}
      <header className="sticky top-0 z-30 border-b border-[var(--color-line)] bg-[#0e0d0b]/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
          <div className="flex items-center gap-2.5">
            <Mark />
            <div className="leading-none">
              <div className="font-display text-[16px] font-800 tracking-[-0.02em] text-[var(--color-ink)]">
                Hermes Voice
              </div>
              <div className="mt-1 font-mono text-[9.5px] uppercase tracking-[0.16em] text-[#e5a93c]">
                macOS HUD · v1.0.0
              </div>
            </div>
          </div>

          {/* Live Status Badges: Active Model, Bridge 127.0.0.1:20130, OmniRoute, TTS Engine */}
          <div className="ml-1 flex flex-wrap items-center gap-1.5">
            <Badge tone="gold" dot>
              {o.activeModel}
            </Badge>
            <Badge tone={o.backend.reachable ? "green" : "rose"} dot>
              {o.backend.reachable ? "127.0.0.1:20130 · live" : "127.0.0.1:20130 · offline"}
            </Badge>
            <Badge tone={routerTone} dot className="hidden sm:inline-flex">
              omniroute {o.health?.reachable ? `${o.health.latencyMs}ms` : "down"}
            </Badge>
            <Badge tone={ttsReady ? "green" : "amber"} dot className="hidden md:inline-flex">
              tts: {ttsReady ? "edge-tts (hi-IN)" : "macOS say"}
            </Badge>
          </div>

          <div className="ml-auto flex items-center gap-2.5">
            <Button
              size="xs"
              variant="outline"
              onClick={() => setDrawerOpen((v) => !v)}
              title="Toggle collapsible workspace drawer (HUD compact vs full studio)"
            >
              {drawerOpen ? "▴ Hide Drawer" : "▾ Inspector Drawer"}
            </Button>

            <span className="hidden font-mono text-[10.5px] tabular text-[var(--color-muted)] xl:inline">
              {clock.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })} ·{" "}
              {clock.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
            </span>

            <div className="flex overflow-hidden rounded-full border border-[var(--color-line)] bg-[#161411] p-[2px]">
              {(["hinglish", "english"] as const).map((l) => (
                <button
                  key={l}
                  onClick={() => o.update("lang", l)}
                  className={cn(
                    "rounded-full px-2.5 py-1 font-mono text-[10px] font-600 uppercase tracking-wide transition-colors",
                    o.settings.lang === l
                      ? "bg-[#e5a93c] text-[#0e0d0b]"
                      : "text-[var(--color-muted)] hover:text-[var(--color-ink)]",
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
      <div
        className={cn(
          "mx-auto flex max-w-[1440px] flex-col gap-4 px-4 py-4",
          drawerOpen ? "lg:flex-row" : "max-w-[460px] items-center justify-center",
        )}
      >
        {/* Prominent Voice Deck (Central in HUD mode, sticky right/left in expanded mode) */}
        <aside className={cn("w-full shrink-0", drawerOpen ? "lg:order-last lg:w-[360px]" : "w-full")}>
          <div className="lg:sticky lg:top-[68px]">
            <VoiceDeck
              o={o}
              onOpenSettings={() => {
                setTab("settings");
                setDrawerOpen(true);
              }}
            />
          </div>
        </aside>

        {/* Collapsible Drawer for Advanced Tabs */}
        {drawerOpen && (
          <div className="flex min-w-0 flex-1 flex-col gap-4 lg:flex-row">
            <nav className="-mx-1 flex shrink-0 gap-1 overflow-x-auto px-1 pb-1 lg:mx-0 lg:w-[156px] lg:flex-col lg:overflow-visible lg:pb-0">
              {TABS.map((x) => {
                const count =
                  x.id === "audit"
                    ? o.audit.length + o.backend.audit.length
                    : x.id === "sessions"
                      ? o.sessions.length + o.backend.sessions.length
                      : 0;
                return (
                  <button
                    key={x.id}
                    onClick={() => setTab(x.id)}
                    className={cn(
                      "group flex shrink-0 items-center gap-2.5 rounded-xl px-3 py-2.5 text-[12.5px] font-500 transition-all",
                      tab === x.id
                        ? "bg-[#1e1b16] text-[#f2be5c] shadow-[0_2px_10px_rgba(0,0,0,0.45)] ring-1 ring-[rgba(229,169,60,0.35)]"
                        : "text-[var(--color-muted)] hover:bg-[#161411] hover:text-[var(--color-ink-2)]",
                    )}
                  >
                    <svg
                      viewBox="0 0 24 24"
                      className={cn(
                        "h-4 w-4 shrink-0 transition-colors",
                        tab === x.id
                          ? "text-[#e5a93c]"
                          : "text-[var(--color-faint)] group-hover:text-[var(--color-muted)]",
                      )}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={1.6}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      {x.icon.split(" M").map((seg, i) => (
                        <path key={i} d={(i === 0 ? seg : "M" + seg).trim()} />
                      ))}
                    </svg>
                    <span className="whitespace-nowrap">{x.label}</span>
                    {count > 0 && (
                      <span className="ml-auto rounded-full bg-[#12100d] px-1.5 font-mono text-[9.5px] text-[#e5a93c]">
                        {count}
                      </span>
                    )}
                  </button>
                );
              })}
              <div className="mt-2 hidden rounded-xl border border-dashed border-[var(--color-line)] bg-[#13110e] px-3 py-2.5 lg:block">
                <div className="label-xs mb-1">state</div>
                <div className="font-display text-[13px] font-700 leading-tight" style={{ color: stateColor }}>
                  {stateCopy(o.state, o.settings.lang)}
                </div>
              </div>
            </nav>

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
          </div>
        )}
      </div>

      {!o.backend.reachable && hintOpen && (
        <div className="mx-auto max-w-[1440px] px-4">
          <div className="rise mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-[rgba(229,169,60,0.3)] bg-[rgba(229,169,60,0.1)] px-4 py-3">
            <span className="text-[15px] text-[#e5a93c]">⚠︎</span>
            <div className="min-w-0 flex-1">
              <div className="font-display text-[13px] font-700 text-[#f2be5c]">
                Local bridge offline — start `npm start` (`node server/index.mjs`) for live Hermes CLI + Edge TTS
              </div>
              <div className="mt-0.5 text-[11.5px] leading-snug text-[var(--color-ink-2)]">
                Terminal me chalao:{" "}
                <code className="rounded bg-[#12100d] px-1.5 py-0.5 font-mono text-[11px] text-[#e5a93c]">
                  npm start
                </code>{" "}
                — phir{" "}
                <code className="rounded bg-[#12100d] px-1.5 py-0.5 font-mono text-[11px] text-[#e5a93c]">
                  node scripts/verify-v1.mjs
                </code>{" "}
                se verify karo.
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="xs"
                variant="primary"
                onClick={() => {
                  setTab("backend");
                  setDrawerOpen(true);
                }}
              >
                Backend tab
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setHintOpen(false)}>
                chhupao
              </Button>
            </div>
          </div>
        </div>
      )}

      <footer className="mx-auto max-w-[1440px] px-4 pb-6">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[var(--color-line)] pt-3 font-mono text-[10.5px] text-[var(--color-muted)]">
          <span>hermes = brain · omniroute (127.0.0.1:20128) = provider pool · hermes voice v1.0 = macOS HUD</span>
          <span className="ml-auto text-[#e5a93c]">$0 budget · strict read-only router · loopback bridge</span>
        </div>
      </footer>

      <PermissionDialog o={o} />
    </div>
  );
}
