# Hermes Voice (macOS)

macOS Voice Front-End for the Hermes Autonomous Agent connected to OmniRoute.

## Architecture
- **Backend:** Node.js HTTP/SSE bridge (`server/index.mjs`) on `127.0.0.1:20130`.
- **Agent Bridge:** TaskManager (`server/agent.mjs`) with process-group kill, 10-task concurrency cap, permission interception.
- **TTS Engine:** Microsoft Edge TTS (`hi-IN-MadhurNeural`) with macOS `say` fallback (`server/tts.mjs`).
- **Frontend:** React 19 + Tailwind CSS + Vite (`src/`) featuring an 8-tab dashboard (Console, Backend, Settings, Sessions, Audit, Logs, Tests, Docs).

## Verification
```bash
node server/selftest.mjs
# 29/29 passed
```

## Running
```bash
npm install
npm run build
node server/index.mjs
```
