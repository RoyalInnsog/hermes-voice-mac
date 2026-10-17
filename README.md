# Hermes Voice v1.0 (macOS)

Dedicated macOS Voice Assistant Frontend & Local Loopback Bridge for the **Hermes Autonomous Agent** (Nous Research) routed locally through **OmniRoute** (`127.0.0.1:20128`).

## Highlights in v1.0
- **Self-Contained Single-Process Server (`server/index.mjs`):** Serves the compiled Vite production UI (`dist/index.html` + static assets) on `GET /` alongside the `/api/*` REST & SSE bridge on `http://127.0.0.1:20130`.
- **Native macOS Floating HUD (`app/HermesVoiceHUD.swift` & `scripts/build-macos-app.sh`):** Zero-dependency Cocoa `NSPanel` + `WKWebView` + `NSStatusBar` menu bar item (`🎙 Hermes`) with Carbon global hotkey (`⌥ Space`) and ad-hoc code signing (`dist/Hermes Voice.app`).
- **Hermes CLI `--format stream-json` Wire Adapter (`server/protocol.mjs` & `server/agent.mjs`):** Parses live line-delimited JSON chunks (`system`, `text`, `tool_call`, `result`) as well as legacy `HV_*` markers and raw stdout fallback, with process-group termination (`SIGTERM` -> 5s -> `SIGKILL`) and a hard cap of 10 concurrent tasks.
- **Deterministic Python & Edge TTS Discovery (`server/config.mjs` & `server/tts.mjs`):** Auto-resolves `/Users/apple/.hermes/hermes-agent/venv/bin/python` (`edge-tts 7.3.1`), caches synthesized `.mp3` audio in `~/.hermes-voice/scratch/tts-cache/`, and falls back to macOS native `say` (`Rishi`).
- **Continuous Hands-Free Voice UX (`src/`):**
  - `webkitSpeechRecognition` (`en-IN` -> `en-US` / `hi-IN`) with real-time interim transcript and `1.8s` silence auto-stop.
  - Instant audio barge-in (tapping the orb or pressing `⌥ Space` immediately halts TTS playback).
  - Spoken permission confirmation (`"haan kar do"`, `"allow"`, `"permission di"`, `"nahi ruko"`, `"mat kar"`) for low/medium risk, and mandatory typed `ALLOW` for `critical` risk.
- **Strict Read-Only OmniRoute Sync (`server/omniroute.mjs`):** Read-only HTTP probes + read-only SQLite URI (`mode=ro`) inspection of `~/.9router/db/data.sqlite`. Never mutates combos or kills processes.

## Quick Start

```bash
npm install
npm run build
npm start
# Open http://127.0.0.1:20130
```

## Build Standalone macOS `.app` Bundle

```bash
npm run build:app
# Outputs: dist/Hermes Voice.app
```

## Verification & Self-Tests

```bash
# Run 30/30 backend unit + integration self-tests
npm test

# Run full v1.0 end-to-end production verification
npm run verify
```
