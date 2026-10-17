# MISSION SPECIFICATION FOR GEMINI 4 ARGON: Hermes Voice v1.0 Production Build

> **Target Model:** Gemini 4 Argon (Google DeepMind Frontier Model)  
> **GitHub Repository:** https://github.com/RoyalInnsog/hermes-voice-mac  
> **Source Base Archive:** `/Users/apple/Downloads/hermes-voice-macos-specification.zip` (also pushed to GitHub above)  
> **Context:** The full repository is live and public at https://github.com/RoyalInnsog/hermes-voice-mac. You can inspect all files directly from the repository.  
> **Objective:** Upgrade this repository into a rock-solid, production-ready, daily-driver macOS Voice Assistant frontend for Hermes Agent connected to OmniRoute. Zero mockups, zero stubs, zero placeholders.

---

## 0. EXECUTIVE SUMMARY & ARCHITECTURE

The user wants a dedicated macOS voice front-end for their autonomous AI agent (**Hermes Agent**, built by Nous Research), routed locally through **OmniRoute** (`127.0.0.1:20128`).
Currently, Hermes is driven via text CLI (`hermes chat`). The user wants to speak naturally (in Hinglish/English), see live speech-to-text waveforms, have the Hermes agent execute tasks with autonomous tool use, receive audio progress updates, securely approve dangerous actions via voice or click, and hear a final spoken summary of task results when finished.

### Existing Baseline in the Attached Zip (`v0.2.0`):
- **Server:** Node.js HTTP/SSE bridge (`server/index.mjs`) on `127.0.0.1:20130` with `agent.mjs` (TaskManager), `tts.mjs` (Edge TTS + macOS say fallback), `risk.mjs`, `redact.mjs`, `store.mjs`, `speechPrep.mjs`.
- **Tests:** 29/29 automated tests passing in `server/selftest.mjs`.
- **Frontend:** React 19 + Tailwind CSS + Vite singlefile (`dist/index.html` 421 kB) featuring an 8-tab dashboard (Console, Backend, Settings, Sessions, Audit, Logs, Tests, Docs).

### Gaps to Bridge in this Pass (v1.0 Deliverables):
1. **Self-Contained Server:** `server/index.mjs` currently only exposes `/api/*`. It must serve the production Vite `dist/` bundle on `GET /` and all static assets, so running `npm start` provides the entire UI + API without requiring `vite` dev server.
2. **Native macOS Floating App Wrapper:** Create a native macOS floating HUD / menu bar wrapper (via a zero-dependency Native WKWebView App Bundle or Python PyObjC/Electron runner) that floats over desktop windows, toggles on hotkey (`⌥ Space`), captures voice, and keeps the screen clutter-free.
3. **Real Hermes CLI Wire Adaptation:** Wire the live CLI output format. Real Hermes CLI supports `hermes chat -q "<query>" --format stream-json`. The server adapter must parse live JSON stream chunks (`{"type":"system"|"text"|"result"|"tool_call"}`) while falling back to plain text stdout when `--format stream-json` is absent.
4. **Python & Edge TTS Environment Auto-Discovery:** Point Edge TTS to the user's verified working python venv at `/Users/apple/.hermes/hermes-agent/venv/bin/python` where `edge-tts 7.3.1` is installed, eliminating any 403 or missing package errors.
5. **Continuous Hands-Free Voice UX:**
   - Auto-play synthesized Edge TTS audio responses immediately on completion.
   - Smart audio barge-in / interruption (when the user taps the mic or speaks, ongoing TTS playback halts instantly).
   - Voice decision recognition: natural spoken replies like *"haan kar do"*, *"allow"*, *"permission di"*, *"nahi ruko"* seamlessly resolve active permission prompts.
6. **Live OmniRoute Read-Only Sync:** Read-only inspection of local OmniRoute SQLite database at `~/.9router/db/data.sqlite` for active combos and provider health without ever mutating combos or killing processes.

---

## 1. HARD ENVIRONMENT & SYSTEM CONSTRAINTS

You must strictly adhere to these verified local machine constraints:
1. **Operating System:** macOS Darwin (Apple Silicon arm64).
2. **Hermes CLI Path:** `/Users/apple/.hermes/hermes-agent/.hermes/bin/hermes` (also accessible via `~/.local/bin/hermes`).
3. **Working Python Runtime:** `/Users/apple/.hermes/hermes-agent/venv/bin/python` (contains `edge-tts 7.3.1`, `aiohttp`, `certifi`).
4. **OmniRoute Gateway:** Running on `http://127.0.0.1:20128`.
   - **CRITICAL RULE:** Never kill the OmniRoute process. Never restart it. Never write to or mutate `~/.9router/db/data.sqlite`. All operations on OmniRoute must be **STRICT READ-ONLY**.
5. **No New Paid APIs ($0 Budget):**
   - STT: Browser Web Speech API (`webkitSpeechRecognition`) on-device / local fallback.
   - TTS: Microsoft Edge TTS via `edge-tts` (voice: `hi-IN-MadhurNeural` for Hindi/Hinglish, `en-IN-NeerjaNeural` or `en-US-ChristopherNeural` for English). Fallback: macOS native `say` command (`say -v Rishi`).
   - Gemini 3.8 Flash TTS has a hard ~10 requests/day free tier cap on this machine; keep it disabled or strictly opt-in behind a manual toggle.
6. **Process Hard-Cap:** Max 10 concurrent agent tasks. Process-group termination (`SIGTERM` -> 5s -> `SIGKILL`) on task timeout or cancel.

---

## 2. DETAILED REQUIREMENTS & IMPLEMENTATION SPECIFICATIONS

### 2.1 Backend Server Overhaul (`server/index.mjs`)
- **Static File Serving:** Serve `dist/index.html` on `GET /` and handle MIME types for all static assets (`.js`, `.css`, `.png`, `.svg`, `.ico`, `.json`, `.mp3`).
- **Single-Port Simplicity:** Default to port `20130`. The entire app (UI + SSE streams + REST endpoints) must run out of a single process:
  ```bash
  node server/index.mjs
  ```
- **Hermes CLI Stream-JSON Adapter:**
  In `server/agent.mjs`:
  Hermes CLI supports `--format stream-json`. The command invoked should be:
  ```bash
  hermes chat -q "<utterance>" --format stream-json
  ```
  The bridge must handle both:
  1. **Line-delimited JSON events:**
     - `{"type": "system", "subtype": "init", "model": "...", "session_id": "..."}` -> emit `status`
     - `{"type": "text", "text": "..."}` -> stream text chunk to UI
     - `{"type": "tool_call", "name": "...", "arguments": {...}}` -> intercept as permission request if risk >= medium
     - `{"type": "result", "text": "...", "exit_code": 0}` -> emit `completed`
  2. **Legacy HV Protocol Markers:** Retain support for `HV_EVENT`, `HV_PERM`, `HV_PROGRESS`, and raw stdout fallback so nothing breaks.

### 2.2 TTS Engine & Python Path Resolution (`server/tts.mjs` & `server/config.mjs`)
- In `server/config.mjs`, resolve Python runtime using deterministic fallbacks:
  1. `process.env.HV_PYTHON`
  2. `/Users/apple/.hermes/hermes-agent/venv/bin/python` (primary verified python on this Mac)
  3. `~/.hermes/installs/*/venv/bin/python`
  4. Global `python3`
- Ensure Edge TTS output caching in `~/.hermes-voice/scratch/tts-cache/`. If directory does not exist, create it recursively.
- When Edge TTS succeeds, return `Content-Type: audio/mpeg` directly or stream from disk. If Edge TTS fails, auto-fallback to macOS `say` generating `.aiff` and converting to `.mp3` or `.wav` via `afconvert` / `ffmpeg` if present, or returning the audio stream.

### 2.3 Mac Native Launcher & Floating HUD Window
Create a lightweight, zero-dependency macOS runner in `app/` or `scripts/`:
- **Option A (Recommended):** A Swift / Cocoa floating panel or AppleScript wrapper bundle (`Hermes Voice.app`) that opens a borderless, floating WebKit window (`WKWebView`) sized 420x680 px pinned to the top right or center overlay of the active display.
- **Option B:** A lightweight Node / Electron or Python `pyobjc` status bar item (`NSStatusBar.systemStatusBar`) with a global hotkey listener (`⌥ Space` or `Cmd+Shift+H`) that toggles visibility of the Hermes Voice floating overlay.
- Provide a `scripts/build-macos-app.sh` script that packages the app bundle into `dist/Hermes Voice.app` without requiring a paid Apple Developer certificate (use ad-hoc `codesign -s -`).

### 2.4 Voice Interaction & Audio Polish (`src/`)
- **Speech-to-Text (STT):**
  - Configure `webkitSpeechRecognition` with `lang: 'en-IN'` (best recognition for Indian Hinglish accents) and fallback to `'en-US'` or `'hi-IN'`.
  - Include interim results for real-time live typing animation in the UI.
  - Implement energy/silence detection: auto-stop after 1.8 seconds of silence when an utterance has been spoken.
- **Barge-In / Interruptibility:**
  - If audio is currently playing and the user taps the mic button or starts speaking, immediately stop the audio element (`audio.pause(); audio.currentTime = 0;`).
- **Spoken Permission Confirmation:**
  - When a permission modal is active (e.g. `rm -rf`, `git push`, or shell command execution):
    - Listen for voice affirmations: `["haan", "ha", "yes", "allow", "proceed", "kar de", "theek hai"]` -> maps to `allowOnce`
    - Listen for voice denials: `["nahi", "no", "deny", "ruk", "cancel", "mat kar"]` -> maps to `deny`
    - For `critical` risk actions (e.g. system file deletion, sensitive credential usage), voice approval must be disabled, and the UI must require typing the exact word `ALLOW` into the dialog input.

### 2.5 UI & Visual Experience (`src/`)
- The UI must look like a polished, high-end macOS utility:
  - Deep dark theme (`#0e0d0b` background with warm gold `#e5a93c` accents, matching the user's design palette).
  - Prominent central Voice Deck with a dynamic Canvas/SVG waveform visualizing both mic input and audio playback output.
  - Collapsible drawer for advanced tabs (Console, Backend status, Settings, Audit logs, Self-tests).
  - Clear visual badge showing active model (e.g. `KRITI / 9Router`), connection status to `127.0.0.1:20130`, and TTS engine status.

---

## 3. REQUIRED CODE DELIVERABLES

You must provide the exact, full code for all modified and new files. Do not truncate with `// ... rest of code unchanged`. Provide production-ready implementations for:

1. **`server/config.mjs`** — Updated with verified Python venv detection, paths, and port configurations.
2. **`server/index.mjs`** — Full HTTP server with static file serving (`dist/`), SSE streams, and REST API.
3. **`server/agent.mjs`** — Updated `TaskManager` with `stream-json` parsing, process-group management, and permission relays.
4. **`server/tts.mjs`** — Robust Edge TTS + macOS `say` fallback with directory auto-creation and stream handling.
5. **`scripts/build-macos-app.sh`** — Automation script to compile the frontend, verify the backend, and bundle a standalone `.app` or standalone runner.
6. **`Makefile`** & **`package.json`** — Updated scripts (`npm start`, `npm run dev`, `npm run build`, `npm test`).
7. **Verification Script (`scripts/verify-v1.mjs`)** — End-to-end automated test script verifying:
   - Server boots and serves `dist/index.html` (200 OK).
   - Python venv and `edge-tts` generate Hindi audio file.
   - Hermes CLI is discovered and responds.
   - Permission rejection on untyped critical actions.

Be thorough, precise, and deliver clean, production-grade code. Produce complete files ready to be pasted or extracted directly into the project directory.
