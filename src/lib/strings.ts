// Section 29 — UI copy deck. Hinglish default, English fallback.

import type { Lang } from "./types";
import type { StateName } from "./stateMachine";

type Pair = { hinglish: string; english: string };

export const COPY = {
  state_idle: { hinglish: "Ready", english: "Ready" },
  state_starting: { hinglish: "Shuru ho raha hai...", english: "Starting..." },
  state_listening: { hinglish: "Sun raha hoon...", english: "Listening..." },
  state_transcribing: { hinglish: "Samajh raha hoon...", english: "Transcribing..." },
  state_confirmingTranscript: { hinglish: "Confirm karo", english: "Confirm transcript" },
  state_thinking: { hinglish: "Soch raha hoon...", english: "Thinking..." },
  state_awaitingPermission: { hinglish: "Permission chahiye", english: "Permission needed" },
  state_speaking: { hinglish: "Bol raha hoon...", english: "Speaking..." },
  state_cancelling: { hinglish: "Cancel kar raha hoon...", english: "Cancelling..." },
  state_degraded: { hinglish: "Degraded mode", english: "Degraded mode" },
  state_error: { hinglish: "Error", english: "Error" },

  taskStart: { hinglish: "Kaam shuru kar raha hoon.", english: "Starting the task." },
  taskDone: { hinglish: "Task ho gaya.", english: "Task complete." },
  taskFailed: { hinglish: "Kaam fail hua", english: "Task failed" },
  taskCancelled: { hinglish: "Task cancel ho gaya.", english: "Task cancelled." },
  cancelled: { hinglish: "Cancelled.", english: "Cancelled." },
  discarded: { hinglish: "Discard kar diya.", english: "Discarded." },
  ready: { hinglish: "Ready.", english: "Ready." },
  permissionTimeout: { hinglish: "Permission timeout, deny kar diya.", english: "Permission timed out, denied." },
  permissionDenied: { hinglish: "Permission deny ki gayi.", english: "Permission denied." },
  permissionGranted: { hinglish: "Permission mil gayi, aage badh raha hoon.", english: "Permission granted, continuing." },
  omnirouteDown: { hinglish: "Omniroute reachable nahi hai.", english: "Omniroute is not reachable." },
  hermesNotFound: { hinglish: "Hermes nahi mila. Settings me path set karo.", english: "Hermes not found. Set the path in Settings." },
  ttsMissing: { hinglish: "Edge TTS nahi hai. System voice use kar raha hoon.", english: "Edge TTS missing. Falling back to system voice." },
  lowConfidence: { hinglish: "Clear nahi suna. Confirm karo.", english: "Low confidence. Please confirm." },

  btn_allowOnce: { hinglish: "Allow once", english: "Allow once" },
  btn_allowSession: { hinglish: "Allow for session", english: "Allow for session" },
  btn_deny: { hinglish: "Deny", english: "Deny" },
  btn_cancel: { hinglish: "Cancel", english: "Cancel" },
  btn_showRaw: { hinglish: "Show raw", english: "Show raw" },
  btn_send: { hinglish: "Send", english: "Send" },
  btn_discard: { hinglish: "Discard", english: "Discard" },
  btn_retry: { hinglish: "Retry", english: "Retry" },
  btn_settings: { hinglish: "Settings", english: "Settings" },
  btn_quit: { hinglish: "Quit", english: "Quit" },

  tab_general: { hinglish: "General", english: "General" },
  tab_voice: { hinglish: "Voice", english: "Voice" },
  tab_agent: { hinglish: "Agent", english: "Agent" },
  tab_router: { hinglish: "Router", english: "Router" },
  tab_permissions: { hinglish: "Permissions", english: "Permissions" },
  tab_privacy: { hinglish: "Privacy", english: "Privacy" },
  tab_about: { hinglish: "About", english: "About" },
} satisfies Record<string, Pair>;

export type CopyKey = keyof typeof COPY;

export function t(key: CopyKey, lang: Lang): string {
  const pair = COPY[key];
  return lang === "english" ? pair.english : pair.hinglish;
}

export function stateCopy(state: StateName, lang: Lang): string {
  const key = ("state_" + state) as CopyKey;
  return COPY[key] ? t(key, lang) : state;
}

export function confirmTranscriptPrompt(text: string, lang: Lang): string {
  return lang === "english" ? `I heard: ${text}. Send it?` : `Maine suna: ${text}. Bhejoon?`;
}

export function permissionAskPrompt(tool: string, risk: string, lang: Lang): string {
  return lang === "english"
    ? `Permission needed for ${tool}, risk ${risk}. Allow?`
    : `Permission chahiye: ${tool}, risk ${risk}. Allow karoon?`;
}
