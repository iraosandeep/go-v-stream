import { useCallback, useEffect, useRef, useState } from "react";

export type Status = "stopped" | "streaming" | "paused" | "buffering" | "error";
export type Repeat = "off" | "all" | "one";

/** Centre frequencies of the 10-band EQ (also used for the spectrum bars). */
export const EQ_BANDS = [
  70, 180, 320, 600, 1000, 3000, 6000, 12000, 14000, 16000,
];

export const EQ_PRESETS: { name: string; gains: number[] }[] = [
  { name: "Flat", gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { name: "Bass", gains: [6, 5, 3, 1, 0, 0, 0, 0, 0, 0] },
  { name: "Treble", gains: [0, 0, 0, 0, 0, 1, 3, 5, 6, 6] },
  { name: "Vocal", gains: [-2, -1, 0, 2, 4, 4, 3, 1, 0, -1] },
  { name: "Loud", gains: [5, 3, 0, -1, 0, 0, 1, 3, 4, 5] },
];

export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

export const VOL_MIN = -30;
export const VOL_MAX = 6;
export const VOL_STEP = 3;

type Graph = {
  ctx: AudioContext;
  gain: GainNode;
  filters: BiquadFilterNode[];
  analyser: AnalyserNode;
};

const dbToGain = (db: number) => (db <= VOL_MIN ? 0 : Math.pow(10, db / 20));

export type Net = { loaded: number; total: number; rate: number };

export function usePlayer({ onEnded }: { onEnded: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const graphRef = useRef<Graph | null>(null);
  const sizeRef = useRef(0);
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;

  const [graphReady, setGraphReady] = useState(false);
  const [status, setStatus] = useState<Status>("stopped");
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState<[number, number][]>([]);
  const [volumeDb, setVolumeDb] = useState(0);
  const [eq, setEq] = useState(0);
  const [speed, setSpeed] = useState(SPEEDS.indexOf(1));
  const [net, setNet] = useState<Net>({ loaded: 0, total: 0, rate: 0 });

  /**
   * Route the video's audio through Web Audio (EQ → gain → analyser) so we can boost volume, equalise
   * and draw a spectrum. Must happen on a user gesture, and only once per media element.
   */
  const ensureGraph = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (graphRef.current) {
      void graphRef.current.ctx.resume();
      return;
    }
    try {
      const ctx = new AudioContext();
      const source = ctx.createMediaElementSource(video);
      const filters = EQ_BANDS.map((freq, i) => {
        const f = ctx.createBiquadFilter();
        f.type =
          i === 0
            ? "lowshelf"
            : i === EQ_BANDS.length - 1
              ? "highshelf"
              : "peaking";
        f.frequency.value = freq;
        f.Q.value = 1.1;
        return f;
      });
      const gain = ctx.createGain();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 4096;
      analyser.smoothingTimeConstant = 0.8;
      const chain: AudioNode[] = [source, ...filters, gain, analyser];
      chain.reduce((a, b) => a.connect(b));
      analyser.connect(ctx.destination);
      graphRef.current = { ctx, gain, filters, analyser };
      setGraphReady(true);
    } catch {
      // Web Audio unavailable: fall back to plain element volume, no EQ/spectrum.
    }
  }, []);

  useEffect(() => {
    const g = graphRef.current;
    const video = videoRef.current;
    if (g) {
      g.gain.gain.value = dbToGain(volumeDb);
      if (video) video.volume = 1;
    } else if (video) {
      video.volume = Math.min(1, dbToGain(volumeDb));
    }
  }, [volumeDb, graphReady]);

  useEffect(() => {
    graphRef.current?.filters.forEach(
      (f, i) => (f.gain.value = EQ_PRESETS[eq]!.gains[i]!),
    );
  }, [eq, graphReady]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = SPEEDS[speed]!;
  }, [speed]);

  // Estimate bytes streamed so far from buffered time ranges, and throughput from its growth.
  useEffect(() => {
    let prev = 0;
    const id = setInterval(() => {
      const v = videoRef.current;
      const total = sizeRef.current;
      if (!v || !total || !Number.isFinite(v.duration) || v.duration === 0)
        return;
      let secs = 0;
      for (let i = 0; i < v.buffered.length; i++)
        secs += v.buffered.end(i) - v.buffered.start(i);
      const loaded = Math.min(total, (secs / v.duration) * total);
      const delta = Math.max(0, loaded - prev);
      prev = loaded;
      setNet((n) => ({ loaded, total, rate: n.rate * 0.5 + delta * 0.5 }));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const load = useCallback(
    (url: string, size: number) => {
      const v = videoRef.current;
      if (!v) return;
      ensureGraph();
      sizeRef.current = size;
      setNet({ loaded: 0, total: size, rate: 0 });
      setBuffered([]);
      setTime(0);
      setDuration(0);
      setStatus("buffering");
      v.src = url;
      v.playbackRate = SPEEDS[speed]!;
      v.play().catch(() => setStatus("paused"));
    },
    [ensureGraph, speed],
  );

  const toggle = useCallback(() => {
    const v = videoRef.current;
    if (!v || !v.currentSrc) return;
    ensureGraph();
    if (v.paused || v.ended) v.play().catch(() => {});
    else v.pause();
  }, [ensureGraph]);

  const seek = useCallback((t: number) => {
    const v = videoRef.current;
    if (!v || !Number.isFinite(v.duration)) return;
    v.currentTime = Math.max(0, Math.min(v.duration, t));
  }, []);

  const seekBy = useCallback(
    (d: number) => seek((videoRef.current?.currentTime ?? 0) + d),
    [seek],
  );

  const replay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = 0;
    v.play().catch(() => {});
  }, []);

  /** Unload the current file entirely (e.g. when the media folder changes). */
  const stop = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.pause();
    v.removeAttribute("src");
    v.load();
    sizeRef.current = 0;
    setStatus("stopped");
    setTime(0);
    setDuration(0);
    setBuffered([]);
    setNet({ loaded: 0, total: 0, rate: 0 });
  }, []);

  const syncBuffered = (v: HTMLVideoElement) => {
    const ranges: [number, number][] = [];
    for (let i = 0; i < v.buffered.length; i++)
      ranges.push([v.buffered.start(i), v.buffered.end(i)]);
    setBuffered(ranges);
  };

  const videoProps = {
    ref: videoRef,
    preload: "metadata" as const,
    playsInline: true,
    onPlaying: () => setStatus("streaming"),
    onPause: (e: React.SyntheticEvent<HTMLVideoElement>) =>
      !e.currentTarget.ended && setStatus("paused"),
    onWaiting: () => setStatus("buffering"),
    onEnded: () => {
      setStatus("stopped");
      onEndedRef.current();
    },
    onError: () => setStatus("error"),
    onTimeUpdate: (e: React.SyntheticEvent<HTMLVideoElement>) =>
      setTime(e.currentTarget.currentTime),
    onDurationChange: (e: React.SyntheticEvent<HTMLVideoElement>) =>
      setDuration(e.currentTarget.duration),
    onProgress: (e: React.SyntheticEvent<HTMLVideoElement>) =>
      syncBuffered(e.currentTarget),
  };

  return {
    videoRef,
    videoProps,
    analyser: graphReady ? graphRef.current!.analyser : null,
    sampleRate: graphReady ? graphRef.current!.ctx.sampleRate : 48000,
    status,
    time,
    duration,
    buffered,
    net,
    volumeDb,
    setVolumeDb,
    eq,
    setEq,
    speed,
    setSpeed,
    load,
    toggle,
    seek,
    seekBy,
    replay,
    stop,
  };
}
