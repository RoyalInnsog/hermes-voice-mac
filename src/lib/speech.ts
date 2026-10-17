// Section 6.4 / 6.8 — STT + TTS engines.
// Browser equivalents of the native AppleSTTEngine / AppleTTSEngine.
// Edge TTS + Gemini TTS are not reachable from a sandboxed page (see LIMITATIONS L-3),
// so selecting them falls back to the system voice and raises ttsEngineMissing.

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

    // Priority queue rule: higher priority interrupts lower.
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
      // Safety net: some engines never fire onend for long text.
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

export class WebSTTEngine {
  private rec: AnySpeechRecognition | null = null;
  private finalText = "";
  private bestConfidence = 0;
  private stream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private raf = 0;
  listening = false;

  static supported(): boolean {
    return typeof window !== "undefined" && getRecognitionCtor() !== null;
  }

  /** Mic level meter — Section 6.3 AudioLevelMeter (RMS for the waveform). */
  private async startMeter(onLevel: (rms: number) => void) {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const Ctx = (window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext) as typeof AudioContext;
      this.audioCtx = new Ctx();
      const src = this.audioCtx.createMediaStreamSource(this.stream);
      const analyser = this.audioCtx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      const buf = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        onLevel(Math.sqrt(sum / buf.length));
        this.raf = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      /* meter is cosmetic; recognition can still run */
    }
  }

  private stopMeter() {
    cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.audioCtx?.close().catch(() => {});
    this.audioCtx = null;
  }

  async start(locale: string, cb: STTCallbacks) {
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      cb.onError("unsupported", "SpeechRecognition API missing in this browser");
      return;
    }
    if (this.listening) return;
    this.finalText = "";
    this.bestConfidence = 0;

    if (cb.onLevel) await this.startMeter(cb.onLevel);

    const rec = new Ctor();
    rec.lang = locale;
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
      cb.onPartial((this.finalText + " " + interim).trim());
    };

    rec.onerror = (ev: unknown) => {
      const e = ev as { error?: string; message?: string };
      const code = e.error === "not-allowed" || e.error === "service-not-allowed" ? "not-allowed" : e.error === "no-speech" ? "no-speech" : "other";
      cb.onError(code, e.message || e.error || "speech error");
    };

    rec.onend = () => {
      this.listening = false;
      this.stopMeter();
      const text = this.finalText.trim();
      // Chrome often reports confidence 0 for interim-heavy sessions; treat
      // "we got words but no score" as a mid confidence rather than a failure.
      const conf = this.bestConfidence > 0 ? this.bestConfidence : text ? 0.72 : 0;
      cb.onFinal(text, conf);
    };

    this.rec = rec;
    this.listening = true;
    try {
      rec.start();
    } catch (e) {
      this.listening = false;
      cb.onError("other", e instanceof Error ? e.message : String(e));
    }
  }

  stop() {
    if (!this.rec) return;
    try {
      this.rec.stop();
    } catch {
      /* already stopped */
    }
    this.listening = false;
  }

  abort() {
    if (!this.rec) return;
    try {
      this.rec.abort();
    } catch {
      /* noop */
    }
    this.listening = false;
    this.stopMeter();
  }
}

/* --------------------- voice command mapping (approvals) ----------------- */

export function mapVoiceDecision(text: string): "allow" | "deny" | null {
  const s = text.toLowerCase().trim();
  if (/\b(allow|yes|yep|haan|haa|ha|kar\s*do|theek|ok|okay|approve|allowed)\b/.test(s)) return "allow";
  if (/\b(deny|no|nope|nahi|na|mat|cancel|reject|stop)\b/.test(s)) return "deny";
  return null;
}
