# Hermes Voice v1.0 — Production macOS Voice Front-End for Hermes Agent

Hermes Voice v1.0 upgrades the local voice bridge and interface into a self-contained, zero-dependency daily-driver macOS voice assistant for the Hermes Agent routed through OmniRoute (`127.0.0.1:20128`), featuring continuous Hinglish/English voice interaction, live `stream-json` tool interception, cached neural TTS playback, and a native floating macOS HUD.

## User Review & Critical Decisions

> [!IMPORTANT]
> All architectural and UX choices have been updated to reflect your feedback for the v1.0 production build:

- **Confirmed Decision 1 — Native macOS Wrapper Architecture & Hotkey Permissions**: Deliver **both** a native Swift/Cocoa `WKWebView` floating HUD bundle (`Hermes Voice.app`) with a menu bar status item (`NSStatusBar`) and global hotkey (`⌥ Space`), **plus** a standalone CLI/PyObjC launcher script. The global `⌥ Space` hotkey uses Carbon's `RegisterEventHotKey` (which registers system-wide hotkeys on macOS without requiring invasive input-monitoring locks) paired with a graceful `AXIsProcessTrustedWithOptions` Accessibility check and fallback menu bar trigger so the app never crashes or hangs if Accessibility permission is not yet granted.
- **Confirmed Decision 2 — Dual-Mode Responsive Dark Gold UI**: Implement a **dual-mode interface** using the deep obsidian (`#0e0d0b`) and warm gold (`#e5a93c`) palette that adapts seamlessly between the **420×680px floating HUD overlay** (centered on the Voice Orb, live Canvas waveform, transcript, and slide-over drawer) and the **full 1440px desktop engineering workspace** with collapsible inspector tabs.
- **Confirmed Decision 3 — Direct `stdin` Permission Interception (No `SIGSTOP` Deadlocks)**: Do **not** use `SIGSTOP` to freeze the child process. Hermes CLI blocks natively on `stdin` when awaiting tool approval; writing to a `SIGSTOP`-paused process can cause pipe buffer/thread deadlocks. Instead, when Hermes CLI emits a `tool_call` in `--format stream-json` or `HV_PERM:`, the bridge holds the request in `awaiting` state and writes `HV_DECISION: {"id":"...","decision":"..."}` directly to child `stdin` upon resolution (and uses process-group `SIGTERM` → `5s` → `SIGKILL` only on task timeout or explicit cancellation).

---

## 1. Overview & Core Concept

- **What It Does**: Provides a hands-free and push-to-talk (`⌥ Space`) voice shell around the local Hermes Agent CLI. Users speak tasks in Hinglish or English, watch real-time speech waveforms and streaming agent progress, approve or reject sensitive tool executions by voice or typed confirmation, and hear synthesized spoken summaries via Edge TTS (`hi-IN-MadhurNeural` / `en-IN-NeerjaNeural`) with automatic `say -v Rishi` fallback.
- **Target Audience / Persona**: Power users and engineers running local autonomous agents on Apple Silicon macOS who want immediate voice access from anywhere on their desktop without leaving their active window or risking unapproved shell mutations.
- **Key Value**: Eliminates terminal context-switching while preserving strict security guardrails—loopback-only network isolation, read-only OmniRoute inspection, automatic secret redaction, and multi-tiered tool permission gating.

---

## 2. User Experience & Visual Design

- **Key User Flows**:
  1. **Hotkey / Orb Activation & Silence Auto-Stop**: Pressing `⌥ Space` or clicking the central Voice Orb halts any active TTS playback (barge-in) and begins `webkitSpeechRecognition` (`en-IN` primary with `hi-IN` and `en-US` fallback). Interim transcripts stream live while a WebAudio RMS analyzer drives a 60fps Canvas waveform. After 1.8 seconds of post-speech silence, the utterance auto-submits.
  2. **Streaming Execution & Audio Progress**: The server spawns `hermes chat -q "<utterance>" --format stream-json`, translating live JSON chunks (`system`, `text`, `tool_call`, `result`) and legacy `HV_*` markers into SSE events.
  3. **Voice & Typed Permission Gating**: When a tool requires approval, the Permission Modal slides over the deck with a countdown ring and spoken prompt. Low/medium risk calls accept natural Hinglish/English voice replies (*"haan kar do"*, *"allow"*, *"permission di"*, *"nahi ruko"*). High risk requires an explicit click, and critical risk (`rm -rf`, credentials, `sudo`) blocks voice approval and requires typing `ALLOW`.
  4. **Spoken Report & Barge-In**: On completion, the response is cleaned for speech, checked against the local SHA-256 TTS cache (`~/.hermes-voice/scratch/tts-cache/`), synthesized via `/Users/apple/.hermes/hermes-agent/venv/bin/python -m edge_tts`, and auto-played with real-time output waveform visualization.
- **Visual Identity & Theme**:
  - *Aesthetic Direction*: High-precision macOS dark utility—tactile, low-glare obsidian surfaces with warm gold instrumentation and crisp tabular telemetry.
  - *Color Palette & Mood*:
    - Dominant Canvas (60%): Deep Obsidian `#0e0d0b` (`--color-canvas`) with Elevated Panel `#161412` (`--color-panel`) and Sunken Well `#11100e` (`--color-sunken`).
    - Structural Surfaces & Borders (30%): Subtle warm hairline `#26231f` (`--color-line`), Primary Ivory text `#f5f2eb` (`--color-ink`), Secondary Stone `#b5afa4` (`--color-ink-2`), Muted Pewter `#7a7469` (`--color-muted`).
    - Accent & Semantic Budget (10%): Warm Gold `#e5a93c` (`--color-gold` / primary accent), Emerald `#22c55e` (nominal/live), Amber `#f59e0b` (degraded/permission warning), Crimson `#ef4444` (critical/error).
  - *Typography & Hierarchy*: `Bricolage Grotesque` (600/800) for display headers and state titles, `IBM Plex Sans` (400/500/600) for body copy and transcripts, and `IBM Plex Mono` (`tabular-nums`) for all latency metrics, PIDs, countdowns, model IDs, and log streams.
  - *Component Styling & Dual-Mode Layout*:
    - **Compact HUD Mode (`<= 520px` width or toggled via HUD button)**: Pinpoints focus on the top status bar (`KRITI / 9Router`, `127.0.0.1:20130`, TTS engine), the central Voice Deck with interactive Canvas waveform, live transcript feed, and a slide-over drawer for Console, Backend, Settings, Sessions, Audit, Logs, Tests, and Docs.
    - **Desktop Console Mode (`> 520px` width)**: Full 3-zone layout with left navigation rail, central multi-tab inspector workspace, and sticky right-hand Voice Deck.
- **Interactive Feedback & Motion**:
  - Compositor-only transitions (`transform`, `opacity`) settling within `160ms`.
  - Dual-source Canvas waveform that renders mic input energy in warm gold (`#e5a93c`) during listening and synthesized audio cadence in emerald-gold during TTS playback.

---

## 3. Key Product Decisions & Trade-Offs

- **Decision 1 — Single-Process Self-Contained Server on Port 20130 (With Port 3000 Preview Compatibility)**
  - *Chosen Approach*: `server/index.mjs` serves the built `dist/` frontend on `GET /` and all static asset MIME types alongside `/api/*` REST and SSE routes. It defaults to `127.0.0.1:20130` for macOS production while respecting `PORT` / `HV_PORT` when launched in cloud preview environments.
  - *Why*: Running `npm start` (`node server/index.mjs`) delivers the complete application from a single zero-dependency Node.js process with zero CORS friction.
- **Decision 2 — Hybrid `stream-json` + `HV_*` Wire Protocol with Direct `stdin` Decision Relay**
  - *Chosen Approach*: `server/protocol.mjs` and `server/agent.mjs` parse line-delimited JSON objects (`{"type":"system"|"text"|"tool_call"|"result"}`) from `hermes chat -q "<utterance>" --format stream-json` while retaining 100% backward compatibility with `HV_EVENT:`, `HV_PERM:`, `HV_PROGRESS:`, and raw stdout fallback. Because Hermes CLI natively waits on `stdin` for approval, `HV_DECISION` is written directly to `task.child.stdin` without `SIGSTOP`, avoiding thread deadlocks. Process groups are spawned with `detached: true` so `SIGTERM` → `5s` → `SIGKILL` cleanly reaps the entire process tree on timeout or cancel.
  - *Why*: Guarantees deadlock-free permission handshakes while ensuring both real Hermes CLI runs and `fake-hermes.mjs` test suites pass reliably.
- **Decision 3 — Strict Read-Only OmniRoute SQLite & HTTP Inspection**
  - *Chosen Approach*: `server/omniroute.mjs` inspects `~/.9router/db/data.sqlite` in strict read-only mode (via `sqlite3 -readonly -json` / URI `file:...?mode=ro`) to surface active combos and provider health when HTTP combo endpoints are absent, paired with `GET /api/health`, `GET /v1/models`, and `stream:false` chat probes.
  - *Why*: Honors the hard rule to never mutate `~/.9router/db/data.sqlite` or restart OmniRoute while giving the user real visibility into their active router combos (e.g., `KRITI / 9Router`).

---

## 4. Technical Architecture & Data Strategy *(Technical Reference)*

### Architecture & Component Diagram

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                     macOS Native Wrapper & Floating HUD                      │
│  ┌────────────────────────────────────┐  ┌────────────────────────────────┐  │
│  │ Hermes Voice.app (Swift WKWebView) │  │ CLI / PyObjC Floating Launcher │  │
│  │  • NSStatusBar Menu Item           │  │  • Borderless 420x680 Overlay  │  │
│  │  • Carbon Hotkey (⌥ Space) + AX    │  │  • Ad-hoc Signed Bundle        │  │
│  └─────────────────┬──────────────────┘  └───────────────┬────────────────┘  │
└────────────────────┼─────────────────────────────────────┼───────────────────┘
                     └──────────────────┬──────────────────┘
                                        ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                   React 19 Dark Gold UI (Dual-Mode HUD / Console)            │
│  ┌─────────────────────────┐  ┌───────────────────────┐  ┌────────────────┐  │
│  │Top Status Header        │  │Voice Deck & Waveform  │  │Permission Modal│  │
│  │ • Model (KRITI/9Router) │  │ • Canvas Input/Output │  │ • Voice Decide │  │
│  │ • Bridge 127.0.0.1:20130│  │ • 1.8s Silence Stop   │  │ • Typed ALLOW  │  │
│  │ • TTS Engine Badge      │  │ • Audio Barge-In      │  │ • Countdown    │  │
│  └────────────┬────────────┘  └───────────┬───────────┘  └───────┬────────┘  │
│               └───────────────────────────┼──────────────────────┘           │
│                                           ▼                                  │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │ Collapsible Drawer / Workspace Tabs                                    │  │
│  │ [Console] [Backend] [Settings] [Sessions] [Audit] [Logs] [Tests] [Docs]│  │
│  └────────────────────────────────────────┬───────────────────────────────┘  │
└───────────────────────────────────────────┼──────────────────────────────────┘
                                            │ HTTP / SSE (127.0.0.1:20130)
                                            ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                  Node.js Zero-Dep Local Bridge (server/index.mjs)            │
│  ┌─────────────────────────┐  ┌───────────────────────┐  ┌────────────────┐  │
│  │Static Asset Server      │  │TaskManager (agent.mjs)│  │TTS Engine      │  │
│  │ • Serves dist/ bundle   │  │ • stream-json + HV_*  │  │ • Python Venv  │  │
│  │ • Loopback guard        │  │ • Direct stdin write  │  │ • Edge TTS     │  │
│  │ • Secret Redactor       │  │ • SIGTERM -> 5s KILL  │  │ • Cache + say  │  │
│  └─────────────────────────┘  └───────────┬───────────┘  └───────┬────────┘  │
└───────────────────────────────────────────┼──────────────────────┼───────────┘
                                            │                      │
              ┌─────────────────────────────┼──────────────────────┘
              ▼                             ▼                      ▼
┌───────────────────────────┐ ┌─────────────────────────┐ ┌────────────────────┐
│ Hermes CLI Binary         │ │ OmniRoute Gateway       │ │ Python Venv + Say  │
│ ~/.hermes/.../bin/hermes  │ │ 127.0.0.1:20128 (RO)    │ │ edge-tts 7.3.1     │
│ chat -q "..." stream-json │ │ ~/.9router/db/data.sqlite│ │ ~/.hermes-voice/   │
└───────────────────────────┘ └─────────────────────────┘ └────────────────────┘
```

### Data Model & State

- **Configuration (`~/.hermes-voice/config.json`)**: Stores loopback port (`20130`), Hermes binary discovery paths (`/Users/apple/.hermes/hermes-agent/.hermes/bin/hermes`, `~/.local/bin/hermes`), Python runtime resolution (`process.env.HV_PYTHON` → `/Users/apple/.hermes/hermes-agent/venv/bin/python` → `~/.hermes/installs/*/venv/bin/python` → `python3`), TTS defaults (`hi-IN-MadhurNeural`, rate `+0%`, fallback `Rishi`), and permission policy (`timeoutSec: 60`, `autoApproveLowRisk: false`).
- **Task & Event Stream**: Tracks up to 10 concurrent tasks with monotonic event sequence numbers (`seq`), active child process group PIDs, accumulated `stream-json` text deltas, pending permission timers, and per-task session allowlists.
- **TTS Cache (`~/.hermes-voice/scratch/tts-cache/`)**: Hashes `(engine, voice, rate, redactedText)` with SHA-256 to serve repeated prompts and confirmations with zero synthesis latency.
- **OmniRoute Read-Only Snapshot**: Combines live HTTP `/api/health` and `/v1/models` with read-only SQLite inspection of `~/.9router/db/data.sqlite` to display active routing combos (`KRITI / 9Router`) and provider health.

### Interactive Component & State Mapping

- **Voice Deck & Silence Detector (`WebSTTEngine` + `useHermesVoice`)**:
  - Starts `webkitSpeechRecognition` (`lang: 'en-IN'`, fallback `'en-US'` / `'hi-IN'`, `interimResults: true`).
  - Tracks speech activity timestamps; once words are captured, a 1.8s silence timer automatically finalizes the utterance and dispatches it to the agent.
  - Tapping the mic or pressing `⌥ Space` while `speakingNow` is true immediately invokes `bargeIn()`, resetting `audioEl.current.pause()`, `audioEl.current.currentTime = 0`, and `window.speechSynthesis.cancel()`.
- **Permission Modal & Voice Decision Engine**:
  - When `state === "awaitingPermission"` and `risk` is `low` or `medium`, background voice recognition listens for affirmative (`["haan", "ha", "yes", "allow", "proceed", "kar de", "kar do", "permission di", "theek hai"]` → `allowOnce`) and negative (`["nahi", "no", "deny", "ruk", "ruko", "cancel", "mat kar"]` → `deny`) phrases.
  - When `risk === "critical"`, voice approval is rejected on both client and server (`403 voiceBlocked`), and the `Allow Once` button remains disabled until the input field equals `"ALLOW"` (`403 typedConfirmRequired` if bypassed).
- **End-to-End Verification (`scripts/verify-v1.mjs` & `server/selftest.mjs`)**:
  - Automated verification suite testing HTTP `200 OK` on `GET /` (`dist/index.html`), Python venv + `edge-tts` Hindi audio synthesis, Hermes CLI discovery and `stream-json` parsing, read-only OmniRoute inspection, and `403` rejection on untyped critical tool permissions.
