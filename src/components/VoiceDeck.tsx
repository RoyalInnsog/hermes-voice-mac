import { useEffect, useRef } from "react";
import type { Orchestrator } from "../hooks/useHermesVoice";
import { stateCopy, t } from "../lib/strings";
import type { StateName } from "../lib/stateMachine";
import { Badge, Button, Kbd } from "./ui";
import { cn } from "../utils/cn";

const STATE_TONE: Record<StateName, { ring: string; text: string; glow: string; label: string }> = {
  starting: { ring: "#8e8679", text: "var(--color-muted)", glow: "rgba(142,134,121,0.22)", label: "Starting" },
  idle: { ring: "#e5a93c", text: "var(--color-ink)", glow: "rgba(229,169,60,0.20)", label: "Idle" },
  listening: { ring: "#f3be5c", text: "#f3be5c", glow: "rgba(243,190,92,0.34)", label: "Listening" },
  transcribing: { ring: "#e5a93c", text: "#e5a93c", glow: "rgba(229,169,60,0.26)", label: "Transcribing" },
  confirmingTranscript: { ring: "#f59e0b", text: "#fbbf24", glow: "rgba(245,158,11,0.24)", label: "Confirm" },
  thinking: { ring: "#e5a93c", text: "#e5a93c", glow: "rgba(229,169,60,0.26)", label: "Thinking" },
  awaitingPermission: { ring: "#f59e0b", text: "#f59e0b", glow: "rgba(245,158,11,0.30)", label: "Permission" },
  speaking: { ring: "#22c55e", text: "#22c55e", glow: "rgba(34,197,94,0.28)", label: "Speaking" },
  cancelling: { ring: "#f43f5e", text: "#f43f5e", glow: "rgba(244,63,94,0.24)", label: "Cancelling" },
  degraded: { ring: "#f59e0b", text: "#f59e0b", glow: "rgba(245,158,11,0.22)", label: "Degraded" },
  error: { ring: "#f43f5e", text: "#f43f5e", glow: "rgba(244,63,94,0.25)", label: "Error" },
};

function MicGlyph({ active, speaking }: { active: boolean; speaking: boolean }) {
  if (speaking && !active) {
    return (
      <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
        <path d="M11 5L6 9H2v6h4l5 4V5z" />
        <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
        <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="2.5" width="6" height="11" rx="3" fill={active ? "currentColor" : "none"} fillOpacity={active ? 0.2 : 0} />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0" />
      <path d="M12 17.5V21" />
      <path d="M8.5 21h7" />
    </svg>
  );
}

/**
 * High-precision HTML5 Canvas waveform visualizing both microphone input (warm gold #e5a93c)
 * and synthesized TTS audio playback (emerald-gold #22c55e).
 */
function CanvasWaveform({
  inputLevel,
  playbackLevel,
  listening,
  speaking,
  thinking,
  color,
}: {
  inputLevel: number;
  playbackLevel: number;
  listening: boolean;
  speaking: boolean;
  thinking: boolean;
  color: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const historyRef = useRef<number[]>(Array.from({ length: 36 }, () => 0.08));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let lastPush = 0;

    const render = (now: number) => {
      const active = listening || speaking || thinking;
      if (now - lastPush > 45) {
        lastPush = now;
        const rawEnergy = listening
          ? Math.min(1, 0.1 + inputLevel * 5.2 + Math.random() * 0.08)
          : speaking
            ? Math.min(1, 0.14 + playbackLevel * 1.4 + Math.sin(now / 120) * 0.12)
            : thinking
              ? 0.16 + Math.sin(now / 220) * 0.08
              : 0.07;
        historyRef.current = [...historyRef.current.slice(1), Math.max(0.06, rawEnergy)];
      }

      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth || 280;
      const h = canvas.clientHeight || 44;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, w, h);

      const bars = historyRef.current;
      const count = bars.length;
      const barWidth = 3.5;
      const totalGap = w - count * barWidth;
      const gap = Math.max(2, totalGap / (count - 1));
      const startX = (w - (count * barWidth + (count - 1) * gap)) / 2;

      for (let i = 0; i < count; i++) {
        // Envelope taper at edges for acoustic symmetry
        const edgeFactor = Math.sin((i / (count - 1)) * Math.PI);
        const val = bars[i] * (0.4 + 0.6 * edgeFactor);
        const barH = Math.max(3, val * (h - 6));
        const x = startX + i * (barWidth + gap);
        const y = (h - barH) / 2;

        ctx.fillStyle = active ? color : "#2f2a23";
        ctx.globalAlpha = active ? Math.min(1, 0.38 + val * 0.62) : 0.65;
        ctx.beginPath();
        ctx.roundRect(x, y, barWidth, barH, 99);
        ctx.fill();
      }

      ctx.restore();
      raf = requestAnimationFrame(render);
    };

    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, [color, inputLevel, listening, playbackLevel, speaking, thinking]);

  return (
    <div className="relative flex h-11 w-full items-center justify-center rounded-lg border border-[var(--color-line-soft)] bg-[var(--color-sunken)] px-2.5">
      <canvas ref={canvasRef} className="h-9 w-full" aria-hidden="true" />
      <span className="pointer-events-none absolute right-2.5 top-1 font-mono text-[9px] uppercase tracking-wider text-[var(--color-faint)]">
        {listening ? "mic rms · 1.8s silence auto-stop" : speaking ? "tts output · tap orb to barge-in" : thinking ? "hermes stream-json" : "standby"}
      </span>
    </div>
  );
}

/** The primary control: one button, unmistakable, with a live level rim and instant barge-in. */
function VoiceOrb({ o, tone }: { o: Orchestrator; tone: (typeof STATE_TONE)[StateName] }) {
  const listening = o.state === "listening";
  const speaking = o.speakingNow || o.state === "speaking";
  // Allow clicking the orb even while speaking so barge-in works immediately!
  const disabled = !o.sttSupported || (o.state !== "idle" && o.state !== "listening" && o.state !== "degraded" && !speaking);
  const r = 60;
  const circumference = 2 * Math.PI * r;
  const meter = Math.min(1, listening ? o.level * 4.5 : speaking ? o.playbackLevel * 1.4 : 0.05);

  return (
    <div className="relative flex h-[156px] w-[156px] items-center justify-center">
      {(listening || speaking) && (
        <>
          <span className="orb-ring absolute inset-3 rounded-full" style={{ border: `2px solid ${tone.ring}` }} />
          <span className="orb-ring-2 absolute inset-3 rounded-full" style={{ border: `2px solid ${tone.ring}` }} />
        </>
      )}

      <svg viewBox="0 0 140 140" className="absolute inset-0 h-full w-full -rotate-90">
        <circle cx="70" cy="70" r={r} fill="none" stroke="#26221c" strokeWidth="4.5" />
        <circle
          cx="70"
          cy="70"
          r={r}
          fill="none"
          stroke={tone.ring}
          strokeWidth="4.5"
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
        onMouseLeave={() => listening && o.stopListening()}
        onClick={() => {
          if (listening) o.stopListening();
          else if (!disabled) void o.startListening();
        }}
        disabled={disabled}
        aria-label={listening ? "Stop listening and send" : speaking ? "Interrupt playback and speak" : "Start voice input"}
        aria-pressed={listening}
        className={cn(
          "group relative flex h-[106px] w-[106px] items-center justify-center rounded-full border border-[var(--color-line)] bg-[#1c1915] transition-transform duration-150",
          !disabled && "hover:scale-[1.03] active:scale-[0.97]",
          disabled && "opacity-45",
        )}
        style={
          listening || speaking
            ? { boxShadow: `0 0 0 5px ${tone.glow}, 0 14px 34px -10px rgba(0,0,0,0.85)`, borderColor: tone.ring }
            : { boxShadow: "0 10px 26px -10px rgba(0,0,0,0.75)" }
        }
      >
        <span
          className="absolute inset-0 rounded-full transition-opacity duration-200"
          style={{ background: `radial-gradient(circle at 50% 35%, ${tone.glow}, transparent 70%)`, opacity: listening || speaking ? 1 : 0.45 }}
        />
        <span className="relative" style={{ color: listening || speaking ? tone.ring : "var(--color-gold)" }}>
          <MicGlyph active={listening} speaking={speaking} />
        </span>
      </button>
    </div>
  );
}

export function VoiceDeck({
  o,
  onOpenSettings,
  onOpenDrawer,
  hudMode,
}: {
  o: Orchestrator;
  onOpenSettings: () => void;
  onOpenDrawer?: () => void;
  hudMode?: boolean;
}) {
  const tone = STATE_TONE[o.state];
  const last = [...o.timeline].reverse().find((x) => x.kind === "assistant" || x.kind === "progress" || x.kind === "tool" || x.kind === "error");
  const ttsEngineName = o.backend.health?.tts.engines.edge.available ? "edge-tts (Madhur)" : o.backend.health?.tts.engines.say.available ? "macOS say (Rishi)" : "webSpeech";

  return (
    <div className="flex flex-col gap-3">
      <div className="panel reveal px-4 pb-4 pt-3.5">
        <div className="flex items-center justify-between gap-2 border-b border-[var(--color-line-soft)] pb-2.5">
          <span className="label-xs text-[var(--color-gold)]">{o.activeModelBadge}</span>
          <span className="font-mono text-[10.5px] tabular text-[var(--color-muted)]">
            127.0.0.1:20130 · <span className={o.backend.reachable ? "text-[var(--color-emerald)]" : "text-[var(--color-amber)]"}>{o.backend.reachable ? "live" : "sim"}</span>
          </span>
        </div>

        <div className="mt-3 flex flex-col items-center">
          <VoiceOrb o={o} tone={tone} />

          <div className="-mt-0.5 text-center">
            <div className="font-display text-[24px] font-800 leading-tight tracking-[-0.02em]" style={{ color: tone.text }}>
              {stateCopy(o.state, o.settings.lang)}
            </div>
            <div className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-muted)]">
              {o.state === "listening"
                ? "speak naturally · auto-sends after 1.8s silence"
                : o.state === "awaitingPermission"
                  ? "say 'haan allow' or 'nahi deny'"
                  : o.speakingNow || o.state === "speaking"
                    ? "tap orb or ⌥Space to barge-in"
                    : "tap orb or hold ⌥Space to speak"}
            </div>
          </div>

          <div className="mt-3 w-full">
            <CanvasWaveform
              inputLevel={o.level}
              playbackLevel={o.playbackLevel}
              listening={o.state === "listening"}
              speaking={o.speakingNow || o.state === "speaking"}
              thinking={o.state === "thinking"}
              color={tone.ring}
            />
          </div>
        </div>

        <div className="panel-flat mt-2.5 min-h-[68px] px-3 py-2.5">
          {o.state === "listening" ? (
            <p className="text-[13px] leading-relaxed text-[var(--color-ink)]">
              {o.partial || <span className="text-[var(--color-faint)]">Bolo (en-IN Hinglish)… live transcript yahan aayega</span>}
            </p>
          ) : o.pendingConfirm ? (
            <p className="text-[13px] leading-relaxed text-[var(--color-gold-bright)]">"{o.pendingConfirm.text}"</p>
          ) : last ? (
            <p className="line-clamp-3 text-[12.5px] leading-relaxed text-[var(--color-ink-2)]">
              {last.kind === "tool" ? `⚙︎ ${last.text}` : last.text}
            </p>
          ) : (
            <p className="text-[12.5px] text-[var(--color-faint)]">Abhi tak koi output nahi. Orb dabao ya ⌥Space hold karke bolo.</p>
          )}
        </div>

        {o.pendingConfirm && (
          <div className="mt-2.5 rounded-xl border border-[var(--color-gold)]/35 bg-[var(--color-gold-wash)] p-3 rise">
            <div className="flex items-center gap-2">
              <Badge tone="gold">confidence {(o.pendingConfirm.confidence * 100).toFixed(0)}%</Badge>
              <span className="text-[11.5px] text-[var(--color-ink-2)]">Threshold se neeche — confirm karo</span>
            </div>
            <div className="mt-2.5 flex gap-2">
              <Button size="sm" variant="primary" onClick={o.confirmSend}>
                {t("btn_send", o.settings.lang)}
              </Button>
              <Button size="sm" onClick={o.confirmDiscard}>
                {t("btn_discard", o.settings.lang)}
              </Button>
              <span className="ml-auto self-center font-mono text-[10px] text-[var(--color-muted)]">auto-discard 15s</span>
            </div>
          </div>
        )}

        {o.activeError && (
          <div className="mt-2.5 rounded-xl border border-[var(--color-rose)]/35 bg-[var(--color-rose-wash)] p-3 rise">
            <div className="flex items-start gap-2">
              <span className="mt-[1px] text-[var(--color-rose)]">✖</span>
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] font-600 text-[var(--color-rose)]">{o.activeError.user}</div>
                <div className="mt-1 text-[11.5px] leading-snug text-[var(--color-ink-2)]">Fix: {o.activeError.fix}</div>
                <div className="mt-1 font-mono text-[10px] text-[var(--color-muted)]">{o.activeError.code}</div>
              </div>
              <button onClick={o.dismissError} className="text-[var(--color-muted)] transition-colors hover:text-[var(--color-rose)]" aria-label="Dismiss">
                ×
              </button>
            </div>
          </div>
        )}

        <div className="mt-3 flex items-center gap-1.5">
          {o.speakingNow && (
            <Button size="sm" variant="warn" onClick={o.bargeIn} title="Stop TTS audio playback immediately">
              Stop Audio
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={o.cancel} disabled={o.state === "idle" || o.state === "starting"} title="⌥⌘Space">
            Cancel
          </Button>
          <Button size="sm" variant="outline" onClick={o.repeatLast} disabled={!o.lastAssistant} title="⌥⇧Space">
            Repeat
          </Button>
          {hudMode && onOpenDrawer ? (
            <Button size="sm" variant="default" onClick={onOpenDrawer} className="ml-auto">
              Inspector Drawer
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={onOpenSettings} className="ml-auto">
              Settings
            </Button>
          )}
        </div>

        {/* Dynamic Narration Mode Controls */}
        <div className="mt-2.5 flex items-center justify-between rounded-xl border border-[var(--color-line-soft)] bg-black/25 px-2.5 py-1.5">
          <span className="text-[11px] font-medium text-[var(--color-muted)]">Voice Updates:</span>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => o.update("narrationMode", "verbose")}
              className={cn(
                "rounded px-2 py-0.5 text-[11px] font-medium transition-all",
                (o.settings.narrationMode ?? "direct") === "verbose"
                  ? "bg-[var(--color-gold)] text-black shadow-sm"
                  : "text-[var(--color-ink-2)] hover:text-white hover:bg-white/5"
              )}
              title="Time-to-time: Speaks intermediate progress pings"
            >
              🔊 Time-to-time
            </button>
            <button
              type="button"
              onClick={() => o.update("narrationMode", "direct")}
              className={cn(
                "rounded px-2 py-0.5 text-[11px] font-medium transition-all",
                (o.settings.narrationMode ?? "direct") === "direct"
                  ? "bg-[var(--color-gold)] text-black shadow-sm"
                  : "text-[var(--color-ink-2)] hover:text-white hover:bg-white/5"
              )}
              title="Direct: Mutes intermediate talk, speaks final result only"
            >
              🎯 Final Only
            </button>
            <button
              type="button"
              onClick={() => o.update("narrationMode", "on_demand")}
              className={cn(
                "rounded px-2 py-0.5 text-[11px] font-medium transition-all",
                (o.settings.narrationMode ?? "direct") === "on_demand"
                  ? "bg-[var(--color-gold)] text-black shadow-sm"
                  : "text-[var(--color-ink-2)] hover:text-white hover:bg-white/5"
              )}
              title="On-Demand: Fully silent until you ask 'Ban gaya kya?'"
            >
              🤫 On-Demand
            </button>
          </div>
        </div>

        <div className="mt-2.5 flex items-center justify-center gap-1.5 border-t border-[var(--color-line-soft)] pt-2.5">
          <span className="label-xs mr-1">talk</span>
          <Kbd>⌥</Kbd>
          <Kbd>Space</Kbd>
          <span className="label-xs mx-1">·</span>
          <span className="label-xs">cancel</span>
          <Kbd>⌥</Kbd>
          <Kbd>⌘</Kbd>
          <Kbd>Space</Kbd>
        </div>
      </div>

      <div className="panel reveal grid grid-cols-2 gap-px overflow-hidden bg-[var(--color-line-soft)]">
        {[
          {
            k: "omniroute",
            v: o.health?.reachable ? `${o.health.latencyMs ?? "?"}ms` : "offline (RO)",
            tone: o.routerBadge === "green" ? "var(--color-emerald)" : o.routerBadge === "red" ? "var(--color-rose)" : "var(--color-gold)",
          },
          {
            k: "hermes cli",
            v: o.backend.health?.hermes.found ? "stream-json ready" : o.backend.reachable ? "missing" : "simulator",
            tone: o.backend.health?.hermes.found ? "var(--color-emerald)" : "var(--color-gold)",
          },
          {
            k: "tasks live",
            v: `${o.backend.health?.tasks.live ?? 0}/${o.backend.health?.tasks.cap ?? 10}`,
            tone: "var(--color-ink)",
          },
          {
            k: "tts engine",
            v: ttsEngineName,
            tone: "var(--color-gold)",
          },
        ].map((s) => (
          <div key={s.k} className="bg-[var(--color-panel)] px-3 py-2">
            <div className="label-xs">{s.k}</div>
            <div className="mt-0.5 truncate font-mono text-[11.5px] font-500 tabular" style={{ color: s.tone }}>
              {s.v}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
