// server/risk.mjs — permission risk matrix (spec §30), mirrored from src/lib/risk.ts.
// Conservative: unknown tool => high. Dangerous args escalate to critical.

const RULES = [
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

export function classifyRisk(toolName, args = {}) {
  let base = { risk: "high", note: "unknown tool — conservative default" };
  for (const r of RULES) {
    if (r.match.test(toolName)) {
      base = { risk: r.risk, note: r.note };
      break;
    }
  }
  const joined = Object.values(args).join(" ");
  if (DANGEROUS_ARG.test(joined)) return { risk: "critical", note: `${base.note} + dangerous argument pattern` };
  if (/(^|\s)(\/|~\/)(?!Users\/apple\/Documents\/Projects)/.test(joined) && /delete|rm|write|edit/i.test(toolName) && base.risk !== "low") {
    return { risk: "critical", note: `${base.note} + path outside project` };
  }
  return base;
}

export const canAutoApprove = (risk, optIn) => Boolean(optIn) && risk === "low";
export const allowsVoiceApproval = (risk) => risk === "low" || risk === "medium";
export const requiresTypedConfirm = (risk) => risk === "critical";
