import { useEffect, useRef, useState } from "react";
import type { Orchestrator } from "../hooks/useHermesVoice";
import { stateCopy, t } from "../lib/strings";
import type { StateName } from "../lib/stateMachine";
import { Badge, Button, Kbd } from "./ui";
import { cn } from "../utils/cn";

const STATE_TONE: Record<StateName, { ring: string; text: string; glow: string; label: string }> = {
  starting: { ring: "#98a2b1", text: "var(--color-muted)", glow: "rgba(152,162,173,0.25)", label: "Starting" },
  idle: { ring: "#0b6b60", text: "var(--color-ink)", glow: "rgba(11,107,96,0.18)", label: "Idle" },
  listening: { ring: "#0f9c8a", text: "#0b6b60", glow: "rgba(15,156,138,0.30)", label: "Listening" },
  transcribing: { ring: "#2f4bd8", text: "#2f4bd8", glow: "rgba(47,75,216,0.22)", label: "Transcribing" },
  confirmingTranscript: { ring: "#7c3aed", text: "#6d28d9", glow: "rgba(124,58,237,0.22)", label: "Confirm" },
  thinking: { ring: "#2f4bd8", text: "#2f4bd8", glow: "rgba(47,75,216,0.22)", label: "Thinking" },
  awaitingPermission: { ring: "#a9650a", text: "#a9650a", glow: "rgba(169,101,10,0.25)", label: "Permission" },
  speaking: { ring: "#0b6b60", text: "#0b6b60", glow: "rgba(11,107,96,0.25)", label: "Speaking" },
  cancelling: { ring: "#ac2340", text: "#ac2340", glow: "rgba(172,35,64,0.22)", label: "Cancelling" },
  degraded: { ring: "#a9650a", text: "#a9650a", glow: "rgba(169,101,10,0.2)", label: "Degraded" },
  error: { ring: "#ac2340", text: "#ac2340", glow: "rgba(172,35,64,0.22)", label: "Error" },
};

function MicGlyph({ active }: { active: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="2.5" width="6" height="11" rx="3" fill={active ? "currentColor" : "none"} fillOpacity={active ? 0.16 : 0} />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0" />
      <path d="M12 17.5V21" />
      <path d="M8.5 21h7" />
    </svg>
  );
}

function Wave({ level, active, color }: { level: number; active: boolean; color: string }) {
  const [bars, setBars] = useState<number[]>(() => Array.from({ length: 22 }, () => 0.1));
  const reduce = useRef(false);
  const timer = useRef(0);

  useEffect(() => {
    reduce.current = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  }, []);

  useEffect(() => {
    if (!active) {
      setBars(Array.from({ length: 22 }, () => 0.1));
      return;
    }
    if (reduce.current) {
      setBars(Array.from({ length: 22 }, () => Math.min(1, 0.12 + level * 2.4)));
      return;
    }
    const tick = () => {
      setBars((prev) => [...prev.slice(1), Math.min(1, 0.1 + level * 5 + Math.random() * 0.1)]);
      timer.current = window.setTimeout(tick, 60);
    };
    tick();
    return () => window.clearTimeout(timer.current);
  }, [active, level]);

  return (
    <div className="flex h-8 items-center justify-center gap-[3px]" aria-hidden>
      {bars.map((b, i) => (
        <span
          key={i}
          className="w-[3px] rounded-full transition-[height,background-color] duration-75"
          style={{ height: `${Math.max(3, b * 30)}px`, backgroundColor: active ? color : "#d5dbe4", opacity: active ? 0.35 + b * 0.65 : 1 }}
        />
      ))}
    </div>
  );
}

/** The primary control: one button, unmistakable, with a live level rim. */
function VoiceOrb({ o, tone }: { o: Orchestrator; tone: (typeof STATE_TONE)[StateName] }) {
  const listening = o.state === "listening";
  const disabled = !o.sttSupported || (o.state !== "idle" && o.state !== "listening" && o.state !== "degraded");
  const r = 62;
  const circumference = 2 * Math.PI * r;
  const meter = Math.min(1, o.level * 4.5);

  return (
    <div className="relative flex h-[168px] w-[168px] items-center justify-center">
      {listening && (
        <>
          <span className="orb-ring absolute inset-3 rounded-full" style={{ border: `2px solid ${tone.ring}` }} />
          <span className="orb-ring-2 absolute inset-3 rounded-full" style={{ border: `2px solid ${tone.ring}` }} />
        </>
      )}

      <svg viewBox="0 0 140 140" className="absolute inset-0 h-full w-full -rotate-90">
        <circle cx="70" cy="70" r={r} fill="none" stroke="#e3e8ef" strokeWidth="5" />
        <circle
          cx="70"
          cy="70"
          r={r}
          fill="none"
          stroke={tone.ring}
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - (listening ? meter : o.speakingNow ? 0.65 : 0.04))}
          style={{ transition: "stroke-dashoffset 90ms linear" }}
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
        aria-label={listening ? "Stop listening and send" : "Start voice input"}
        aria-pressed={listening}
        className={cn(
          "group relative flex h-[112px] w-[112px] items-center justify-center rounded-full transition-all duration-200",
          "bg-white shadow-[0_10px_30px_-12px_rgba(15,19,25,0.45),0_1px_2px_rgba(15,19,25,0.08)] ring-1 ring-[var(--color-line)]",
          !disabled && "hover:scale-[1.03] active:scale-[0.98]",
          disabled && "opacity-45",
        )}
        style={listening ? { boxShadow: `0 0 0 6px ${tone.glow}, 0 14px 34px -12px rgba(15,19,25,0.5)` } : undefined}
      >
        <span
          className="absolute inset-0 rounded-full transition-opacity duration-300"
          style={{ background: `radial-gradient(circle at 50% 35%, ${tone.glow}, transparent 68%)`, opacity: listening ? 1 : 0.35 }}
        />
        <span className="relative" style={{ color: listening ? tone.ring : "var(--color-ink-2)" }}>
          <MicGlyph active={listening} />
        </span>
      </button>
    </div>
  );
}

export function VoiceDeck({ o, onOpenSettings }: { o: Orchestrator; onOpenSettings: () => void }) {
  const tone = STATE_TONE[o.state];
  const last = [...o.timeline].reverse().find((x) => x.kind === "assistant" || x.kind === "progress" || x.kind === "tool" || x.kind === "error");

  return (
    <div className="flex flex-col gap-3">
      <div className="panel reveal px-4 pb-4 pt-3.5">
        <div className="flex items-center justify-between">
          <span className="label-xs">Voice deck</span>
          <span className="flex items-center gap-1.5">
            <Badge tone={o.backend.reachable ? "green" : "amber"} dot>
              {o.backend.reachable ? "bridge live" : "bridge offline"}
            </Badge>
          </span>
        </div>

        <div className="mt-3 flex flex-col items-center">
          <VoiceOrb o={o} tone={tone} />

          <div className="-mt-1 text-center">
            <div className="font-display text-[26px] font-800 leading-tight tracking-[-0.02em]" style={{ color: tone.text }}>
              {stateCopy(o.state, o.settings.lang)}
            </div>
            <div className="mt-0.5 font-mono text-[10.5px] uppercase tracking-[0.14em] text-[var(--color-faint)]">
              {o.state === "listening" ? "release / click to send" : o.state === "awaitingPermission" ? "answer the dialog" : o.state === "speaking" ? "report playing" : "tap the orb to talk"}
            </div>
          </div>

          <div className="mt-2 w-full">
            <Wave level={o.level} active={o.state === "listening"} color={tone.ring} />
          </div>
        </div>

        <div className="panel-flat mt-1 min-h-[64px] px-3 py-2.5">
          {o.state === "listening" ? (
            <p className="text-[13px] leading-relaxed text-[var(--color-ink)]">
              {o.partial || <span className="text-[var(--color-faint)]">Bolo… live transcript yahan aayega</span>}
            </p>
          ) : o.pendingConfirm ? (
            <p className="text-[13px] leading-relaxed text-[#6d28d9]">"{o.pendingConfirm.text}"</p>
          ) : last ? (
            <p className="line-clamp-3 text-[12.5px] leading-relaxed text-[var(--color-ink-2)]">
              {last.kind === "tool" ? `⚙︎ ${last.text}` : last.text}
            </p>
          ) : (
            <p className="text-[12.5px] text-[var(--color-faint)]">Abhi tak koi output nahi. Orb dabao aur bolo.</p>
          )}
        </div>

        {o.pendingConfirm && (
          <div className="mt-2.5 rounded-xl border border-[rgba(124,58,237,0.25)] bg-[#f5f0ff] p-3 rise">
            <div className="flex items-center gap-2">
              <Badge tone="indigo">confidence {(o.pendingConfirm.confidence * 100).toFixed(0)}%</Badge>
              <span className="text-[11.5px] text-[#6d28d9]">Threshold se neeche — confirm karo</span>
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

        {o.activeError && (
          <div className="mt-2.5 rounded-xl border border-[rgba(172,35,64,0.22)] bg-[var(--color-rose-wash)] p-3 rise">
            <div className="flex items-start gap-2">
              <span className="mt-[1px] text-[var(--color-rose)]">✖</span>
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] font-600 text-[var(--color-rose)]">{o.activeError.user}</div>
                <div className="mt-1 text-[11.5px] leading-snug text-[#8d2038]">Fix: {o.activeError.fix}</div>
                <div className="mt-1 font-mono text-[10px] text-[#a45c6c]">{o.activeError.code}</div>
              </div>
              <button onClick={o.dismissError} className="text-[#a45c6c] transition-colors hover:text-[var(--color-rose)]" aria-label="Dismiss">
                ×
              </button>
            </div>
          </div>
        )}

        <div className="mt-3 flex items-center gap-1.5">
          <Button size="sm" variant="outline" onClick={o.cancel} disabled={o.state === "idle" || o.state === "starting"} title="⌥⌘Space">
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
          <span className="label-xs mr-1">hold</span>
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
          { k: "omniroute", v: o.health?.reachable ? `${o.health.latencyMs ?? "?"}ms` : "down", tone: o.routerBadge === "green" ? "var(--color-pine)" : o.routerBadge === "red" ? "var(--color-rose)" : "var(--color-amber)" },
          { k: "agent binary", v: o.backend.health?.hermes.found ? "found" : o.backend.reachable ? "missing" : "unknown", tone: o.backend.health?.hermes.found ? "var(--color-pine)" : "var(--color-amber)" },
          { k: "tasks live", v: `${o.backend.health?.tasks.live ?? 0}/${o.backend.health?.tasks.cap ?? 10}`, tone: "var(--color-ink)" },
          { k: "tts engine", v: o.backend.health?.tts.engines.edge.available ? "edge-tts" : "system voice", tone: "var(--color-ink)" },
        ].map((s) => (
          <div key={s.k} className="bg-white px-3 py-2">
            <div className="label-xs">{s.k}</div>
            <div className="mt-0.5 truncate font-mono text-[12px] font-500" style={{ color: s.tone }}>
              {s.v}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
