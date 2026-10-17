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
    <div className="flex min-h-0 flex-1 gap-4">
      <nav className="w-[136px] shrink-0 space-y-0.5">
        {TABS.map((x) => (
          <button
            key={x}
            onClick={() => setTab(x)}
            className={cn(
              "w-full rounded-lg px-3 py-2 text-left text-[12.5px] font-500 transition-all",
              tab === x ? "bg-white text-[var(--color-pine)] shadow-[0_1px_3px_rgba(15,19,25,0.08)] ring-1 ring-[var(--color-line)]" : "text-[var(--color-muted)] hover:bg-white/60 hover:text-[var(--color-ink-2)]",
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
            <Row label="Push-to-talk" hint="Hold karke bolo; release = send. Native build me global hotkey, yahan window-scoped.">
              <span className="flex gap-1">
                <Kbd>⌥</Kbd>
                <Kbd>Space</Kbd>
              </span>
            </Row>
            <Row label="Repeat last answer" hint="Aakhri report dobara bolta hai.">
              <span className="flex gap-1">
                <Kbd>⌥</Kbd>
                <Kbd>⇧</Kbd>
                <Kbd>Space</Kbd>
              </span>
            </Row>
            <Row label="Cancel current task" hint="Har busy state me kaam karta hai — bridge pe DELETE bhi jaata hai.">
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
            <Row label="Launch at login" hint="SMAppService native build me — browser se possible nahi (LIMITATIONS L-5).">
              <Badge tone="amber">native only</Badge>
            </Row>
          </Panel>
        )}

        {tab === "Voice" && (
          <>
            <Panel className="p-4">
              <SectionTitle hint="speech → text">Speech to text</SectionTitle>
              <Row label="STT locale" hint="en-IN Hinglish ke liye sabse behtar; hi-IN pure Hindi ke liye better, English words ke liye worse.">
                <Select
                  value={s.sttLocale}
                  onChange={(v) => o.update("sttLocale", v)}
                  options={[
                    { value: "en-IN", label: "en-IN (default)" },
                    { value: "hi-IN", label: "hi-IN" },
                    { value: "en-US", label: "en-US" },
                  ]}
                />
              </Row>
              <Row label="On-device recognition" hint="Native build: requiresOnDeviceRecognition. Browser STT cloud pe ja sakta hai — Privacy tab dekho.">
                <Toggle value={s.onDeviceSTT} onChange={(v) => o.update("onDeviceSTT", v)} label="On-device STT" />
              </Row>
              <Row label="Confidence threshold" hint="Isse neeche → 'Maine suna: …. Bhejoon?' confirmation flow.">
                <Slider value={s.confidenceThreshold} onChange={(v) => o.update("confidenceThreshold", v)} min={0} max={1} step={0.05} />
              </Row>
              <Row label="Engine status" hint="Is runtime me SpeechRecognition API available hai ya nahi.">
                {o.sttSupported ? <Badge tone="green" dot>available</Badge> : <Badge tone="rose" dot>unsupported</Badge>}
              </Row>
            </Panel>

            <Panel className="p-4">
              <SectionTitle hint="edge-tts primary, system voice fallback">Text to speech</SectionTitle>
              <Row label="Voice engine" hint="Edge TTS = free unlimited (hi-IN-MadhurNeural). Gemini TTS ~10 req/day/key cap ki wajah se deliberately wire nahi kiya.">
                <Select
                  value={s.ttsEngine}
                  onChange={(v) => o.update("ttsEngine", v)}
                  options={[
                    { value: "webSpeech", label: "System voice (browser)" },
                    { value: "edgeTTS", label: "Edge TTS (via bridge)" },
                    { value: "apple", label: "AVSpeech (native only)" },
                    { value: "gemini", label: "Gemini TTS (capped, unwired)" },
                  ]}
                />
              </Row>
              <Row label="Prefer bridge audio" hint="ON = pehle bridge ka edge-tts audio try karo, fail ho to system voice. OFF = sirf browser voice.">
                <Toggle value={s.useBridgeTTS} onChange={(v) => o.update("useBridgeTTS", v)} label="Prefer bridge TTS" />
              </Row>
              <div className="panel-flat mt-1 mb-3 px-3 py-2 text-[11.5px] leading-relaxed text-[var(--color-ink-2)]">
                Bridge pe detect hua:{" "}
                <span className="font-mono">
                  edge={String(h?.tts.engines.edge.available ?? "?")} · say={String(h?.tts.engines.say.available ?? "?")} · gemini={String(h?.tts.engines.gemini.available ?? "false")}
                </span>
                <div className="mt-1 font-mono text-[10.5px] text-[var(--color-muted)]">{h?.tts.engines.edge.detail ?? "bridge offline — start: node server/index.mjs"}</div>
              </div>
              <Row label="Browser voice" hint="System voice fallback ke liye. Indian English/Hindi voice ho to wahi chuno.">
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
              <Row label="Speak progress events" hint="Low priority — permission prompt inhe interrupt kar deta hai.">
                <Toggle value={s.speakProgress} onChange={(v) => o.update("speakProgress", v)} label="Speak progress" />
              </Row>
            </Panel>
          </>
        )}

        {tab === "Agent" && (
          <>
            <Panel className="p-4">
              <SectionTitle hint="adapter boundary">Agent bridge</SectionTitle>
              <Row label="Bridge mode" hint="local = real Node bridge (hermes spawn + SSE). mock = local simulator. subprocess/http = native-only paths.">
                <Select
                  value={s.bridgeMode}
                  onChange={(v) => o.update("bridgeMode", v)}
                  options={[
                    { value: "local", label: "Local bridge (real)" },
                    { value: "mock", label: "Mock Hermes (simulator)" },
                    { value: "subprocess", label: "hermes CLI (native app only)" },
                    { value: "http", label: "Hermes HTTP/ACP (unverified)" },
                  ]}
                />
              </Row>
              <div className={cn("mt-2 rounded-xl border px-3 py-2.5 text-[11.5px] leading-relaxed", o.bridgeStatus.ok ? "border-[rgba(11,107,96,0.25)] bg-[var(--color-pine-wash)] text-[var(--color-pine)]" : "border-[rgba(169,101,10,0.28)] bg-[var(--color-amber-wash)] text-[var(--color-amber)]")}>
                <span className="font-mono font-600">{o.bridgeLabel}</span> — {o.bridgeStatus.ok ? "available" : o.bridgeStatus.reason}
              </div>
              <Row label="Bridge URL" hint="Node bridge kahan chal raha hai. Loopback only — server bhi non-loopback peer reject karta hai.">
                <TextField mono value={s.bridgeURL} onChange={(v) => o.update("bridgeURL", v)} className="w-[250px]" />
              </Row>
              <Row label="Hermes binary path" hint="Native build ke liye. Bridge apna command ~/.hermes-voice/config.json se padhta hai.">
                <TextField mono value={s.hermesPath} onChange={(v) => o.update("hermesPath", v)} className="w-[250px]" />
              </Row>
              <Row label="Working directory" hint="Hermes yahan spawn hota hai taaki config.yaml mile.">
                <TextField mono value={s.hermesWorkingDir} onChange={(v) => o.update("hermesWorkingDir", v)} className="w-[250px]" />
              </Row>
              <Row label="Task timeout" hint="Iske baad process kill + hermesTimeout report.">
                <NumberField value={s.hermesTimeoutSec} min={30} max={1800} step={30} onChange={(v) => o.update("hermesTimeoutSec", v)} suffix="s" />
              </Row>
              <Row label="HTTP bridge base URL" hint="Sirf tab jab Hermes ka server mode exist kare. TODO-VERIFY.">
                <TextField mono value={s.httpBridgeBaseURL} onChange={(v) => o.update("httpBridgeBaseURL", v)} className="w-[250px]" />
              </Row>
            </Panel>

            <Panel className="p-4">
              <SectionTitle hint={h ? `pid ${h.pid} · uptime ${h.uptimeSec}s` : "bridge offline"}>Bridge pe agent config (live)</SectionTitle>
              {h ? (
                <>
                  <Row label="Resolved command">
                    <span className="max-w-[300px] truncate font-mono text-[11px] text-[var(--color-ink-2)]">{h.hermes.command.join(" ")}</span>
                  </Row>
                  <Row label="argv template" hint="TODO-VERIFY against `hermes chat --help`.">
                    <span className="max-w-[300px] truncate font-mono text-[11px] text-[var(--color-ink-2)]">{h.hermes.argvTemplate.join(" ")}</span>
                  </Row>
                  <Row label="cwd / timeout">
                    <span className="font-mono text-[11px] text-[var(--color-muted)]">{h.hermes.cwd} · {h.hermes.timeoutSec}s</span>
                  </Row>
                  <Row label="Binary found">
                    {h.hermes.found ? <Badge tone="green" dot>{h.hermes.path}</Badge> : <Badge tone="rose" dot>{h.hermes.detail}</Badge>}
                  </Row>
                  <Row label="Data dir">
                    <span className="font-mono text-[11px] text-[var(--color-muted)]">{h.dataDir}</span>
                  </Row>
                </>
              ) : (
                <p className="text-[12px] leading-relaxed text-[var(--color-muted)]">
                  Bridge offline hai, isliye live config nahi dikh raha. Terminal me chalao: <code className="rounded bg-[var(--color-sunken)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--color-ink-2)]">node server/index.mjs</code>
                </p>
              )}
            </Panel>

            <Panel className="p-4">
              <SectionTitle hint="read-only, never written">Hermes memory</SectionTitle>
              <p className="mb-2.5 text-[11.5px] leading-relaxed text-[var(--color-muted)]">
                ~/.hermes/memories ke files bridge ke through read-only dikhte hain. Path jail laga hua hai — traversal pe HTTP 400.
              </p>
              {o.backend.memory?.available ? (
                <div className="flex flex-wrap gap-1.5">
                  {o.backend.memory.files.slice(0, 24).map((f) => (
                    <button key={f} onClick={() => void o.loadMemoryFile(f)} className="rounded-full border border-[var(--color-line)] bg-white px-2.5 py-1 font-mono text-[10.5px] text-[var(--color-ink-2)] transition-colors hover:border-[var(--color-pine-bright)] hover:text-[var(--color-pine)]">
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
              <SectionTitle hint="read-only client">Omniroute</SectionTitle>
              <div className="mb-3 rounded-xl border border-[rgba(172,35,64,0.22)] bg-[var(--color-rose-wash)] px-3 py-2.5 text-[11.5px] leading-relaxed text-[#8d2038]">
                <span className="font-600">HARD RULE:</span> ye app Omniroute ko kabhi stop/restart/reconfigure nahi karti, combos ya 9router DB kabhi edit nahi karti.
                Sirf GET + ek non-mutating <span className="font-mono">stream:false</span> probe. Test suite isi ko enforce karti hai.
              </div>
              <Row label="Base URL" hint="Bridge isi ko proxy karta hai — browser ke CORS problem se bachne ke liye.">
                <TextField mono value={s.omnirouteBaseURL} onChange={(v) => o.update("omnirouteBaseURL", v)} className="w-[250px]" />
              </Row>
              <Row label="Health poll interval">
                <NumberField value={s.healthPollSec} min={15} max={600} step={15} onChange={(v) => o.update("healthPollSec", v)} suffix="s" />
              </Row>
              <Row label="Probe model" hint="Model naam kabhi assume mat karo — probe karo. opc/beam-free known-good free route hai.">
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
              <SectionTitle hint="live probe results">Status</SectionTitle>
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                {[
                  { k: "reachable", v: o.health?.reachable ? "UP" : "DOWN", tone: o.health?.reachable ? "green" : "rose" },
                  { k: "latency", v: o.health?.latencyMs != null ? `${o.health.latencyMs}ms` : "—", tone: "slate" },
                  { k: "models", v: String(o.models.length), tone: "slate" },
                  { k: "combos path", v: o.combos.pathUsed ?? "none", tone: o.combos.pathUsed ? "green" : "amber" },
                ].map((x) => (
                  <div key={x.k} className="panel-flat px-3 py-2">
                    <div className="label-xs">{x.k}</div>
                    <div className={cn("mt-0.5 truncate font-mono text-[12.5px] font-600", x.tone === "green" ? "text-[var(--color-pine)]" : x.tone === "rose" ? "text-[var(--color-rose)]" : x.tone === "amber" ? "text-[var(--color-amber)]" : "text-[var(--color-ink)]")}>
                      {x.v}
                    </div>
                  </div>
                ))}
              </div>
              <p className="mt-2.5 font-mono text-[10.5px] text-[var(--color-muted)]">{o.health?.detail ?? "no probe yet"}</p>
              {o.probe && (
                <div className={cn("mt-3 rounded-xl border px-3 py-2.5 font-mono text-[11.5px] leading-relaxed", o.probe.ok ? "border-[rgba(11,107,96,0.25)] bg-[var(--color-pine-wash)] text-[var(--color-pine)]" : "border-[rgba(172,35,64,0.22)] bg-[var(--color-rose-wash)] text-[#8d2038]")}>
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
            <SectionTitle hint="default deny">Policy</SectionTitle>
            <Row label="Auto-approve low-risk" hint="Opt-in. Medium/high/critical kabhi auto-approve nahi hote — server bhi yahi check karta hai.">
              <Toggle value={s.autoApproveLowRisk} onChange={(v) => o.update("autoApproveLowRisk", v)} label="Auto approve low risk" />
            </Row>
            <Row label="Voice approval" hint="Sirf low/medium. High = click, critical = typed ALLOW.">
              <Toggle value={s.voiceApproval} onChange={(v) => o.update("voiceApproval", v)} label="Voice approval" />
            </Row>
            <Row label="Decision timeout" hint="Jawab nahi = auto-deny, audit me timeout-deny.">
              <NumberField value={s.permissionTimeoutSec} min={10} max={300} step={5} onChange={(v) => o.update("permissionTimeoutSec", v)} suffix="s" />
            </Row>
            <Row label="Session allowlist" hint="Sirf is session ke liye. Session khatam = list clear.">
              <span className="max-w-[220px] truncate font-mono text-[11px] text-[var(--color-muted)]">{o.sessionAllowlist.join(", ") || "empty"}</span>
            </Row>
            <div className="mt-4 overflow-hidden rounded-xl border border-[var(--color-line)]">
              <table className="w-full text-left text-[11.5px]">
                <thead className="bg-[var(--color-sunken)] text-[var(--color-muted)]">
                  <tr>
                    {["Risk", "Auto", "Voice", "Typed", "Examples"].map((x) => (
                      <th key={x} className="px-3 py-2 font-mono text-[10px] font-500 uppercase tracking-[0.08em]">
                        {x}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[
                    ["low", "opt-in", "yes", "no", "read_file, list_dir, web_fetch", "#0b6b60"],
                    ["medium", "never", "yes", "no", "write_file, git_status", "#a9650a"],
                    ["high", "never", "no", "no", "shell, git_push, delete_file", "#b4441a"],
                    ["critical", "never", "no", "ALLOW", "credentials, sudo, rm -rf", "#ac2340"],
                  ].map((r) => (
                    <tr key={r[0]} className="border-t border-[var(--color-line-soft)]">
                      <td className="px-3 py-2">
                        <span className="font-mono text-[10.5px] font-600 uppercase" style={{ color: r[5] }}>
                          {r[0]}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-[var(--color-ink-2)]">{r[1]}</td>
                      <td className="px-3 py-2 text-[var(--color-ink-2)]">{r[2]}</td>
                      <td className="px-3 py-2 text-[var(--color-ink-2)]">{r[3]}</td>
                      <td className="px-3 py-2 font-mono text-[10.5px] text-[var(--color-muted)]">{r[4]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-[11.5px] leading-relaxed text-[var(--color-muted)]">
              Unknown tool = <span className="font-mono">high</span>. Dangerous argument pattern (<span className="font-mono">rm -rf</span>, <span className="font-mono">sudo</span>,{" "}
              <span className="font-mono">~/.ssh</span>) = <span className="font-mono">critical</span>.
            </p>
          </Panel>
        )}

        {tab === "Privacy" && (
          <Panel className="p-4">
            <SectionTitle hint="local only">Privacy</SectionTitle>
            <Row label="Redact logs & audit" hint="Key/token/password patterns sink pe [REDACTED]. Server side bhi wahi filter lagta hai.">
              <Toggle value={s.redactLogs} onChange={(v) => o.update("redactLogs", v)} label="Redact logs" />
            </Row>
            <Row label="Save debug audio" hint="Default off. Native build scratch me likhta hai, 24h me auto-delete.">
              <Toggle value={s.saveDebugAudio} onChange={(v) => o.update("saveDebugAudio", v)} label="Save debug audio" />
            </Row>
            <Row label="Telemetry" hint="Koi nahi. No analytics, no cloud sync, no crash upload.">
              <Badge tone="green">none</Badge>
            </Row>
            <Row label="Secrets" hint="Is build me koi secret store hi nahi hota. Native me Keychain.">
              <Badge tone="green">no secrets stored</Badge>
            </Row>
            <Row label="Bridge network exposure" hint="Node bridge sirf 127.0.0.1 pe bind karta hai aur non-loopback peer ko 403 deta hai.">
              <Badge tone="green">loopback only</Badge>
            </Row>
            <div className="mt-4 flex gap-2">
              <Button variant="danger" onClick={o.clearSessions}>
                Delete local sessions
              </Button>
              <Button variant="danger" onClick={o.clearAuditLog}>
                Clear local audit
              </Button>
            </div>
            <p className="mt-3 text-[11.5px] leading-relaxed text-[var(--color-amber)]">
              ⚠︎ Honest note: browser SpeechRecognition (Chrome) audio Google servers pe bhejta hai. "On-device" guarantee sirf native Apple Speech me
              milti hai. Dekho LIMITATIONS → L-6.
            </p>
          </Panel>
        )}

        {tab === "About" && (
          <Panel className="p-4">
            <SectionTitle>About</SectionTitle>
            <Row label="Product">
              <span className="text-[12.5px] font-500 text-[var(--color-ink)]">Hermes Voice — voice shell + local bridge</span>
            </Row>
            <Row label="Version">
              <span className="font-mono text-[12px] text-[var(--color-ink-2)]">0.2.0 {h ? `· bridge v${h.version}` : ""}</span>
            </Row>
            <Row label="Spec">
              <span className="text-[12.5px] text-[var(--color-ink-2)]">Master build specification §0–§37</span>
            </Row>
            <Row label="Cost">
              <Badge tone="green">₹0 — koi paid route nahi</Badge>
            </Row>
            <Row label="Brain">
              <span className="font-mono text-[11px] text-[var(--color-muted)]">~/.hermes → 127.0.0.1:20128</span>
            </Row>
            <p className="mt-3 text-[11.5px] leading-relaxed text-[var(--color-muted)]">
              Ye front-end hai. Hermes brain hai, Omniroute provider pool hai. Ye app na Hermes replace karti hai, na keys manage karti hai, na combos edit karti hai.
            </p>
          </Panel>
        )}
      </div>
    </div>
  );
}
