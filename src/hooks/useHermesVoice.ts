// The Voice Orchestrator — spec §4.1 / §8.x, wired to the UI and to the real local bridge (v1.0).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { attempt, type StateName } from "../lib/stateMachine";
import { logger } from "../lib/logger";
import { formatArgs, redact, redactArgs } from "../lib/redactor";
import { allowsVoiceApproval, canAutoApprove } from "../lib/risk";
import { makeBridge, type AgentBridge } from "../lib/agentBridge";
import { BridgeClient, LocalBridge, type BridgeServerHealth, type ServerTestResult } from "../lib/localBridge";
import { OmnirouteClient, type ProbeResult } from "../lib/omniroute";
import { duckSystemAudio, mapVoiceDecision, restoreSystemAudio, speechify, summarizeForSpeech, WebSTTEngine, WebTTSEngine } from "../lib/speech";
import { appendAudit, clearAudit, deleteSessions, loadAudit, loadSessions, loadSettings, saveSession, saveSettings } from "../lib/store";
import { errText, type ErrorCode } from "../lib/errors";
import { confirmTranscriptPrompt, permissionAskPrompt, t } from "../lib/strings";
import {
  uid,
  type AgentEvent,
  type ApprovalDecision,
  type ApprovalOutcome,
  type AuditEntry,
  type ComboInfo,
  type HealthStatus,
  type LogLine,
  type ModelInfo,
  type PermissionRequest,
  type Session,
  type Settings,
  type Utterance,
} from "../lib/types";

export interface TimelineItem {
  id: string;
  at: number;
  kind: "user" | "assistant" | "tool" | "progress" | "permission" | "error" | "system";
  text: string;
  meta?: string;
}

export interface ActiveError {
  code: ErrorCode;
  user: string;
  fix: string;
  at: number;
}

export interface BackendSnapshot {
  health: BridgeServerHealth | null;
  reachable: boolean;
  lastChecked: number;
  reason: string;
  tests: { results: ServerTestResult[]; passed: number; total: number } | null;
  testsRunning: boolean;
  logs: LogLine[];
  audit: AuditEntry[];
  sessions: Session[];
  memory: { root: string; files: string[]; available: boolean; note?: string } | null;
  memoryText: { path: string; text: string } | null;
}

const MAX_UTTERANCE_MS = 120_000;
const emptyBackend: BackendSnapshot = {
  health: null,
  reachable: false,
  lastChecked: 0,
  reason: "not probed yet",
  tests: null,
  testsRunning: false,
  logs: [],
  audit: [],
  sessions: [],
  memory: null,
  memoryText: null,
};

export function useHermesVoice() {
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const [state, setStateRaw] = useState<StateName>("starting");
  const stateRef = useRef<StateName>("starting");

  const [partial, setPartial] = useState("");
  const [level, setLevel] = useState(0);
  const [playbackLevel, setPlaybackLevel] = useState(0);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [pending, setPending] = useState<PermissionRequest | null>(null);
  const [pendingRemaining, setPendingRemaining] = useState(0);
  const [pendingConfirm, setPendingConfirm] = useState<{ text: string; confidence: number } | null>(null);
  const [lastAssistant, setLastAssistant] = useState("");
  const [activeError, setActiveError] = useState<ActiveError | null>(null);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [combos, setCombos] = useState<{ combos: ComboInfo[]; pathUsed: string | null }>({ combos: [], pathUsed: null });
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [sessions, setSessions] = useState<Session[]>(() => loadSessions());
  const [audit, setAudit] = useState<AuditEntry[]>(() => loadAudit());
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [backend, setBackend] = useState<BackendSnapshot>(emptyBackend);
  const [sttSupported] = useState(() => WebSTTEngine.supported());
  const [ttsSupported] = useState(() => WebTTSEngine.supported());
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [sessionAllowlist, setSessionAllowlist] = useState<string[]>([]);
  const [speakingNow, setSpeakingNow] = useState(false);

  const stt = useRef<WebSTTEngine | null>(null);
  const tts = useRef<WebTTSEngine | null>(null);
  const audioEl = useRef<HTMLAudioElement | null>(null);
  const playbackMeterRaf = useRef<number>(0);
  const bridgeRef = useRef<AgentBridge | null>(null);
  const clientRef = useRef<BridgeClient>(new BridgeClient(settings.bridgeURL));
  const mockBridge = useRef<AgentBridge>(makeBridge("mock", { hermesPath: "", workingDir: "", timeoutSec: 0, httpBaseURL: "" }));
  const approvalResolver = useRef<((o: ApprovalOutcome) => void) | null>(null);
  const permTimer = useRef<number | null>(null);
  const cancelFlag = useRef(false);
  const currentTask = useRef<string | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const listenStart = useRef(0);
  const maxLenTimer = useRef<number | null>(null);
  const confirmTimer = useRef<number | null>(null);
  const allowlistRef = useRef<string[]>([]);
  allowlistRef.current = sessionAllowlist;

  /* ------------------------------ plumbing ------------------------------ */

  const push = useCallback((item: Omit<TimelineItem, "id" | "at">) => {
    setTimeline((prev) => [...prev.slice(-90), { ...item, id: uid(), at: Date.now() }]);
  }, []);

  const setState = useCallback((to: StateName, why?: string) => {
    const from = stateRef.current;
    const res = attempt(from, to);
    if (!res.ok) {
      logger.warn("state", `${res.reason}${why ? ` (${why})` : ""}`);
      return false;
    }
    if (from !== to) logger.debug("state", `${from} → ${to}${why ? ` (${why})` : ""}`);
    stateRef.current = to;
    setStateRaw(to);
    return true;
  }, []);

  /**
   * Smart audio barge-in / interruption (spec §0.5 / §2.4):
   * Immediately halts any active Edge TTS HTMLAudioElement or Web Speech synthesis.
   */
  const bargeIn = useCallback(() => {
    cancelAnimationFrame(playbackMeterRaf.current);
    setPlaybackLevel(0);
    if (audioEl.current) {
      try {
        audioEl.current.pause();
        audioEl.current.currentTime = 0;
      } catch {
        /* ignore */
      }
    }
    tts.current?.stop();
    setSpeakingNow(false);
    restoreSystemAudio(settingsRef.current.bridgeURL);
  }, []);

  /** Speak via the bridge's Edge TTS when available; otherwise the system voice. */
  const playBridgeAudio = useCallback(
    async (text: string): Promise<boolean> => {
      const s = settingsRef.current;
      if (!s.useBridgeTTS || !backend.reachable) return false;
      try {
        const preferredVoice = s.lang === "english" ? "en-IN-NeerjaNeural" : "hi-IN-MadhurNeural";
        const res = await clientRef.current.tts(text, preferredVoice, s.ttsEngine === "edgeTTS" ? "auto" : undefined);
        if (!res.ok) {
          logger.warn("tts", `bridge tts refused: ${res.message ?? res.error} (${res.hint ?? "no hint"})`);
          return false;
        }
        const url = clientRef.current.resolveMediaUrl(res.url);
        const el = audioEl.current ?? new Audio();
        audioEl.current = el;
        el.src = url;
        el.volume = s.ttsVolume;
        duckSystemAudio(s.bridgeURL);
        setSpeakingNow(true);

        // Animate playback waveform energy while audio plays
        const startWave = () => {
          const tick = () => {
            if (el.paused || el.ended) {
              setPlaybackLevel(0);
              return;
            }
            const tNow = performance.now() / 1000;
            const synthEnergy = 0.22 + 0.18 * Math.sin(tNow * 11.5) + 0.12 * Math.cos(tNow * 19.3);
            setPlaybackLevel(Math.max(0.05, Math.min(1, synthEnergy)));
            playbackMeterRaf.current = requestAnimationFrame(tick);
          };
          tick();
        };

        await el.play();
        startWave();
        await new Promise<void>((r) => {
          el.onended = () => r();
          el.onerror = () => r();
          setTimeout(r, 45000);
        });
        cancelAnimationFrame(playbackMeterRaf.current);
        setPlaybackLevel(0);
        setSpeakingNow(false);
        restoreSystemAudio(s.bridgeURL);
        logger.info("tts", `played ${res.bytes}B from bridge engine=${res.engine}${res.cached ? " (cached)" : ""} in ${res.ms}ms`);
        return true;
      } catch (e) {
        cancelAnimationFrame(playbackMeterRaf.current);
        setPlaybackLevel(0);
        setSpeakingNow(false);
        restoreSystemAudio(s.bridgeURL);
        logger.warn("tts", `bridge audio playback failed: ${e instanceof Error ? e.message : String(e)}`);
        return false;
      }
    },
    [backend.reachable],
  );

  const speak = useCallback(
    async (text: string, priority: "low" | "normal" | "high" = "normal") => {
      const s = settingsRef.current;
      if (!text.trim()) return;
      logger.debug("tts", `speak(${priority}): ${text.slice(0, 90)}`);
      if (s.ttsEngine !== "webSpeech" || s.useBridgeTTS) {
        const spoken = s.ttsEngine === "webSpeech" ? text : summarizeForSpeech(text);
        if (await playBridgeAudio(speechify(spoken))) return;
        if (s.ttsEngine !== "webSpeech") logger.warn("tts", `engine "${s.ttsEngine}" unavailable → falling back to system voice`);
      }
      if (!tts.current) return;
      duckSystemAudio(s.bridgeURL);
      setSpeakingNow(true);
      setPlaybackLevel(0.35);
      await tts.current.speak(speechify(text), {
        priority,
        lang: s.sttLocale,
        rate: s.ttsRate,
        pitch: s.ttsPitch,
        volume: s.ttsVolume,
        voiceURI: s.ttsVoiceURI,
      });
      setPlaybackLevel(0);
      setSpeakingNow(false);
      restoreSystemAudio(s.bridgeURL);
    },
    [playBridgeAudio],
  );

  const raise = useCallback(
    (code: ErrorCode, extra?: string) => {
      const e = errText(code, settingsRef.current.lang);
      logger.error("app", `${code}: ${e.user}${extra ? " — " + extra : ""}`);
      setActiveError({ code, user: e.user, fix: e.fix, at: Date.now() });
      push({ kind: "error", text: e.user, meta: e.fix });
      void speak(e.spoken, "high");
    },
    [push, speak],
  );

  /* --------------------------- session handling -------------------------- */

  const ensureSession = useCallback((): Session => {
    if (sessionRef.current) return sessionRef.current;
    const s: Session = { schemaVersion: 1, id: uid(), startedAt: Date.now(), endedAt: null, status: "active", utterances: [] };
    sessionRef.current = s;
    return s;
  }, []);

  const appendUtterance = useCallback(
    (u: Utterance) => {
      const s = ensureSession();
      s.utterances = [...s.utterances, u];
      if (!saveSession(s)) logger.error("app", "sessionSaveFailed: localStorage write rejected");
      setSessions(loadSessions());
    },
    [ensureSession],
  );

  const endSession = useCallback(() => {
    const s = sessionRef.current;
    if (!s) return;
    s.endedAt = Date.now();
    s.status = "completed";
    saveSession(s);
    setSessions(loadSessions());
    sessionRef.current = null;
    setSessionAllowlist([]);
  }, []);

  /* ------------------------------ permission ----------------------------- */

  const logAudit = useCallback((req: PermissionRequest, decision: AuditEntry["decision"], via: AuditEntry["via"]) => {
    const entry: AuditEntry = {
      id: uid(),
      at: Date.now(),
      toolName: req.toolName,
      risk: req.risk,
      decision,
      argsRedacted: formatArgs(redactArgs(req.args)),
      via,
    };
    appendAudit(entry);
    setAudit(loadAudit());
    logger.info("permissions", `${req.toolName} [${req.risk}] → ${decision} (via ${via}) ${entry.argsRedacted}`);
  }, []);

  const clearPermTimer = () => {
    if (permTimer.current) {
      window.clearInterval(permTimer.current);
      permTimer.current = null;
    }
  };

  const resolvePermission = useCallback(
    (decision: ApprovalDecision, via: "click" | "voice", typedConfirm: string | null = null) => {
      const req = pending;
      if (!req || !approvalResolver.current) return;
      clearPermTimer();
      stt.current?.abort();
      logAudit(req, via === "click" && decision === "deny" && typedConfirm === "__timeout" ? "timeout-deny" : decision, via);
      if (decision === "allowSession") {
        allowlistRef.current = allowlistRef.current.includes(req.toolName) ? allowlistRef.current : [...allowlistRef.current, req.toolName];
        setSessionAllowlist(allowlistRef.current);
      }
      push({ kind: "permission", text: `${req.toolName} → ${decision.toUpperCase()}`, meta: `${req.risk} · via ${via}` });
      const resolver = approvalResolver.current;
      approvalResolver.current = null;
      setPending(null);
      setPendingRemaining(0);
      setState("thinking", "permission resolved");
      void speak(decision === "deny" ? t("permissionDenied", settingsRef.current.lang) : t("permissionGranted", settingsRef.current.lang), decision === "deny" ? "high" : "low");
      resolver({ decision, via, typedConfirm });
    },
    [pending, logAudit, push, setState, speak],
  );

  const timeoutDeny = useCallback(() => {
    const req = pending;
    if (!req || !approvalResolver.current) return;
    clearPermTimer();
    stt.current?.abort();
    logAudit(req, "timeout-deny", "timeout");
    push({ kind: "permission", text: `${req.toolName} → TIMEOUT-DENY`, meta: "auto-deny" });
    const resolver = approvalResolver.current;
    approvalResolver.current = null;
    setPending(null);
    setState("thinking", "permission timeout");
    void speak(t("permissionTimeout", settingsRef.current.lang), "high");
    resolver({ decision: "deny", via: "click" });
  }, [pending, logAudit, push, setState, speak]);

  const requestApproval = useCallback(
    (req: PermissionRequest): Promise<ApprovalOutcome> => {
      const s = settingsRef.current;
      if (canAutoApprove(req.risk, s.autoApproveLowRisk)) {
        logAudit(req, "allowOnce", "policy");
        push({ kind: "permission", text: `${req.toolName} → AUTO-ALLOW (low-risk policy)`, meta: "policy" });
        return Promise.resolve({ decision: "allowOnce", via: "click" });
      }
      if (allowlistRef.current.includes(req.toolName) && req.risk !== "critical") {
        logAudit(req, "allowSession", "policy");
        push({ kind: "permission", text: `${req.toolName} → ALLOW (session allowlist)`, meta: "policy" });
        return Promise.resolve({ decision: "allowSession", via: "click" });
      }

      const timeoutSec = s.permissionTimeoutSec;
      const withExpiry: PermissionRequest = { ...req, expiresAt: req.expiresAt || Date.now() + timeoutSec * 1000 };
      setPending(withExpiry);
      setPendingRemaining(Math.max(0, Math.ceil((withExpiry.expiresAt - Date.now()) / 1000)));
      setState("awaitingPermission", "bridge requested approval");
      push({ kind: "permission", text: `Permission chahiye: ${req.toolName}`, meta: `${req.risk} · ${formatArgs(redactArgs(req.args))}` });
      void speak(permissionAskPrompt(req.toolName, req.risk, s.lang), "high");

      clearPermTimer();
      const deadline = withExpiry.expiresAt;
      permTimer.current = window.setInterval(() => {
        const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
        setPendingRemaining(left);
        if (left <= 0) {
          clearPermTimer();
          timeoutDeny();
        }
      }, 250);

      return new Promise<ApprovalOutcome>((resolve) => {
        approvalResolver.current = resolve;
      });
    },
    [logAudit, push, setState, speak, timeoutDeny],
  );

  /* ------------------------------- agent run ----------------------------- */

  const handleEvent = useCallback(
    (e: AgentEvent) => {
      const s = settingsRef.current;
      switch (e.kind) {
        case "thinking":
          setState("thinking", "agent thinking");
          break;
        case "toolCall":
          push({ kind: "tool", text: e.name, meta: formatArgs(redactArgs(e.args)) });
          logger.info("agent", `toolCall ${e.name} ${formatArgs(redactArgs(e.args))}`);
          break;
        case "progress": {
          push({ kind: "progress", text: e.text });
          const isMidTaskPing = e.text.startsWith("🔊 ");
          const spokenText = isMidTaskPing ? e.text.replace(/^🔊\s*/, "") : e.text;
          if ((isMidTaskPing || s.speakProgress) && spokenText.length < 140) {
            void speak(spokenText, "low");
          }
          break;
        }
        case "completed": {
          setLastAssistant(e.text);
          push({ kind: "assistant", text: e.text });
          appendUtterance({ id: uid(), timestamp: Date.now(), role: "assistant", text: e.text, audioDuration: null, confidence: null });
          setState("speaking", "task completed");
          void speak(`${t("taskDone", s.lang)} ${summarizeForSpeech(e.text)}`, "normal").then(() => {
            setState("idle", "report delivered");
            endSession();
          });
          break;
        }
        case "failed":
          push({ kind: "error", text: `${t("taskFailed", s.lang)}: ${e.reason}` });
          setState("idle", "task failed");
          raise("hermesCrashed", e.reason);
          break;
        case "cancelled":
          push({ kind: "system", text: t("taskCancelled", s.lang) });
          setState("idle", "task cancelled");
          void speak(t("taskCancelled", s.lang), "high");
          break;
      }
    },
    [appendUtterance, endSession, push, raise, setState, speak],
  );

  const runAgent = useCallback(
    async (text: string, confidence: number | null, durationMs: number | null) => {
      const s = settingsRef.current;
      const configured = bridgeRef.current;
      if (!configured) return;

      let bridge = configured;
      const avail = configured.available();
      if (!avail.ok) {
        if (s.bridgeMode === "local") {
          bridge = mockBridge.current;
          logger.warn("agent", `local bridge offline → simulator mode. ${avail.reason}`);
          push({ kind: "system", text: "Local bridge offline — simulator mode me chala raha hoon (real hermes spawn nahi hoga).", meta: avail.reason });
        } else {
          raise("bridgeNotImplemented", avail.reason);
          setState("idle", "bridge unavailable");
          return;
        }
      }

      const session = ensureSession();
      appendUtterance({ id: uid(), timestamp: Date.now(), role: "user", text, audioDuration: durationMs ? durationMs / 1000 : null, confidence });
      push({ kind: "user", text, meta: confidence !== null ? `confidence ${(confidence * 100).toFixed(0)}%` : "typed" });

      const taskID = uid();
      currentTask.current = taskID;
      cancelFlag.current = false;
      setState("thinking", "dispatching to agent");
      void speak(t("taskStart", s.lang), "low");
      logger.info("agent", `send → "${redact(text)}" (task ${taskID.slice(0, 8)}, bridge ${bridge.id})`);

      const timeoutHandle = window.setTimeout(() => {
        if (currentTask.current === taskID) {
          cancelFlag.current = true;
          raise("hermesTimeout");
          setState("idle", "agent timeout");
        }
      }, s.hermesTimeoutSec * 1000);

      try {
        await bridge.send({
          utterance: text,
          sessionId: session.id,
          taskID,
          permissionTimeoutSec: s.permissionTimeoutSec,
          onEvent: handleEvent,
          requestApproval,
          isCancelled: () => cancelFlag.current,
        });
      } catch (err) {
        const e = err as Error & { code?: string; hint?: string };
        if (e.code === "tooManyTasks") raise("hermesCrashed", `10-task hard cap: ${e.message}`);
        else if (e.code === "hermesNotFound") raise("hermesNotFound", e.hint ?? e.message);
        else raise("hermesCrashed", e.message);
        setState("idle", "bridge threw");
      } finally {
        window.clearTimeout(timeoutHandle);
        currentTask.current = null;
        void refreshBackend();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [appendUtterance, ensureSession, handleEvent, push, raise, requestApproval, setState, speak],
  );

  /* ------------------------------- listening ----------------------------- */

    const finalizeTranscript = useCallback(
    (text: string, confidence: number, durationMs: number) => {
      const s = settingsRef.current;
      setPartial("");
      setLevel(0);
      restoreSystemAudio(s.bridgeURL);
      if (!text.trim()) {
        setState("idle", "empty transcript");
        return;
      }

      let cleanText = text.trim();
      // Clean wake-word prefix ("Hey Kriti" / "Kriti")
      const wakeMatch = cleanText.match(/^(?:hey\s+)?(?:kriti|kreeti|कृति)[,\s]*/i);
      if (wakeMatch) {
        cleanText = cleanText.slice(wakeMatch[0].length).trim();
        if (!cleanText) {
          setState("speaking", "wake word greeted");
          void speak("Haan boliye, main sun rahi hoon.", "high").then(() => {
            void startListening();
          });
          return;
        }
      }

      setState("transcribing", "stt finalizing");
      logger.info("stt", `final "${redact(cleanText)}" conf=${confidence.toFixed(2)}`);

      if (confidence < s.confidenceThreshold) {
        setPendingConfirm({ text: cleanText, confidence });
        setState("confirmingTranscript", "low confidence");
        void speak(confirmTranscriptPrompt(cleanText, s.lang), "high");
        if (confirmTimer.current) window.clearTimeout(confirmTimer.current);
        confirmTimer.current = window.setTimeout(() => {
          setPendingConfirm((p) => {
            if (p) {
              push({ kind: "system", text: t("discarded", s.lang) });
              void speak(t("discarded", s.lang), "normal");
              setState("idle", "confirm timeout");
            }
            return null;
          });
        }, 15000);
        return;
      }
      void runAgent(cleanText, confidence, durationMs);
    },
    [push, runAgent, setState, speak],
  );

  const startListening = useCallback(async () => {
    const s = settingsRef.current;
    // Barge-in: if currently speaking, immediately stop playback and transition to listening
    if (speakingNow || stateRef.current === "speaking") {
      bargeIn();
      if (stateRef.current === "speaking") {
        stateRef.current = "idle";
        setStateRaw("idle");
      }
    }
    if (stateRef.current === "listening") return;
    if (!sttSupported) {
      raise("sttUnsupported");
      return;
    }
    if (!setState("listening", "hotkey/orb down")) return;
    setActiveError(null);
    setPartial("");
    listenStart.current = Date.now();
    bargeIn();
    duckSystemAudio(s.bridgeURL);

    if (maxLenTimer.current) window.clearTimeout(maxLenTimer.current);
    maxLenTimer.current = window.setTimeout(() => {
      if (stateRef.current === "listening") {
        void speak("Max length hit, bhej raha hoon.", "high");
        stt.current?.stop();
      }
    }, MAX_UTTERANCE_MS);

    await stt.current?.start(s.sttLocale, {
      onPartial: (txt) => {
        // Barge-in if any stray audio started while mic is active
        if (audioEl.current && !audioEl.current.paused) bargeIn();
        setPartial(txt);
      },
      onLevel: setLevel,
      onFinal: (txt, conf) => finalizeTranscript(txt, conf, Date.now() - listenStart.current),
      onError: (code, detail) => {
        logger.error("stt", `${code}: ${detail}`);
        if (code === "not-allowed") raise("micPermissionDenied", detail);
        else if (code === "unsupported") raise("sttUnsupported", detail);
        else if (code === "no-speech") push({ kind: "system", text: "Kuch suna nahi — dobara bolo." });
        else raise("sttFailed", detail);
        setState("idle", "stt error");
      },
    });
  }, [bargeIn, finalizeTranscript, push, raise, setState, speak, speakingNow, sttSupported]);

  const stopListening = useCallback(() => {
    if (stateRef.current !== "listening") return;
    if (maxLenTimer.current) window.clearTimeout(maxLenTimer.current);
    stt.current?.stop();
  }, []);

  /* -------------------------------- cancel ------------------------------- */

  const cancel = useCallback(() => {
    const s = settingsRef.current;
    const st = stateRef.current;
    cancelFlag.current = true;
    bargeIn();
    if (currentTask.current && backend.reachable) {
      void clientRef.current.cancelTask(currentTask.current).catch(() => {});
    }
    if (st === "listening" || st === "transcribing") {
      stt.current?.abort();
      setPartial("");
      setState("idle", "user cancel");
      void speak(t("cancelled", s.lang), "high");
      push({ kind: "system", text: t("cancelled", s.lang) });
      return;
    }
    if (st === "awaitingPermission") {
      resolvePermission("deny", "click");
      setState("cancelling", "cancel during permission");
      setState("idle", "cancelled");
      return;
    }
    if (st === "thinking") {
      setState("cancelling", "user cancel");
      setState("idle", "cancelled");
      push({ kind: "system", text: t("taskCancelled", s.lang) });
      void speak(t("taskCancelled", s.lang), "high");
      return;
    }
    if (st === "speaking") {
      setState("idle", "tts stopped");
      return;
    }
    if (st === "confirmingTranscript") {
      setPendingConfirm(null);
      setState("idle", "confirm cancelled");
    }
  }, [backend.reachable, bargeIn, push, resolvePermission, setState, speak]);

  /* ----------------------------- voice approval -------------------------- */

  const voiceDecide = useCallback(
    (spoken: string) => {
      if (!pending || !settingsRef.current.voiceApproval) return false;
      if (!allowsVoiceApproval(pending.risk)) {
        push({ kind: "system", text: `Voice approval ${pending.risk} risk pe blocked hai — click ya type karo.` });
        return false;
      }
      const d = mapVoiceDecision(spoken);
      if (!d) return false;
      resolvePermission(d, "voice");
      return true;
    },
    [pending, push, resolvePermission],
  );

  const listenForApproval = useCallback(async () => {
    if (!pending || !stt.current) return;
    if (!settingsRef.current.voiceApproval || !allowsVoiceApproval(pending.risk)) {
      push({ kind: "system", text: `Voice approval ${pending.risk} risk pe blocked hai.` });
      return;
    }
    bargeIn();
    await stt.current.start(settingsRef.current.sttLocale, {
      onPartial: (txt) => {
        setPartial(txt);
        // Immediate voice decision recognition on unambiguous spoken phrases
        const quick = mapVoiceDecision(txt);
        if (quick) {
          stt.current?.stop();
        }
      },
      onLevel: setLevel,
      onFinal: (txt) => {
        setPartial("");
        setLevel(0);
        if (!txt.trim()) return;
        logger.info("permissions", `voice reply: "${txt}"`);
        if (!voiceDecide(txt)) push({ kind: "system", text: `Clear nahi tha: "${txt}" — haan/allow ya nahi/deny bolo.` });
      },
      onError: (code, detail) => logger.error("stt", `approval listen ${code}: ${detail}`),
    });
  }, [bargeIn, pending, push, voiceDecide]);

  /* ------------------------------ confirm flow --------------------------- */

  const confirmSend = useCallback(() => {
    const p = pendingConfirm;
    if (!p) return;
    if (confirmTimer.current) window.clearTimeout(confirmTimer.current);
    setPendingConfirm(null);
    void runAgent(p.text, p.confidence, null);
  }, [pendingConfirm, runAgent]);

  const confirmDiscard = useCallback(() => {
    if (confirmTimer.current) window.clearTimeout(confirmTimer.current);
    setPendingConfirm(null);
    setState("idle", "transcript discarded");
    push({ kind: "system", text: t("discarded", settingsRef.current.lang) });
  }, [push, setState]);

  const submitText = useCallback(
    (text: string) => {
      if (!text.trim()) return;
      if (stateRef.current !== "idle" && stateRef.current !== "degraded") {
        logger.warn("app", `submitText ignored in state ${stateRef.current}`);
        return;
      }
      bargeIn();
      void runAgent(text.trim(), null, null);
    },
    [bargeIn, runAgent],
  );

  const repeatLast = useCallback(() => {
    if (!lastAssistant) return;
    void speak(summarizeForSpeech(lastAssistant), "high");
  }, [lastAssistant, speak]);

  /* ------------------------------ backend -------------------------------- */

  const refreshBackend = useCallback(async () => {
    const s = settingsRef.current;
    if (clientRef.current.baseURL !== s.bridgeURL) {
      clientRef.current = new BridgeClient(s.bridgeURL);
    }
    try {
      const h = await clientRef.current.health();
      setBackend((b) => ({ ...b, health: h, reachable: true, lastChecked: Date.now(), reason: `bridge v${h.version} · pid ${h.pid}` }));
      setHealth({
        reachable: h.omniroute.reachable,
        latencyMs: h.omniroute.latencyMs,
        version: h.omniroute.version,
        checkedAt: h.omniroute.checkedAt,
        detail: h.omniroute.reachable ? `${h.omniroute.path} → ${h.omniroute.status}` : "unreachable from bridge host",
      });
      if (!h.hermes.found) logger.warn("agent", `hermes binary not found: ${h.hermes.detail}`);
      return h;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setBackend((b) => ({ ...b, health: null, reachable: false, lastChecked: Date.now(), reason: msg }));
      return null;
    }
  }, []);

  const refreshHealth = useCallback(async () => {
    const s = settingsRef.current;
    if (backend.reachable) return refreshBackend();
    const c = new OmnirouteClient(s.omnirouteBaseURL);
    const h = await c.health();
    setHealth(h);
    logger.info("router", `direct health probe: ${h.reachable ? "UP" : "DOWN"} — ${h.detail}`);
    if (h.reachable) {
      try {
        setModels(await c.models());
      } catch (e) {
        logger.warn("router", `models failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      try {
        setCombos(await c.combos());
      } catch {
        /* combos path unverified */
      }
    }
    return h;
  }, [backend.reachable, refreshBackend]);

  const runProbe = useCallback(async () => {
    const s = settingsRef.current;
    logger.info("router", `probe ${s.probeModel} (stream:false)`);
    if (backend.reachable) {
      const r = await clientRef.current.routerProbe(s.probeModel);
      const res: ProbeResult = { ok: r.ok, latencyMs: r.latencyMs, model: r.model, sample: r.sample ?? "", error: r.error };
      setProbe(res);
      try {
        const [m, c] = await Promise.all([clientRef.current.routerModels(), clientRef.current.routerCombos()]);
        setModels(m.models);
        setCombos({ combos: c.combos, pathUsed: c.pathUsed });
      } catch (e) {
        logger.warn("router", `model/combo listing failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      return res;
    }
    const c = new OmnirouteClient(s.omnirouteBaseURL);
    const r = await c.chatProbe(s.probeModel);
    setProbe(r);
    return r;
  }, [backend.reachable]);

  const loadBackendData = useCallback(async () => {
    if (!backend.reachable) return;
    try {
      const [a, s, l, m, c] = await Promise.all([
        clientRef.current.audit(),
        clientRef.current.sessions(),
        clientRef.current.logs(200),
        clientRef.current.memory(),
        clientRef.current.routerCombos().catch(() => ({ combos: [], pathUsed: null })),
      ]);
      if (c.combos.length > 0) setCombos({ combos: c.combos, pathUsed: c.pathUsed });
      setBackend((b) => ({
        ...b,
        audit: a.entries.map((e) => ({
          id: (e as AuditEntry & { id: string }).id,
          at: Number((e as unknown as { at: number }).at),
          toolName: String((e as unknown as { tool?: string }).tool ?? (e as AuditEntry).toolName ?? "?"),
          risk: (e as unknown as { risk: AuditEntry["risk"] }).risk,
          decision: (e as unknown as { decision: AuditEntry["decision"] }).decision,
          argsRedacted: String((e as unknown as { args?: string }).args ?? (e as AuditEntry).argsRedacted ?? ""),
          via: (e as unknown as { via: AuditEntry["via"] }).via,
        })),
        sessions: s.sessions,
        logs: l.lines,
        memory: m,
      }));
    } catch (e) {
      logger.warn("agent", `backend data load failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [backend.reachable]);

  const runServerTests = useCallback(async () => {
    setBackend((b) => ({ ...b, testsRunning: true }));
    try {
      const r = await clientRef.current.selftest();
      setBackend((b) => ({ ...b, tests: r, testsRunning: false }));
      logger.info("app", `bridge self-tests: ${r.passed}/${r.total} passed`);
      return r;
    } catch (e) {
      setBackend((b) => ({ ...b, testsRunning: false }));
      logger.error("app", `bridge self-test failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }, []);

  const loadMemoryFile = useCallback(async (path: string) => {
    try {
      const f = await clientRef.current.memoryFile(path);
      setBackend((b) => ({ ...b, memoryText: { path: f.path, text: f.text } }));
    } catch (e) {
      const err = e as Error;
      setBackend((b) => ({
        ...b,
        memoryText: { path, text: `Read failed: ${err.message}\n(~/.hermes/memories read-only hai; file is host pe maujood honi chahiye.)` },
      }));
    }
  }, []);

  /* ------------------------------ lifecycle ------------------------------ */

  useEffect(() => {
    stt.current = new WebSTTEngine();
    tts.current = new WebTTSEngine();
    const unsub = logger.subscribe(() => setLogs([...logger.lines()]));
    logger.info("app", "Hermes Voice v1.0 starting — voice shell for the Hermes Agent");

    const loadVoices = () => setVoices(WebTTSEngine.supported() ? window.speechSynthesis.getVoices() : []);
    loadVoices();
    if (WebTTSEngine.supported()) window.speechSynthesis.onvoiceschanged = loadVoices;

    void (async () => {
      if (!WebSTTEngine.supported()) logger.warn("stt", "SpeechRecognition unavailable in this browser");
      const h = await refreshBackend();
      if (h && h.hermes.found) {
        setState("idle", "startup complete — bridge online");
      } else if (h) {
        setState("degraded", "bridge online but agent binary missing");
      } else {
        setState("degraded", "bridge offline");
        logger.warn("app", "degraded: local bridge offline. Start it with `node server/index.mjs`.");
      }
    })();

    return () => {
      unsub();
      stt.current?.abort();
      bargeIn();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Bridge instance follows settings + backend reachability.
  useEffect(() => {
    if (clientRef.current.baseURL !== settings.bridgeURL) {
      clientRef.current = new BridgeClient(settings.bridgeURL);
    }
    const client = clientRef.current;
    let next: AgentBridge;
    if (settings.bridgeMode === "local") {
      const lb = new LocalBridge(client);
      lb.setStatus(
        backend.reachable
          ? { ok: true }
          : { ok: false, reason: `Local bridge ${settings.bridgeURL} pe nahi mila (${backend.reason}). Chalao: node server/index.mjs` },
      );
      next = lb;
    } else {
      next = makeBridge(settings.bridgeMode, {
        hermesPath: settings.hermesPath,
        workingDir: settings.hermesWorkingDir,
        timeoutSec: settings.hermesTimeoutSec,
        httpBaseURL: settings.httpBridgeBaseURL,
      });
    }
    bridgeRef.current = next;
    logger.info("agent", `bridge = ${next.label} (${next.available().ok ? "available" : "unavailable"})`);
  }, [
    backend.reachable,
    backend.reason,
    settings.bridgeMode,
    settings.bridgeURL,
    settings.hermesPath,
    settings.hermesWorkingDir,
    settings.hermesTimeoutSec,
    settings.httpBridgeBaseURL,
  ]);

  // Load initial backend data once reachable.
  useEffect(() => {
    if (backend.reachable) {
      void loadBackendData();
    }
  }, [backend.reachable, loadBackendData]);

  // Backend health polling.
  useEffect(() => {
    const id = window.setInterval(() => void refreshBackend(), 8000);
    return () => window.clearInterval(id);
  }, [refreshBackend]);

  // Refresh backend stores when the tab regains focus.
  useEffect(() => {
    const onFocus = () => void (backend.reachable && loadBackendData());
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [backend.reachable, loadBackendData]);

  useEffect(() => {
    logger.redactEnabled = settings.redactLogs;
  }, [settings.redactLogs]);

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  /* ------------------------------- hotkeys ------------------------------- */

  const pttDown = useRef(false);
  useEffect(() => {
    const typing = (target: HTMLElement | null) =>
      Boolean(target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable));
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.altKey && e.metaKey && e.code === "Space") {
        e.preventDefault();
        cancel();
        return;
      }
      if (e.altKey && e.shiftKey && e.code === "Space") {
        e.preventDefault();
        repeatLast();
        return;
      }
      if (e.altKey && e.code === "Space" && !typing(e.target as HTMLElement)) {
        e.preventDefault();
        if (!pttDown.current) {
          pttDown.current = true;
          void startListening();
        }
        return;
      }
      if (e.key === "Escape" && pending) {
        e.preventDefault();
        resolvePermission("deny", "click");
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (pttDown.current && (e.code === "Space" || e.key === "Alt")) {
        pttDown.current = false;
        stopListening();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [cancel, pending, repeatLast, resolvePermission, startListening, stopListening]);

  /* -------------------------------- derived ------------------------------ */

  const routerBadge = useMemo<"green" | "yellow" | "red">(() => {
    if (!backend.reachable) return "yellow";
    if (!health) return "yellow";
    if (!health.reachable) return "red";
    if ((health.latencyMs ?? 0) > 1500) return "yellow";
    return "green";
  }, [backend.reachable, health]);

  const activeModelBadge = useMemo<string>(() => {
    if (combos.combos.length > 0) {
      return `${combos.combos[0].name} / 9Router`;
    }
    return backend.health?.omniroute.activeComboName || "KRITI / 9Router";
  }, [backend.health?.omniroute.activeComboName, combos.combos]);

  const update = useCallback(<K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  }, []);

  return {
    state,
    partial,
    level,
    playbackLevel,
    timeline,
    pending,
    pendingRemaining,
    pendingConfirm,
    lastAssistant,
    activeError,
    health,
    models,
    combos,
    probe,
    sessions,
    audit,
    logs,
    settings,
    voices,
    sttSupported,
    ttsSupported,
    routerBadge,
    activeModelBadge,
    sessionAllowlist,
    backend,
    speakingNow,
    bridgeStatus: bridgeRef.current?.available() ?? { ok: false, reason: "bridge not initialised" },
    bridgeLabel: bridgeRef.current?.label ?? "—",
    bridgeId: bridgeRef.current?.id ?? "mock",
    startListening,
    stopListening,
    bargeIn,
    cancel,
    submitText,
    repeatLast,
    resolvePermission,
    voiceDecide,
    listenForApproval,
    stopApprovalListen: () => stt.current?.stop(),
    confirmSend,
    confirmDiscard,
    refreshHealth,
    refreshBackend,
    loadBackendData,
    runServerTests,
    loadMemoryFile,
    runProbe,
    update,
    dismissError: () => setActiveError(null),
    clearAuditLog: () => {
      clearAudit();
      setAudit([]);
      logger.info("permissions", "local audit log cleared by user");
    },
    clearSessions: () => {
      deleteSessions();
      setSessions([]);
      sessionRef.current = null;
    },
  };
}

export type Orchestrator = ReturnType<typeof useHermesVoice>;
