import { useEffect, useState } from "react";
import type { Orchestrator } from "../hooks/useHermesVoice";
import { allowsVoiceApproval, requiresTypedConfirm } from "../lib/risk";
import { formatArgs, redactArgs } from "../lib/redactor";
import { t } from "../lib/strings";
import type { RiskLevel } from "../lib/types";
import { Badge, Button, Kbd } from "./ui";
import { cn } from "../utils/cn";

const RISK: Record<RiskLevel, { label: string; fg: string; bg: string; border: string; icon: string; blurb: string }> = {
  low: { label: "LOW", fg: "#0b6b60", bg: "var(--color-pine-wash)", border: "rgba(11,107,96,0.24)", icon: "○", blurb: "Read-only kaam. Auto-approve sirf tab jab tumne opt-in kiya ho." },
  medium: { label: "MEDIUM", fg: "#a9650a", bg: "var(--color-amber-wash)", border: "rgba(169,101,10,0.26)", icon: "◐", blurb: "Project ke andar write. Approval zaroori, voice allowed." },
  high: { label: "HIGH", fg: "#b4441a", bg: "#fbe9e0", border: "rgba(180,68,26,0.26)", icon: "◆", blurb: "Shell / git push / delete. Voice approval blocked — click karo." },
  critical: { label: "CRITICAL", fg: "#ac2340", bg: "var(--color-rose-wash)", border: "rgba(172,35,64,0.3)", icon: "✖", blurb: "Credentials ya system change. Typed ALLOW ke bina kuch nahi hoga." },
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
  const total = Math.max(1, Math.round((req.expiresAt - req.requestedAt || o.settings.permissionTimeoutSec * 1000) / 1000));
  const pct = Math.max(0, Math.min(1, o.pendingRemaining / total));
  const displayArgs = showRaw ? formatArgs(req.args) : formatArgs(redactArgs(req.args));
  const R = 20;
  const C = 2 * Math.PI * R;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(15,19,25,0.42)] p-4 backdrop-blur-[2px]">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Permission request for ${req.toolName}`}
        onKeyDown={(e) => {
          if (e.key === "Escape") o.resolvePermission("deny", "click");
          if (e.key === "Enter" && typedOK) o.resolvePermission("allowOnce", "click", needsTyped ? typed.trim() : null);
        }}
        className="rise w-full max-w-[520px] overflow-hidden rounded-2xl bg-white shadow-[0_40px_90px_-24px_rgba(15,19,25,0.55)] ring-1 ring-[var(--color-line)]"
      >
        <div className="h-[3px] w-full bg-[var(--color-line-soft)]">
          <div className="h-full transition-[width] duration-200" style={{ width: `${pct * 100}%`, backgroundColor: req.risk === "critical" ? "#ac2340" : "#a9650a" }} />
        </div>

        <div className="space-y-4 p-5">
          <header className="flex items-start gap-3.5">
            <div className="relative h-11 w-11 shrink-0" style={{ color: risk.fg }}>
              <svg viewBox="0 0 44 44" className="absolute inset-0 -rotate-90">
                <circle cx="22" cy="22" r={R} fill="none" stroke="#eaeef4" strokeWidth="3" />
                <circle cx="22" cy="22" r={R} fill="none" stroke={risk.fg} strokeWidth="3" strokeLinecap="round" strokeDasharray={C} strokeDashoffset={C * (1 - pct)} style={{ transition: "stroke-dashoffset 200ms linear" }} />
              </svg>
              <span className="absolute inset-0 flex items-center justify-center font-mono text-[12px] font-600 tabular">{o.pendingRemaining}</span>
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-display text-[17px] font-800 tracking-tight text-[var(--color-ink)]">Permission chahiye</h2>
                <span className="rounded-full px-2 py-[3px] font-mono text-[10px] font-600 uppercase tracking-[0.08em] ring-1" style={{ color: risk.fg, backgroundColor: risk.bg, borderColor: risk.border, boxShadow: `inset 0 0 0 1px ${risk.border}` }}>
                  {risk.icon} {risk.label}
                </span>
              </div>
              <p className="mt-1 text-[12.5px] leading-snug text-[var(--color-muted)]">{risk.blurb}</p>
            </div>
          </header>

          <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-sunken)] p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[13px] font-600 text-[var(--color-indigo-ink)]">{req.toolName}</span>
              <button onClick={() => setShowRaw((v) => !v)} className="font-mono text-[10.5px] text-[var(--color-muted)] underline-offset-2 transition-colors hover:text-[var(--color-ink)] hover:underline">
                {showRaw ? "hide raw" : t("btn_showRaw", o.settings.lang)}
              </button>
            </div>
            <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-[var(--color-ink-2)]">{displayArgs || "(no args)"}</pre>
            {showRaw && <p className="mt-2 text-[11px] font-500 text-[var(--color-amber)]">⚠︎ Raw view redaction bypass karta hai. Screen share par mat kholo.</p>}
            {req.reason && <p className="mt-2 border-t border-[var(--color-line-soft)] pt-2 text-[11.5px] text-[var(--color-muted)]">Classifier: {req.reason}</p>}
          </div>

          {needsTyped && (
            <div className="rounded-xl border p-3" style={{ borderColor: risk.border, backgroundColor: risk.bg }}>
              <p className="text-[12px] font-500" style={{ color: risk.fg }}>
                Critical risk — allow karne ke liye <span className="font-mono font-600">ALLOW</span> type karo. Voice approval yahan blocked hai.
              </p>
              <input
                autoFocus
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder="ALLOW"
                aria-label="Type ALLOW to confirm"
                className="mt-2 w-full rounded-lg border bg-white px-3 py-2 font-mono text-[13px] tracking-[0.18em] text-[var(--color-ink)] outline-none placeholder:text-[rgba(15,19,25,0.25)] focus:shadow-[0_0_0_3px_rgba(172,35,64,0.12)]"
                style={{ borderColor: risk.border }}
              />
            </div>
          )}

          {voiceOK && (
            <div className="rounded-xl border border-[var(--color-line)] bg-white p-3">
              <div className="flex items-center gap-2">
                <Badge tone="pine">voice approval</Badge>
                <span className="text-[11.5px] text-[var(--color-muted)]">"{req.risk}" risk pe allowed — haan/allow ya nahi/deny</span>
              </div>
              <div className="mt-2 flex gap-2">
                <button
                  onMouseDown={() => void o.listenForApproval()}
                  onMouseUp={o.stopApprovalListen}
                  onMouseLeave={o.stopApprovalListen}
                  disabled={!o.sttSupported}
                  className="flex shrink-0 items-center gap-1.5 rounded-lg border border-[rgba(11,107,96,0.3)] bg-[var(--color-pine-wash)] px-3 py-2 text-[11.5px] font-600 text-[var(--color-pine)] transition-all hover:bg-[#d5ebe7] active:scale-[0.98] disabled:opacity-40"
                  title="Hold and speak"
                >
                  🎙 Hold & answer
                </button>
                <input
                  value={o.partial || voiceText}
                  onChange={(e) => setVoiceText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !o.voiceDecide(voiceText)) setVoiceText("");
                  }}
                  placeholder="…ya reply type karo (haan / nahi)"
                  className="min-w-0 flex-1 rounded-lg border border-[var(--color-line)] bg-white px-3 py-2 text-[12px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-faint)] focus:border-[var(--color-pine-bright)]"
                />
                <Button size="sm" onClick={() => !o.voiceDecide(voiceText) && setVoiceText("")}>
                  Apply
                </Button>
              </div>
            </div>
          )}

          {!voiceOK && !needsTyped && (
            <p className="rounded-lg bg-[var(--color-amber-wash)] px-3 py-2 text-[11.5px] font-500 text-[var(--color-amber)]">
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
                title={req.risk === "critical" ? "Critical tools can never be session-allowlisted" : "Allow this tool for the rest of the session"}
              >
                {t("btn_allowSession", o.settings.lang)}
              </Button>
              <Button variant="primary" disabled={!typedOK} onClick={() => o.resolvePermission("allowOnce", "click", needsTyped ? typed.trim() : null)}>
                {t("btn_allowOnce", o.settings.lang)}
              </Button>
              <span className="flex items-center gap-1 text-[10px] text-[var(--color-faint)]">
                <Kbd>↵</Kbd>
              </span>
            </div>
          </footer>
          <p className={cn("-mt-1 text-[11px] text-[var(--color-faint)]", needsTyped && "text-[var(--color-rose)]")}>
            {needsTyped ? "Bridge typed-confirm ko server pe dobara validate karta hai — client pe bharosa nahi." : "Koi jawab nahi = auto-deny. Har decision audit log me jaata hai, redacted."}
          </p>
        </div>
      </div>
    </div>
  );
}
