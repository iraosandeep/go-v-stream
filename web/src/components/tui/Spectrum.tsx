import { useEffect, useRef } from "react";
import { EQ_BANDS } from "@/hooks/usePlayer";

const GREEN = "#a3be8c";
const YELLOW = "#ebcb8b";
const RED = "#bf616a";

/** One stacked bar per EQ band (green → yellow → red), like a terminal visualiser. */
export function Spectrum({
  analyser,
  sampleRate,
  active,
}: {
  analyser: AnalyserNode | null;
  sampleRate: number;
  active: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const data = new Uint8Array(analyser?.frequencyBinCount ?? 0);
    const levels = new Array(EQ_BANDS.length).fill(0);
    const binHz = sampleRate / 2 / Math.max(1, data.length);
    let raf = 0;

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      if (analyser && active) analyser.getByteFrequencyData(data);
      const gap = 10;
      const barW = (w - gap * (EQ_BANDS.length - 1)) / EQ_BANDS.length;

      EQ_BANDS.forEach((freq, i) => {
        // Average the bins between this band and its neighbours (geometric midpoints).
        const lo = i === 0 ? 20 : Math.sqrt(freq * EQ_BANDS[i - 1]!);
        const hi =
          i === EQ_BANDS.length - 1
            ? 20000
            : Math.sqrt(freq * EQ_BANDS[i + 1]!);
        let sum = 0;
        let n = 0;
        for (
          let b = Math.floor(lo / binHz);
          b <= Math.ceil(hi / binHz) && b < data.length;
          b++
        ) {
          sum += data[b]!;
          n++;
        }
        const target = active && n ? sum / n / 255 : 0;
        // Fast attack, slow fall.
        levels[i] = target > levels[i] ? target : levels[i] * 0.9;

        const barH = levels[i] * h;
        const x = i * (barW + gap);
        const segments: [number, number, string][] = [
          [0, 0.55, GREEN],
          [0.55, 0.88, YELLOW],
          [0.88, 1, RED],
        ];
        for (const [from, to, color] of segments) {
          const segH = Math.min(barH, to * h) - from * h;
          if (segH <= 0) continue;
          ctx.fillStyle = color;
          ctx.fillRect(x, h - from * h - segH, barW, segH);
        }
      });
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [analyser, sampleRate, active]);

  return <canvas ref={canvasRef} className="block h-full w-full" />;
}
