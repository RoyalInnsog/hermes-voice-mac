import { useEffect, useRef } from "react";
import type { Orchestrator } from "../hooks/useHermesVoice";
import { stateCopy, t } from "../lib/strings";
import type { StateName } from "../lib/stateMachine";
import { Badge, Button, Kbd } from "./ui";
import { cn } from "../utils/cn";

const STATE_TONE: Record<StateName, { ring: string; text: string; glow: string; label: string }> = {
  starting: { ring: "#9a9080", text: "var(--color-muted)", glow: "rgba(154,144,128,0.22)", label: "Starting" },
  idle: { ring: "#e5a93c", text: "var(--color-ink)", glow: "rgba(229,169,60,0.22)", label: "Idle" },
  listening: { ring: "#f2be5c", text: "#f2be5c", glow: "rgba(242,190,92,0.38)", label: "Listening" },
  transcribing: { ring: "#38bdf8", text: "#38bdf8", glow: "rgba(56,189,248,0.28)", label: "Transcribing" },
  confirmingTranscript: { ring: "#c084fc", text: "#c084fc", glow: "rgba(192,132,252,0.28)", label: "Confirm" },
  thinking: { ring: "#e5a93c", text: "#e5a93c", glow: "rgba(229,169,60,0.28)", label: "Thinking" },
  awaitingPermission: { ring: "#f59e0b", text: "#fbbf24", glow: "rgba(245,158,11,0.34)", label: "Permission" },
  speaking: { ring: "#2dd4bf", text: "#2dd4bf", glow: "rgba(45,212,191,0.34)", label: "Speaking" },
  cancelling: { ring: "#f43f5e", text: "#fb7185", glow: "rgba(244,63,94,0.28)", label: "Cancelling" },
  degraded: { ring: "#f59e0b", text: "#fbbf24", glow: "rgba(245,158,11,0.24)", label: "Degraded" },
  error: { ring: "#f43f5e", text: "#fb7185", glow: "rgba(244,63,94,0.28)", label: "Error" },
};

function MicGlyph({ active, speaking }: { active: boolean; speaking: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-7 w-7"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect
        x="9"
        y="2.5"
        width="6"
        height="11"
        rx="3"
        fill={active || speaking ? "currentColor" : "none"}
        fillOpacity={active ? 0.25 : speaking ? 0.18 : 0}
      />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0" />
      <path d="M12 17.5V21" />
      <path d="M8.5 21h7" />
    </svg>
  );
}

/**
 * Dynamic HTML5 Canvas + SVG Dual Waveform visualizing both microphone input (listening)
 * and Edge TTS audio playback output (speaking).
 */
function DualWaveform({
  level,
  listening,
  speaking,
  color,
}: {
  level: number;
  listening: boolean;
  speaking: boolean;
  color: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const phaseRef = useRef(0);
  const barsRef = useRef<number[]>(Array.from({ length: 28 }, () => 0.08));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    const active = listening || speaking;

    const render = () => {
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      phaseRef.current += active ? 0.16 : 0.03;
      const bars = barsRef.current;
      const barCount = bars.length;

      for (let i = 0; i < barCount; i++) {
        const centerDist = 1 - Math.abs(i - (barCount - 1) / 2) / ((barCount - 1) / 2);
        const target = active
          ? Math.min(
              1,
              0.12 +
                centerDist *
                  (level * 4.8 + Math.abs(Math.sin(phaseRef.current + i * 0.45)) * (speaking ? 0.42 : 0.25)),
            )
          : 0.08 + Math.sin(phaseRef.current + i * 0.3) * 0.025;
        bars[i] = bars[i] * 0.72 + target * 0.28;
      }

      // 1. Ambient sine ribbon
      ctx.beginPath();
      for (let x = 0; x < w; x += 3) {
        const normX = x / w;
        const env = Math.sin(normX * Math.PI);
        const amp = active ? Math.min(h * 0.42, (0.15 + level * 3.5) * h * 0.42) : 2.5;
        const y = h / 2 + Math.sin(normX * 10 + phaseRef.current * 1.5) * amp * env;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = active ? color : "rgba(154,144,128,0.22)";
      ctx.globalAlpha = active ? 0.35 : 0.2;
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // 2. Crisp vertical equalizer bars
      const gap = 4;
      const barW = Math.max(2.5, (w - (barCount - 1) * gap) / barCount);
      for (let i = 0; i < barCount; i++) {
        const val = Math.max(0.07, Math.min(1, bars[i]));
        const bh = Math.max(4, val * (h - 6));
        const x = i * (barW + gap);
        const y = (h - bh) / 2;

        ctx.globalAlpha = active ? 0.45 + val * 0.55 : 0.28;
        ctx.fillStyle = active ? color : "#3a342b";
        ctx.beginPath();
        ctx.roundRect(x, y, barW, bh, 99);
        ctx.fill();
      }

      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(render);
    };

    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, [color, level, listening, speaking]);

  return (
    <div className="relative flex flex-col items-center">
      <canvas
        ref={canvasRef}
        width={296}
        height={46}
        className="h-[46px] w-full max-w-[296px]"
        aria-label={listening ? "Microphone input waveform" : speaking ? "Audio playback waveform" : "Idle waveform"}
      />
      <div className="mt-1 flex items-center gap-2 font-mono text-[9.5px] uppercase tracking-[0.14em] text-[var(--color-faint)]">
        <span className={cn("h-1.5 w-1.5 rounded-full", listening ? "bg-[#f2be5c]" : speaking ? "bg-[#2dd4bf]" : "bg-[#3a342b]")} />
        <span>
          {listening
            ? "mic input · 1.8s silence auto-send"
            : speaking
              ? "tts output · tap orb to barge-in"
              : "ready · hinglish + english"}
        </span>
      </div>
    </div>
  );
}

/** The primary control: one button, unmistakable, with live level rim & barge-in support. */
function VoiceOrb({ o, tone }: { o: Orchestrator; tone: (typeof STATE_TONE)[StateName] }) {
  const listening = o.state === "listening";
  const speaking = o.speakingNow || o.state === "speaking";
  // Barge-in enabled: orb is clickable during speaking and awaitingPermission too!
  const canInteract =
    o.sttSupported &&
    (o.state === "idle" ||
      o.state === "listening" ||
      o.state === "speaking" ||
      o.state === "awaitingPermission" ||
      o.state === "degraded" ||
      o.speakingNow);
  const disabled = !canInteract;
  const r = 62;
  const circumference = 2 * Math.PI * r;
  const meter = Math.min(1, o.level * 4.5);

  return (
    <div className="relative flex h-[172px] w-[172px] items-center justify-center">
      {(listening || speaking) && (
        <>
          <span className="orb-ring absolute inset-3 rounded-full" style={{ border: `2px solid ${tone.ring}` }} />
          <span className="orb-ring-2 absolute inset-3 rounded-full" style={{ border: `2px solid ${tone.ring}` }} />
        </>
      )}

      <svg viewBox="0 0 140 140" className="absolute inset-0 h-full w-full -rotate-90">
        <circle cx="70" cy="70" r={r} fill="none" stroke="#26221c" strokeWidth="5" />
        <circle
          cx="70"
          cy="70"
          r={r}
          fill="none"
          stroke={tone.ring}
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - (listening ? Math.max(0.12, meter) : speaking ? Math.max(0.25, meter) : 0.06))}
          style={{ transition: "stroke-dashoffset 80ms linear" }}
        />
      </svg>

      <button
        onMouseDown={() => {
          if (!disabled && !listening) void o.startListening();
        }}
        onClick={() => {
          if (listening) o.stopListening();
          else if (!disabled) void o.startListening();
        }}
        disabled={disabled}
        aria-label={
          listening
            ? "Stop listening and send"
            : speaking
              ? "Barge-in: interrupt speech and talk"
              : "Start voice input"
        }
        aria-pressed={listening}
        className={cn(
          "group relative flex h-[114px] w-[114px] items-center justify-center rounded-full transition-all duration-200",
          "bg-[#1a1713] shadow-[0_14px_38px_-10px_rgba(0,0,0,0.85),0_0_0_1px_rgba(229,169,60,0.22)]",
          !disabled && "hover:scale-[1.03] active:scale-[0.97]",
          disabled && "opacity-45",
        )}
        style={
          listening || speaking
            ? { boxShadow: `0 0 0 6px ${tone.glow}, 0 18px 42px -12px rgba(0,0,0,0.9)` }
            : undefined
        }
      >
        <span
          className="absolute inset-0 rounded-full transition-opacity duration-300"
          style={{
            background: `radial-gradient(circle at 50% 35%, ${tone.glow}, transparent 70%)`,
            opacity: listening || speaking ? 1 : 0.45,
          }}
        />
        <span className="relative" style={{ color: listening || speaking ? tone.ring : "#e5a93c" }}>
          <MicGlyph active={listening} speaking={speaking} />
        </span>
      </button>
    </div>
  );
}

export function VoiceDeck({ o, onOpenSettings }: { o: Orchestrator; onOpenSettings: () => void }) {
  const tone = STATE_TONE[o.state];
  const last = [...o.timeline]
    .reverse()
    .find((x) => x.kind === "assistant" || x.kind === "progress" || x.kind === "tool" || x.kind === "error");

  const ttsEngineLabel = o.backend.health?.tts.engines.edge.available
    ? `edge-tts · ${o.backend.health.tts.configured.voice.replace("Neural", "")}`
    : o.backend.health?.tts.engines.say.available
      ? "macOS say · Rishi"
      : "web speech";

  return (
    <div className="flex flex-col gap-3">
      <div className="panel reveal px-4 pb-4 pt-3.5">
        <div className="flex flex-wrap items-center justify-between gap-1.5">
          <span className="label-xs text-[#e5a93c]">Voice Deck · HUD</span>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone="gold" dot>
              {o.activeModel}
            </Badge>
            <Badge tone={o.backend.reachable ? "green" : "amber"} dot>
              {o.backend.reachable ? "127.0.0.1:20130" : "bridge offline"}
            </Badge>
          </div>
        </div>

        <div className="mt-3 flex flex-col items-center">
          <VoiceOrb o={o} tone={tone} />

          <div className="-mt-1 text-center">
            <div
              className="font-display text-[25px] font-800 leading-tight tracking-[-0.02em]"
              style={{ color: tone.text }}
            >
              {stateCopy(o.state, o.settings.lang)}
            </div>
            <div className="mt-0.5 font-mono text-[10.5px] uppercase tracking-[0.14em] text-[var(--color-muted)]">
              {o.state === "listening"
                ? "click to send · or pause 1.8s"
                : o.state === "awaitingPermission"
                  ? "say 'haan kar do' / 'nahi ruko' or click"
                  : o.speakingNow || o.state === "speaking"
                    ? "playing · tap orb to interrupt (barge-in)"
                    : "tap orb or press ⌥Space to speak"}
            </div>
          </div>

          <div className="mt-3 w-full">
            <DualWaveform
              level={o.level}
              listening={o.state === "listening"}
              speaking={o.speakingNow || o.state === "speaking"}
              color={tone.ring}
            />
          </div>
        </div>

        <div className="panel-flat mt-3 min-h-[68px] px-3.5 py-2.5">
          {o.state === "listening" ? (
            <p className="text-[13px] leading-relaxed text-[#f2be5c]">
              {o.partial || <span className="text-[var(--color-faint)]">Bolo… live Hinglish/English transcript yahan aayega</span>}
            </p>
          ) : o.pendingConfirm ? (
            <p className="text-[13px] leading-relaxed text-[#c084fc]">"{o.pendingConfirm.text}"</p>
          ) : last ? (
            <p className="line-clamp-3 text-[12.5px] leading-relaxed text-[var(--color-ink-2)]">
              {last.kind === "tool" ? `⚙︎ ${last.text}` : last.text}
            </p>
          ) : (
            <p className="text-[12.5px] text-[var(--color-faint)]">
              Hermes Voice v1.0 ready. Orb dabao ya ⌥Space hold karke bolo.
            </p>
          )}
        </div>

        {o.pendingConfirm && (
          <div className="mt-2.5 rounded-xl border border-[rgba(192,132,252,0.3)] bg-[rgba(192,132,252,0.1)] p-3 rise">
            <div className="flex items-center gap-2">
              <Badge tone="indigo">confidence {(o.pendingConfirm.confidence * 100).toFixed(0)}%</Badge>
              <span className="text-[11.5px] text-[#d8b4fe]">Threshold se neeche — confirm karo</span>
            </div>
            <div className="mt-2.5 flex gap-2">
              <Button size="sm" variant="primary" onClick={o.confirmSend}>
                {t("btn_send", o.settings.lang)}
              </Button>
              <Button size="sm" onClick={o.confirmDiscard}>
                {t("btn_discard", o.settings.lang)}
              </Button>
              <span className="ml-auto self-center font-mono text-[10px] text-[var(--color-faint)]">
                auto-discard 15s
              </span>
            </div>
          </div>
        )}

        {o.activeError && (
          <div className="mt-2.5 rounded-xl border border-[rgba(244,63,94,0.3)] bg-[var(--color-rose-wash)] p-3 rise">
            <div className="flex items-start gap-2">
              <span className="mt-[1px] text-[#fb7185]">✖</span>
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] font-600 text-[#fb7185]">{o.activeError.user}</div>
                <div className="mt-1 text-[11.5px] leading-snug text-[var(--color-ink-2)]">
                  Fix: {o.activeError.fix}
                </div>
                <div className="mt-1 font-mono text-[10px] text-[var(--color-muted)]">{o.activeError.code}</div>
              </div>
              <button
                onClick={o.dismissError}
                className="text-[var(--color-muted)] transition-colors hover:text-[#fb7185]"
                aria-label="Dismiss"
              >
                ×
              </button>
            </div>
          </div>
        )}

        <div className="mt-3 flex items-center gap-1.5">
          {o.speakingNow && (
            <Button size="sm" variant="warn" onClick={o.haltAudio} title="Stop TTS playback immediately">
              ⏹ Mute TTS
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={o.cancel}
            disabled={o.state === "idle" || o.state === "starting"}
            title="⌥⌘Space"
          >
            Cancel
          </Button>
          <Button size="sm" variant="outline" onClick={o.repeatLast} disabled={!o.lastAssistant} title="⌥⇧Space">
            ↻ Repeat
          </Button>
          <Button size="sm" variant="ghost" onClick={onOpenSettings} className="ml-auto">
            Settings
          </Button>
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
            k: "active model",
            v: o.activeModel,
            tone: "#e5a93c",
          },
          {
            k: "omniroute (20128)",
            v: o.health?.reachable ? `${o.health.latencyMs ?? "?"}ms · read-only` : "down",
            tone:
              o.routerBadge === "green"
                ? "#2dd4bf"
                : o.routerBadge === "red"
                  ? "#fb7185"
                  : "#fbbf24",
          },
          {
            k: "hermes cli",
            v: o.backend.health?.hermes.found
              ? "stream-json ready"
              : o.backend.reachable
                ? "missing"
                : "simulator",
            tone: o.backend.health?.hermes.found ? "#2dd4bf" : "#fbbf24",
          },
          {
            k: "tts engine",
            v: ttsEngineLabel,
            tone: "#e5a93c",
          },
        ].map((s) => (
          <div key={s.k} className="bg-[#14120f] px-3 py-2.5">
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
