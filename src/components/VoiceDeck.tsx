import { useEffect, useRef, useState } from "react";
import type { Orchestrator } from "../hooks/useHermesVoice";
import { stateCopy, t } from "../lib/strings";
import type { StateName } from "../lib/stateMachine";
import { Badge, Button, Kbd } from "./ui";
import { cn } from "../utils/cn";

const STATE_TONE: Record<StateName, { ring: string; text: string; glow: string; label: string }> = {
  starting: { ring: "#9e9381", text: "var(--color-muted)", glow: "rgba(158,147,129,0.22)", label: "Starting" },
  idle: { ring: "#e5a93c", text: "var(--color-ink)", glow: "rgba(229,169,60,0.22)", label: "Ready" },
  listening: { ring: "#34c78a", text: "#34c78a", glow: "rgba(52,199,138,0.34)", label: "Listening" },
  transcribing: { ring: "#e5a93c", text: "#e5a93c", glow: "rgba(229,169,60,0.28)", label: "Transcribing" },
  confirmingTranscript: { ring: "#f4c15d", text: "#f4c15d", glow: "rgba(244,193,93,0.28)", label: "Confirm" },
  thinking: { ring: "#93b8ff", text: "#93b8ff", glow: "rgba(147,184,255,0.28)", label: "Thinking" },
  awaitingPermission: { ring: "#e5a93c", text: "#e5a93c", glow: "rgba(229,169,60,0.34)", label: "Permission" },
  speaking: { ring: "#e5a93c", text: "#f4c15d", glow: "rgba(229,169,60,0.32)", label: "Speaking" },
  cancelling: { ring: "#e55365", text: "#e55365", glow: "rgba(229,83,101,0.28)", label: "Cancelling" },
  degraded: { ring: "#e5a93c", text: "#e5a93c", glow: "rgba(229,169,60,0.22)", label: "Ready (Local)" },
  error: { ring: "#e55365", text: "#e55365", glow: "rgba(229,83,101,0.28)", label: "Error" },
};

function MicGlyph({ active, speaking }: { active: boolean; speaking: boolean }) {
  if (speaking) {
    return (
      <svg viewBox="0 0 24 24" className="h-8 w-8" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
        <path d="M11 5 6 9H2v6h4l5 4V5Z" fill="currentColor" fillOpacity={0.18} />
        <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
        <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" className="h-8 w-8" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="2.5" width="6" height="11" rx="3" fill={active ? "currentColor" : "none"} fillOpacity={active ? 0.22 : 0} />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0" />
      <path d="M12 17.5V21" />
      <path d="M8.5 21h7" />
    </svg>
  );
}

/**
 * Dual-mode waveform visualizer (Spec §2.5):
 * Visualizes BOTH mic input (`level` when listening) and TTS playback (`outputLevel` when speaking).
 */
function DualWave({
  micLevel,
  outLevel,
  listening,
  speaking,
  thinking,
  color,
}: {
  micLevel: number;
  outLevel: number;
  listening: boolean;
  speaking: boolean;
  thinking: boolean;
  color: string;
}) {
  const [bars, setBars] = useState<number[]>(() => Array.from({ length: 28 }, () => 0.1));
  const reduce = useRef(false);
  const timer = useRef(0);

  useEffect(() => {
    reduce.current = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  }, []);

  useEffect(() => {
    const active = listening || speaking || thinking;
    if (!active) {
      setBars(Array.from({ length: 28 }, (_, i) => 0.08 + Math.sin(i * 0.45) * 0.03));
      return;
    }
    const signal = listening ? micLevel * 5.2 : speaking ? outLevel * 1.65 : 0.22;
    if (reduce.current) {
      setBars(Array.from({ length: 28 }, () => Math.min(1, 0.15 + signal)));
      return;
    }
    let phase = 0;
    const tick = () => {
      phase += 0.35;
      setBars((prev) =>
        prev.map((_, idx) => {
          const centerWeight = 1 - Math.abs(idx - 13.5) / 15;
          const wave = Math.abs(Math.sin(phase + idx * 0.42)) * 0.35;
          const amp = Math.min(1, 0.1 + (signal + wave) * (0.45 + centerWeight * 0.65));
          return amp;
        }),
      );
      timer.current = window.setTimeout(tick, 55);
    };
    tick();
    return () => window.clearTimeout(timer.current);
  }, [listening, speaking, thinking, micLevel, outLevel]);

  const active = listening || speaking || thinking;

  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className="flex h-10 items-center justify-center gap-[3.5px]" aria-hidden>
        {bars.map((b, i) => (
          <span
            key={i}
            className="w-[3.5px] rounded-full transition-[height,background-color] duration-75"
            style={{
              height: `${Math.max(4, b * 36)}px`,
              backgroundColor: active ? color : "#2f2920",
              opacity: active ? 0.4 + b * 0.6 : 0.75,
            }}
          />
        ))}
      </div>
      <div className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-[var(--color-faint)]">
        {listening
          ? "mic input · 1.8s silence auto-send"
          : speaking
            ? "tts audio output · tap orb to barge-in"
            : thinking
              ? "hermes stream-json active"
              : "voice channel standby"}
      </div>
    </div>
  );
}

function VoiceOrb({ o, tone }: { o: Orchestrator; tone: (typeof STATE_TONE)[StateName] }) {
  const listening = o.state === "listening";
  const speaking = o.speakingNow || o.state === "speaking";
  // Allow clicking while speaking to trigger instant barge-in!
  const disabled =
    !o.sttSupported ||
    (o.state !== "idle" &&
      o.state !== "listening" &&
      o.state !== "degraded" &&
      o.state !== "speaking" &&
      !o.speakingNow);

  const r = 64;
  const circumference = 2 * Math.PI * r;
  const meter = listening
    ? Math.min(1, 0.12 + o.level * 4.8)
    : speaking
      ? Math.min(1, 0.18 + o.outputLevel * 1.3)
      : 0.08;

  return (
    <div className="relative flex h-[176px] w-[176px] items-center justify-center">
      {(listening || speaking) && (
        <>
          <span className="orb-ring absolute inset-3 rounded-full" style={{ border: `2px solid ${tone.ring}` }} />
          <span className="orb-ring-2 absolute inset-3 rounded-full" style={{ border: `2px solid ${tone.ring}` }} />
        </>
      )}

      <svg viewBox="0 0 144 144" className="absolute inset-0 h-full w-full -rotate-90">
        <circle cx="72" cy="72" r={r} fill="none" stroke="#28221a" strokeWidth="5" />
        <circle
          cx="72"
          cy="72"
          r={r}
          fill="none"
          stroke={tone.ring}
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - meter)}
          style={{ transition: "stroke-dashoffset 80ms linear" }}
        />
      </svg>

      <button
        onMouseDown={() => {
          if (!disabled && !listening) void o.startListening();
        }}
        onMouseUp={() => listening && o.stopListening()}
        onClick={() => {
          if (listening) {
            o.stopListening();
          } else if (speaking) {
            o.bargeIn();
            void o.startListening();
          } else if (!disabled) {
            void o.startListening();
          }
        }}
        disabled={disabled}
        aria-label={
          listening
            ? "Stop listening and send"
            : speaking
              ? "Barge-in: stop speech and start listening"
              : "Start voice input"
        }
        aria-pressed={listening}
        className={cn(
          "group relative flex h-[118px] w-[118px] items-center justify-center rounded-full transition-all duration-200",
          "bg-gradient-to-b from-[#211d17] to-[#13110d] shadow-[0_16px_38px_-12px_rgba(0,0,0,0.9),0_1px_0_0_rgba(255,244,219,0.09)_inset] ring-1 ring-[#383024]",
          !disabled && "hover:scale-[1.03] hover:ring-[var(--color-gold)]/60 active:scale-[0.97]",
          disabled && "opacity-45",
        )}
        style={
          listening || speaking
            ? { boxShadow: `0 0 0 7px ${tone.glow}, 0 18px 40px -12px rgba(0,0,0,0.95)` }
            : undefined
        }
      >
        <span
          className="absolute inset-0 rounded-full transition-opacity duration-300"
          style={{
            background: `radial-gradient(circle at 50% 32%, ${tone.glow}, transparent 68%)`,
            opacity: listening || speaking ? 1 : 0.45,
          }}
        />
        <span className="relative" style={{ color: listening || speaking ? tone.ring : "var(--color-gold)" }}>
          <MicGlyph active={listening} speaking={speaking && !listening} />
        </span>
      </button>
    </div>
  );
}

export function VoiceDeck({
  o,
  onOpenSettings,
  drawerOpen,
  onToggleDrawer,
}: {
  o: Orchestrator;
  onOpenSettings: () => void;
  drawerOpen?: boolean;
  onToggleDrawer?: () => void;
}) {
  const tone = STATE_TONE[o.state];
  const last = [...o.timeline]
    .reverse()
    .find((x) => x.kind === "assistant" || x.kind === "progress" || x.kind === "tool" || x.kind === "error");

  return (
    <div className="flex flex-col gap-3">
      <div className="panel reveal px-4 pb-4 pt-3.5">
        {/* Top telemetry badges (Spec §2.5) */}
        <div className="flex flex-wrap items-center justify-between gap-1.5">
          <Badge tone="gold" dot>
            {o.activeModel}
          </Badge>
          <Badge tone={o.backend.reachable ? "green" : "amber"} dot>
            {o.backend.reachable ? "127.0.0.1:20130" : "local sim"}
          </Badge>
        </div>

        <div className="mt-2.5 flex flex-col items-center">
          <VoiceOrb o={o} tone={tone} />

          <div className="-mt-0.5 text-center">
            <div
              className="font-display text-[25px] font-800 leading-tight tracking-[-0.02em]"
              style={{ color: tone.text }}
            >
              {stateCopy(o.state, o.settings.lang)}
            </div>
            <div className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-muted)]">
              {o.state === "listening"
                ? "bolte raho · 1.8s silence pe auto-send"
                : o.speakingNow || o.state === "speaking"
                  ? "tap orb or ⌥Space to barge-in"
                  : o.state === "awaitingPermission"
                    ? "bolo 'haan kar do' ya 'nahi ruko'"
                    : "tap orb or hold ⌥Space"}
            </div>
          </div>

          <div className="mt-2.5 w-full">
            <DualWave
              micLevel={o.level}
              outLevel={o.outputLevel}
              listening={o.state === "listening"}
              speaking={o.speakingNow || o.state === "speaking"}
              thinking={o.state === "thinking"}
              color={tone.ring}
            />
          </div>
        </div>

        {/* Live transcript / latest agent output */}
        <div className="panel-flat mt-2 min-h-[68px] px-3.5 py-2.5">
          {o.state === "listening" ? (
            <p className="text-[13px] leading-relaxed text-[var(--color-ink)]">
              {o.partial || (
                <span className="text-[var(--color-faint)]">
                  Sun raha hoon… Hinglish ya English me bolo
                </span>
              )}
            </p>
          ) : o.pendingConfirm ? (
            <p className="text-[13px] leading-relaxed text-[var(--color-gold)]">"{o.pendingConfirm.text}"</p>
          ) : last ? (
            <p className="line-clamp-3 text-[12.5px] leading-relaxed text-[var(--color-ink-2)]">
              {last.kind === "tool" ? `⚙︎ ${last.text}` : last.text}
            </p>
          ) : (
            <p className="text-[12.5px] text-[var(--color-faint)]">
              Ready. Tap the gold orb or press ⌥Space to speak to Hermes.
            </p>
          )}
        </div>

        {/* Low-confidence confirmation */}
        {o.pendingConfirm && (
          <div className="mt-2.5 rounded-xl border border-[rgba(229,169,60,0.35)] bg-[var(--color-gold-wash)] p-3 rise">
            <div className="flex items-center gap-2">
              <Badge tone="gold">confidence {(o.pendingConfirm.confidence * 100).toFixed(0)}%</Badge>
              <span className="text-[11.5px] text-[var(--color-ink-2)]">Confirm transcript</span>
            </div>
            <div className="mt-2.5 flex gap-2">
              <Button size="sm" variant="primary" onClick={o.confirmSend}>
                {t("btn_send", o.settings.lang)}
              </Button>
              <Button size="sm" onClick={o.confirmDiscard}>
                {t("btn_discard", o.settings.lang)}
              </Button>
              <span className="ml-auto self-center font-mono text-[10px] text-[var(--color-faint)]">auto-discard 15s</span>
            </div>
          </div>
        )}

        {/* Active error card */}
        {o.activeError && (
          <div className="mt-2.5 rounded-xl border border-[rgba(229,83,101,0.3)] bg-[var(--color-rose-wash)] p-3 rise">
            <div className="flex items-start gap-2">
              <span className="mt-[1px] text-[var(--color-rose)]">✖</span>
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] font-600 text-[#ff8b99]">{o.activeError.user}</div>
                <div className="mt-1 text-[11.5px] leading-snug text-[var(--color-ink-2)]">Fix: {o.activeError.fix}</div>
                <div className="mt-1 font-mono text-[10px] text-[#d67a86]">{o.activeError.code}</div>
              </div>
              <button
                onClick={o.dismissError}
                className="text-[#d67a86] transition-colors hover:text-white"
                aria-label="Dismiss"
              >
                ×
              </button>
            </div>
          </div>
        )}

        {/* Action controls */}
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {o.speakingNow && (
            <Button size="sm" variant="primary" onClick={o.bargeIn} title="Stop TTS immediately">
              ⏹ Barge-In
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={o.cancel}
            disabled={o.state === "idle" || o.state === "starting" || o.state === "degraded"}
            title="⌥⌘Space"
          >
            Cancel
          </Button>
          <Button size="sm" variant="outline" onClick={o.repeatLast} disabled={!o.lastAssistant} title="⌥⇧Space">
            ↻ Repeat
          </Button>
          {onToggleDrawer && (
            <Button size="sm" variant="ghost" onClick={onToggleDrawer} className="ml-auto">
              {drawerOpen ? "Hide Drawer" : "Workspace ▾"}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onOpenSettings} className={onToggleDrawer ? "" : "ml-auto"}>
            ⚙︎
          </Button>
        </div>

        <div className="mt-2.5 flex items-center justify-between border-t border-[var(--color-line-soft)] pt-2.5 font-mono text-[10px] text-[var(--color-muted)]">
          <span className="truncate">{o.ttsStatusLabel}</span>
          <span className="flex shrink-0 items-center gap-1">
            <Kbd>⌥</Kbd>
            <Kbd>Space</Kbd>
          </span>
        </div>
      </div>

      {/* Telemetry quad */}
      <div className="panel reveal grid grid-cols-2 gap-px overflow-hidden bg-[var(--color-line-soft)]">
        {[
          {
            k: "active model",
            v: o.activeModel,
            tone: "var(--color-gold)",
          },
          {
            k: "omniroute 20128",
            v: o.health?.reachable ? `UP · ${o.health.latencyMs ?? 42}ms` : "read-only standby",
            tone: o.routerBadge === "green" ? "var(--color-emerald)" : "var(--color-gold)",
          },
          {
            k: "hermes cli",
            v: o.backend.health?.hermes.found ? "stream-json ready" : "local simulator",
            tone: o.backend.health?.hermes.found ? "var(--color-emerald)" : "var(--color-gold)",
          },
          {
            k: "tasks (cap 10)",
            v: `${o.backend.health?.tasks.live ?? 0} live / ${o.backend.health?.tasks.cap ?? 10} max`,
            tone: "var(--color-ink)",
          },
        ].map((s) => (
          <div key={s.k} className="bg-[#14120f] px-3 py-2">
            <div className="label-xs">{s.k}</div>
            <div className="mt-0.5 truncate font-mono text-[11.5px] font-500" style={{ color: s.tone }}>
              {s.v}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
