"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";

const API = "http://localhost:8000";

// ---------------------------------------------------------------------------
// IndexedDB helpers — persist FileSystemDirectoryHandle across sessions
// ---------------------------------------------------------------------------

const IDB_DB = "crate-digger";
const IDB_STORE = "settings";
const IDB_KEY = "outputDir";

function openIDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(value: unknown) {
  const db = await openIDB();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(value, IDB_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet<T>(): Promise<T | null> {
  try {
    const db = await openIDB();
    return new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
      req.onsuccess = () => resolve((req.result as T) ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// useOutputDir — File System Access API with IndexedDB persistence
// ---------------------------------------------------------------------------

function useOutputDir() {
  const [handle, setHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [dirName, setDirName] = useState<string | null>(null);
  const [supported, setSupported] = useState(false);
  const [showSetup, setShowSetup] = useState(false);

  useEffect(() => {
    setSupported("showDirectoryPicker" in window);
  }, []);

  // Restore saved handle on mount
  useEffect(() => {
    if (!supported) return;
    idbGet<FileSystemDirectoryHandle>().then(async (h) => {
      if (!h) {
        setShowSetup(true); // first visit — prompt setup
        return;
      }
      // Verify we still have permission (may have been revoked)
      try {
        // queryPermission / requestPermission are File System Access API extensions
        // not yet in TypeScript's lib.dom.d.ts — cast to any
        const perm = await (h as any).queryPermission({ mode: "readwrite" });
        if (perm === "granted") {
          setHandle(h);
          setDirName(h.name);
        } else {
          setShowSetup(true);
        }
      } catch {
        setShowSetup(true);
      }
    });
  }, [supported]);

  const pickDir = useCallback(async () => {
    if (!supported) return;
    try {
      const h = await (window as unknown as { showDirectoryPicker: (o?: object) => Promise<FileSystemDirectoryHandle> })
        .showDirectoryPicker({ mode: "readwrite" });
      await idbPut(h);
      setHandle(h);
      setDirName(h.name);
      setShowSetup(false);
    } catch {
      // user cancelled — keep existing state
    }
  }, [supported]);

  const saveFile = useCallback(async (blob: Blob, filename: string): Promise<boolean> => {
    if (!handle) return false;
    try {
      const perm = await (handle as any).requestPermission({ mode: "readwrite" });
      if (perm !== "granted") return false;
      const fh = await handle.getFileHandle(filename, { create: true });
      const writable = await fh.createWritable();
      await writable.write(blob);
      await writable.close();
      return true;
    } catch {
      return false;
    }
  }, [handle]);

  return { supported, handle, dirName, showSetup, setShowSetup, pickDir, saveFile };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Track {
  id: string;
  filename: string;
  title: string;
  bpm?: number | null;
  duration?: number | null;
}

interface AudioNodes {
  gain: GainNode;
  low: BiquadFilterNode;
  mid: BiquadFilterNode;
  high: BiquadFilterNode;
  sweep: BiquadFilterNode;
  crossfadeGain: GainNode;
}

// ---------------------------------------------------------------------------
// useDeck — owns the full audio graph for one deck
// ---------------------------------------------------------------------------

function useDeck(progressColor: string) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const nodesRef = useRef<AudioNodes | null>(null);
  const mediaStreamDestRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const loopStartRef = useRef<number | null>(null);
  const loopEndRef = useRef<number | null>(null);
  const loopingRef = useRef(false);
  const bpmRef = useRef<number | null>(null);

  const [track, setTrack] = useState<Track | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [bpm, setBpmState] = useState<number | null>(null);
  const [eqLow, setEqLow] = useState(0);
  const [eqMid, setEqMid] = useState(0);
  const [eqHigh, setEqHigh] = useState(0);
  const [filterVal, setFilterValState] = useState(0.5);
  const [volume, setVolumeState] = useState(1);
  const [hotCues, setHotCues] = useState<(number | null)[]>([null, null, null]);
  const [looping, setLooping] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;

    // ---- Audio element ----
    const audio = new Audio();
    audio.crossOrigin = "anonymous";
    audioRef.current = audio;

    // Loop enforcement via timeupdate
    audio.addEventListener("timeupdate", () => {
      if (
        loopingRef.current &&
        loopStartRef.current !== null &&
        loopEndRef.current !== null &&
        audio.currentTime >= loopEndRef.current
      ) {
        audio.currentTime = loopStartRef.current;
      }
    });

    // ---- Web Audio graph ----
    const ctx = new AudioContext();
    ctxRef.current = ctx;

    const source = ctx.createMediaElementSource(audio);
    const gain = ctx.createGain();

    const low = ctx.createBiquadFilter();
    low.type = "lowshelf";
    low.frequency.value = 320;
    low.gain.value = 0;

    const mid = ctx.createBiquadFilter();
    mid.type = "peaking";
    mid.frequency.value = 1000;
    mid.Q.value = 0.5;
    mid.gain.value = 0;

    const high = ctx.createBiquadFilter();
    high.type = "highshelf";
    high.frequency.value = 3200;
    high.gain.value = 0;

    const sweep = ctx.createBiquadFilter();
    sweep.type = "lowpass";
    sweep.frequency.value = 22050; // effectively open at center
    sweep.Q.value = 0.7;

    const crossfadeGain = ctx.createGain();
    crossfadeGain.gain.value = 1; // starts fully open; controlled by crossfader

    const mediaStreamDest = ctx.createMediaStreamDestination();
    mediaStreamDestRef.current = mediaStreamDest;

    source
      .connect(gain)
      .connect(low)
      .connect(mid)
      .connect(high)
      .connect(sweep)
      .connect(crossfadeGain);

    // Connect to both speakers and the recording tap
    crossfadeGain.connect(ctx.destination);
    crossfadeGain.connect(mediaStreamDest);

    nodesRef.current = { gain, low, mid, high, sweep, crossfadeGain };

    // ---- WaveSurfer (uses our audio element for transport + viz) ----
    const ws = WaveSurfer.create({
      container: containerRef.current,
      media: audio,
      waveColor: "#3f3f46",
      progressColor,
      height: 80,
      barWidth: 2,
      barGap: 1,
      interact: true,
      normalize: true,
    });

    ws.on("finish", () => setIsPlaying(false));
    wsRef.current = ws;

    return () => {
      ws.destroy();
      ctx.close();
      wsRef.current = null;
      audioRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const loadTrack = useCallback((t: Track) => {
    ctxRef.current?.resume();
    wsRef.current?.load(`${API}/api/audio/${t.filename}`);
    setTrack(t);
    setIsPlaying(false);
    const b = t.bpm ?? null;
    setBpmState(b);
    bpmRef.current = b;
    setHotCues([null, null, null]);
    loopingRef.current = false;
    setLooping(false);
  }, []);

  const setBpm = useCallback((val: number) => {
    setBpmState(val);
    bpmRef.current = val;
  }, []);

  const togglePlay = useCallback(() => {
    ctxRef.current?.resume();
    wsRef.current?.playPause();
    setIsPlaying((p) => !p);
  }, []);

  const setLow = useCallback((db: number) => {
    if (nodesRef.current) nodesRef.current.low.gain.value = db;
    setEqLow(db);
  }, []);

  const setMid = useCallback((db: number) => {
    if (nodesRef.current) nodesRef.current.mid.gain.value = db;
    setEqMid(db);
  }, []);

  const setHigh = useCallback((db: number) => {
    if (nodesRef.current) nodesRef.current.high.gain.value = db;
    setEqHigh(db);
  }, []);

  const setFilter = useCallback((val: number) => {
    setFilterValState(val);
    const sw = nodesRef.current?.sweep;
    if (!sw) return;
    if (val <= 0.5) {
      sw.type = "lowpass";
      const t = val / 0.5; // 0→1
      sw.frequency.value = 150 * Math.pow(22050 / 150, t); // 150Hz → 22kHz
    } else {
      sw.type = "highpass";
      const t = (val - 0.5) / 0.5; // 0→1
      sw.frequency.value = 20 * Math.pow(100, t); // 20Hz → 2000Hz
    }
  }, []);

  const setVolume = useCallback((val: number) => {
    if (nodesRef.current) nodesRef.current.gain.gain.value = val;
    setVolumeState(val);
  }, []);

  const setCrossfadeGain = useCallback((val: number) => {
    if (nodesRef.current) nodesRef.current.crossfadeGain.gain.value = val;
  }, []);

  const tapHotCue = useCallback(
    (index: number) => {
      const ws = wsRef.current;
      const audio = audioRef.current;
      if (!ws || !audio) return;
      const cue = hotCues[index];
      if (cue !== null) {
        ws.setTime(cue);
      } else {
        const pos = audio.currentTime;
        setHotCues((prev) => {
          const next = [...prev];
          next[index] = pos;
          return next;
        });
      }
    },
    [hotCues]
  );

  const clearHotCue = useCallback((index: number) => {
    setHotCues((prev) => {
      const next = [...prev];
      next[index] = null;
      return next;
    });
  }, []);

  const toggleLoop = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (loopingRef.current) {
      loopingRef.current = false;
      setLooping(false);
    } else {
      const start = audio.currentTime;
      const bars = bpmRef.current ? (32 / bpmRef.current) * 60 : 8;
      loopStartRef.current = start;
      loopEndRef.current = start + bars;
      loopingRef.current = true;
      setLooping(true);
    }
  }, []);

  const [playbackRate, setPlaybackRateState] = useState(1.0);

  const setTempo = useCallback((rate: number) => {
    if (audioRef.current) audioRef.current.playbackRate = rate;
    setPlaybackRateState(rate);
  }, []);

  const resetTempo = useCallback(() => {
    if (audioRef.current) audioRef.current.playbackRate = 1.0;
    setPlaybackRateState(1.0);
  }, []);

  // Effective BPM accounts for playback rate
  const effectiveBpm = bpm != null ? Math.round(bpm * playbackRate * 10) / 10 : null;

  const getMediaStream = useCallback(
    () => mediaStreamDestRef.current?.stream ?? null,
    []
  );

  return {
    containerRef, wsRef,
    track, isPlaying, bpm: effectiveBpm, rawBpm: bpm, setBpm,
    eqLow, eqMid, eqHigh, filterVal, volume,
    hotCues, looping,
    playbackRate,
    loadTrack, togglePlay,
    setLow, setMid, setHigh, setFilter, setVolume,
    tapHotCue, clearHotCue, toggleLoop,
    setTempo, resetTempo,
    getMediaStream,
    setCrossfadeGain,
  };
}

// ---------------------------------------------------------------------------
// Deck component
// ---------------------------------------------------------------------------

const CUE_COLORS = ["#ef4444", "#eab308", "#22d3ee"];

function Deck({
  label,
  accentClass,
  deck,
}: {
  label: string;
  accentClass: string;
  deck: ReturnType<typeof useDeck>;
}) {
  const {
    containerRef, track, isPlaying, bpm,
    eqLow, eqMid, eqHigh, filterVal, volume,
    hotCues, looping,
    playbackRate, setTempo, resetTempo,
    togglePlay, setLow, setMid, setHigh, setFilter, setVolume,
    tapHotCue, clearHotCue, toggleLoop,
  } = deck;

  const filterLabel = filterVal < 0.47 ? "LP" : filterVal > 0.53 ? "HP" : "OPEN";

  return (
    <div className="flex-1 flex flex-col gap-2.5 bg-zinc-900 rounded-xl p-3 border border-zinc-800 min-w-0">
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className={`text-xs font-mono tracking-widest uppercase ${accentClass}`}>{label}</span>
        {bpm != null && (
          <span className="text-xs font-mono text-zinc-400">{bpm.toFixed(1)} BPM</span>
        )}
      </div>

      {/* Waveform */}
      <div ref={containerRef} className="h-20 bg-zinc-800 rounded-lg overflow-hidden" />

      {/* Track title */}
      <p className="text-xs text-zinc-300 truncate min-h-[1rem]">
        {track?.title ?? <span className="text-zinc-600 italic">No track loaded</span>}
      </p>

      {/* Transport row */}
      <div className="flex gap-1.5">
        <button
          onClick={togglePlay}
          disabled={!track}
          className="flex-1 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-30 text-white text-xs font-mono tracking-wider transition-colors"
        >
          {isPlaying ? "⏸  PAUSE" : "▶  PLAY"}
        </button>
        <button
          onClick={toggleLoop}
          disabled={!track}
          title="8-bar loop from current position"
          className={`px-3 py-1.5 rounded-lg text-xs font-mono transition-colors disabled:opacity-30 ${
            looping
              ? "bg-amber-500 text-black font-bold"
              : "bg-zinc-800 hover:bg-zinc-700 text-zinc-400"
          }`}
        >
          LOOP
        </button>
      </div>

      {/* Hot cues */}
      <div className="flex gap-1">
        {hotCues.map((cue, i) => (
          <div key={i} className="flex-1 flex gap-0.5 min-w-0">
            <button
              onClick={() => tapHotCue(i)}
              disabled={!track}
              title={cue !== null ? `Jump to ${cue.toFixed(1)}s` : "Set cue at current position"}
              className="flex-1 py-1 rounded text-[10px] font-mono transition-all disabled:opacity-30 truncate"
              style={{
                backgroundColor: cue !== null ? CUE_COLORS[i] + "22" : "#27272a",
                color: cue !== null ? CUE_COLORS[i] : "#52525b",
                border: `1px solid ${cue !== null ? CUE_COLORS[i] + "55" : "transparent"}`,
              }}
            >
              {cue !== null ? `${cue.toFixed(0)}s` : `CUE ${i + 1}`}
            </button>
            {cue !== null && (
              <button
                onClick={() => clearHotCue(i)}
                className="px-1 rounded text-[10px] text-zinc-600 hover:text-red-400 transition-colors bg-zinc-800 shrink-0"
              >
                ✕
              </button>
            )}
          </div>
        ))}
      </div>

      {/* 3-Band EQ */}
      <div className="border-t border-zinc-800 pt-2">
        <p className="text-[9px] font-mono text-zinc-600 mb-1.5 tracking-widest">EQ</p>
        <div className="grid grid-cols-3 gap-2">
          {[
            { label: "LOW", val: eqLow, set: setLow },
            { label: "MID", val: eqMid, set: setMid },
            { label: "HIGH", val: eqHigh, set: setHigh },
          ].map(({ label: l, val, set }) => (
            <div key={l} className="flex flex-col items-center gap-0.5">
              <span className="text-[9px] font-mono text-zinc-500">{l}</span>
              <input
                type="range" min="-12" max="6" step="0.5" value={val}
                onChange={(e) => set(parseFloat(e.target.value))}
                className="w-full"
              />
              <span className="text-[9px] font-mono text-zinc-500">
                {val > 0 ? "+" : ""}{val}dB
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Filter + Volume */}
      <div className="border-t border-zinc-800 pt-2 grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-0.5">
          <div className="flex justify-between items-center">
            <span className="text-[9px] font-mono text-zinc-500">FILTER</span>
            <span className={`text-[9px] font-mono ${
              filterLabel === "OPEN" ? "text-zinc-600" : "text-amber-400"
            }`}>{filterLabel}</span>
          </div>
          <input
            type="range" min="0" max="1" step="0.01" value={filterVal}
            onChange={(e) => setFilter(parseFloat(e.target.value))}
            className="w-full"
          />
          <div className="flex justify-between">
            <span className="text-[9px] text-zinc-700 font-mono">LP</span>
            <span className="text-[9px] text-zinc-700 font-mono">HP</span>
          </div>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[9px] font-mono text-zinc-500">VOLUME</span>
          <input
            type="range" min="0" max="1.5" step="0.01" value={volume}
            onChange={(e) => setVolume(parseFloat(e.target.value))}
            className="w-full"
          />
          <span className="text-[9px] font-mono text-zinc-500 text-right">
            {Math.round(volume * 100)}%
          </span>
        </div>
      </div>

      {/* Tempo */}
      <div className="border-t border-zinc-800 pt-2">
        <div className="flex justify-between items-center mb-1">
          <span className="text-[9px] font-mono text-zinc-500">TEMPO</span>
          <div className="flex items-center gap-1.5">
            {bpm != null && (
              <span className="text-[9px] font-mono text-zinc-400">{bpm.toFixed(1)} BPM</span>
            )}
            <button
              onClick={resetTempo}
              disabled={playbackRate === 1.0}
              className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-500 hover:text-zinc-300 disabled:opacity-30 transition-colors"
            >
              RST
            </button>
          </div>
        </div>
        <input
          type="range" min="0.85" max="1.15" step="0.001" value={playbackRate}
          onChange={(e) => setTempo(parseFloat(e.target.value))}
          className="w-full"
        />
        <div className="flex justify-between mt-0.5">
          <span className="text-[9px] text-zinc-700 font-mono">-15%</span>
          <span className={`text-[9px] font-mono ${Math.abs(playbackRate - 1) < 0.002 ? "text-zinc-700" : "text-amber-400"}`}>
            {playbackRate > 1 ? "+" : ""}{((playbackRate - 1) * 100).toFixed(1)}%
          </span>
          <span className="text-[9px] text-zinc-700 font-mono">+15%</span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Suggestion types (from API)
// ---------------------------------------------------------------------------

interface SuggestionTrack {
  title: string;
  url: string;
  duration?: number | null;
}

interface Suggestion {
  id: string;
  label: string;
  technique: string;
  tip: string;
  color: string;
  vibe: string;
  tracks: SuggestionTrack[];
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function Home() {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [ingestUrl, setIngestUrl] = useState("");
  const [ingesting, setIngesting] = useState(false);
  const [ingestError, setIngestError] = useState("");
  const [crossfader, setCrossfader] = useState(0.5);
  const [mixReady, setMixReady] = useState(false);
  const [mixing, setMixing] = useState(false);
  const [showMixIdeas, setShowMixIdeas] = useState(false);
  const [blending, setBlending] = useState(false);
  const [blendDuration, setBlendDuration] = useState(16);
  const blendRAFRef = useRef<number | null>(null);
  const blendStartRef = useRef<{ t: number; from: number; to: number } | null>(null);
  const [recording, setRecording] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recChunksRef = useRef<Blob[]>([]);
  const recMergeCtxRef = useRef<AudioContext | null>(null);
  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [analyzingA, setAnalyzingA] = useState(false);
  const [analyzingB, setAnalyzingB] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [diggingCard, setDiggingCard] = useState<Record<string, number>>({}); // id → count done
  const suggestionsLoaded = useRef(false);

  const outputDir = useOutputDir();

  const deckA = useDeck("#34d399");
  const deckB = useDeck("#a78bfa");

  // Keep real-time crossfade gains in sync with the crossfader position
  useEffect(() => {
    const angle = crossfader * Math.PI / 2;
    deckA.setCrossfadeGain(Math.cos(angle));
    deckB.setCrossfadeGain(Math.sin(angle));
  }, [crossfader]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll track library
  const fetchTracks = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/tracks`);
      if (res.ok) setTracks((await res.json()).tracks);
    } catch { /* backend not ready */ }
  }, []);

  useEffect(() => {
    fetchTracks();
    const id = setInterval(fetchTracks, 3000);
    return () => clearInterval(id);
  }, [fetchTracks]);

  // Fetch suggestions once when panel first opens (cached 24h on server)
  useEffect(() => {
    if (!showMixIdeas || suggestionsLoaded.current) return;
    setLoadingSuggestions(true);
    fetch(`${API}/api/suggestions`)
      .then((r) => r.json())
      .then((d) => { setSuggestions(d.suggestions); suggestionsLoaded.current = true; })
      .catch(() => {})
      .finally(() => setLoadingSuggestions(false));
  }, [showMixIdeas]);

  const clearLibrary = useCallback(async () => {
    if (!confirm("Delete all tracks from the library? This cannot be undone.")) return;
    await fetch(`${API}/api/library`, { method: "DELETE" });
    setTracks([]);
  }, []);

  const digSuggestion = useCallback(async (suggestion: Suggestion) => {
    const tracks = suggestion.tracks.slice(0, 5);
    setDiggingCard((prev) => ({ ...prev, [suggestion.id]: 0 }));
    for (let i = 0; i < tracks.length; i++) {
      await fetch(`${API}/api/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: tracks[i].url }),
      }).catch(() => {});
      setDiggingCard((prev) => ({ ...prev, [suggestion.id]: i + 1 }));
    }
    // Remove progress indicator after a moment, then refresh crate
    setTimeout(() => {
      setDiggingCard((prev) => { const n = { ...prev }; delete n[suggestion.id]; return n; });
      fetchTracks();
    }, 1500);
    setTimeout(fetchTracks, 8000);
  }, [fetchTracks]);

  const startBlend = useCallback(() => {
    const target = crossfader < 0.5 ? 1 : 0;
    blendStartRef.current = { t: performance.now(), from: crossfader, to: target };
    setBlending(true);

    const animate = () => {
      if (!blendStartRef.current) return;
      const progress = Math.min((performance.now() - blendStartRef.current.t) / 1000 / blendDuration, 1);
      // Ease-in-out (smooth start + smooth landing)
      const eased = progress < 0.5 ? 2 * progress * progress : -1 + (4 - 2 * progress) * progress;
      const next = blendStartRef.current.from + (blendStartRef.current.to - blendStartRef.current.from) * eased;
      setCrossfader(next);
      setMixReady(false);

      if (progress < 1) {
        blendRAFRef.current = requestAnimationFrame(animate);
      } else {
        setCrossfader(blendStartRef.current.to); // snap to exact target
        blendStartRef.current = null;
        setBlending(false);
      }
    };
    blendRAFRef.current = requestAnimationFrame(animate);
  }, [crossfader, blendDuration]);

  const cancelBlend = useCallback(() => {
    if (blendRAFRef.current) cancelAnimationFrame(blendRAFRef.current);
    blendRAFRef.current = null;
    blendStartRef.current = null;
    setBlending(false);
  }, []);

  const startRecording = useCallback(() => {
    const streamA = deckA.getMediaStream();
    const streamB = deckB.getMediaStream();
    if (!streamA && !streamB) return;

    // Merge both deck streams into a single AudioContext
    const mergeCtx = new AudioContext();
    recMergeCtxRef.current = mergeCtx;
    const mergeDest = mergeCtx.createMediaStreamDestination();
    if (streamA) mergeCtx.createMediaStreamSource(streamA).connect(mergeDest);
    if (streamB) mergeCtx.createMediaStreamSource(streamB).connect(mergeDest);

    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : MediaRecorder.isTypeSupported("audio/ogg;codecs=opus")
      ? "audio/ogg;codecs=opus"
      : "";

    const recorder = new MediaRecorder(mergeDest.stream, mimeType ? { mimeType } : {});
    recChunksRef.current = [];

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) recChunksRef.current.push(e.data);
    };

    recorder.onstop = async () => {
      const blob = new Blob(recChunksRef.current, { type: recorder.mimeType });
      const ext = recorder.mimeType.includes("ogg") ? "ogg"
        : recorder.mimeType.includes("mp4") ? "m4a" : "webm";
      const filename = `recording-${Date.now()}.${ext}`;
      const saved = await outputDir.saveFile(blob, filename);
      if (!saved) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = filename; a.click();
        URL.revokeObjectURL(url);
      }
      recMergeCtxRef.current?.close();
      recMergeCtxRef.current = null;
    };

    recorder.start();
    mediaRecorderRef.current = recorder;
    setRecSeconds(0);
    recTimerRef.current = setInterval(() => setRecSeconds((s) => s + 1), 1000);
    setRecording(true);
  }, [deckA, deckB, outputDir]);

  const stopRecording = useCallback(() => {
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current = null;
    if (recTimerRef.current) { clearInterval(recTimerRef.current); recTimerRef.current = null; }
    setRecording(false);
    setRecSeconds(0);
  }, []);

  // Match one deck's tempo to the other's base BPM
  // reference = the deck that stays fixed; the other deck's playbackRate is adjusted
  const matchBpm = useCallback((reference: "A" | "B") => {
    const ref = reference === "A" ? deckA : deckB;
    const adj = reference === "A" ? deckB : deckA;
    if (!ref.rawBpm || !adj.rawBpm) return;
    const newRate = ref.rawBpm / adj.rawBpm;
    adj.setTempo(Math.max(0.85, Math.min(1.15, newRate)));
  }, [deckA, deckB]);

  const analyzeBpm = useCallback(
    async (deck: "A" | "B") => {
      const d = deck === "A" ? deckA : deckB;
      if (!d.track) return;
      const setAnalyzing = deck === "A" ? setAnalyzingA : setAnalyzingB;
      setAnalyzing(true);
      try {
        const res = await fetch(`${API}/api/analyze/${d.track.id}`, { method: "POST" });
        if (!res.ok) return;
        const data = await res.json();
        d.setBpm(data.bpm);
        setTracks((prev) => prev.map((t) => (t.id === d.track!.id ? { ...t, bpm: data.bpm } : t)));
      } finally {
        setAnalyzing(false);
      }
    },
    [deckA, deckB]
  );

  const handleSync = useCallback(async () => {
    if (!deckA.track || !deckB.track || mixing) return;
    if (!deckA.bpm || !deckB.bpm) {
      alert("Hit BPM on both decks first.");
      return;
    }
    setMixing(true);
    try {
      const res = await fetch(`${API}/api/mix`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deck_a: deckA.track.id,
          deck_b: deckB.track.id,
          crossfader,
          eq_bass_a: 1,
          eq_bass_b: 1,
          target_bpm: deckA.bpm,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const blob = await res.blob();
      const filename = `mix-${Date.now()}.wav`;
      // Try saving to chosen output directory first; fall back to browser download
      const saved = await outputDir.saveFile(blob, filename);
      if (!saved) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = filename; a.click();
        URL.revokeObjectURL(url);
      }
      setMixReady(true);
    } catch (e) {
      alert(`Mix failed: ${e instanceof Error ? e.message : "unknown"}`);
    } finally {
      setMixing(false);
    }
  }, [deckA, deckB, crossfader, mixing]);

  const handleIngest = useCallback(async () => {
    if (!ingestUrl || ingesting) return;
    setIngesting(true);
    setIngestError("");
    try {
      const res = await fetch(`${API}/api/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: ingestUrl }),
      });
      if (!res.ok) throw new Error(await res.text());
      setIngestUrl("");
      setTimeout(fetchTracks, 4000);
      setTimeout(fetchTracks, 12000);
    } catch (e) {
      setIngestError(e instanceof Error ? e.message : "Ingest failed");
    } finally {
      setIngesting(false);
    }
  }, [ingestUrl, ingesting, fetchTracks]);

  return (
    <main className="h-screen flex flex-col overflow-hidden bg-zinc-950 text-white">

      {/* Output dir setup modal — shown on first visit or when no dir is set */}
      {outputDir.showSetup && outputDir.supported && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="bg-zinc-900 border border-zinc-700 rounded-2xl p-8 max-w-sm w-full mx-4 flex flex-col gap-5">
            <div>
              <h2 className="text-sm font-mono font-bold text-white tracking-wide mb-1">
                Where should mixes be saved?
              </h2>
              <p className="text-xs text-zinc-400 leading-relaxed">
                Pick a folder on your computer. Every mix you export will land there automatically — no more hunting through Downloads.
              </p>
            </div>
            <button
              onClick={outputDir.pickDir}
              className="w-full py-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-black text-xs font-mono tracking-widest transition-colors"
            >
              CHOOSE FOLDER
            </button>
            <button
              onClick={() => outputDir.setShowSetup(false)}
              className="text-[10px] font-mono text-zinc-600 hover:text-zinc-400 transition-colors text-center"
            >
              Skip — use browser Downloads for now
            </button>
          </div>
        </div>
      )}

      {/* Header */}
      <header className="flex items-center gap-3 px-5 py-2.5 border-b border-zinc-800 shrink-0">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
        <span className="text-xs font-mono tracking-[0.3em] text-zinc-400 uppercase">Crate Digger</span>
        <div className="flex-1" />
        {/* Output dir indicator */}
        {outputDir.supported && (
          <button
            onClick={outputDir.pickDir}
            className="flex items-center gap-1.5 text-[10px] font-mono px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 transition-colors"
            title="Change mix output folder"
          >
            <span className={outputDir.dirName ? "text-emerald-400" : "text-zinc-600"}>
              {outputDir.dirName ? `→ ${outputDir.dirName}` : "SET OUTPUT FOLDER"}
            </span>
          </button>
        )}
        <button
          onClick={() => setShowMixIdeas((v) => !v)}
          className={`text-xs font-mono px-3 py-1 rounded-lg transition-colors ${
            showMixIdeas
              ? "bg-zinc-700 text-white"
              : "bg-zinc-800 hover:bg-zinc-700 text-zinc-400"
          }`}
        >
          {showMixIdeas ? "HIDE IDEAS" : "MIX IDEAS"}
        </button>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* ---- Crate ---- */}
        <aside className="w-56 flex flex-col border-r border-zinc-800 shrink-0">
          <div className="p-2.5 border-b border-zinc-800 space-y-2">
            <div className="flex gap-1.5">
              <input
                type="text"
                value={ingestUrl}
                onChange={(e) => setIngestUrl(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleIngest()}
                placeholder="SoundCloud URL..."
                className="flex-1 min-w-0 bg-zinc-800 text-xs text-zinc-300 px-2.5 py-1.5 rounded-lg outline-none placeholder-zinc-600 border border-zinc-700 focus:border-zinc-500 transition-colors"
              />
              <button
                onClick={handleIngest}
                disabled={ingesting || !ingestUrl}
                className="px-2.5 py-1.5 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-black text-xs font-mono rounded-lg transition-colors shrink-0"
              >
                {ingesting ? "..." : "DIG"}
              </button>
            </div>
            {ingestError && <p className="text-[10px] text-red-400 font-mono">{ingestError}</p>}
          </div>

          <div className="flex-1 overflow-y-auto">
            {tracks.length === 0 ? (
              <p className="text-[11px] text-zinc-600 p-3 font-mono leading-relaxed">
                Crate is empty.<br />Paste a URL above.
              </p>
            ) : (
              <>
              <div className="px-3 py-2 border-b border-zinc-800/60 flex items-center justify-between">
                <span className="text-[10px] font-mono text-zinc-600">{tracks.length} tracks</span>
                <button
                  onClick={clearLibrary}
                  className="text-[10px] font-mono text-zinc-600 hover:text-red-400 transition-colors"
                >
                  CLEAR ALL
                </button>
              </div>
              {tracks.map((track) => (
                <div key={track.id} className="group px-3 py-2 hover:bg-zinc-800/60 border-b border-zinc-800/40 transition-colors">
                  <p className="text-[11px] text-zinc-300 truncate leading-snug">{track.title}</p>
                  {track.bpm != null && (
                    <p className="text-[10px] text-zinc-600 font-mono mt-0.5">{track.bpm.toFixed(1)} BPM</p>
                  )}
                  <div className="flex gap-1 mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onClick={() => deckA.loadTrack(track)}
                      className="text-[10px] px-2 py-0.5 rounded bg-emerald-500/20 hover:bg-emerald-500/40 text-emerald-400 font-mono transition-colors">
                      A
                    </button>
                    <button onClick={() => deckB.loadTrack(track)}
                      className="text-[10px] px-2 py-0.5 rounded bg-violet-500/20 hover:bg-violet-500/40 text-violet-400 font-mono transition-colors">
                      B
                    </button>
                  </div>
                </div>
              ))}
              </>
            )}
          </div>
        </aside>

        {/* ---- Main mixer area ---- */}
        <div className="flex-1 flex flex-col overflow-hidden">

          {/* Mix Ideas Panel */}
          {showMixIdeas && (
            <div className="border-b border-zinc-800 bg-zinc-900/60 overflow-x-auto shrink-0">
              {loadingSuggestions ? (
                <div className="flex items-center gap-2 p-4">
                  <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-pulse" />
                  <span className="text-xs font-mono text-zinc-500">Searching for current tracks...</span>
                </div>
              ) : (
                <div className="flex gap-3 p-3 w-max">
                  {suggestions.map((s) => {
                    const digging = diggingCard[s.id];
                    const isDone = digging === 5;
                    return (
                      <div key={s.id}
                        className="w-60 shrink-0 rounded-xl border border-zinc-700 bg-zinc-900 p-3 flex flex-col gap-2">
                        {/* Header */}
                        <div className="flex items-start justify-between gap-2">
                          <span className="text-[10px] font-mono font-bold text-white leading-snug">{s.label}</span>
                          <span className="text-[9px] px-1.5 py-0.5 rounded font-mono shrink-0 mt-0.5"
                            style={{ backgroundColor: s.color + "22", color: s.color }}>
                            {s.technique}
                          </span>
                        </div>
                        {/* Tip */}
                        <p className="text-[10px] text-zinc-400 leading-relaxed">{s.tip}</p>
                        {/* Track list */}
                        {s.tracks.length > 0 && (
                          <div className="border-t border-zinc-800 pt-2 flex flex-col gap-1">
                            <p className="text-[9px] font-mono text-zinc-600 mb-0.5">NOW TRENDING:</p>
                            {s.tracks.slice(0, 5).map((t, i) => (
                              <p key={i} className="text-[10px] text-zinc-400 truncate leading-snug">
                                <span className="text-zinc-600 font-mono mr-1">{i + 1}.</span>{t.title}
                              </p>
                            ))}
                          </div>
                        )}
                        {/* Footer */}
                        <div className="mt-auto pt-2 border-t border-zinc-800 flex items-center justify-between">
                          <span className="text-[9px] font-mono" style={{ color: s.color }}>
                            {s.vibe}
                          </span>
                          <button
                            onClick={() => !digging && !isDone && digSuggestion(s)}
                            disabled={digging !== undefined || s.tracks.length === 0}
                            className="text-[9px] font-mono px-2 py-1 rounded transition-colors disabled:opacity-40"
                            style={{
                              backgroundColor: isDone ? s.color + "33" : s.color + "22",
                              color: s.color,
                            }}
                          >
                            {isDone ? "DIGGED ✓"
                              : digging !== undefined ? `${digging}/5...`
                              : "DIG THESE"}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Decks + center controls */}
          <div className="flex gap-3 flex-1 p-3 overflow-hidden min-h-0">
            <Deck label="DECK A" accentClass="text-emerald-400" deck={deckA} />

            {/* Center column */}
            <div className="w-24 flex flex-col items-center justify-center gap-2 shrink-0">
              <button
                onClick={() => analyzeBpm("A")}
                disabled={!deckA.track || analyzingA}
                className="w-full py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-30 text-emerald-400 text-[10px] font-mono transition-colors"
              >
                {analyzingA ? "..." : "BPM A"}
              </button>
              {/* Match BPM buttons */}
              <div className="flex flex-col gap-1 w-full">
                <button
                  onClick={() => matchBpm("A")}
                  disabled={!deckA.rawBpm || !deckB.rawBpm}
                  title="Set deck B tempo to match deck A"
                  className="w-full py-1 rounded-lg bg-zinc-800 hover:bg-emerald-900/50 disabled:opacity-30 text-emerald-400 text-[9px] font-mono transition-colors"
                >
                  B←A
                </button>
                <button
                  onClick={() => matchBpm("B")}
                  disabled={!deckA.rawBpm || !deckB.rawBpm}
                  title="Set deck A tempo to match deck B"
                  className="w-full py-1 rounded-lg bg-zinc-800 hover:bg-violet-900/50 disabled:opacity-30 text-violet-400 text-[9px] font-mono transition-colors"
                >
                  A←B
                </button>
              </div>
              <button
                onClick={handleSync}
                disabled={mixing || !deckA.track || !deckB.track}
                className={`w-full py-3 rounded-xl text-xs font-mono tracking-widest transition-all disabled:opacity-30 ${
                  mixing ? "bg-zinc-700 text-zinc-400 animate-pulse"
                  : mixReady ? "bg-emerald-500 text-black"
                  : "bg-zinc-800 hover:bg-zinc-700 text-zinc-300"
                }`}
              >
                {mixing ? "..." : "SYNC"}
              </button>
              <button
                onClick={() => analyzeBpm("B")}
                disabled={!deckB.track || analyzingB}
                className="w-full py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-30 text-violet-400 text-[10px] font-mono transition-colors"
              >
                {analyzingB ? "..." : "BPM B"}
              </button>
            </div>

            <Deck label="DECK B" accentClass="text-violet-400" deck={deckB} />
          </div>

          {/* Crossfader + Record */}
          <div className="crossfader px-5 py-3 border-t border-zinc-800 shrink-0 bg-zinc-900/40">
            <div className="flex items-center gap-4">
              <span className="text-xs font-mono text-emerald-400 shrink-0">A</span>
              <input
                type="range" min="0" max="1" step="0.01" value={crossfader}
                onChange={(e) => {
                  cancelBlend();
                  setCrossfader(parseFloat(e.target.value));
                  setMixReady(false);
                }}
                className="flex-1"
              />
              <span className="text-xs font-mono text-violet-400 shrink-0">B</span>
            </div>

            {/* Blend controls row */}
            <div className="flex items-center justify-center gap-2 mt-1.5">
              {blending ? (
                <button
                  onClick={cancelBlend}
                  className="px-3 py-1 rounded-lg bg-amber-900/50 hover:bg-amber-800/50 text-amber-400 text-[10px] font-mono tracking-widest transition-colors"
                >
                  CANCEL BLEND
                </button>
              ) : (
                <>
                  <button
                    onClick={startBlend}
                    disabled={!deckA.track || !deckB.track}
                    className="px-3 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-30 text-zinc-300 text-[10px] font-mono tracking-widest transition-colors"
                  >
                    {crossfader < 0.5 ? "AUTO BLEND →B" : "A← AUTO BLEND"}
                  </button>
                  <select
                    value={blendDuration}
                    onChange={(e) => setBlendDuration(Number(e.target.value))}
                    className="bg-zinc-800 border border-zinc-700 rounded text-[9px] font-mono text-zinc-400 px-1.5 py-1 outline-none"
                  >
                    <option value={8}>8s</option>
                    <option value={16}>16s</option>
                    <option value={32}>32s</option>
                  </select>
                </>
              )}
              <span className="text-[9px] font-mono text-zinc-700 tracking-widest">CROSSFADER</span>
            </div>

            {/* Record controls */}
            <div className="flex items-center justify-center gap-3 mt-2">
              {!recording ? (
                <button
                  onClick={startRecording}
                  disabled={!deckA.track && !deckB.track}
                  className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-zinc-800 hover:bg-red-900/50 disabled:opacity-30 text-zinc-400 hover:text-red-400 text-[10px] font-mono tracking-widest transition-colors"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-current" />
                  REC
                </button>
              ) : (
                <button
                  onClick={stopRecording}
                  className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-red-900/60 hover:bg-red-800/60 text-red-400 text-[10px] font-mono tracking-widest transition-colors"
                >
                  <span className="w-1.5 h-1.5 rounded bg-red-400 animate-pulse" />
                  {`STOP  ${String(Math.floor(recSeconds / 60)).padStart(2, "0")}:${String(recSeconds % 60).padStart(2, "0")}`}
                </button>
              )}
              {recording && (
                <span className="text-[9px] font-mono text-zinc-600">
                  saving to {outputDir.dirName ?? "Downloads"}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
