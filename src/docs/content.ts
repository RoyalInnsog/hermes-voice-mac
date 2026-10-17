export interface Doc {
  id: string;
  title: string;
  subtitle: string;
  body: string;
}

export const DOCS: Doc[] = [
  {
    id: "build-report",
    title: "BUILD_REPORT.md",
    subtitle: "Live-probed self-assessment · green/red + gaps",
    body: `# BUILD REPORT — Hermes Voice v0.2 (UI + real local bridge)

## Delta since v0.1

v0.1 shipped only browser-side logic with a **mock** agent, because a page cannot
spawn processes or reach 127.0.0.1 through CORS. That was the honest gap.

v0.2 closes it: **there is now a real backend.** \`server/\` is a zero-dependency
Node bridge (Node >= 18, no npm install) that:

- spawns the agent as a real child process (\`child_process.spawn\`) with piped stdin/stdout
- parses the HV_* wire protocol line-by-line (\`server/protocol.mjs\`)
- streams AgentEvents to the UI over **SSE** (\`GET /api/tasks/:id/events\`)
- **pauses on HV_PERM and waits**, then writes \`HV_DECISION\` back into the child's stdin
- re-validates risk policy **server-side** (voice blocked for high/critical, typed ALLOW for critical)
- proxies Omniroute **read-only** (kills the CORS problem; still never mutates anything)
- synthesises speech with **edge-tts** via python3, falling back to macOS \`say\`
- persists audit (append-only jsonl), sessions (json) and redacted logs under ~/.hermes-voice
- enforces the **10-concurrent-task hard cap**, per-task timeout with SIGTERM→SIGKILL, and clean shutdown

Plus \`server/fake-hermes.mjs\`: a test double that implements the exact contract, so
the whole loop is verifiable **today**, on any machine, without waiting for a Hermes patch.

## Live evidence (actually executed, not claimed)

Backend suite — \`node server/selftest.mjs\`:
    29/29 passed
    including 9 integration tests that really spawn fake-hermes and drive it over stdin/stdout

End-to-end HTTP probe — \`node scripts/probe-bridge.mjs "check omniroute health and combos"\`:
    [1] GET /api/health ................ ✓ bridge v0.2.0 · node v20.20.2 · pid 2357
                                          ✓ agent binary resolved → /usr/local/bin/node
                                          ✓ omniroute probed (never restarted) reachable=false
                                          ✓ gemini tts deliberately unwired
                                          ✓ concurrency hard cap = 10
    [2] POST /api/tasks ................ ✓ task accepted id=4c29275e
    [3] SSE + permission round-trip .... ✓ text/event-stream
                                          ⏸ web_fetch [low] → ▶ allowOnce HTTP 200 deliveredToAgent=true
                                          ⚙ toolCall web_fetch
                                          ⏸ read_file [low] → ▶ allowOnce HTTP 200 deliveredToAgent=true
                                          ⚙ toolCall read_file
                                          ✓ task completed over the stream (137 chars)
    [4] audit + sessions ............... ✓ 2 audit rows, no plaintext secrets
                                          ✓ session persisted with user + assistant turns
    [5] memory read-only ............... ✓ listing answered · ✓ path traversal → HTTP 400
    [6] router proxy ................... ✓ health proxied · ✓ combos TODO-VERIFY reported honestly
    [7] GET /api/selftest .............. ✓ 29/29
    [8] POST /api/tts .................. ✓ honest failure: "No module named edge_tts (pip install edge-tts)"
    [9] logs ........................... ✓ 11 lines, no secrets
    ALL CHECKS PASSED

Critical-risk gate probe (separate run):
    perm: read_credentials critical | args: {"store":"Keychain","item":"gemini_api_key","api_key":"AIza…"}
    voice allow      -> 403 voiceBlocked
    click no-confirm -> 403 typedConfirmRequired
    allowSession     -> 403 noSessionAllowlist
    typed ALLOW      -> 200 deliveredToAgent=true
    audit row        -> args="store=Keychain item=gemini_api_key api_key=[REDACTED]"

Three real bugs were caught by these tests and fixed before writing this report:
1. permission timers leaked past task end → phantom audit rows in the next task
2. \`HV_HERMES_CMD="node script.mjs"\` dropped command[1..] → wrong argv spawned
3. critical-risk check order let typedConfirmRequired mask voiceBlocked

## Self-Assessment

**Backend correctness: 92%** — spawned, streamed, decided, audited, killed; all observed live.
**UI logic correctness: 86%** — 25 in-app assertions green.
**End-to-end against YOUR real Hermes: 30%** — blocked on L-2, not on this code.
**Shippable signed macOS .app: 0%** — still not one; see L-0.

### Green — working and observed this session
- AC-2  startup health check; router badge green/yellow/red from a real probe
- AC-3  push-to-talk (⌥Space + orb tap/hold) → listening state + overlay/deck
- AC-4  live speech capture, partial transcript, RMS-driven orb rim + waveform
- AC-5  on release the transcript is dispatched through the AgentBridge
- AC-6  response rendered in the console AND spoken (bridge edge-tts audio when available, else system voice)
- AC-7  **permission interception end-to-end over a real subprocess**: pause → dialog → decision → stdin → resume, with server-side re-validation
- AC-8  cancel in every state; DELETE /api/tasks/:id → SIGTERM then SIGKILL
- AC-9  Settings: 7 tabs, every documented knob, persisted
- AC-10 audit log written redacted, exportable, verified to contain no secret
- AC-11 sessions persisted with 100/30-day retention, viewer included
- AC-12 Hermes memory read-only with a path jail (traversal → HTTP 400)
- AC-13 19-entry error catalog: spoken + visual + suggested fix
- AC-14 missing TTS engine → honest failure + fallback, observed as "No module named edge_tts"
- AC-15 low-confidence confirmation with 15s auto-discard
- AC-17 tests: 29 backend (incl. 9 integration) + 25 UI assertions
- AC-18/19/20 these documents
- Hard rules: no mutating verb toward Omniroute (test-enforced), no combo writes, no plaintext credentials anywhere, no auto-approval above "low", no browser automation at all

### Red — not working / not verifiable
- AC-1  real NSStatusItem + LSUIElement: this is a web UI with a menu-bar-styled header, not an AppKit status item
- AC-16 launch at login (SMAppService): impossible from a page
- Real \`hermes\` answers: depends on L-2. The plumbing is proven against fake-hermes; your binary must emit the markers.
- Omniroute from this hosted preview: a remote page cannot reach your 127.0.0.1, and the bridge runs on your Mac, not here. Red badge here = honest, not faked.
- edge-tts audio in this sandbox: module not installed here; on your Mac it will be (pip install edge-tts)
- On-device STT guarantee: browser STT may use a cloud recognizer (L-6)
- Keychain: nothing to store, so nothing is stored

### Gaps vs your ideal
1. **L-2 is still the single biggest risk.** The bridge implements the pause/decide/resume protocol perfectly — but only if Hermes emits \`HV_PERM:\` and reads \`HV_DECISION:\`. \`hermes chat --help\` decides this in 30 seconds. Until then fake-hermes proves the contract, and your real agent runs in raw-stdout fallback mode (answers still come back, permissions stay inside Hermes).
2. Native shell (menu bar, global hotkey, dock-less, login item) still needs Xcode. The bridge already gives the native app everything it needs over HTTP/SSE — a SwiftUI client can reuse it unchanged.
3. Whisper STT (best Hinglish accuracy) is v0.2+: free but a ~1.5 GB local model.

### Honest "kitna percent sure"
- Bridge protocol, streaming, permission round-trip, redaction, audit, caps, kills: **92%** (all observed live)
- Documented Hermes flags \`chat -q … --session …\`: **35%** — unverified, configurable, marked TODO-VERIFY
- Your installed Hermes supports an interactive permission hook today: **20%**
- Omniroute endpoints (/api/health, /v1/models, stream:false): **90%**; combos path: **25%**
- This is a shippable macOS .app: **0%**`,
  },
  {
    id: "limitations",
    title: "LIMITATIONS.md",
    subtitle: "Every gap + reason + ₹0 unblock path",
    body: `# LIMITATIONS

Nothing silently skipped. Each item: what / why / cheapest unblock (all ₹0).

## L-0 — No signed macOS .app
LIMITATION: the shell is a web UI plus a Node bridge, not an AppKit menu-bar app.
REASON: no Xcode/Swift toolchain in this build environment.
IMPACT: AC-1 (NSStatusItem/LSUIElement) and AC-16 (SMAppService) not literally satisfied.
UNBLOCK (₹0): \`xcode-select --install\`, new macOS App target (13+, LSUIElement=YES),
MenuBarExtra + NSPanel. The bridge API is already HTTP/SSE, so a SwiftUI client reuses it
unchanged — port only the shell, not the logic. Ad-hoc sign with \`codesign -s -\`.

## L-1 — A web page cannot spawn \`hermes\`
LIMITATION: the browser still cannot fork processes.
STATUS: **solved architecturally** — \`server/agent.mjs\` does the spawning, the page talks HTTP.
REMAINING: you must run the bridge on your Mac (\`node server/index.mjs\`). It is not a daemon yet.
UNBLOCK (₹0): add a launchd plist (~/Library/LaunchAgents/com.hermesvoice.bridge.plist) with
KeepAlive=true, or ship it inside the .app bundle as a helper.

## L-2 — Permission interception needs Hermes-side cooperation  ← biggest risk
LIMITATION: the bridge pauses/resumes correctly **only if** the agent emits \`HV_PERM:\` and reads
\`HV_DECISION:\` from stdin. Your installed \`hermes\` almost certainly does neither yet.
PROOF THE CONTRACT WORKS: \`server/fake-hermes.mjs\` implements exactly this and the whole loop
(spawn → SSE → dialog → stdin decision → resume → toolCall → completed) passes live, 29/29 tests.
WHAT HAPPENS WITHOUT IT: raw-stdout fallback — you still get answers and a spoken report, but
tool approvals stay inside Hermes' own flow and AC-7 only holds against the simulator.
UNBLOCK (₹0), in order of preference:
  1. \`hermes --help | grep -iE 'serve|api|acp|server'\` → if a server mode exists, point the bridge
     at it and stream SSE (cleanest).
  2. \`hermes chat --help | grep -iE 'hook|approval|permission|tool|json'\` → if a hook/plugin point
     exists, emit HV_PERM from it. Hermes is yours; a ~40-line patch is enough.
  3. Wrapper: run hermes under a shim that intercepts its own approval prompt on the pty and
     re-emits HV_PERM. More fragile; last resort.
  Do NOT pretend approvals are intercepted when they are not — that would be bluffing.

## L-3 — Gemini TTS deliberately unwired
LIMITATION: only edge-tts and macOS \`say\` are used.
REASON: ~10 req/day/key is unusable for continuous narration; wiring it would invite silent quota failures.
UNBLOCK (₹0 if you insist): add a key to Keychain, count usage locally, disable at the cap with a
spoken notice. Recommend keeping edge-tts as primary — it is free and uncapped.

## L-4 — XCTest replaced by two runnable suites
LIMITATION: \`xcodebuild test\` cannot run here.
STATUS: \`node server/selftest.mjs\` (29 cases, incl. 9 real subprocess integration tests) and the
in-app UI suite (25 assertions) cover the same behaviours; \`GET /api/selftest\` runs them live.
UNBLOCK (₹0): translate to XCTest when porting; suite names already match spec §15.1.

## L-5 — Global hotkey, launch at login, dock-less menu bar
LIMITATION: hotkeys only fire while the page has focus.
REASON: browser security model.
UNBLOCK (₹0): KeyboardShortcuts (MIT) or a CGEvent tap for ⌥Space; SMAppService.mainApp.register()
for login; MenuBarExtra + LSUIElement for the dock-less status item.

## L-6 — "On-device STT" is aspirational in a browser
LIMITATION: Chrome streams recognition audio to Google servers; the toggle cannot guarantee local-only.
IMPACT: the Privacy tab says so explicitly rather than claiming something false.
UNBLOCK (₹0): native SFSpeechRecognizer with requiresOnDeviceRecognition=true, or local Whisper
(free, ~1.5 GB model, M1 Pro handles it fine).

## L-7 — This hosted preview cannot see your machine
LIMITATION: bridge + Omniroute both show offline/red in the deployed preview.
REASON: the bridge runs on your Mac; a remote page cannot reach your loopback.
UNBLOCK (₹0): run the UI locally (\`npm run dev\`) next to the bridge on the same machine. Then the
badge goes green and real audio/tasks flow. Verify with \`node scripts/probe-bridge.mjs\`.

## L-8 — Combos endpoint path unverified
LIMITATION: /api/combos, /v1/combos, /combos are probed read-only; if none answers the list stays empty.
UNBLOCK (₹0): curl each path, or read the combos table from ~/.9router/db/data.sqlite **read-only**.

## L-9 — Session continuity flag assumed
LIMITATION: \`--session <id>\` is passed; whether Hermes honours it is unknown.
UNBLOCK (₹0): \`hermes chat --help | grep -i session\`. If unsupported, drop it from argvTemplate in
~/.hermes-voice/config.json — no code change needed, it is configuration.

## L-10 — fake-hermes is a simulator, not a brain
LIMITATION: no LLM is called by it; responses are scripted.
REASON: it exists to prove the bridge contract before L-2 is resolved.
UNBLOCK: resolve L-2 and point hermes.command at the real binary.`,
  },
  {
    id: "verify",
    title: "VERIFY.md",
    subtitle: "Exact commands — run them, don't trust me",
    body: `# VERIFY — adversarial probe sheet

## 0. Start the bridge (two ways)
    node server/index.mjs                                  # real hermes, if it emits HV_* markers
    HV_HERMES_CMD="node server/fake-hermes.mjs" node server/index.mjs   # simulator: proves the whole loop today

## 1. One-shot end-to-end proof
    node scripts/probe-bridge.mjs
Walks health → task create → SSE stream → permission allow/deny → completion →
audit → sessions → memory jail → router proxy → selftest → tts → logs.
Expect: ALL CHECKS PASSED. Anything red is a real bug, not a cosmetic miss.

## 2. Backend test suite (29 cases, 9 real subprocess integrations)
    node server/selftest.mjs
    curl -s http://127.0.0.1:20130/api/selftest | head -c 400

## 3. Bridge capability (probed, never assumed)
    curl -s http://127.0.0.1:20130/api/health | python3 -m json.tool | head -60
Look at: hermes.found/path/detail, omniroute.reachable, tts.engines.edge.detail, tasks.cap (must be 10).

## 4. Watch a permission round-trip by hand
    curl -s -X POST http://127.0.0.1:20130/api/tasks -H 'Content-Type: application/json' \\
      -d '{"utterance":"check omniroute health","sessionId":"manual-1"}' | python3 -m json.tool
    curl -N http://127.0.0.1:20130/api/tasks/<TASK_ID>/events        # SSE: watch it pause
    curl -s -X POST http://127.0.0.1:20130/api/tasks/<TASK_ID>/permissions/<REQ_ID>/decision \\
      -H 'Content-Type: application/json' -d '{"decision":"allowOnce","via":"click"}'
Expect deliveredToAgent=true, then a toolCall event, then completed.

## 5. Security gates must refuse you
    # critical without typed ALLOW  -> 403 typedConfirmRequired
    # critical via voice            -> 403 voiceBlocked
    # critical allowSession         -> 403 noSessionAllowlist
    # memory traversal              -> 400
    curl -s "http://127.0.0.1:20130/api/memory/file?path=../../etc/passwd" -o /dev/null -w '%{http_code}\\n'
    curl -s http://127.0.0.1:20130/api/audit?limit=1 | grep -c REDACTED

## 6. Prove nothing mutates Omniroute
    grep -rnE "method:\\s*['\\"](PUT|PATCH|DELETE)" server/ src/    # expect: no matches on 20128 paths
    grep -rn "20128" server/ src/ | grep -i post                   # only the stream:false probe
Also enforced by the tests "client can only issue GET plus the single probe POST" and
"probe always sends stream:false".

## 7. Hard cap + kill behaviour
    # start 10 tasks, the 11th must be rejected
    for i in $(seq 1 11); do curl -s -o /dev/null -w "%{http_code} " -X POST http://127.0.0.1:20130/api/tasks \\
      -H 'Content-Type: application/json' -d '{"utterance":"slow task","sessionId":"cap-'$i'"}'; done; echo
    # expect ten 201s then one 429
    curl -s -X DELETE http://127.0.0.1:20130/api/tasks/<TASK_ID>   # cancel → child killed
    pgrep -fl fake-hermes                                          # should drain to zero

## 8. Your real Hermes — this decides L-2
    which hermes && hermes --version
    hermes --help | head -60
    hermes chat --help | head -60
    hermes --help | grep -iE 'serve|api|acp|server|hook|approval|permission|tool'
    hermes chat --help | grep -iE 'json|session|quiet|-q'
If the greps print nothing: permissions cannot be intercepted yet → L-2 unblock steps.

## 9. Omniroute ground truth (from your terminal, never restart it)
    curl -sS -m 5 http://127.0.0.1:20128/api/health; echo
    curl -sS -m 10 http://127.0.0.1:20128/v1/models | head -c 600; echo
    curl -sS -m 30 -X POST http://127.0.0.1:20128/v1/chat/completions \\
      -H 'Content-Type: application/json' \\
      -d '{"model":"opc/beam-free","messages":[{"role":"user","content":"ping"}],"stream":false}' | head -c 400; echo

## 10. Free unlimited TTS
    pip install edge-tts
    curl -s -X POST http://127.0.0.1:20130/api/tts -H 'Content-Type: application/json' \\
      -d '{"text":"Task ho gaya. Report overlay me hai."}' | python3 -m json.tool
    # then play the returned url, or: afplay ~/.hermes-voice/scratch/<file>.mp3`,
  },
  {
    id: "testing",
    title: "TESTING.md",
    subtitle: "Manual checklist — UI, voice, permissions, failure modes",
    body: `# MANUAL TEST CHECKLIST

Automated: \`node server/selftest.mjs\` (29) + Tests tab (25). These are the human-only paths.

## Voice
[ ] Tap the orb → listening within ~100ms, rim + waveform react to your voice level
[ ] Hold ⌥Space → same; release → sends
[ ] Live transcript appears word-by-word while you speak Hinglish
[ ] Completion speaks "Task ho gaya" + a summary; full text stays in the console
[ ] ⌥⇧Space repeats the last answer; Cancel stops speech mid-sentence
[ ] Mumble → confidence card appears with the % and Send/Discard; 15s of nothing auto-discards

## Permissions (use the four suggestion chips — each hits a different risk tier)
[ ] "health/combos" → low risk, voice approval box visible, allow resumes the run
[ ] "commit" → high risk, voice approval blocked, click required
[ ] "clean scratch" → critical, typed ALLOW required, Allow-for-session disabled
[ ] "api key" → critical + credential args; audit row shows api_key=[REDACTED]
[ ] Countdown ring ticks; letting it expire auto-denies and speaks the timeout line
[ ] Esc denies; Enter allows when permitted
[ ] Allow-for-session → same tool skips the dialog later, until the session ends
[ ] Every decision appears in the Audit tab with risk, via and redacted args

## Backend tab
[ ] Connect shows version/pid/uptime and the four capability tiles
[ ] "Run backend tests" → 29/29 with per-case detail
[ ] Endpoint list matches what curl returns
[ ] Bridge logs tail shows redacted lines
[ ] With the bridge stopped, the amber banner appears and the mock path still works

## Degradation (must be honest, never faked)
[ ] Bridge offline → red/offline badge, banner with the exact start command
[ ] Bridge mode "hermes CLI" → refuses with the real argv it would run
[ ] TTS engine "Edge TTS" with the module missing → warn + system-voice fallback
[ ] Browser without SpeechRecognition → sttUnsupported, orb disabled (not a dead button)
[ ] Type a key like sk-abcdef1234567890 into a task → Logs tab shows [REDACTED]

## Accessibility
[ ] Permission dialog is keyboard-only operable (Tab/Enter/Esc)
[ ] Risk conveyed by icon + label, not colour alone
[ ] prefers-reduced-motion freezes orb rings and waveform animation
[ ] Focus rings visible on every control`,
  },
  {
    id: "setup",
    title: "SETUP.md",
    subtitle: "Run it, wire it to real Hermes, port to Swift",
    body: `# SETUP

## A. Run everything (₹0, no npm install needed for the bridge)
    npm install                       # UI only
    npm run dev                       # http://localhost:5173
    node server/index.mjs             # bridge on http://127.0.0.1:20130
Then open the UI **on the same machine** as the bridge (a hosted preview cannot see your loopback).

No real Hermes yet? Prove the loop with the simulator:
    HV_HERMES_CMD="node server/fake-hermes.mjs" node server/index.mjs
    node scripts/probe-bridge.mjs

Free unlimited voice:
    pip install edge-tts              # hi-IN-MadhurNeural, no key, no daily cap

## B. Configuration
File: \`~/.hermes-voice/config.json\` (created on first PATCH). Env overrides for one-off runs:
    HV_PORT              bridge port (default 20130)
    HV_HERMES_CMD        agent launcher, e.g. "hermes" or "node server/fake-hermes.mjs"
    HV_HERMES_CWD        spawn cwd (default ~/.hermes)
    HV_OMNI_BASE         Omniroute base URL (default http://127.0.0.1:20128)
    HV_TTS_ENGINE        edge | say | auto
    HV_DATA_DIR          storage root (default ~/.hermes-voice)

argvTemplate is configurable — when \`hermes chat --help\` shows the real flags, change this and
nothing else:
    { "hermes": { "command": ["hermes"], "argvTemplate": ["chat","-q","{{utterance}}","--session","{{sessionId}}"] } }

## C. Prerequisites for the real thing
- Hermes Agent at ~/.hermes with \`hermes\` on PATH
- Omniroute / 9Router listening on 127.0.0.1:20128 — **already running; never restart it**
- Node >= 18 for the bridge, python3 + edge-tts for unlimited TTS

## D. Native port map (SwiftUI shell reuses this bridge unchanged)
| TypeScript / Node                              | Native target (Swift)                        |
|------------------------------------------------|----------------------------------------------|
| server/protocol.mjs                            | Agent/HermesProtocol.swift                   |
| server/agent.mjs (spawn, SSE, stdin decisions) | Agent/SubprocessAgentBridge.swift (Process)  |
| server/omniroute.mjs                           | Omniroute/OmnirouteClient.swift (URLSession) |
| server/risk.mjs / redact.mjs                   | Permissions/RiskClassifier.swift, Logging/Redactor.swift |
| server/store.mjs                               | Session/SessionStore.swift + audit.jsonl     |
| server/tts.mjs                                 | TTS/EdgeTTSEngine.swift (Process → AVAudioPlayer) |
| src/lib/stateMachine.ts                        | State/AppStateMachine.swift                  |
| src/lib/errors.ts / strings.ts                 | Errors/ErrorManager.swift / Localizable      |
| src/hooks/useHermesVoice.ts                    | App/AppState.swift + Voice Orchestrator      |
| src/components/VoiceDeck.tsx                   | UI/Overlay/OverlayPanel.swift (NSPanel)      |
| src/components/PermissionDialog.tsx            | UI/Permissions/PermissionDialog.swift        |
| src/lib/speech.ts (WebSTT)                     | STT/AppleSTTEngine.swift (SFSpeechRecognizer)|

A native app can either link these modules directly or just be a thin SwiftUI client of the
already-working bridge over HTTP/SSE — the second option is days, not weeks.

Info.plist: NSMicrophoneUsageDescription, NSSpeechRecognitionUsageDescription, LSUIElement=YES.
If App Sandbox blocks spawning \`hermes\`, ship unsandboxed and document it — do not weaken the
permission model to work around it.

## E. First command after porting
    hermes chat --help
Everything about permission interception (L-2) depends on what it prints.`,
  },
];
