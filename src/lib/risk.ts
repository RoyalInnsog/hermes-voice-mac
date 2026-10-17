// Section 30 — Permission risk classification matrix.
// Conservative by design: unknown tool => "high".

import type { RiskLevel } from "./types";

interface Rule {
  match: RegExp;
  risk: RiskLevel;
  note: string;
}

const RULES: Rule[] = [
  { match: /^(read_file|read|cat_file|view_file|list_dir|list_files|glob|grep|web_fetch|http_get|search)$/i, risk: "low", note: "read-only" },
  { match: /^(write_file|edit_file|create_file|append_file|patch)$/i, risk: "medium", note: "write inside project" },
  { match: /^(git_status|git_diff|git_log|shell_read)$/i, risk: "medium", note: "read-only shell/git" },
  { match: /^(shell|bash|exec|run_command|terminal)$/i, risk: "high", note: "arbitrary shell" },
  { match: /^(git_push|git_commit|git_reset)$/i, risk: "high", note: "repo mutation" },
  { match: /^(http_post|http_put|network_write|api_call)$/i, risk: "high", note: "network write" },
  { match: /^(delete_file|rm|move_file|rename)$/i, risk: "high", note: "destructive inside project" },
  { match: /^(keychain|read_credentials|env_secrets|credential.*)$/i, risk: "critical", note: "credential access" },
  { match: /^(sudo|system_modify|launchctl|install_pkg|defaults_write)$/i, risk: "critical", note: "system modification" },
  { match: /^(rm_rf|delete_outside_project|format_disk)$/i, risk: "critical", note: "destructive outside project" },
];

const DANGEROUS_ARG = /(\brm\s+-rf\b|\bsudo\b|~\/\.ssh|\.aws\/credentials|\bkeychain\b|\/etc\/|--force\b|\bcurl\b[^|]*\|\s*(ba)?sh)/i;

export function classifyRisk(toolName: string, args: Record<string, string> = {}): { risk: RiskLevel; note: string } {
  let base: { risk: RiskLevel; note: string } = { risk: "high", note: "unknown tool — conservative default" };
  for (const r of RULES) {
    if (r.match.test(toolName)) {
      base = { risk: r.risk, note: r.note };
      break;
    }
  }
  const joined = Object.values(args).join(" ");
  if (DANGEROUS_ARG.test(joined)) {
    return { risk: "critical", note: `${base.note} + dangerous argument pattern` };
  }
  // Writes/deletes that escape the working dir get escalated.
  if (/(^|\s)(\/|~\/)(?!Users\/apple\/Documents\/Projects)/.test(joined) && (base.risk === "medium" || base.risk === "high")) {
    if (/delete|rm|write|edit/i.test(toolName)) {
      return { risk: "critical", note: `${base.note} + path outside project` };
    }
  }
  return base;
}

export const RISK_ORDER: RiskLevel[] = ["low", "medium", "high", "critical"];

export function canAutoApprove(risk: RiskLevel, autoApproveLowRisk: boolean): boolean {
  return autoApproveLowRisk && risk === "low";
}

export function allowsVoiceApproval(risk: RiskLevel): boolean {
  return risk === "low" || risk === "medium";
}

export function requiresTypedConfirm(risk: RiskLevel): boolean {
  return risk === "critical";
}

export const RISK_STYLE: Record<RiskLevel, { bg: string; text: string; ring: string; dot: string; label: string; icon: string }> = {
  low: { bg: "bg-emerald-500/10", text: "text-emerald-300", ring: "ring-emerald-500/30", dot: "bg-emerald-400", label: "LOW", icon: "○" },
  medium: { bg: "bg-amber-500/10", text: "text-amber-300", ring: "ring-amber-500/30", dot: "bg-amber-400", label: "MEDIUM", icon: "◐" },
  high: { bg: "bg-orange-500/10", text: "text-orange-300", ring: "ring-orange-500/30", dot: "bg-orange-400", label: "HIGH", icon: "◆" },
  critical: { bg: "bg-rose-500/10", text: "text-rose-300", ring: "ring-rose-500/30", dot: "bg-rose-400", label: "CRITICAL", icon: "✖" },
};
