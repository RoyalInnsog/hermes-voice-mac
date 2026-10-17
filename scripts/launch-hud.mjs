#!/usr/bin/env node
// scripts/launch-hud.mjs — CLI & macOS Floating HUD Launcher (Hermes Voice v1.0).
//
// 1. Ensures `server/index.mjs` is running on http://127.0.0.1:20130
// 2. On macOS:
//    • If `dist/Hermes Voice.app` is built, opens the native floating WKWebView bundle.
//    • Otherwise opens a compact 420x680 Chrome/Brave/Edge `--app=http://127.0.0.1:20130/?hud=1`
//      window or default browser.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, "..");
const PORT = Number(process.env.HV_PORT || 20130);
const HUD_URL = `http://127.0.0.1:${PORT}/?hud=1`;

async function isBridgeUp() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/health`, {
      signal: AbortSignal.timeout(1000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  let up = await isBridgeUp();
  let bridgeChild = null;

  if (!up) {
    console.log(`[hermes-voice] Starting local bridge on http://127.0.0.1:${PORT} ...`);
    bridgeChild = spawn(process.execPath, [resolve(ROOT_DIR, "server/index.mjs")], {
      cwd: ROOT_DIR,
      stdio: "inherit",
    });
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 150));
      if (await isBridgeUp()) {
        up = true;
        break;
      }
    }
  } else {
    console.log(`[hermes-voice] Local bridge already active on http://127.0.0.1:${PORT}`);
  }

  if (process.platform === "darwin") {
    const appBundle = resolve(ROOT_DIR, "dist/Hermes Voice.app");
    if (existsSync(appBundle)) {
      console.log(`[hermes-voice] Opening native bundle: ${appBundle}`);
      spawn("open", ["-a", appBundle], { stdio: "ignore", detached: true }).unref();
    } else {
      const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
      if (existsSync(chromePath)) {
        console.log(`[hermes-voice] Launching 420x680 HUD overlay window (${HUD_URL})...`);
        spawn(chromePath, [`--app=${HUD_URL}`, "--window-size=420,680"], {
          stdio: "ignore",
          detached: true,
        }).unref();
      } else {
        spawn("open", [HUD_URL], { stdio: "ignore", detached: true }).unref();
      }
    }
  } else {
    console.log(`[hermes-voice] HUD ready at: ${HUD_URL}`);
  }

  if (bridgeChild) {
    process.on("SIGINT", () => {
      bridgeChild.kill("SIGTERM");
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error("[hermes-voice] Launcher error:", err);
  process.exit(1);
});
