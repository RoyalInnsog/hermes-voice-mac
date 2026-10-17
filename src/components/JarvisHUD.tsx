import { useEffect, useRef, useMemo } from "react";
import type { Orchestrator } from "../hooks/useHermesVoice";
import { cn } from "../utils/cn";

interface JarvisHUDProps {
  o: Orchestrator;
  className?: string;
}

export function JarvisHUD({ o, className }: JarvisHUDProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const active = o.state === "listening" || o.state === "thinking" || o.state === "speaking";
  const energy = o.state === "listening" 
    ? Math.min(1, o.level * 4.5) 
    : o.state === "speaking" 
      ? Math.min(1, o.playbackLevel * 2.2) 
      : o.state === "thinking" 
        ? 0.45 
        : 0.12;

  // Extract quantitative data / stats from the last assistant response to draw intelligent graphs
  const visualData = useMemo(() => {
    const text = o.lastAssistant || "";
    if (!text) return null;

    // Detect numbers, percentages, or items
    const percentMatches = Array.from(text.matchAll(/(\d+(?:\.\d+)?)\s*%/g)).map(m => parseFloat(m[1]));
    const ratioMatches = Array.from(text.matchAll(/(\d+)\/(\d+)/g)).map(m => ({ num: parseInt(m[1]), den: parseInt(m[2]) }));
    const stepMatches = Array.from(text.matchAll(/(?:^|\n)\s*(?:\d+\.|\-|\*)\s*([^\n]+)/g)).map(m => m[1].slice(0, 32));

    const stats: { label: string; value: string; pct: number }[] = [];

    if (percentMatches.length > 0) {
      percentMatches.slice(0, 3).forEach((p, idx) => {
        stats.push({ label: `METRIC ${idx + 1}`, value: `${p}%`, pct: Math.min(100, p) });
      });
    }

    if (ratioMatches.length > 0) {
      ratioMatches.slice(0, 2).forEach((r, idx) => {
        const pct = Math.min(100, Math.round((r.num / Math.max(1, r.den)) * 100));
        stats.push({ label: `VERIFY ${idx + 1}`, value: `${r.num}/${r.den}`, pct });
      });
    }

    return {
      hasData: stats.length > 0 || stepMatches.length > 0,
      stats,
      steps: stepMatches.slice(0, 3)
    };
  }, [o.lastAssistant]);

  // Canvas Arc Reactor & Holographic Waveform Animation
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let rotation = 0;

    const render = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth || 320;
      const h = canvas.clientHeight || 180;

      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }

      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, w, h);

      const cx = w / 2;
      const cy = h / 2;
      const baseR = 48 + energy * 18;

      rotation += (0.012 + energy * 0.02);

      // 1. Radial Glow / Arc Reactor Core
      const grad = ctx.createRadialGradient(cx, cy, 4, cx, cy, baseR * 1.8);
      if (o.state === "listening") {
        grad.addColorStop(0, "rgba(243, 190, 92, 0.85)");
        grad.addColorStop(0.4, "rgba(229, 169, 60, 0.45)");
        grad.addColorStop(1, "rgba(229, 169, 60, 0)");
      } else if (o.state === "thinking") {
        grad.addColorStop(0, "rgba(245, 158, 11, 0.8)");
        grad.addColorStop(0.5, "rgba(217, 119, 6, 0.35)");
        grad.addColorStop(1, "rgba(217, 119, 6, 0)");
      } else if (o.state === "speaking") {
        grad.addColorStop(0, "rgba(34, 197, 94, 0.85)");
        grad.addColorStop(0.5, "rgba(229, 169, 60, 0.4)");
        grad.addColorStop(1, "rgba(34, 197, 94, 0)");
      } else {
        grad.addColorStop(0, "rgba(229, 169, 60, 0.45)");
        grad.addColorStop(0.5, "rgba(229, 169, 60, 0.15)");
        grad.addColorStop(1, "rgba(229, 169, 60, 0)");
      }
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, baseR * 1.8, 0, Math.PI * 2);
      ctx.fill();

      // 2. Outer Rotating Reticle (Iron Man HUD)
      ctx.strokeStyle = "rgba(229, 169, 60, 0.25)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, baseR + 24, 0, Math.PI * 2);
      ctx.stroke();

      // Segmented outer ring
      const segments = 16;
      for (let i = 0; i < segments; i++) {
        const a1 = rotation + (i * (Math.PI * 2 / segments));
        const a2 = a1 + (Math.PI / segments) * 0.65;
        ctx.strokeStyle = i % 4 === 0 ? "rgba(243, 190, 92, 0.75)" : "rgba(229, 169, 60, 0.35)";
        ctx.lineWidth = i % 4 === 0 ? 2 : 1;
        ctx.beginPath();
        ctx.arc(cx, cy, baseR + 24, a1, a2);
        ctx.stroke();
      }

      // 3. Counter-rotating inner conduit ring
      const innerSegments = 12;
      for (let i = 0; i < innerSegments; i++) {
        const a1 = -rotation * 1.4 + (i * (Math.PI * 2 / innerSegments));
        const a2 = a1 + (Math.PI / innerSegments) * 0.4;
        ctx.strokeStyle = "rgba(229, 169, 60, 0.5)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(cx, cy, baseR + 10, a1, a2);
        ctx.stroke();
      }

      // 4. Frequency spectrum bars radiating outward
      const barCount = 36;
      for (let i = 0; i < barCount; i++) {
        const ang = (i / barCount) * Math.PI * 2;
        const wave = Math.sin(ang * 4 + rotation * 3) * 0.5 + 0.5;
        const barLen = 4 + energy * 24 * wave + (active ? Math.sin(ang * 8 + Date.now() / 80) * 4 : 0);

        const x1 = cx + Math.cos(ang) * (baseR - 4);
        const y1 = cy + Math.sin(ang) * (baseR - 4);
        const x2 = cx + Math.cos(ang) * (baseR + barLen);
        const y2 = cy + Math.sin(ang) * (baseR + barLen);

        ctx.strokeStyle = o.state === "speaking" ? "rgba(34, 197, 94, 0.8)" : "rgba(243, 190, 92, 0.85)";
        ctx.lineWidth = 2;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }

      // 5. Central Reactor Core
      ctx.fillStyle = o.state === "speaking" ? "#22c55e" : "#e5a93c";
      ctx.beginPath();
      ctx.arc(cx, cy, 9 + energy * 6, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
      raf = requestAnimationFrame(render);
    };

    render();
    return () => cancelAnimationFrame(raf);
  }, [energy, o.state, active]);

  return (
    <div className={cn("relative flex flex-col items-center justify-center w-full", className)}>
      {/* Top Sci-Fi Telemetry Banner */}
      <div className="w-full flex items-center justify-between px-3 py-1 mb-1 border-b border-white/5 text-[9.5px] font-mono tracking-wider text-[var(--color-gold)]/70 uppercase">
        <span className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-gold)] animate-pulse" />
          JARVIS // MK-85
        </span>
        <span className="text-[var(--color-muted)]">
          {o.state.toUpperCase()} · VAD_280Hz: OK
        </span>
        <span className="text-emerald-400 font-semibold">
          WAKE: "KRITI"
        </span>
      </div>

      {/* Main Holographic Reactor Canvas */}
      <div className="relative w-full h-[180px] flex items-center justify-center">
        <canvas ref={canvasRef} className="w-full h-full block" />
        
        {/* Center state badge */}
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[10px] font-mono tracking-widest text-black font-bold uppercase drop-shadow">
            {o.state === "thinking" ? "THINK" : o.state === "listening" ? "REC" : o.state === "speaking" ? "VOX" : "HUD"}
          </span>
        </div>
      </div>

      {/* Intelligent Data / Graph Visualizations (Shown when Hermes answers with metrics or steps) */}
      {visualData && visualData.hasData && (
        <div className="w-full mt-2 rounded-xl border border-[var(--color-gold)]/20 bg-black/40 p-2.5 backdrop-blur-md">
          <div className="flex items-center justify-between mb-2 pb-1 border-b border-white/5">
            <span className="text-[10px] font-mono text-[var(--color-gold-bright)] uppercase tracking-wider flex items-center gap-1">
              📊 INTELLIGENT METRICS // TELEMETRY
            </span>
            <span className="text-[9px] text-[var(--color-muted)] font-mono">LIVE AGENT TELEMETRY</span>
          </div>

          {/* Glowing Animated Bar Metrics */}
          {visualData.stats.length > 0 && (
            <div className="grid grid-cols-2 gap-2 mb-2">
              {visualData.stats.map((s, idx) => (
                <div key={idx} className="rounded-lg bg-white/5 p-2 border border-white/5">
                  <div className="flex items-center justify-between text-[10px] font-mono text-[var(--color-muted)]">
                    <span>{s.label}</span>
                    <span className="text-[var(--color-gold-bright)] font-bold">{s.value}</span>
                  </div>
                  <div className="w-full h-1.5 bg-black/50 rounded-full mt-1.5 overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-[var(--color-gold)] to-emerald-400 rounded-full transition-all duration-700"
                      style={{ width: `${s.pct}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Sequential Step Execution Breakdown */}
          {visualData.steps.length > 0 && (
            <div className="space-y-1">
              {visualData.steps.map((st, idx) => (
                <div key={idx} className="flex items-center gap-2 text-[11px] text-[var(--color-ink-2)] font-mono">
                  <span className="text-[var(--color-gold)] font-bold">[{idx + 1}]</span>
                  <span className="truncate">{st}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
