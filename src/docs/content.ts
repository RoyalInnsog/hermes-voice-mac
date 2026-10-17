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
    subtitle: "v1.0 Production Build — live verification & status",
    body: `# BUILD REPORT — Hermes Voice v1.0 Production Build

## What was upgraded in v1.0

1. **Self-Contained Single-Port Server (\`server/index.mjs\`)**
   - Serves the compiled production UI (\`dist/index.html\` and all static assets) on \`GET /\` alongside \`/api/*\` on \`127.0.0.1:20130\`.
   - Running \`node server/index.mjs\` (or \`make start\`) serves the entire UI + SSE streams + REST API from a single process.

2. **Real Hermes CLI \`--format stream-json\` Wire Adapter (\`server/protocol.mjs\`, \`server/agent.mjs\`)**
   - Default invocation: \`hermes chat -q "<utterance>" --format stream-json\`
   - Parses live JSON stream chunks:
     - \`{"type": "system", "subtype": "init", "model": "...", "session_id": "..."}\` -> emits \`status\` and updates active model badge
     - \`{"type": "text", "text": "..."}\` -> streams text chunks to UI
     - \`{"type": "tool_call", "name": "...", "arguments": {...}}\` -> classifies risk and pauses for permission approval
     - \`{"type": "result", "text": "...", "exit_code": 0}\` -> emits \`completed\` (or \`failed\` on non-zero exit)
   - Retains full backward compatibility with \`HV_EVENT:\`, \`HV_PERM:\`, \`HV_PROGRESS:\` and plain-text stdout fallback.
   - Process-group termination (\`SIGTERM\` -> 5s -> \`SIGKILL\` on \`-pid\`) on cancel or timeout, plus the 10-concurrent-task hard cap.

3. **Deterministic Python Venv & Edge TTS Caching (\`server/config.mjs\`, \`server/tts.mjs\`)**
   - Resolves Python in strict priority order:
     1. \`process.env.HV_PYTHON\`
     2. \`/Users/apple/.hermes/hermes-agent/venv/bin/python\` (verified \`edge-tts 7.3.1\` venv)
     3. \`~/.hermes/installs/*/venv/bin/python\`
     4. Global \`python3\`
   - Content-addressed SHA-256 audio cache in \`~/.hermes-voice/scratch/tts-cache/\` (auto-created recursively).
   - Automatic fallback to macOS \`say -v Rishi\` / \`say -v Lekha\` + \`afconvert\`/\`ffmpeg\`.

4. **Strict Read-Only OmniRoute SQLite & HTTP Sync (\`server/omniroute.mjs\`)**
   - Inspects \`~/.9router/db/data.sqlite\` via \`sqlite3 -readonly -json\` for \`combos\` and \`providerConnections\` metadata with mandatory credential redaction.
   - Never mutates combos, never reads \`apiKeys\`, and never stops or restarts OmniRoute.

5. **Native macOS Floating HUD App Bundle (\`app/HermesVoiceHUD.swift\`, \`scripts/build-macos-app.sh\`)**
   - Native Cocoa + WebKit + Carbon floating \`NSPanel\` (\`420x680\` HUD mode <-> \`1220x780\` full studio) + \`NSStatusBar\` menu-bar item + global \`⌥ Space\` hotkey + automatic \`WKWebView\` microphone permission grant.
   - Packaged into \`dist/Hermes Voice.app\` and ad-hoc signed with \`codesign --force --deep --sign -\` ($0 cost).

6. **Continuous Hands-Free Voice UX & Dark Gold UI (\`src/\`)**
   - Deep dark obsidian theme (\`#0e0d0b\` background with warm gold \`#e5a93c\` accents).
   - Dual-mode waveform visualizing both mic input (\`level\`) and TTS playback output (\`outputLevel\`).
   - 1.8-second silence auto-stop detector after speech begins.
   - Instant barge-in (\`audio.pause(); audio.currentTime = 0;\` + \`speechSynthesis.cancel()\`) when tapping the orb or pressing \`⌥ Space\`.
   - Spoken permission decisions (\`"haan kar do"\`, \`"permission di"\`, \`"kar de"\`, \`"theek hai"\` -> \`allowOnce\`; \`"nahi ruko"\`, \`"mat kar"\`, \`"ruk"\` -> \`deny\`), with voice strictly blocked and exact typed \`ALLOW\` required on \`critical\` actions.`,
  },
  {
    id: "verify",
    title: "VERIFY.md",
    subtitle: "Run scripts/verify-v1.mjs &server/selftest.mjs",
    body: `# VERIFY — Hermes Voice v1.0 Verification Sheet

## 1. End-to-End Automated v1.0 Verification
    node scripts/verify-v1.mjs
Verifies:
- Server boots v1.0.0 and serves \`dist/index.html\` on \`GET /\` (200 OK, \`text/html\`).
- Python runtime resolves (\`/Users/apple/.hermes/hermes-agent/venv/bin/python\` priority #1) and creates \`tts-cache/\`.
- Hermes CLI discovery & \`--format stream-json\` execution over SSE (\`system\`, \`tool_call\`, \`result\`).
- Critical permission rejection gates: HTTP 403 \`voiceBlocked\`, HTTP 403 \`typedConfirmRequired\`, HTTP 403 \`noSessionAllowlist\`, and HTTP 200 on exact typed \`ALLOW\` with \`[REDACTED]\` audit log.
- Read-only OmniRoute SQLite inspection (\`GET /api/router/sqlite\`).

## 2. Backend Unit + Subprocess Integration Suite (30 cases)
    node server/selftest.mjs

## 3. Build & Launch Native macOS Floating HUD App
    bash scripts/build-macos-app.sh
    open "dist/Hermes Voice.app"

## 4. Start Self-Contained Single-Port Production Server
    npm run build
    node server/index.mjs
    # Open http://127.0.0.1:20130`,
  },
  {
    id: "setup",
    title: "SETUP.md",
    subtitle: "Makefile, package.json scripts & macOS app bundle",
    body: `# SETUP — Hermes Voice v1.0 Daily Driver

## Quick Commands (Makefile)
    make build       # Compile Vite production bundle into dist/index.html
    make test        # Run 30 backend unit & subprocess integration tests
    make verify      # Run end-to-end v1.0 verification (scripts/verify-v1.mjs)
    make macos-app   # Build ad-hoc signed dist/Hermes Voice.app
    make start       # Build + start self-contained server on http://127.0.0.1:20130

## Recommended package.json scripts
    "scripts": {
      "start": "node server/index.mjs",
      "dev": "vite",
      "build": "vite build",
      "test": "node server/selftest.mjs",
      "verify": "node scripts/verify-v1.mjs",
      "macos-app": "bash scripts/build-macos-app.sh"
    }

## Verified Paths on Your Mac
- **Hermes CLI:** \`/Users/apple/.hermes/hermes-agent/.hermes/bin/hermes\` (or \`~/.local/bin/hermes\`)
- **Python Venv (Edge TTS 7.3.1):** \`/Users/apple/.hermes/hermes-agent/venv/bin/python\`
- **OmniRoute Gateway:** \`http://127.0.0.1:20128\` (strict read-only)
- **OmniRoute SQLite DB:** \`~/.9router/db/data.sqlite\` (strict read-only via \`sqlite3 -readonly\`)
- **TTS Audio Cache:** \`~/.hermes-voice/scratch/tts-cache/\``,
  },
];
