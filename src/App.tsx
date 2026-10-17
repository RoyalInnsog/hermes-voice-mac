import { useEffect, useState } from "react";
import { useHermesVoice } from "./hooks/useHermesVoice";
import { VoiceDeck } from "./components/VoiceDeck";
import { PermissionDialog } from "./components/PermissionDialog";
import { Console } from "./components/Console";
import { SettingsPanel } from "./components/SettingsPanel";
import { AuditPanel, BackendPanel, DiagnosticsPanel, DocsPanel, LogsPanel, SessionsPanel } from "./components/Inspectors";
import { Badge, Kbd } from "./components/ui";
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
  starting: "#7a7469",
  idle: "#e5a93c",
  listening: "#f5c469",
  transcribing: "#38bdf8",
  confirmingTranscript: "#c084fc",
  thinking: "#e5a93c",
  awaitingPermission: "#f59e0b",
  speaking: "#22c55e",
  cancelling: "#ef4444",
  degraded: "#f59e0b",
  error: "#ef4444",
};

function Mark() {
  return (
    <span className="relative flex h-8 w-8 items-center justify-center rounded-[10px] border border-[rgba(229,169,60,0.4)] bg-[#1c1916] shadow-[0_4px_14px_-4px_rgba(229,169,60,0.45)]">
      <svg viewBox="0 0 24 24" className="h-4 w-4 text-[var(--color-gold-bright)]" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round">
        <rect x="9" y="2.5" width="6" height="11" rx="3" />
        <path d="M5.5 11a6.5 6.5 0 0 0 13 0" />
        <path d="M12 17.5V21" />
      </svg>
      <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-[#22c55e] ring-2 ring-[#0e0d0b]" />
    </span>
  );
}

export default function App() {
  const o = useHermesVoice();
  const [tab, setTab] = useState<TabId>("console");
  const [drawerOpen, setDrawerOpen] = useState<boolean>(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      if (params.get("hud") === "1") return false;
      return window.innerWidth > 640;
    }
    return true;
  });
  const [hudPreviewMode, setHudPreviewMode] = useState<boolean>(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      return params.get("hud") === "1" || window.innerWidth <= 520;
    }
    return false;
  });

  useEffect(() => {
    const onResize = () => {
      if (window.innerWidth <= 520) {
        setHudPreviewMode(true);
      }
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const stateColor = STATE_COLOR[o.state];
  const ttsReady = o.backend.health?.tts.engines.edge.available;
  const ttsLabel = ttsReady ? "edge-tts · hi-IN" : o.backend.health?.tts.engines.say.available ? "macOS say" : "webSpeech";

  const openInspectorTab = (nextTab: TabId) => {
    setTab(nextTab);
    setDrawerOpen(true);
  };

  return (
    <div className="app-canvas min-h-screen text-[var(--color-ink)]">
      {/* ------------------------------- top bar ------------------------------ */}
      <header className="sticky top-0 z-30 border-b border-[var(--color-line)] bg-[#0e0d0b]/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
          <div className="flex items-center gap-2.5">
            <Mark />
            <div className="leading-none">
              <div className="flex items-center gap-2">
                <span className="font-display text-[16px] font-800 tracking-[-0.02em] text-[var(--color-ink)]">Hermes Voice</span>
                <span className="font-mono text-[10px] font-600 uppercase tracking-[0.12em] text-[var(--color-gold)]">v1.0</span>
              </div>
              <div className="mt-1 font-mono text-[9.5px] uppercase tracking-[0.14em] text-[var(--color-muted)]">
                macOS voice shell · stream-json
              </div>
            </div>
          </div>

          {/* Telemetry status strip: Model (KRITI / 9Router), Bridge 127.0.0.1:20130, TTS Engine */}
          <div className="ml-1 flex flex-wrap items-center gap-x-4 gap-y-1 border-l border-[var(--color-line)] pl-3">
            <Badge tone="gold" dot>
              {o.activeModelLabel}
            </Badge>
            <Badge tone={o.backend.reachable ? "green" : "amber"} dot>
              127.0.0.1:20130 {o.backend.reachable ? "live" : "sim"}
            </Badge>
            <Badge tone={ttsReady ? "green" : "slate"} dot className="hidden sm:inline-flex">
              {ttsLabel}
            </Badge>
            <span className="hidden items-center gap-1.5 font-mono text-[10.5px] text-[var(--color-ink-2)] xl:inline-flex">
              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: stateColor }} />
              {stateCopy(o.state, o.settings.lang)}
            </span>
          </div>

          <div className="ml-auto flex items-center gap-2">
            {/* Dual-mode layout switcher: Compact 420x680 HUD vs Full Workspace */}
            <button
              onClick={() => setHudPreviewMode((v) => !v)}
              className={cn(
                "hidden items-center gap-1.5 rounded-lg border px-2.5 py-1 font-mono text-[10px] font-600 uppercase tracking-wider transition-all sm:inline-flex",
                hudPreviewMode
                  ? "border-[var(--color-gold)] bg-[var(--color-gold-wash)] text-[var(--color-gold-bright)]"
                  : "border-[var(--color-line)] bg-[var(--color-sunken)] text-[var(--color-muted)] hover:text-[var(--color-ink)]",
              )}
              title="Toggle between 420x680 floating HUD mode and full workspace"
            >
              <span>{hudPreviewMode ? "HUD 420×680" : "Full Workspace"}</span>
            </button>

            <button
              onClick={() => setDrawerOpen((v) => !v)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 font-mono text-[10px] font-600 uppercase tracking-wider transition-all",
                drawerOpen
                  ? "border-[rgba(229,169,60,0.4)] bg-[var(--color-panel-2)] text-[var(--color-gold-bright)]"
                  : "border-[var(--color-line)] bg-[var(--color-sunken)] text-[var(--color-ink-2)] hover:border-[var(--color-gold)]",
              )}
            >
              <span>{drawerOpen ? "Hide Drawer" : "Open Drawer"}</span>
              {(o.audit.length > 0 || o.timeline.length > 0) && (
                <span className="font-mono text-[9.5px] text-[var(--color-gold)]">({o.timeline.length})</span>
              )}
            </button>

            <div className="flex overflow-hidden rounded-lg border border-[var(--color-line)] bg-[var(--color-sunken)] p-[2px]">
              {(["hinglish", "english"] as const).map((l) => (
                <button
                  key={l}
                  onClick={() => o.update("lang", l)}
                  className={cn(
                    "rounded-md px-2 py-0.5 font-mono text-[10px] font-600 uppercase tracking-wide transition-colors",
                    o.settings.lang === l
                      ? "bg-[var(--color-gold)] text-[#0e0d0b]"
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
      {hudPreviewMode ? (
        /* COMPACT 420x680 MACOS FLOATING HUD MODE */
        <div className="mx-auto flex max-w-[440px] flex-col gap-3 px-3 py-4">
          <VoiceDeck o={o} onOpenSettings={() => openInspectorTab("settings")} />

          {/* Quick collapsible drawer for advanced tabs in HUD mode */}
          <div className="panel overflow-hidden">
            <div className="flex items-center gap-1 overflow-x-auto border-b border-[var(--color-line)] bg-[var(--color-sunken)] px-2 py-1.5">
              {TABS.map((x) => (
                <button
                  key={x.id}
                  onClick={() => {
                    if (tab === x.id && drawerOpen) {
                      setDrawerOpen(false);
                    } else {
                      setTab(x.id);
                      setDrawerOpen(true);
                    }
                  }}
                  className={cn(
                    "shrink-0 rounded-md px-2.5 py-1 font-mono text-[10px] font-600 uppercase tracking-wider transition-all",
                    drawerOpen && tab === x.id
                      ? "bg-[var(--color-gold)] text-[#0e0d0b]"
                      : "text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-ink)]",
                  )}
                >
                  {x.label}
                </button>
              ))}
            </div>
            {drawerOpen && (
              <div className="flex max-h-[420px] min-h-[300px] flex-col overflow-y-auto p-2">
                {tab === "console" && <Console o={o} />}
                {tab === "backend" && <BackendPanel o={o} />}
                {tab === "settings" && <SettingsPanel o={o} />}
                {tab === "sessions" && <SessionsPanel o={o} />}
                {tab === "audit" && <AuditPanel o={o} />}
                {tab === "logs" && <LogsPanel o={o} />}
                {tab === "tests" && <DiagnosticsPanel o={o} />}
                {tab === "docs" && <DocsPanel />}
              </div>
            )}
          </div>
        </div>
      ) : (
        /* FULL DESKTOP WORKSPACE MODE WITH PROMINENT VOICE DECK + COLLAPSIBLE DRAWER */
        <div className="mx-auto flex max-w-[1440px] flex-col gap-4 px-5 py-4 lg:flex-row">
          {/* Collapsible Inspector Drawer (Left Rail + Main Workspace) */}
          {drawerOpen && (
            <>
              <nav className="-mx-1 flex shrink-0 gap-1 overflow-x-auto px-1 pb-1 lg:mx-0 lg:w-[158px] lg:flex-col lg:overflow-visible lg:pb-0">
                {TABS.map((x) => {
                  const count =
                    x.id === "audit"
                      ? o.audit.length + o.backend.audit.length
                      : x.id === "sessions"
                        ? o.sessions.length + o.backend.sessions.length
                        : x.id === "console"
                          ? o.timeline.length
                          : 0;
                  return (
                    <button
                      key={x.id}
                      onClick={() => setTab(x.id)}
                      className={cn(
                        "group flex shrink-0 items-center gap-2.5 rounded-xl px-3 py-2.5 text-[12.5px] font-500 transition-all",
                        tab === x.id
                          ? "bg-[var(--color-panel-2)] text-[var(--color-gold-bright)] ring-1 ring-[rgba(229,169,60,0.4)]"
                          : "text-[var(--color-muted)] hover:bg-[var(--color-panel)] hover:text-[var(--color-ink)]",
                      )}
                    >
                      <svg
                        viewBox="0 0 24 24"
                        className={cn(
                          "h-4 w-4 shrink-0 transition-colors",
                          tab === x.id ? "text-[var(--color-gold)]" : "text-[var(--color-faint)] group-hover:text-[var(--color-muted)]",
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
                        <span className="ml-auto font-mono text-[10px] tabular text-[var(--color-gold)]">{count}</span>
                      )}
                    </button>
                  );
                })}

                <div className="mt-2 hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] px-3 py-2.5 lg:block">
                  <div className="label-xs mb-1">Active State</div>
                  <div className="font-display text-[13px] font-700 leading-tight" style={{ color: stateColor }}>
                    {stateCopy(o.state, o.settings.lang)}
                  </div>
                  <div className="mt-2 flex items-center justify-between border-t border-[var(--color-line-soft)] pt-2 font-mono text-[10px] text-[var(--color-muted)]">
                    <span>Hotkey</span>
                    <span className="flex gap-1">
                      <Kbd>⌥</Kbd>
                      <Kbd>Space</Kbd>
                    </span>
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
            </>
          )}

          {/* Prominent Voice Deck */}
          <aside className={cn("w-full shrink-0 transition-all", drawerOpen ? "lg:w-[380px]" : "mx-auto max-w-[460px] py-4")}>
            <div className="lg:sticky lg:top-[68px]">
              <VoiceDeck o={o} onOpenSettings={() => openInspectorTab("settings")} />
            </div>
          </aside>
        </div>
      )}

      <footer className="mx-auto max-w-[1440px] px-5 pb-6">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[var(--color-line)] pt-3 font-mono text-[10.5px] text-[var(--color-muted)]">
          <span>hermes = brain · omniroute (127.0.0.1:20128 RO) = router · hermes voice v1.0 = macOS voice HUD</span>
          <span className="ml-auto">$0 stack · edge-tts neural cache · loopback-only bridge</span>
        </div>
      </footer>

      <PermissionDialog o={o} />
    </div>
  );
}
