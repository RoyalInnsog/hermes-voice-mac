import { useEffect, useState } from "react";
import type { Orchestrator } from "../hooks/useHermesVoice";
import { allowsVoiceApproval, requiresTypedConfirm } from "../lib/risk";
import { formatArgs, redactArgs } from "../lib/redactor";
import { t } from "../lib/strings";
import type { RiskLevel } from "../lib/types";
import { Badge, Button, Kbd } from "./ui";
import { cn } from "../utils/cn";

const RISK: Record<RiskLevel, { label: string; fg: string; bg: string; border: string; icon: string; blurb: string }> = {
  low: {
    label: "LOW",
    fg: "#2dd4bf",
    bg: "rgba(45,212,191,0.12)",
    border: "rgba(45,212,191,0.3)",
    icon: "○",
    blurb: "Read-only kaam. Voice ('haan kar do' / 'nahi') ya click se approve karo.",
  },
  medium: {
    label: "MEDIUM",
    fg: "#e5a93c",
    bg: "rgba(229,169,60,0.14)",
    border: "rgba(229,169,60,0.32)",
    icon: "◐",
    blurb: "Project ke andar write. Approval zaroori, voice ('haan kar do' / 'permission di') allowed.",
  },
  high: {
    label: "HIGH",
    fg: "#fb923c",
    bg: "rgba(251,146,60,0.14)",
    border: "rgba(251,146,60,0.32)",
    icon: "◆",
    blurb: "Shell / git push / delete. Voice approval blocked — click karo.",
  },
  critical: {
    label: "CRITICAL",
    fg: "#fb7185",
    bg: "rgba(244,63,94,0.15)",
    border: "rgba(244,63,94,0.38)",
    icon: "✖",
    blurb: "Credentials ya system change (rm -rf / sudo). Exact word ALLOW type kiye bina kuch nahi hoga.",
  },
};

export function PermissionDialog({ o }: { o: Orchestrator }) {
  const req = o.pending;
  const [showRaw, setShowRaw] = useState(false);
  const [typed, setTyped] = useState("");
  const [voiceText, setVoiceText] = useState("");

  useEffect(() => {
    setShowRaw(false);
    setTyped("");
    setVoiceText("");
  }, [req?.id]);

  if (!req) return null;

  const risk = RISK[req.risk];
  const needsTyped = requiresTypedConfirm(req.risk);
  const typedOK = !needsTyped || typed.trim() === "ALLOW";
  const voiceOK = o.settings.voiceApproval && allowsVoiceApproval(req.risk);
  const total = Math.max(
    1,
    Math.round((req.expiresAt - req.requestedAt || o.settings.permissionTimeoutSec * 1000) / 1000),
  );
  const pct = Math.max(0, Math.min(1, o.pendingRemaining / total));
  const displayArgs = showRaw ? formatArgs(req.args) : formatArgs(redactArgs(req.args));
  const R = 20;
  const C = 2 * Math.PI * R;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(8,7,6,0.75)] p-4 backdrop-blur-md">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Permission request for ${req.toolName}`}
        onKeyDown={(e) => {
          if (e.key === "Escape") o.resolvePermission("deny", "click");
          if (e.key === "Enter" && typedOK) {
            o.resolvePermission("allowOnce", "click", needsTyped ? typed.trim() : null);
          }
        }}
        className="rise w-full max-w-[520px] overflow-hidden rounded-2xl border border-[#332d24] bg-[#161411] shadow-[0_40px_90px_-20px_rgba(0,0,0,0.9)]"
      >
        <div className="h-[3px] w-full bg-[#24201a]">
          <div
            className="h-full transition-[width] duration-200"
            style={{ width: `${pct * 100}%`, backgroundColor: req.risk === "critical" ? "#f43f5e" : "#e5a93c" }}
          />
        </div>

        <div className="space-y-4 p-5">
          <header className="flex items-start gap-3.5">
            <div className="relative h-11 w-11 shrink-0" style={{ color: risk.fg }}>
              <svg viewBox="0 0 44 44" className="absolute inset-0 -rotate-90">
                <circle cx="22" cy="22" r={R} fill="none" stroke="#28231c" strokeWidth="3" />
                <circle
                  cx="22"
                  cy="22"
                  r={R}
                  fill="none"
                  stroke={risk.fg}
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray={C}
                  strokeDashoffset={C * (1 - pct)}
                  style={{ transition: "stroke-dashoffset 200ms linear" }}
                />
              </svg>
              <span className="absolute inset-0 flex items-center justify-center font-mono text-[12px] font-600 tabular">
                {o.pendingRemaining}
              </span>
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-display text-[17px] font-800 tracking-tight text-[var(--color-ink)]">
                  Permission chahiye
                </h2>
                <span
                  className="rounded-full px-2.5 py-[3px] font-mono text-[10px] font-600 uppercase tracking-[0.08em]"
                  style={{
                    color: risk.fg,
                    backgroundColor: risk.bg,
                    boxShadow: `inset 0 0 0 1px ${risk.border}`,
                  }}
                >
                  {risk.icon} {risk.label}
                </span>
              </div>
              <p className="mt-1 text-[12.5px] leading-snug text-[var(--color-muted)]">{risk.blurb}</p>
            </div>
          </header>

          <div className="rounded-xl border border-[var(--color-line)] bg-[#100f0c] p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[13px] font-600 text-[#e5a93c]">{req.toolName}</span>
              <button
                onClick={() => setShowRaw((v) => !v)}
                className="font-mono text-[10.5px] text-[var(--color-muted)] underline-offset-2 transition-colors hover:text-[var(--color-ink)] hover:underline"
              >
                {showRaw ? "hide raw" : t("btn_showRaw", o.settings.lang)}
              </button>
            </div>
            <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-[var(--color-ink-2)]">
              {displayArgs || "(no args)"}
            </pre>
            {showRaw && (
              <p className="mt-2 text-[11px] font-500 text-[#fbbf24]">
                ⚠︎ Raw view redaction bypass karta hai. Screen share par mat kholo.
              </p>
            )}
            {req.reason && (
              <p className="mt-2 border-t border-[var(--color-line-soft)] pt-2 text-[11.5px] text-[var(--color-muted)]">
                Classifier: {req.reason}
              </p>
            )}
          </div>

          {needsTyped && (
            <div className="rounded-xl border p-3" style={{ borderColor: risk.border, backgroundColor: risk.bg }}>
              <p className="text-[12px] font-500" style={{ color: risk.fg }}>
                Critical risk — allow karne ke liye exact word <span className="font-mono font-700">ALLOW</span> type
                karo. Voice approval yahan strictly disabled hai.
              </p>
              <input
                autoFocus
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder="ALLOW"
                aria-label="Type ALLOW to confirm"
                className="mt-2 w-full rounded-lg border bg-[#0e0d0b] px-3 py-2 font-mono text-[13px] tracking-[0.18em] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-faint)] focus:shadow-[0_0_0_3px_rgba(244,63,94,0.2)]"
                style={{ borderColor: risk.border }}
              />
            </div>
          )}

          {voiceOK && (
            <div className="rounded-xl border border-[var(--color-line)] bg-[#12100d] p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="gold">spoken confirmation</Badge>
                <span className="text-[11.5px] text-[var(--color-muted)]">
                  Bolo: "haan kar do", "allow", "permission di" ya "nahi ruko", "deny"
                </span>
              </div>
              <div className="mt-2 flex gap-2">
                <button
                  onMouseDown={() => void o.listenForApproval()}
                  onMouseUp={o.stopApprovalListen}
                  onMouseLeave={o.stopApprovalListen}
                  disabled={!o.sttSupported}
                  className="flex shrink-0 items-center gap-1.5 rounded-lg border border-[rgba(229,169,60,0.35)] bg-[rgba(229,169,60,0.14)] px-3 py-2 text-[11.5px] font-600 text-[#f2be5c] transition-all hover:bg-[rgba(229,169,60,0.24)] active:scale-[0.98] disabled:opacity-40"
                  title="Hold and speak decision"
                >
                  🎙 Hold & speak
                </button>
                <input
                  value={o.partial || voiceText}
                  onChange={(e) => setVoiceText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !o.voiceDecide(voiceText)) setVoiceText("");
                  }}
                  placeholder="…ya बोलो / type karo (haan kar do / nahi ruko)"
                  className="min-w-0 flex-1 rounded-lg border border-[var(--color-line)] bg-[#0e0d0b] px-3 py-2 text-[12px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-faint)] focus:border-[#e5a93c]"
                />
                <Button size="sm" onClick={() => !o.voiceDecide(voiceText) && setVoiceText("")}>
                  Apply
                </Button>
              </div>
            </div>
          )}

          {!voiceOK && !needsTyped && (
            <p className="rounded-lg border border-[rgba(245,158,11,0.28)] bg-[var(--color-amber-wash)] px-3 py-2 text-[11.5px] font-500 text-[#fbbf24]">
              ⚠︎ {req.risk} risk — voice approval disabled. Click zaroori hai.
            </p>
          )}

          <footer className="flex items-center gap-2 border-t border-[var(--color-line-soft)] pt-3.5">
            <Button variant="danger" onClick={() => o.resolvePermission("deny", "click")}>
              {t("btn_deny", o.settings.lang)}
            </Button>
            <span className="flex items-center gap-1 text-[10px] text-[var(--color-faint)]">
              <Kbd>Esc</Kbd>
            </span>
            <div className="ml-auto flex gap-2">
              <Button
                variant="outline"
                disabled={!typedOK || req.risk === "critical"}
                onClick={() => o.resolvePermission("allowSession", "click")}
                title={
                  req.risk === "critical"
                    ? "Critical tools can never be session-allowlisted"
                    : "Allow this tool for the rest of the session"
                }
              >
                {t("btn_allowSession", o.settings.lang)}
              </Button>
              <Button
                variant="primary"
                disabled={!typedOK}
                onClick={() => o.resolvePermission("allowOnce", "click", needsTyped ? typed.trim() : null)}
              >
                {t("btn_allowOnce", o.settings.lang)}
              </Button>
              <span className="flex items-center gap-1 text-[10px] text-[var(--color-faint)]">
                <Kbd>↵</Kbd>
              </span>
            </div>
          </footer>
          <p className={cn("-mt-1 text-[11px] text-[var(--color-faint)]", needsTyped && "text-[#fb7185]")}>
            {needsTyped
              ? "Bridge typed-confirm ko server pe dobara validate karta hai — client pe bharosa nahi."
              : "Koi jawab nahi = auto-deny. Har decision audit log me jaata hai, redacted."}
          </p>
        </div>
      </div>
    </div>
  );
}
