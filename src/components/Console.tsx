import { useEffect, useRef, useState } from "react";
import type { Orchestrator, TimelineItem } from "../hooks/useHermesVoice";
import { Badge, Button, Empty, Panel, TextField } from "./ui";
import { cn } from "../utils/cn";

const KIND: Record<TimelineItem["kind"], { label: string; wrap: string; icon: string }> = {
  user: { label: "you", wrap: "border-[rgba(11,107,96,0.2)] bg-[var(--color-pine-wash)]", icon: "🎙" },
  assistant: { label: "hermes", wrap: "border-[var(--color-line)] bg-white", icon: "✦" },
  tool: { label: "tool", wrap: "border-[var(--color-line-soft)] bg-[var(--color-sunken)]", icon: "⚙︎" },
  progress: { label: "progress", wrap: "border-transparent bg-transparent", icon: "›" },
  permission: { label: "permission", wrap: "border-[rgba(169,101,10,0.22)] bg-[var(--color-amber-wash)]", icon: "🔐" },
  error: { label: "error", wrap: "border-[rgba(172,35,64,0.22)] bg-[var(--color-rose-wash)]", icon: "✖" },
  system: { label: "system", wrap: "border-transparent bg-transparent", icon: "·" },
};

const SUGGESTIONS = [
  { text: "Omniroute ka health check karo aur combos batao", note: "low risk · read-only" },
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
    <Panel className="min-h-0 flex-1" title="Conversation" hint={`${o.timeline.length} events · ${o.bridgeLabel}`} action={<Badge tone={o.bridgeStatus.ok ? "green" : "amber"} dot>{o.bridgeId}</Badge>}>
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-4 py-4">
        {o.timeline.length === 0 && (
          <Empty
            title="Ek task bolo, ya neeche se shuru karo"
            body="Har chip alag risk tier trigger karta hai — low se critical tak — taaki poora permission flow verify ho jaye. Orb se voice ya ⌥Space."
            action={
              <div className="grid w-full max-w-xl gap-2 sm:grid-cols-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s.text}
                    onClick={() => o.submitText(s.text)}
                    className="group rounded-xl border border-[var(--color-line)] bg-white px-3.5 py-2.5 text-left transition-all hover:-translate-y-[1px] hover:border-[var(--color-pine-bright)] hover:shadow-[0_8px_20px_-14px_rgba(11,107,96,0.8)]"
                  >
                    <div className="text-[12.5px] font-500 leading-snug text-[var(--color-ink-2)] group-hover:text-[var(--color-pine)]">{s.text}</div>
                    <div className="mt-1 font-mono text-[10px] uppercase tracking-wide text-[var(--color-faint)]">{s.note}</div>
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
              className={cn("rise rounded-xl border px-3.5 py-2.5", k.wrap, bubble ? "" : "py-2", item.kind === "user" && "ml-12", item.kind === "assistant" && "mr-12")}
            >
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-[var(--color-faint)]">
                  {k.icon} {k.label}
                </span>
                <span className="ml-auto font-mono text-[9.5px] tabular text-[var(--color-faint)]">
                  {new Date(item.at).toLocaleTimeString([], { hour12: false })}
                </span>
              </div>
              <div className={cn("mt-1 whitespace-pre-wrap break-words", bubble ? "text-[13.5px] leading-relaxed text-[var(--color-ink)]" : "text-[12.5px] text-[var(--color-ink-2)]")}>
                {item.text}
              </div>
              {item.meta && <div className="mt-1.5 break-all border-t border-[rgba(15,19,25,0.06)] pt-1.5 font-mono text-[10.5px] text-[var(--color-muted)]">{item.meta}</div>}
            </article>
          );
        })}
      </div>

      <div className="flex items-center gap-2 border-t border-[var(--color-line-soft)] px-3 py-2.5">
        <TextField
          value={text}
          onChange={setText}
          placeholder={busy ? "Agent busy hai — cancel karke naya bolo" : "Type a task (voice ka text equivalent)…"}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !busy) {
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
