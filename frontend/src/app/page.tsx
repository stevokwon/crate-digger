"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";

const API = "http://localhost:8000";

interface Track {
  id: string;
  filename: string;
  title: string;
  bpm?: number | null;
  duration?: number | null;
}

interface DeckState {
  track: Track | null;
  isPlaying: boolean;
  bpm: number | null;
}

// ---------------------------------------------------------------------------
// Deck component
// ---------------------------------------------------------------------------

function Deck({
  label,
  accentColor,
  state,
  waveRef,
  bassEQ,
  onTogglePlay,
  onAnalyze,
  onBassChange,
}: {
  label: string;
  accentColor: "emerald" | "violet";
  state: DeckState;
  waveRef: React.RefObject<HTMLDivElement | null>;
  bassEQ: number;
  onTogglePlay: () => void;
  onAnalyze: () => void;
  onBassChange: (v: number) => void;
}) {
  const accent = accentColor === "emerald" ? "text-emerald-400" : "text-violet-400";
  const accentBg =
    accentColor === "emerald"
      ? "bg-emerald-500/20 hover:bg-emerald-500/40 text-emerald-400"
      : "bg-violet-500/20 hover:bg-violet-500/40 text-violet-400";

  return (
    <div className="flex-1 bg-zinc-900 rounded-xl p-4 flex flex-col gap-3 border border-zinc-800">
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="text-xs font-mono tracking-widest text-zinc-500 uppercase">{label}</span>
        {state.bpm != null && (
          <span className={`text-xs font-mono ${accent}`}>{state.bpm.toFixed(1)} BPM</span>
        )}
      </div>

      {/* Waveform */}
      <div
        ref={waveRef}
        className="h-24 bg-zinc-800 rounded-lg overflow-hidden"
      />

      {/* Track title */}
      <p className="text-sm text-zinc-300 truncate h-5">
        {state.track?.title ?? <span className="text-zinc-600">No track loaded</span>}
      </p>

      {/* Controls */}
      <div className="flex gap-2">
        <button
          onClick={onTogglePlay}
          disabled={!state.track}
          className="flex-1 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-30 text-white text-xs font-mono tracking-wider transition-colors"
        >
          {state.isPlaying ? "PAUSE" : "PLAY"}
        </button>
        <button
          onClick={onAnalyze}
          disabled={!state.track}
          className={`px-4 py-2 rounded-lg text-xs font-mono transition-colors disabled:opacity-30 ${accentBg}`}
        >
          BPM
        </button>
      </div>

      {/* Bass EQ */}
      <div className="flex items-center gap-3">
        <span className="text-xs font-mono text-zinc-600 w-10 shrink-0">BASS</span>
        <input
          type="range"
          min="0"
          max="2"
          step="0.01"
          value={bassEQ}
          onChange={(e) => onBassChange(parseFloat(e.target.value))}
          className="flex-1"
        />
        <span className="text-xs font-mono text-zinc-500 w-10 text-right shrink-0">
          {Math.round(bassEQ * 100)}%
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function Home() {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [ingestUrl, setIngestUrl] = useState("");
  const [ingesting, setIngesting] = useState(false);
  const [ingestError, setIngestError] = useState("");

  const [deckA, setDeckA] = useState<DeckState>({ track: null, isPlaying: false, bpm: null });
  const [deckB, setDeckB] = useState<DeckState>({ track: null, isPlaying: false, bpm: null });
  const [crossfader, setCrossfader] = useState(0.5);
  const [bassA, setBassA] = useState(1.0);
  const [bassB, setBassB] = useState(1.0);
  const [mixReady, setMixReady] = useState(false);
  const [mixing, setMixing] = useState(false);

  const waveContainerA = useRef<HTMLDivElement>(null);
  const waveContainerB = useRef<HTMLDivElement>(null);
  const wsA = useRef<WaveSurfer | null>(null);
  const wsB = useRef<WaveSurfer | null>(null);

  // Poll track library
  const fetchTracks = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/tracks`);
      if (res.ok) {
        const data = await res.json();
        setTracks(data.tracks);
      }
    } catch {
      // Backend not ready yet — silent
    }
  }, []);

  useEffect(() => {
    fetchTracks();
    const id = setInterval(fetchTracks, 3000);
    return () => clearInterval(id);
  }, [fetchTracks]);

  // WaveSurfer A
  useEffect(() => {
    if (!waveContainerA.current) return;
    const ws = WaveSurfer.create({
      container: waveContainerA.current,
      waveColor: "#3f3f46",
      progressColor: "#34d399",
      height: 96,
      barWidth: 2,
      barGap: 1,
      interact: true,
      normalize: true,
    });
    ws.on("finish", () => setDeckA((d) => ({ ...d, isPlaying: false })));
    wsA.current = ws;
    return () => {
      ws.destroy();
      wsA.current = null;
    };
  }, []);

  // WaveSurfer B
  useEffect(() => {
    if (!waveContainerB.current) return;
    const ws = WaveSurfer.create({
      container: waveContainerB.current,
      waveColor: "#3f3f46",
      progressColor: "#a78bfa",
      height: 96,
      barWidth: 2,
      barGap: 1,
      interact: true,
      normalize: true,
    });
    ws.on("finish", () => setDeckB((d) => ({ ...d, isPlaying: false })));
    wsB.current = ws;
    return () => {
      ws.destroy();
      wsB.current = null;
    };
  }, []);

  const loadTrack = useCallback((deck: "A" | "B", track: Track) => {
    const ws = deck === "A" ? wsA.current : wsB.current;
    const setter = deck === "A" ? setDeckA : setDeckB;
    if (!ws) return;
    ws.load(`${API}/api/audio/${track.filename}`);
    setter({ track, isPlaying: false, bpm: track.bpm ?? null });
    setMixReady(false);
  }, []);

  const togglePlay = useCallback((deck: "A" | "B") => {
    const ws = deck === "A" ? wsA.current : wsB.current;
    const setter = deck === "A" ? setDeckA : setDeckB;
    if (!ws) return;
    ws.playPause();
    setter((d) => ({ ...d, isPlaying: !d.isPlaying }));
  }, []);

  const analyzeBpm = useCallback(
    async (deck: "A" | "B") => {
      const state = deck === "A" ? deckA : deckB;
      const setter = deck === "A" ? setDeckA : setDeckB;
      if (!state.track) return;
      const res = await fetch(`${API}/api/analyze/${state.track.id}`, { method: "POST" });
      if (!res.ok) return;
      const data = await res.json();
      setter((d) => ({ ...d, bpm: data.bpm }));
      setTracks((prev) =>
        prev.map((t) => (t.id === state.track!.id ? { ...t, bpm: data.bpm } : t))
      );
    },
    [deckA, deckB]
  );

  const handleSync = useCallback(async () => {
    if (!deckA.track || !deckB.track || mixing) return;
    if (!deckA.bpm || !deckB.bpm) {
      alert("Analyze BPM on both decks first, then SYNC.");
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
          eq_bass_a: bassA,
          eq_bass_b: bassB,
          target_bpm: deckA.bpm,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "mix.wav";
      a.click();
      URL.revokeObjectURL(url);
      setMixReady(true);
    } catch (e) {
      alert(`Mix failed: ${e instanceof Error ? e.message : "unknown error"}`);
    } finally {
      setMixing(false);
    }
  }, [deckA, deckB, crossfader, bassA, bassB, mixing]);

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
      // Give yt-dlp time to download, then refresh
      setTimeout(fetchTracks, 4000);
      setTimeout(fetchTracks, 10000);
    } catch (e) {
      setIngestError(e instanceof Error ? e.message : "Ingest failed");
    } finally {
      setIngesting(false);
    }
  }, [ingestUrl, ingesting, fetchTracks]);

  return (
    <main className="h-screen flex flex-col overflow-hidden bg-zinc-950">
      {/* Header */}
      <header className="flex items-center gap-3 px-6 py-3 border-b border-zinc-800 shrink-0">
        <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
        <span className="text-xs font-mono tracking-[0.25em] text-zinc-400 uppercase">
          Crate Digger
        </span>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* ---- Crate Panel ---- */}
        <aside className="w-64 flex flex-col border-r border-zinc-800 shrink-0">
          {/* Ingest form */}
          <div className="p-3 border-b border-zinc-800">
            <div className="flex gap-2">
              <input
                type="text"
                value={ingestUrl}
                onChange={(e) => setIngestUrl(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleIngest()}
                placeholder="SoundCloud / Bandcamp URL"
                className="flex-1 min-w-0 bg-zinc-800 text-xs text-zinc-300 px-3 py-2 rounded-lg outline-none placeholder-zinc-600 border border-zinc-700 focus:border-zinc-500 transition-colors"
              />
              <button
                onClick={handleIngest}
                disabled={ingesting || !ingestUrl}
                className="px-3 py-2 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-black text-xs font-mono rounded-lg transition-colors shrink-0"
              >
                {ingesting ? "..." : "DIG"}
              </button>
            </div>
            {ingestError && (
              <p className="text-xs text-red-400 mt-2 font-mono">{ingestError}</p>
            )}
          </div>

          {/* Track list */}
          <div className="flex-1 overflow-y-auto">
            {tracks.length === 0 ? (
              <p className="text-xs text-zinc-600 p-4 font-mono leading-relaxed">
                No tracks yet.
                <br />
                Paste a URL above.
              </p>
            ) : (
              tracks.map((track) => (
                <div
                  key={track.id}
                  className="group px-3 py-2.5 hover:bg-zinc-800/60 border-b border-zinc-800/50 transition-colors"
                >
                  <p className="text-xs text-zinc-300 truncate leading-snug">{track.title}</p>
                  {track.bpm != null && (
                    <p className="text-xs text-zinc-600 font-mono mt-0.5">{track.bpm.toFixed(1)} BPM</p>
                  )}
                  <div className="flex gap-1.5 mt-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={() => loadTrack("A", track)}
                      className="text-xs px-2.5 py-0.5 rounded bg-emerald-500/20 hover:bg-emerald-500/40 text-emerald-400 font-mono transition-colors"
                    >
                      A
                    </button>
                    <button
                      onClick={() => loadTrack("B", track)}
                      className="text-xs px-2.5 py-0.5 rounded bg-violet-500/20 hover:bg-violet-500/40 text-violet-400 font-mono transition-colors"
                    >
                      B
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </aside>

        {/* ---- Mixer ---- */}
        <div className="flex-1 flex flex-col p-5 gap-4 overflow-hidden">
          {/* Decks row */}
          <div className="flex gap-4 flex-1">
            <Deck
              label="Deck A"
              accentColor="emerald"
              state={deckA}
              waveRef={waveContainerA}
              bassEQ={bassA}
              onTogglePlay={() => togglePlay("A")}
              onAnalyze={() => analyzeBpm("A")}
              onBassChange={setBassA}
            />

            {/* Center column */}
            <div className="w-28 flex flex-col items-center justify-center gap-5 shrink-0">
              <button
                onClick={handleSync}
                disabled={mixing || !deckA.track || !deckB.track}
                className={`w-full py-3 rounded-xl text-xs font-mono tracking-widest transition-all disabled:opacity-30 ${
                  mixing
                    ? "bg-zinc-700 text-zinc-400 animate-pulse"
                    : mixReady
                    ? "bg-emerald-500 text-black"
                    : "bg-zinc-800 hover:bg-zinc-700 text-zinc-300"
                }`}
              >
                {mixing ? "MIXING" : "SYNC"}
              </button>
              <p className="text-xs font-mono text-zinc-600 tracking-widest">XFADE</p>
            </div>

            <Deck
              label="Deck B"
              accentColor="violet"
              state={deckB}
              waveRef={waveContainerB}
              bassEQ={bassB}
              onTogglePlay={() => togglePlay("B")}
              onAnalyze={() => analyzeBpm("B")}
              onBassChange={setBassB}
            />
          </div>

          {/* Crossfader */}
          <div className="crossfader bg-zinc-900 rounded-xl px-5 py-4 border border-zinc-800 shrink-0">
            <div className="flex items-center gap-4">
              <span className="text-xs font-mono text-emerald-400 shrink-0">A</span>
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={crossfader}
                onChange={(e) => {
                  setCrossfader(parseFloat(e.target.value));
                  setMixReady(false);
                }}
                className="flex-1"
              />
              <span className="text-xs font-mono text-violet-400 shrink-0">B</span>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
