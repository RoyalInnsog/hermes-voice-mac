// Section 6.4 / 6.8 — STT + TTS engines + Native macOS Audio Ducking & SFSpeechRecognizer Hook (v1.1).
// Features:
//   • webkitSpeechRecognition with 'en-IN' primary and 'en-US' / 'hi-IN' auto-fallback
//   • Offline Apple Speech (SFSpeechRecognizer) native hook fallback via WKWebView `hermesNative` or `/api/stt/stream`
//   • Native macOS system audio ducking (`duckSystemAudio` / `restoreSystemAudio`)
//   • Interim results for live typing animation
//   • 1.8s silence / energy auto-stop detection after an utterance is spoken
//   • Expanded Hinglish/English voice permission affirmation & denial mapping

/* ----------------------- Native macOS Audio Ducking ---------------------- */

type WebkitMessageHandler = {
  postMessage: (msg: Record<string, unknown>) => void;
};

function getNativeBridge(): WebkitMessageHandler | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    webkit?: { messageHandlers?: { hermesNative?: WebkitMessageHandler } };
  };
  return w.webkit?.messageHandlers?.hermesNative ?? null;
}

export function isNativeMacWrapper(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as { __HERMES_NATIVE__?: boolean };
  return Boolean(w.__HERMES_NATIVE__ || getNativeBridge());
}

/**
 * Ducks macOS system/media volume when user starts speaking or Hermes begins TTS playback.
 */
export function duckSystemAudio(bridgeBaseURL = "http://127.0.0.1:20130"): void {
  const native = getNativeBridge();
  if (native) {
    try {
      native.postMessage({ action: "duckAudio" });
      return;
    } catch {
      /* fall through to HTTP bridge */
    }
  }
  const base = bridgeBaseURL.replace(/\/+$/, "");
  void fetch(`${base}/api/audio/duck`, { method: "POST" }).catch(() => {
    void fetch("/api/audio/duck", { method: "POST" }).catch(() => {});
  });
}

/**
 * Immediately restores original macOS system volume upon completion, idle, or cancellation.
 */
export function restoreSystemAudio(bridgeBaseURL = "http://127.0.0.1:20130"): void {
  const native = getNativeBridge();
  if (native) {
    try {
      native.postMessage({ action: "restoreAudio" });
      return;
    } catch {
      /* fall through to HTTP bridge */
    }
  }
  const base = bridgeBaseURL.replace(/\/+$/, "");
  void fetch(`${base}/api/audio/restore`, { method: "POST" }).catch(() => {
    void fetch("/api/audio/restore", { method: "POST" }).catch(() => {});
  });
}

/* ----------------------------- TTS text prep ----------------------------- */

/** Strip markdown / code / URLs so the synthesiser doesn't read punctuation soup. */
export function speechify(input: string): string {
  let s = input;
  s = s.replace(/```[\s\S]*?```/g, " code block, detail overlay me hai, ");
  s = s.replace(/`([^`]+)`/g, "$1");
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, " image ");
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  s = s.replace(/https?:\/\/\S+/g, " link ");
  s = s.replace(/^\s{0,3}#{1,6}\s*/gm, "");
  s = s.replace(/[*_~>#|]/g, " ");
  s = s.replace(/\s{2,}/g, " ");
  return s.trim();
}

/** Long replies: speak the gist, show the full text. */
export function summarizeForSpeech(input: string, maxSentences = 3, maxChars = 320): string {
  const clean = speechify(input);
  if (clean.length <= maxChars) return clean;
  const sentences = clean.split(/(?<=[.!?])\s+/);
  let out = "";
  for (const sentence of sentences.slice(0, maxSentences)) {
    if ((out + sentence).length > maxChars) break;
    out += (out ? " " : "") + sentence;
  }
  if (!out) out = clean.slice(0, maxChars);
  return out + " Poori report overlay me hai.";
}

/* -------------------------------- TTS ----------------------------------- */

export type SpeechPriority = "low" | "normal" | "high";

export interface SpeakOptions {
  priority?: SpeechPriority;
  lang?: string;
  rate?: number;
  pitch?: number;
  volume?: number;
  voiceURI?: string | null;
}

export class WebTTSEngine {
  private currentPriority: SpeechPriority = "low";
  speaking = false;

  static supported(): boolean {
    return typeof window !== "undefined" && "speechSynthesis" in window;
  }

  voices(): SpeechSynthesisVoice[] {
    if (!WebTTSEngine.supported()) return [];
    return window.speechSynthesis.getVoices();
  }

  stop() {
    if (!WebTTSEngine.supported()) return;
    window.speechSynthesis.cancel();
    this.speaking = false;
  }

  speak(text: string, opts: SpeakOptions = {}): Promise<void> {
    const priority = opts.priority ?? "normal";
    if (!WebTTSEngine.supported() || !text.trim()) return Promise.resolve();

    const rank: Record<SpeechPriority, number> = { low: 0, normal: 1, high: 2 };
    if (this.speaking && rank[priority] < rank[this.currentPriority]) return Promise.resolve();
    if (this.speaking) this.stop();

    return new Promise<void>((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = opts.lang ?? "en-IN";
      u.rate = opts.rate ?? 1;
      u.pitch = opts.pitch ?? 1;
      u.volume = opts.volume ?? 1;
      if (opts.voiceURI) {
        const v = this.voices().find((x) => x.voiceURI === opts.voiceURI);
        if (v) u.voice = v;
      }
      const done = () => {
        this.speaking = false;
        resolve();
      };
      u.onend = done;
      u.onerror = done;
      this.currentPriority = priority;
      this.speaking = true;
      window.speechSynthesis.speak(u);
      setTimeout(done, Math.min(60000, 2500 + text.length * 90));
    });
  }
}

/* -------------------------------- STT ----------------------------------- */

export interface STTCallbacks {
  onPartial: (text: string) => void;
  onFinal: (text: string, confidence: number) => void;
  onError: (code: "not-allowed" | "no-speech" | "unsupported" | "other", detail: string) => void;
  onLevel?: (rms: number) => void;
}

type AnySpeechRecognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((e: unknown) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onend: (() => void) | null;
};

function getRecognitionCtor(): (new () => AnySpeechRecognition) | null {
  const w = window as unknown as Record<string, unknown>;
  const Ctor = (w.SpeechRecognition ?? w.webkitSpeechRecognition) as (new () => AnySpeechRecognition) | undefined;
  return Ctor ?? null;
}

const FALLBACK_LOCALES = ["en-IN", "en-US", "hi-IN"] as const;
const SILENCE_AUTO_STOP_MS = 1000; // Fast 1.0s cutoff after speech ends (cooler-proof)

export class WebSTTEngine {
  private rec: AnySpeechRecognition | null = null;
  private nativeEventSource: EventSource | null = null;
  private nativeWindowListener: ((e: Event) => void) | null = null;
  private finalText = "";
  private interimText = "";
  private bestConfidence = 0;
  private stream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private biquadFilter: BiquadFilterNode | null = null;
  private raf = 0;
  private silenceTimer: number | null = null;
  private hasSpoken = false;
  private noiseFloor = 0.035;
  private noiseSamples = 0;
  private noiseSum = 0;
  listening = false;

  static supported(): boolean {
    return typeof window !== "undefined" && (getRecognitionCtor() !== null || isNativeMacWrapper());
  }

  private clearSilenceTimer() {
    if (this.silenceTimer !== null) {
      window.clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  private resetSilenceTimer() {
    this.clearSilenceTimer();
    if (!this.hasSpoken) return;
    this.silenceTimer = window.setTimeout(() => {
      if (this.listening && this.hasSpoken) {
        this.stop();
      }
    }, SILENCE_AUTO_STOP_MS);
  }

  /** Mic level meter — with High-Pass Filter (<280Hz) to kill cooler motor hum & adaptive noise gate. */
  private async startMeter(onLevel: (rms: number) => void) {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      const Ctx = (window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext) as typeof AudioContext;
      this.audioCtx = new Ctx();
      const src = this.audioCtx.createMediaStreamSource(this.stream);

      // High-pass filter cuts off cooler motor/fan hum (< 280Hz)
      this.biquadFilter = this.audioCtx.createBiquadFilter();
      this.biquadFilter.type = "highpass";
      this.biquadFilter.frequency.value = 280;

      const analyser = this.audioCtx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(this.biquadFilter);
      this.biquadFilter.connect(analyser);

      const buf = new Uint8Array(analyser.frequencyBinCount);
      this.noiseFloor = 0.035;
      this.noiseSamples = 0;
      this.noiseSum = 0;

      const tick = () => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / buf.length);

        // Calibrate ambient noise floor for first 30 frames (~500ms)
        if (this.noiseSamples < 30) {
          this.noiseSamples++;
          this.noiseSum += rms;
          this.noiseFloor = Math.max(0.02, this.noiseSum / this.noiseSamples);
        }

        onLevel(rms);

        // Only reset silence timer if energy is significantly above the cooler noise floor
        const voiceThreshold = this.noiseFloor + 0.065;
        if (this.hasSpoken && rms > voiceThreshold) {
          this.resetSilenceTimer();
        }
        this.raf = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      /* meter is cosmetic; recognition can still run */
    }
  }

  private stopMeter() {
    this.clearSilenceTimer();
    cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.audioCtx?.close().catch(() => {});
    this.audioCtx = null;
  }

  /**
   * Native Apple Speech (SFSpeechRecognizer) fallback hook:
   * 1. Inside Hermes Voice.app WKWebView: uses `hermesNative` script handler + `hv:native-stt` event.
   * 2. In browser connected to local bridge: connects to `/api/stt/stream` (`app/stt.swift`).
   */
  private startNativeAppleSpeechFallback(locale: string, cb: STTCallbacks): boolean {
    const native = getNativeBridge();
    if (native) {
      this.listening = true;
      const handler = (ev: Event) => {
        const detail = (ev as CustomEvent<{ type: string; text?: string; confidence?: number; error?: string }>).detail;
        if (!detail) return;
        if (detail.type === "interim" && detail.text) {
          this.interimText = detail.text;
          this.hasSpoken = true;
          cb.onPartial(detail.text);
        } else if (detail.type === "final") {
          this.cleanupNativeListeners();
          this.listening = false;
          this.stopMeter();
          cb.onFinal((detail.text || this.interimText).trim(), detail.confidence ?? 0.92);
        } else if (detail.type === "error") {
          this.cleanupNativeListeners();
          this.listening = false;
          this.stopMeter();
          cb.onError("other", detail.error || "SFSpeechRecognizer error");
        }
      };
      this.nativeWindowListener = handler;
      window.addEventListener("hv:native-stt", handler);
      native.postMessage({ action: "startNativeSTT", locale });
      return true;
    }

    // Try SSE stream `/api/stt/stream` from local bridge (`app/stt.swift`)
    if (typeof EventSource !== "undefined") {
      try {
        const es = new EventSource(`http://127.0.0.1:20130/api/stt/stream?locale=${encodeURIComponent(locale)}&silenceMs=${SILENCE_AUTO_STOP_MS}`);
        this.nativeEventSource = es;
        this.listening = true;
        es.onmessage = (msg) => {
          try {
            const data = JSON.parse(msg.data) as { type: string; text?: string; confidence?: number; error?: string };
            if (data.type === "interim" && data.text) {
              this.interimText = data.text;
              this.hasSpoken = true;
              cb.onPartial(data.text);
            } else if (data.type === "final") {
              this.cleanupNativeListeners();
              this.listening = false;
              this.stopMeter();
              cb.onFinal((data.text || this.interimText).trim(), data.confidence ?? 0.92);
            } else if (data.type === "error") {
              this.cleanupNativeListeners();
              this.listening = false;
              this.stopMeter();
              cb.onError("other", data.error || "Native STT bridge error");
            }
          } catch {
            /* ignore */
          }
        };
        es.onerror = () => {
          this.cleanupNativeListeners();
          this.listening = false;
          this.stopMeter();
          const fallbackTxt = (this.finalText || this.interimText).trim();
          if (fallbackTxt) {
            cb.onFinal(fallbackTxt, 0.85);
          } else {
            cb.onError("other", "Speech recognition connection dropped");
          }
        };
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  private cleanupNativeListeners() {
    if (this.nativeWindowListener) {
      window.removeEventListener("hv:native-stt", this.nativeWindowListener);
      this.nativeWindowListener = null;
      getNativeBridge()?.postMessage({ action: "stopNativeSTT" });
    }
    if (this.nativeEventSource) {
      this.nativeEventSource.close();
      this.nativeEventSource = null;
    }
  }

  async start(locale = "en-IN", cb: STTCallbacks) {
    if (this.listening) return;
    this.finalText = "";
    this.interimText = "";
    this.bestConfidence = 0;
    this.hasSpoken = false;

    if (cb.onLevel) await this.startMeter(cb.onLevel);

    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      if (this.startNativeAppleSpeechFallback(locale, cb)) return;
      this.stopMeter();
      cb.onError("unsupported", "SpeechRecognition API missing in this browser");
      return;
    }

    const localesToTry = [locale, ...FALLBACK_LOCALES.filter((l) => l !== locale)];
    let localeIndex = 0;

    const launchWithLocale = (lang: string) => {
      const rec = new Ctor();
      rec.lang = lang;
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 1;

      rec.onresult = (ev: unknown) => {
        const e = ev as { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string; confidence: number }> & { isFinal: boolean }> };
        let interim = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          const alt = r[0];
          if (r.isFinal) {
            this.finalText += (this.finalText ? " " : "") + alt.transcript.trim();
            this.bestConfidence = Math.max(this.bestConfidence, alt.confidence || 0);
          } else {
            interim += alt.transcript;
          }
        }
        this.interimText = interim.trim();
        const combined = (this.finalText + " " + this.interimText).trim();
        if (combined.length > 0) {
          this.hasSpoken = true;
          this.resetSilenceTimer();
        }

        // Wake Word "Kriti" detection: unhides HUD & wakes app
        if (/\b(kriti|hey\s*kriti|kreeti|कृति)\b/i.test(combined)) {
          const native = getNativeBridge();
          native?.postMessage({ action: "wakeApp" });
          window.dispatchEvent(new CustomEvent("hv:wake-word", { detail: { word: "Kriti" } }));
        }

        cb.onPartial(combined);
      };

      rec.onerror = (ev: unknown) => {
        const e = ev as { error?: string; message?: string };
        if (e.error === "language-not-supported" && localeIndex + 1 < localesToTry.length) {
          localeIndex++;
          try {
            rec.abort();
          } catch {
            /* ignore */
          }
          launchWithLocale(localesToTry[localeIndex]);
          return;
        }
        // If browser webkitSpeechRecognition drops network connection, seamlessly hand off to native Apple Speech (SFSpeechRecognizer)
        if ((e.error === "network" || e.error === "service-not-allowed") && this.startNativeAppleSpeechFallback(lang, cb)) {
          try {
            rec.abort();
          } catch {
            /* ignore */
          }
          this.rec = null;
          return;
        }
        const code =
          e.error === "not-allowed" || e.error === "service-not-allowed"
            ? "not-allowed"
            : e.error === "no-speech"
              ? "no-speech"
              : "other";
        cb.onError(code, e.message || e.error || "speech error");
      };

      rec.onend = () => {
        if (this.nativeEventSource || this.nativeWindowListener) return; // handed off to native SFSpeechRecognizer
        this.listening = false;
        this.stopMeter();
        const text = (this.finalText || this.interimText).trim();
        const conf = this.bestConfidence > 0 ? this.bestConfidence : text ? 0.78 : 0;
        cb.onFinal(text, conf);
      };

      this.rec = rec;
      this.listening = true;
      try {
        rec.start();
      } catch (e) {
        if (this.startNativeAppleSpeechFallback(lang, cb)) return;
        this.listening = false;
        this.stopMeter();
        cb.onError("other", e instanceof Error ? e.message : String(e));
      }
    };

    launchWithLocale(localesToTry[0]);
  }

  stop() {
    this.clearSilenceTimer();
    this.cleanupNativeListeners();
    if (!this.rec) {
      this.listening = false;
      this.stopMeter();
      return;
    }
    try {
      this.rec.stop();
    } catch {
      /* already stopped */
    }
    this.listening = false;
  }

  abort() {
    this.clearSilenceTimer();
    this.cleanupNativeListeners();
    if (this.rec) {
      try {
        this.rec.abort();
      } catch {
        /* noop */
      }
    }
    this.listening = false;
    this.stopMeter();
  }
}

/* --------------------- voice command mapping (approvals) ----------------- */

const ALLOW_SESSION_RE = /\b(allow\s+session|session\s+allow|session\s+ke\s+liye(\s+allow)?|for\s+session|hamesha\s+allow)\b/i;
const ALLOW_RE = /\b(allow|yes|yep|haan|haa|ha|kar\s*do|kar\s*de|permission\s*di|proceed|theek\s*hai|theek|ok|okay|approve|allowed|chalo|chalega)\b/i;
const DENY_RE = /\b(deny|no|nope|nahi|na|mat\s*kar|mat|ruk\s*jao|ruko|ruk|cancel|reject|stop|abort)\b/i;

export function mapVoiceDecision(text: string): "allowOnce" | "allowSession" | "deny" | null {
  const s = text.toLowerCase().trim();
  if (!s) return null;
  const allowSession = ALLOW_SESSION_RE.test(s);
  const allow = ALLOW_RE.test(s);
  const deny = DENY_RE.test(s);
  if ((allow || allowSession) && deny) return null;
  if (allowSession) return "allowSession";
  if (allow) return "allowOnce";
  if (deny) return "deny";
  return null;
}
