// server/geminiPool.mjs — 20-Key Round-Robin Gemini TTS Pool from ~/.9router/db/data.sqlite
// Zero-friction fallback: rotates keys on 429, falls back to Edge TTS on pool exhaustion.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { OMNIROUTE_DB } from "./config.mjs";

let cachedKeys = null;
let lastKeyScan = 0;
let currentIndex = 0;
const cooldowns = new Map(); // key -> cooldownUntilMs

export function getGeminiKeys() {
  const now = Date.now();
  if (cachedKeys && now - lastKeyScan < 60000) {
    return cachedKeys;
  }

  const dbPath = OMNIROUTE_DB || join(homedir(), ".9router/db/data.sqlite");
  if (!existsSync(dbPath)) return [];

  try {
    const pyScript = `
import sqlite3, json, sys
conn = sqlite3.connect('${dbPath}')
c = conn.cursor()
c.execute('SELECT data FROM providerConnections WHERE provider="gemini" AND isActive=1')
keys = []
for row in c.fetchall():
    try:
        d = json.loads(row[0])
        k = d.get('apiKey')
        if k: keys.append(k)
    except: pass
print(json.dumps(keys))
`;
    const out = execFileSync("python3", ["-c", pyScript], { encoding: "utf8", timeout: 3000 });
    cachedKeys = JSON.parse(out.trim());
    lastKeyScan = now;
    return cachedKeys;
  } catch {
    return [];
  }
}

/**
 * Synthesizes high-fidelity 24kHz Hindi/English audio using the 20-Key Gemini pool.
 * Voice: "Kore" (warm, expressive, natural breathing).
 */
export async function synthesizeGeminiLiveVoice(text, voiceName = "Kore", log) {
  const keys = getGeminiKeys();
  if (!keys || !keys.length) {
    throw new Error("No active Gemini keys found in OmniRoute database.");
  }

  const now = Date.now();
  let attempts = 0;

  while (attempts < Math.min(keys.length, 6)) {
    const key = keys[currentIndex % keys.length];
    currentIndex = (currentIndex + 1) % keys.length;
    attempts++;

    // Skip keys on cooldown
    if (cooldowns.has(key) && cooldowns.get(key) > now) {
      continue;
    }

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-tts:generateContent?key=${key}`;
      const payload = {
        contents: [{ parts: [{ text: String(text).slice(0, 800) }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: voiceName || "Kore"
              }
            }
          }
        }
      };

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(9000)
      });

      if (res.status === 429 || res.status === 403) {
        log?.warn("tts", `Gemini key ${key.slice(0, 8)}... rate-limited (${res.status}) — rotating to next key`);
        cooldowns.set(key, now + 10 * 60 * 1000); // 10 min cooldown
        continue;
      }

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        log?.warn("tts", `Gemini TTS ${res.status}: ${errText.slice(0, 120)}`);
        continue;
      }

      const data = await res.json();
      const b64 = data.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (b64) {
        return Buffer.from(b64, "base64");
      }
    } catch (e) {
      log?.warn("tts", `Gemini TTS fetch error: ${e.message}`);
    }
  }

  throw new Error("All active Gemini keys in pool temporarily rate-limited or unavailable.");
}
