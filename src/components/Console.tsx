import { useEffect, useRef, useState } from "react";
import type { Orchestrator, TimelineItem } from "../hooks/useHermesVoice";
import { Badge, Button, Empty, Panel, TextField } from "./ui";
import { cn } from "../utils/cn";

const KIND: Record<TimelineItem["kind"], { label: string; wrap: string; icon: string; accent: string }> = {
  user: {
    label: "you",
    wrap: "border-[rgba(229,169,60,0.28)] bg-[rgba(229,169,60,0.08)]",
    icon: "🎙",
    accent: "text-[var(--color-gold-bright)]",
  },
  assistant: {
    label: "hermes",
    wrap: "border-[var(--color-line)] bg-[var(--color-panel-2)]",
    icon: "✦",
    accent: "text-[var(--color-ink)]",
  },
  tool: {
    label: "tool_call",
    wrap: "border-[var(--color-line-soft)] bg-[var(--color-sunken)]",
    icon: "⚙︎",
    accent: "text-[var(--color-gold)]",
  },
  progress: {
    label: "stream",
    wrap: "border-transparent bg-transparent",
    icon: "›",
    accent: "text-[var(--color-muted)]",
  },
  permission: {
    label: "permission",
    wrap: "border-[rgba(245,158,11,0.3)] bg-[var(--color-amber-wash)]",
    icon: "🔐",
    accent: "text-[var(--color-amber)]",
  },
  error: {
    label: "error",
    wrap: "border-[rgba(239,68,68,0.3)] bg-[var(--color-rose-wash)]",
    icon: "✖",
    accent: "text-[var(--color-rose)]",
  },
  system: {
    label: "system",
    wrap: "border-transparent bg-transparent",
    icon: "·",
    accent: "text-[var(--color-faint)]",
  },
};

const SUGGESTIONS = [
  { text: "Omniroute ka health check karo aur combos batao", note: "low risk · read-only SQLite + HTTP" },
  { text: "Repo me changes commit kar do", note: "high risk · git mutation" },
  { text: "Scratch folder clean kar do", note: "critical · rm -rf" },
  { text: "Mera gemini api key padh ke batao", note: "critical · typed ALLOW" },
];

export function Console({ o }: { o: Orchestrator }) {
  const [text, setText] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const busy = o.state !== "idle" && o.state !== "degraded";

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [o.timeline.length]);

  return (
    <Panel
      className="min-h-0 flex-1"
      title="Conversation & Tool Stream"
      hint={`${o.timeline.length} events · ${o.bridgeLabel}`}
      action={
        <div className="flex items-center gap-3">
          <Badge tone={o.bridgeStatus.ok ? "green" : "amber"} dot>
            {o.bridgeId}
          </Badge>
          {o.timeline.length > 0 && (
            <Button size="xs" variant="ghost" onClick={o.repeatLast} disabled={!o.lastAssistant}>
              Replay TTS
            </Button>
          )}
        </div>
      }
    >
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-4 py-4">
        {o.timeline.length === 0 && (
          <Empty
            title="Ek task bolo, ya neeche se shuru karo"
            body="Har prompt alag risk tier trigger karta hai — low se critical tak — taaki stream-json tool interception, Hinglish voice approval, aur typed ALLOW verify ho jaye."
            action={
              <div className="grid w-full max-w-xl gap-2 sm:grid-cols-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s.text}
                    onClick={() => o.submitText(s.text)}
                    className="group rounded-xl border border-[var(--color-line)] bg-[var(--color-sunken)] px-3.5 py-2.5 text-left transition-all hover:-translate-y-[1px] hover:border-[rgba(229,169,60,0.45)] hover:bg-[var(--color-panel-2)]"
                  >
                    <div className="text-[12.5px] font-500 leading-snug text-[var(--color-ink)] group-hover:text-[var(--color-gold-bright)]">
                      {s.text}
                    </div>
                    <div className="mt-1 font-mono text-[10px] uppercase tracking-wide text-[var(--color-muted)]">{s.note}</div>
                  </button>
                ))}
              </div>
            }
          />
        )}

        {o.timeline.map((item) => {
          const k = KIND[item.kind];
          const bubble = item.kind === "user" || item.kind === "assistant";
          return (
            <article
              key={item.id}
              className={cn(
                "rise rounded-xl border px-3.5 py-2.5",
                k.wrap,
                bubble ? "" : "py-2",
                item.kind === "user" && "ml-8 sm:ml-14",
                item.kind === "assistant" && "mr-8 sm:mr-14",
              )}
            >
              <div className="flex items-baseline gap-2">
                <span className={cn("font-mono text-[9.5px] font-600 uppercase tracking-[0.12em]", k.accent)}>
                  {k.icon} {k.label}
                </span>
                <span className="ml-auto font-mono text-[9.5px] tabular text-[var(--color-faint)]">
                  {new Date(item.at).toLocaleTimeString([], { hour12: false })}
                </span>
              </div>
              <div
                className={cn(
                  "mt-1 whitespace-pre-wrap break-words",
                  bubble ? "text-[13.5px] leading-relaxed text-[var(--color-ink)]" : "text-[12.5px] text-[var(--color-ink-2)]",
                )}
              >
                {item.text}
              </div>
              {item.meta && (
                <div className="mt-1.5 break-all border-t border-[var(--color-line-soft)] pt-1.5 font-mono text-[10.5px] text-[var(--color-muted)]">
                  {item.meta}
                </div>
              )}
            </article>
          );
        })}
      </div>

      <div className="flex items-center gap-2 border-t border-[var(--color-line)] bg-[var(--color-sunken)] px-3 py-2.5">
        <TextField
          value={text}
          onChange={setText}
          placeholder={busy ? "Agent busy hai — cancel karke naya bolo" : "Type a task in Hinglish or English (hermes chat -q … --format stream-json)…"}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !busy && text.trim()) {
              o.submitText(text);
              setText("");
            }
          }}
        />
        <Button
          variant="primary"
          disabled={busy || !text.trim()}
          onClick={() => {
            o.submitText(text);
            setText("");
          }}
        >
          Send
        </Button>
      </div>
    </Panel>
  );
}
