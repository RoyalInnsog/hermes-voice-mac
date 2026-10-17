import { useState } from "react";
import type { Orchestrator } from "../hooks/useHermesVoice";
import { Badge, Button, NumberField, Panel, Row, SectionTitle, Select, Slider, TextField, Toggle, Kbd } from "./ui";
import { cn } from "../utils/cn";

const TABS = ["General", "Voice", "Agent", "Router", "Permissions", "Privacy", "About"] as const;
type Tab = (typeof TABS)[number];

export function SettingsPanel({ o }: { o: Orchestrator }) {
  const [tab, setTab] = useState<Tab>("Voice");
  const [probing, setProbing] = useState(false);
  const s = o.settings;
  const h = o.backend.health;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 md:flex-row">
      <nav className="flex shrink-0 gap-1 overflow-x-auto md:w-[144px] md:flex-col">
        {TABS.map((x) => (
          <button
            key={x}
            onClick={() => setTab(x)}
            className={cn(
              "shrink-0 rounded-lg px-3 py-2 text-left text-[12.5px] font-500 transition-all",
              tab === x
                ? "bg-[var(--color-panel-2)] text-[var(--color-gold-bright)] ring-1 ring-[rgba(229,169,60,0.4)]"
                : "text-[var(--color-muted)] hover:bg-[var(--color-sunken)] hover:text-[var(--color-ink)]",
            )}
          >
            {x}
          </button>
        ))}
      </nav>

      <div className="min-w-0 flex-1 space-y-4 overflow-y-auto pr-1">
        {tab === "General" && (
          <Panel className="p-4">
            <SectionTitle hint="persisted locally">General</SectionTitle>
            <Row label="Language" hint="UI + spoken copy. Logs aur code identifiers English hi rahenge.">
              <Select
                value={s.lang}
                onChange={(v) => o.update("lang", v)}
                options={[
                  { value: "hinglish", label: "Hinglish (default)" },
                  { value: "english", label: "English" },
                ]}
              />
            </Row>
            <Row label="Push-to-talk / Toggle HUD" hint="Global hotkey in Hermes Voice.app (Carbon RegisterEventHotKey + Accessibility check) and window-scoped in browser.">
              <span className="flex gap-1">
                <Kbd>⌥</Kbd>
                <Kbd>Space</Kbd>
              </span>
            </Row>
            <Row label="Repeat last answer" hint="Aakhri spoken report dobara sunata hai.">
              <span className="flex gap-1">
                <Kbd>⌥</Kbd>
                <Kbd>⇧</Kbd>
                <Kbd>Space</Kbd>
              </span>
            </Row>
            <Row label="Cancel current task" hint="Har busy state me kaam karta hai — bridge pe DELETE + process-group SIGTERM bhejta hai.">
              <span className="flex gap-1">
                <Kbd>⌥</Kbd>
                <Kbd>⌘</Kbd>
                <Kbd>Space</Kbd>
              </span>
            </Row>
            <Row label="Overlay auto-hide" hint="Idle ke baad overlay dim hone ka wait.">
              <NumberField value={s.overlayAutoHideSec} min={0} max={60} onChange={(v) => o.update("overlayAutoHideSec", v)} suffix="s" />
            </Row>
            <Row label="Speak 'Ready' on launch" hint="Noise se bachne ke liye default off.">
              <Toggle value={s.startupChime} onChange={(v) => o.update("startupChime", v)} label="Startup chime" />
            </Row>
            <Row label="macOS Floating Wrapper" hint="Hermes Voice.app bundle (Swift WKWebView) + scripts/launch-hud.mjs runner included.">
              <Badge tone="gold" dot>v1.0 bundled</Badge>
            </Row>
          </Panel>
        )}

        {tab === "Voice" && (
          <>
            <Panel className="p-4">
              <SectionTitle hint="speech → text (1.8s silence auto-stop)">Speech to Text (STT)</SectionTitle>
              <Row label="STT locale" hint="en-IN Hinglish ke liye sabse behtar; auto-fallback to en-US / hi-IN.">
                <Select
                  value={s.sttLocale}
                  onChange={(v) => o.update("sttLocale", v)}
                  options={[
                    { value: "en-IN", label: "en-IN (Hinglish optimal)" },
                    { value: "hi-IN", label: "hi-IN (Hindi)" },
                    { value: "en-US", label: "en-US (English)" },
                  ]}
                />
              </Row>
              <Row label="On-device recognition" hint="Prefers local recognition where available.">
                <Toggle value={s.onDeviceSTT} onChange={(v) => o.update("onDeviceSTT", v)} label="On-device STT" />
              </Row>
              <Row label="Confidence threshold" hint="Isse neeche → 'Maine suna: …. Bhejoon?' confirmation flow.">
                <Slider value={s.confidenceThreshold} onChange={(v) => o.update("confidenceThreshold", v)} min={0} max={1} step={0.05} />
              </Row>
              <Row label="Engine status" hint="Web Speech API + 1.8s post-speech silence detector.">
                {o.sttSupported ? <Badge tone="green" dot>available</Badge> : <Badge tone="rose" dot>unsupported</Badge>}
              </Row>
            </Panel>

            <Panel className="p-4">
              <SectionTitle hint="edge-tts primary, macOS say fallback">Text to Speech (TTS)</SectionTitle>
              <Row label="Voice engine" hint="Edge TTS = free unlimited neural voice (hi-IN-MadhurNeural / en-IN-NeerjaNeural) via verified Python venv.">
                <Select
                  value={s.ttsEngine}
                  onChange={(v) => o.update("ttsEngine", v)}
                  options={[
                    { value: "edgeTTS", label: "Edge TTS (Python venv · cached)" },
                    { value: "webSpeech", label: "System voice (browser)" },
                    { value: "apple", label: "macOS say (-v Rishi)" },
                    { value: "gemini", label: "Gemini TTS (10/day cap, disabled)" },
                  ]}
                />
              </Row>
              <Row label="Prefer bridge audio" hint="ON = synthesize via local bridge with SHA-256 disk caching + instant barge-in.">
                <Toggle value={s.useBridgeTTS} onChange={(v) => o.update("useBridgeTTS", v)} label="Prefer bridge TTS" />
              </Row>
              <div className="panel-flat mt-1 mb-3 px-3 py-2.5 text-[11.5px] leading-relaxed text-[var(--color-ink-2)]">
                <div>
                  Bridge TTS capability:{" "}
                  <span className="font-mono text-[var(--color-gold-bright)]">
                    edge={String(h?.tts.engines.edge.available ?? "?")} · say={String(h?.tts.engines.say.available ?? "?")} · cache={String(h?.tts.cacheFiles ?? 0)} files
                  </span>
                </div>
                <div className="mt-1 font-mono text-[10.5px] text-[var(--color-muted)]">
                  Python: {h?.python?.bin ?? h?.tts.engines.edge.pythonBin ?? "bridge offline — run npm start"}
                </div>
              </div>
              <Row label="Browser fallback voice" hint="Used if bridge is unreachable.">
                <Select
                  value={s.ttsVoiceURI ?? ""}
                  onChange={(v) => o.update("ttsVoiceURI", v || null)}
                  options={[{ value: "", label: "System default" }, ...o.voices.map((v) => ({ value: v.voiceURI, label: `${v.name} (${v.lang})` }))]}
                  className="max-w-[230px]"
                />
              </Row>
              <Row label="Rate">
                <Slider value={s.ttsRate} onChange={(v) => o.update("ttsRate", v)} min={0.5} max={2} step={0.05} />
              </Row>
              <Row label="Pitch">
                <Slider value={s.ttsPitch} onChange={(v) => o.update("ttsPitch", v)} min={0} max={2} step={0.05} />
              </Row>
              <Row label="Volume">
                <Slider value={s.ttsVolume} onChange={(v) => o.update("ttsVolume", v)} min={0} max={1} step={0.05} />
              </Row>
              <Row label="Speak progress events" hint="Low priority — permission prompt or user barge-in interrupts immediately.">
                <Toggle value={s.speakProgress} onChange={(v) => o.update("speakProgress", v)} label="Speak progress" />
              </Row>
            </Panel>
          </>
        )}

        {tab === "Agent" && (
          <>
            <Panel className="p-4">
              <SectionTitle hint="stream-json + HV_* adapter">Agent Bridge</SectionTitle>
              <Row label="Bridge mode" hint="local = real Node bridge spawning hermes chat -q <query> --format stream-json.">
                <Select
                  value={s.bridgeMode}
                  onChange={(v) => o.update("bridgeMode", v)}
                  options={[
                    { value: "local", label: "Local bridge (real Hermes)" },
                    { value: "mock", label: "Mock Hermes (simulator)" },
                    { value: "subprocess", label: "hermes CLI (native)" },
                    { value: "http", label: "Hermes HTTP/ACP" },
                  ]}
                />
              </Row>
              <div
                className={cn(
                  "mt-2 rounded-xl border px-3 py-2.5 text-[11.5px] leading-relaxed",
                  o.bridgeStatus.ok
                    ? "border-[rgba(34,197,94,0.3)] bg-[var(--color-pine-wash)] text-[#4ade80]"
                    : "border-[rgba(245,158,11,0.3)] bg-[var(--color-amber-wash)] text-[#fbbf24]",
                )}
              >
                <span className="font-mono font-600">{o.bridgeLabel}</span> — {o.bridgeStatus.ok ? "ready" : o.bridgeStatus.reason}
              </div>
              <Row label="Bridge URL" hint="Loopback-only HTTP/SSE server (127.0.0.1:20130).">
                <TextField mono value={s.bridgeURL} onChange={(v) => o.update("bridgeURL", v)} className="w-[250px]" />
              </Row>
              <Row label="Hermes binary path" hint="Auto-discovered at /Users/apple/.hermes/hermes-agent/.hermes/bin/hermes or ~/.local/bin/hermes.">
                <TextField mono value={s.hermesPath} onChange={(v) => o.update("hermesPath", v)} className="w-[250px]" />
              </Row>
              <Row label="Working directory" hint="Hermes spawns here so config.yaml is loaded.">
                <TextField mono value={s.hermesWorkingDir} onChange={(v) => o.update("hermesWorkingDir", v)} className="w-[250px]" />
              </Row>
              <Row label="Task timeout" hint="Process-group SIGTERM → 5s → SIGKILL on timeout.">
                <NumberField value={s.hermesTimeoutSec} min={30} max={1800} step={30} onChange={(v) => o.update("hermesTimeoutSec", v)} suffix="s" />
              </Row>
            </Panel>

            <Panel className="p-4">
              <SectionTitle hint={h ? `pid ${h.pid} · uptime ${h.uptimeSec}s` : "bridge offline"}>Live Server Agent Config</SectionTitle>
              {h ? (
                <>
                  <Row label="Resolved command">
                    <span className="max-w-[300px] truncate font-mono text-[11px] text-[var(--color-gold-bright)]">{h.hermes.command.join(" ")}</span>
                  </Row>
                  <Row label="argv template">
                    <span className="max-w-[300px] truncate font-mono text-[11px] text-[var(--color-ink-2)]">{h.hermes.argvTemplate.join(" ")}</span>
                  </Row>
                  <Row label="cwd / timeout">
                    <span className="font-mono text-[11px] text-[var(--color-muted)]">
                      {h.hermes.cwd} · {h.hermes.timeoutSec}s
                    </span>
                  </Row>
                  <Row label="Binary status">
                    {h.hermes.found ? <Badge tone="green" dot>{h.hermes.path}</Badge> : <Badge tone="rose" dot>{h.hermes.detail}</Badge>}
                  </Row>
                </>
              ) : (
                <p className="text-[12px] leading-relaxed text-[var(--color-muted)]">
                  Bridge offline hai. Run <code className="rounded bg-[var(--color-sunken)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--color-gold-bright)]">npm start</code>
                </p>
              )}
            </Panel>

            <Panel className="p-4">
              <SectionTitle hint="read-only, path-jailed">Hermes Memory (~/.hermes/memories)</SectionTitle>
              {o.backend.memory?.available ? (
                <div className="flex flex-wrap gap-1.5">
                  {o.backend.memory.files.slice(0, 24).map((f) => (
                    <button
                      key={f}
                      onClick={() => void o.loadMemoryFile(f)}
                      className="rounded-lg border border-[var(--color-line)] bg-[var(--color-sunken)] px-2.5 py-1 font-mono text-[10.5px] text-[var(--color-ink-2)] transition-colors hover:border-[var(--color-gold)] hover:text-[var(--color-gold-bright)]"
                    >
                      {f}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="font-mono text-[11px] text-[var(--color-faint)]">{o.backend.memory?.note ?? "bridge offline"}</p>
              )}
              {o.backend.memoryText && (
                <pre className="mt-3 max-h-[280px] overflow-auto rounded-xl border border-[var(--color-line)] bg-[var(--color-sunken)] p-3 font-mono text-[11px] leading-relaxed text-[var(--color-ink-2)]">
                  {`# ${o.backend.memoryText.path} (read-only)\n\n${o.backend.memoryText.text}`}
                </pre>
              )}
            </Panel>
          </>
        )}

        {tab === "Router" && (
          <>
            <Panel className="p-4">
              <SectionTitle hint="strict read-only client">OmniRoute Gateway & SQLite Sync</SectionTitle>
              <div className="mb-3 rounded-xl border border-[rgba(229,169,60,0.3)] bg-[var(--color-gold-wash)] px-3 py-2.5 text-[11.5px] leading-relaxed text-[var(--color-gold-bright)]">
                <span className="font-600">STRICT READ-ONLY CONTRACT:</span> Hermes Voice never stops, restarts, or reconfigures OmniRoute, and inspects{" "}
                <span className="font-mono">~/.9router/db/data.sqlite</span> exclusively in read-only mode (`-readonly` / `mode=ro`).
              </div>
              <Row label="Base URL" hint="Proxied via local bridge to avoid CORS.">
                <TextField mono value={s.omnirouteBaseURL} onChange={(v) => o.update("omnirouteBaseURL", v)} className="w-[250px]" />
              </Row>
              <Row label="Health poll interval">
                <NumberField value={s.healthPollSec} min={15} max={600} step={15} onChange={(v) => o.update("healthPollSec", v)} suffix="s" />
              </Row>
              <Row label="Probe model" hint="Non-streaming completion probe model.">
                <TextField mono value={s.probeModel} onChange={(v) => o.update("probeModel", v)} className="w-[250px]" />
              </Row>
              <div className="mt-3 flex gap-2">
                <Button onClick={() => void o.refreshHealth()}>Re-check health</Button>
                <Button
                  variant="primary"
                  disabled={probing}
                  onClick={async () => {
                    setProbing(true);
                    await o.runProbe();
                    setProbing(false);
                  }}
                >
                  {probing ? "Probing…" : "Run chat probe"}
                </Button>
              </div>
            </Panel>

            <Panel className="p-4">
              <SectionTitle hint="HTTP + ~/.9router/db/data.sqlite">Live Router Snapshot</SectionTitle>
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                {[
                  { k: "reachable", v: o.health?.reachable ? "UP" : "DOWN", tone: o.health?.reachable ? "green" : "rose" },
                  { k: "latency", v: o.health?.latencyMs != null ? `${o.health.latencyMs}ms` : "—", tone: "slate" },
                  { k: "models", v: String(o.models.length), tone: "slate" },
                  { k: "combos source", v: o.combos.pathUsed ?? "none", tone: o.combos.pathUsed ? "gold" : "amber" },
                ].map((x) => (
                  <div key={x.k} className="panel-flat px-3 py-2">
                    <div className="label-xs">{x.k}</div>
                    <div
                      className={cn(
                        "mt-0.5 truncate font-mono text-[12px] font-600 tabular",
                        x.tone === "green"
                          ? "text-[#4ade80]"
                          : x.tone === "rose"
                            ? "text-[#f87171]"
                            : x.tone === "gold"
                              ? "text-[var(--color-gold-bright)]"
                              : "text-[var(--color-ink)]",
                      )}
                    >
                      {x.v}
                    </div>
                  </div>
                ))}
              </div>
              {o.combos.combos.length > 0 && (
                <div className="mt-3">
                  <div className="label-xs mb-1.5">Active Combos ({o.combos.combos.length})</div>
                  <div className="flex flex-wrap gap-1.5">
                    {o.combos.combos.map((c) => (
                      <span
                        key={c}
                        className="rounded-md border border-[rgba(229,169,60,0.3)] bg-[var(--color-sunken)] px-2 py-1 font-mono text-[10.5px] text-[var(--color-gold-bright)]"
                      >
                        {c}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {o.probe && (
                <div
                  className={cn(
                    "mt-3 rounded-xl border px-3 py-2.5 font-mono text-[11.5px] leading-relaxed",
                    o.probe.ok
                      ? "border-[rgba(34,197,94,0.3)] bg-[var(--color-pine-wash)] text-[#4ade80]"
                      : "border-[rgba(239,68,68,0.3)] bg-[var(--color-rose-wash)] text-[#f87171]",
                  )}
                >
                  probe {o.probe.model} → {o.probe.ok ? "OK" : "FAIL"} · {o.probe.latencyMs}ms
                  <div className="mt-1 break-all text-[var(--color-ink-2)]">{o.probe.ok ? o.probe.sample || "(empty content)" : o.probe.error}</div>
                </div>
              )}
              {o.models.length > 0 && (
                <div className="mt-3 max-h-[180px] overflow-auto rounded-xl border border-[var(--color-line)] bg-[var(--color-sunken)] p-2.5 font-mono text-[11px] text-[var(--color-ink-2)]">
                  {o.models.map((m) => (
                    <div key={m.id} className="flex justify-between gap-3 py-[1px]">
                      <span>{m.id}</span>
                      <span className="text-[var(--color-faint)]">{m.ownedBy ?? ""}</span>
                    </div>
                  ))}
                </div>
              )}
            </Panel>
          </>
        )}

        {tab === "Permissions" && (
          <Panel className="p-4">
            <SectionTitle hint="direct stdin HV_DECISION · default deny">Tool Permission Policy</SectionTitle>
            <Row label="Auto-approve low-risk" hint="Opt-in. Medium/high/critical never auto-approve (enforced on server).">
              <Toggle value={s.autoApproveLowRisk} onChange={(v) => o.update("autoApproveLowRisk", v)} label="Auto approve low risk" />
            </Row>
            <Row label="Voice approval (low/medium)" hint="Recognizes 'haan kar do', 'allow', 'permission di', 'theek hai' vs 'nahi ruko', 'cancel'.">
              <Toggle value={s.voiceApproval} onChange={(v) => o.update("voiceApproval", v)} label="Voice approval" />
            </Row>
            <Row label="Decision timeout" hint="Unanswered prompt auto-denies and logs timeout-deny in audit.jsonl.">
              <NumberField value={s.permissionTimeoutSec} min={10} max={300} step={5} onChange={(v) => o.update("permissionTimeoutSec", v)} suffix="s" />
            </Row>
            <Row label="Session allowlist" hint="Cleared automatically when session ends.">
              <span className="max-w-[220px] truncate font-mono text-[11px] text-[var(--color-gold-bright)]">{o.sessionAllowlist.join(", ") || "empty"}</span>
            </Row>
            <div className="mt-4 overflow-hidden rounded-xl border border-[var(--color-line)]">
              <table className="w-full text-left text-[11.5px]">
                <thead className="bg-[var(--color-sunken)] text-[var(--color-muted)]">
                  <tr>
                    {["Risk", "Auto", "Voice", "Typed", "Examples"].map((x) => (
                      <th key={x} className="px-3 py-2 font-mono text-[10px] font-600 uppercase tracking-[0.08em]">
                        {x}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[
                    ["low", "opt-in", "yes", "no", "read_file, list_dir, web_fetch", "#4ade80"],
                    ["medium", "never", "yes", "no", "write_file, git_status", "#fbbf24"],
                    ["high", "never", "no (click)", "no", "shell, git_push, delete_file", "#fb923c"],
                    ["critical", "never", "blocked", "ALLOW", "credentials, sudo, rm -rf", "#f87171"],
                  ].map((r) => (
                    <tr key={r[0]} className="border-t border-[var(--color-line-soft)]">
                      <td className="px-3 py-2">
                        <span className="font-mono text-[10.5px] font-600 uppercase" style={{ color: r[5] }}>
                          {r[0]}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-[var(--color-ink-2)]">{r[1]}</td>
                      <td className="px-3 py-2 text-[var(--color-ink-2)]">{r[2]}</td>
                      <td className="px-3 py-2 font-mono text-[var(--color-ink)]">{r[3]}</td>
                      <td className="px-3 py-2 font-mono text-[10.5px] text-[var(--color-muted)]">{r[4]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        )}

        {tab === "Privacy" && (
          <Panel className="p-4">
            <SectionTitle hint="local only">Privacy & Security</SectionTitle>
            <Row label="Redact logs & audit" hint="API keys, Bearer tokens, and secret patterns replaced with [REDACTED].">
              <Toggle value={s.redactLogs} onChange={(v) => o.update("redactLogs", v)} label="Redact logs" />
            </Row>
            <Row label="Save debug audio" hint="Default off. Scratch TTS cache auto-prunes after 24h.">
              <Toggle value={s.saveDebugAudio} onChange={(v) => o.update("saveDebugAudio", v)} label="Save debug audio" />
            </Row>
            <Row label="Bridge network exposure" hint="Binds strictly to 127.0.0.1 and rejects non-loopback peers with HTTP 403.">
              <Badge tone="green" dot>loopback only</Badge>
            </Row>
            <div className="mt-4 flex gap-2">
              <Button variant="danger" onClick={o.clearSessions}>
                Delete local sessions
              </Button>
              <Button variant="danger" onClick={o.clearAuditLog}>
                Clear local audit
              </Button>
            </div>
          </Panel>
        )}

        {tab === "About" && (
          <Panel className="p-4">
            <SectionTitle>About Hermes Voice</SectionTitle>
            <Row label="Product">
              <span className="text-[12.5px] font-500 text-[var(--color-ink)]">Hermes Voice — macOS Voice Front-End for Hermes Agent</span>
            </Row>
            <Row label="Version">
              <span className="font-mono text-[12px] text-[var(--color-gold-bright)]">1.0.0 {h ? `· bridge v${h.version}` : ""}</span>
            </Row>
            <Row label="Runtime">
              <span className="font-mono text-[11px] text-[var(--color-ink-2)]">{h?.python?.bin ?? "/Users/apple/.hermes/hermes-agent/venv/bin/python"}</span>
            </Row>
            <Row label="Cost">
              <Badge tone="gold" dot>$0 / ₹0 — 100% Free Local & Edge Neural Stack</Badge>
            </Row>
          </Panel>
        )}
      </div>
    </div>
  );
}
