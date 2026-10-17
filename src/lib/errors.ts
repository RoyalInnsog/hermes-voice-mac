// Section 28 — Error catalog. Every error carries a Hinglish user message,
// a short spoken message (<3s), a suggested fix and a recoverable flag.

import type { Lang } from "./types";

export type ErrorCode =
  | "micPermissionDenied"
  | "speechPermissionDenied"
  | "sttUnsupported"
  | "hermesNotFound"
  | "hermesTimeout"
  | "hermesCrashed"
  | "omnirouteDown"
  | "omnirouteProbeFailed"
  | "sttFailed"
  | "sttLowConfidence"
  | "ttsFailed"
  | "ttsEngineMissing"
  | "permissionTimeout"
  | "permissionDeniedByUser"
  | "parseFailed"
  | "invalidTransition"
  | "sessionSaveFailed"
  | "bridgeNotImplemented"
  | "unknown";

export interface ErrorSpec {
  code: ErrorCode;
  userMessage: { hinglish: string; english: string };
  spoken: { hinglish: string; english: string };
  fix: { hinglish: string; english: string };
  recoverable: boolean;
}

export const ERRORS: Record<ErrorCode, ErrorSpec> = {
  micPermissionDenied: {
    code: "micPermissionDenied",
    userMessage: { hinglish: "Mic permission nahi mila.", english: "Microphone permission denied." },
    spoken: { hinglish: "Mic permission chahiye.", english: "Microphone permission required." },
    fix: { hinglish: "Browser/System Settings → Privacy → Microphone → Hermes Voice allow karo.", english: "Allow microphone access in browser/system privacy settings." },
    recoverable: false,
  },
  speechPermissionDenied: {
    code: "speechPermissionDenied",
    userMessage: { hinglish: "Speech recognition permission nahi mila.", english: "Speech recognition permission denied." },
    spoken: { hinglish: "Speech permission chahiye.", english: "Speech permission required." },
    fix: { hinglish: "System Settings → Privacy → Speech Recognition on karo.", english: "Enable Speech Recognition in privacy settings." },
    recoverable: false,
  },
  sttUnsupported: {
    code: "sttUnsupported",
    userMessage: { hinglish: "Is browser me speech recognition nahi hai.", english: "This browser has no speech recognition." },
    spoken: { hinglish: "STT support nahi hai.", english: "Speech recognition unsupported." },
    fix: { hinglish: "Chrome/Edge/Safari use karo, ya type-mode se test karo.", english: "Use Chrome/Edge/Safari, or use type-mode." },
    recoverable: false,
  },
  hermesNotFound: {
    code: "hermesNotFound",
    userMessage: { hinglish: "Hermes binary nahi mila.", english: "Hermes binary not found." },
    spoken: { hinglish: "Hermes nahi mila.", english: "Hermes not found." },
    fix: { hinglish: "`which hermes` chala ke Settings → Agent me path paste karo.", english: "Run `which hermes` and paste the path in Settings → Agent." },
    recoverable: false,
  },
  hermesTimeout: {
    code: "hermesTimeout",
    userMessage: { hinglish: "Hermes time pe respond nahi kiya.", english: "Hermes did not respond in time." },
    spoken: { hinglish: "Hermes timeout.", english: "Hermes timed out." },
    fix: { hinglish: "Timeout Settings me badhao ya task chhota karo.", english: "Increase the timeout or shorten the task." },
    recoverable: true,
  },
  hermesCrashed: {
    code: "hermesCrashed",
    userMessage: { hinglish: "Hermes crash ho gaya.", english: "Hermes crashed." },
    spoken: { hinglish: "Hermes crash.", english: "Hermes crashed." },
    fix: { hinglish: "Terminal me `hermes chat -q hi` chala ke check karo.", english: "Run `hermes chat -q hi` in a terminal." },
    recoverable: true,
  },
  omnirouteDown: {
    code: "omnirouteDown",
    userMessage: { hinglish: "Omniroute reachable nahi hai.", english: "Omniroute is unreachable." },
    spoken: { hinglish: "Router down hai.", english: "Router is down." },
    fix: { hinglish: "`curl http://127.0.0.1:20128/api/health` chalao. Process ko kill mat karna.", english: "Run `curl http://127.0.0.1:20128/api/health`. Never kill the process." },
    recoverable: true,
  },
  omnirouteProbeFailed: {
    code: "omnirouteProbeFailed",
    userMessage: { hinglish: "Omniroute probe fail hua.", english: "Omniroute probe failed." },
    spoken: { hinglish: "Probe fail.", english: "Probe failed." },
    fix: { hinglish: "Model name verify karo; stream:false bhejna mat bhoolna.", english: "Verify the model id; always send stream:false." },
    recoverable: true,
  },
  sttFailed: {
    code: "sttFailed",
    userMessage: { hinglish: "Speech recognition fail hua.", english: "Speech recognition failed." },
    spoken: { hinglish: "STT fail.", english: "Speech recognition failed." },
    fix: { hinglish: "Locale change karo ya mic re-check karo.", english: "Change locale or re-check the microphone." },
    recoverable: true,
  },
  sttLowConfidence: {
    code: "sttLowConfidence",
    userMessage: { hinglish: "Maine clearly nahi suna.", english: "I did not hear that clearly." },
    spoken: { hinglish: "Repeat karo.", english: "Please repeat." },
    fix: { hinglish: "Mic paas rakho, background noise kam karo.", english: "Move closer to the mic, reduce noise." },
    recoverable: true,
  },
  ttsFailed: {
    code: "ttsFailed",
    userMessage: { hinglish: "Voice output fail hua.", english: "Voice output failed." },
    spoken: { hinglish: "TTS fail.", english: "Text to speech failed." },
    fix: { hinglish: "Settings → Voice me engine badlo.", english: "Switch the engine in Settings → Voice." },
    recoverable: true,
  },
  ttsEngineMissing: {
    code: "ttsEngineMissing",
    userMessage: { hinglish: "Chuna hua TTS engine is environment me nahi hai.", english: "Selected TTS engine unavailable here." },
    spoken: { hinglish: "TTS engine nahi hai.", english: "TTS engine missing." },
    fix: { hinglish: "System voice pe fallback ho gaya. Native app me `pip install edge-tts`.", english: "Fell back to system voice. In the native app run `pip install edge-tts`." },
    recoverable: true,
  },
  permissionTimeout: {
    code: "permissionTimeout",
    userMessage: { hinglish: "Permission time pe nahi mili, auto-deny.", english: "Permission timed out, auto-denied." },
    spoken: { hinglish: "Permission timeout, denied.", english: "Permission timed out, denied." },
    fix: { hinglish: "Timeout Settings → Permissions me badhao.", english: "Increase the timeout in Settings → Permissions." },
    recoverable: true,
  },
  permissionDeniedByUser: {
    code: "permissionDeniedByUser",
    userMessage: { hinglish: "Tumne permission deny ki.", english: "You denied the permission." },
    spoken: { hinglish: "Denied.", english: "Denied." },
    fix: { hinglish: "—", english: "—" },
    recoverable: true,
  },
  parseFailed: {
    code: "parseFailed",
    userMessage: { hinglish: "Hermes output parse nahi hua.", english: "Could not parse Hermes output." },
    spoken: { hinglish: "Parse fail.", english: "Parse failed." },
    fix: { hinglish: "Raw output overlay me dekho; adapter update karo.", english: "Inspect raw output in the overlay; update the adapter." },
    recoverable: true,
  },
  invalidTransition: {
    code: "invalidTransition",
    userMessage: { hinglish: "Internal state error (transition reject hui).", english: "Internal state error (rejected transition)." },
    spoken: { hinglish: "State error.", english: "State error." },
    fix: { hinglish: "Logs tab dekho; ye non-fatal hai.", english: "Check the Logs tab; this is non-fatal." },
    recoverable: true,
  },
  sessionSaveFailed: {
    code: "sessionSaveFailed",
    userMessage: { hinglish: "Session save nahi hua.", english: "Session could not be saved." },
    spoken: { hinglish: "Save fail.", english: "Save failed." },
    fix: { hinglish: "Storage quota check karo.", english: "Check storage quota." },
    recoverable: true,
  },
  bridgeNotImplemented: {
    code: "bridgeNotImplemented",
    userMessage: { hinglish: "Ye bridge is environment me available nahi hai.", english: "This bridge is unavailable in this environment." },
    spoken: { hinglish: "Bridge available nahi hai.", english: "Bridge unavailable." },
    fix: { hinglish: "Mock bridge use karo ya native macOS build chalao. Dekho LIMITATIONS.", english: "Use the mock bridge or run the native macOS build. See LIMITATIONS." },
    recoverable: true,
  },
  unknown: {
    code: "unknown",
    userMessage: { hinglish: "Kuch galat hua.", english: "Something went wrong." },
    spoken: { hinglish: "Error.", english: "Error." },
    fix: { hinglish: "Logs tab dekho.", english: "Check the Logs tab." },
    recoverable: true,
  },
};

export function errText(code: ErrorCode, lang: Lang) {
  const e = ERRORS[code];
  return {
    user: lang === "english" ? e.userMessage.english : e.userMessage.hinglish,
    spoken: lang === "english" ? e.spoken.english : e.spoken.hinglish,
    fix: lang === "english" ? e.fix.english : e.fix.hinglish,
    recoverable: e.recoverable,
  };
}

/** Retry with exponential backoff — Section 8.6 (2 retries: 1s, 2s). */
export async function withRetry<T>(
  fn: () => Promise<T>,
  attempts = 3,
  baseDelayMs = 1000,
  onRetry?: (attempt: number, err: unknown) => void,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1) break;
      onRetry?.(i + 1, err);
      await new Promise((r) => setTimeout(r, baseDelayMs * Math.pow(2, i)));
    }
  }
  throw lastErr;
}
