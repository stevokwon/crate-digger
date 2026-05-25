# SKILL.md — Crate Digger MVP: Functional Requirements

Persistent specification for all code in this repository. Treat this as ground truth when implementing or reviewing features.

---

## Backend API (FastAPI, port 8000)

### `GET /api/tracks`
Returns all `.mp3` files found in `backend/library/`.
```json
{ "tracks": [{ "id": "track-stem", "filename": "track-stem.mp3", "title": "track-stem", "bpm": 132.4 }] }
```
- `bpm` is `null` if not yet analyzed.

### `POST /api/ingest`
Body: `{ "url": "https://soundcloud.com/..." }`
Starts a background task that calls yt-dlp to download audio as MP3 (320kbps) into `backend/library/`.
Returns immediately: `{ "status": "ingesting", "url": "..." }`

**yt-dlp options required:**
- `format`: `bestaudio/best`
- postprocessor: FFmpegExtractAudio → mp3 @ 320k
- `outtmpl`: `library/%(title)s.%(ext)s`

### `POST /api/analyze/{track_id}`
Runs `librosa.beat.beat_track` on the MP3. Caches result in `track_library` dict.
Returns: `{ "track_id": "...", "bpm": 132.4 }`

### `POST /api/mix`
Body:
```json
{
  "deck_a": "track-id-a",
  "deck_b": "track-id-b",
  "crossfader": 0.5,
  "eq_bass_a": 1.0,
  "eq_bass_b": 0.3,
  "target_bpm": 132.0
}
```
- If `target_bpm` is set and differs from detected BPM by > 0.5, time-stretch that deck via pyrubberband.
- Apply equal-power crossfade: `gain_a = cos(x * π/2)`, `gain_b = sin(x * π/2)` where `x = crossfader`.
- Apply bass EQ (Butterworth low-pass at 250 Hz) per deck with the given gain multiplier.
- Normalize output if `peak > 1.0`.
- Returns WAV blob (`audio/wav`) directly — not a URL.

### `GET /api/audio/{filename}`
Serves the raw MP3 from `backend/library/{filename}`.

---

## Audio Processing Pipeline (`mixer_engine.py`)

```
Input: two MP3 paths
  └─ librosa.load(sr=44100, mono=True)
  └─ [optional] pyrubberband.time_stretch(ratio = target_bpm / source_bpm)
  └─ zero-pad shorter array to match length
  └─ bass EQ: butter(4, 250/(sr/2), 'low') → separate bass, apply gain, recombine
  └─ equal-power crossfade blend
  └─ normalize if peak > 1.0
Output: WAV tempfile path
```

**BPM Detection:**
- `librosa.load(filepath, sr=None, mono=True)` then `librosa.beat.beat_track(y, sr)`
- Return `float(tempo[0])` — unwrap from array.

**Time Stretch:**
- Load as 44100 Hz stereo-aware (handle mono/stereo ndim check).
- `pyrubberband.time_stretch(channel, sr, ratio)` per channel.
- Write result to `tempfile.NamedTemporaryFile(suffix='.wav')`.

---

## Frontend UI (`frontend/src/app/page.tsx`)

### Layout
```
┌─ Header (logo + status dot) ─────────────────────────────┐
│ ┌─ Crate Panel (w-64) ─┐  ┌─ Mixer ───────────────────┐ │
│ │ [URL input] [DIG btn] │  │ [Deck A] [Center] [Deck B] │ │
│ │ track list...         │  │ [──── Crossfader ────────] │ │
│ └──────────────────────┘  └───────────────────────────┘ │
└───────────────────────────────────────────────────────────┘
```

### Deck Component
- Wavesurfer waveform (height: 96px, barWidth: 2, barGap: 1)
- Deck A: `waveColor: #3f3f46`, `progressColor: #34d399` (emerald)
- Deck B: `waveColor: #3f3f46`, `progressColor: #a78bfa` (violet)
- Track title (truncated)
- BPM display (shown after analysis)
- PLAY/PAUSE toggle button
- BPM analyze button
- BASS slider: `range 0–2`, default `1.0`, displayed as percentage

### Center Controls
- SYNC button: triggers `/api/mix` with both decks + current crossfader/EQ values → downloads `mix.wav`
- Turns emerald when mix has been rendered

### Crossfader
- `range 0–1`, step 0.01, default 0.5
- Label "A" (emerald) on left, "B" (violet) on right

### Crate Panel
- URL input + DIG button → POST `/api/ingest`
- Track list polls GET `/api/tracks` every 3s
- Each track row: hover reveals [A] and [B] load buttons
- [A] loads into Deck A wavesurfer, [B] into Deck B

### WaveSurfer Lifecycle (critical)
```ts
useEffect(() => {
  const ws = WaveSurfer.create({ container: ref.current, ... });
  ws.on('finish', () => setDeck(d => ({ ...d, isPlaying: false })));
  wavesurferRef.current = ws;
  return () => { ws.destroy(); wavesurferRef.current = null; };
}, []); // empty deps — runs once per mount
```

---

## File Structure

```
blend-lab/
├── CLAUDE.md
├── SKILL.md
├── dj-architect.md
├── backend/
│   ├── main.py
│   ├── ingest_worker.py
│   ├── mixer_engine.py
│   ├── requirements.txt
│   └── library/          ← downloaded audio files (gitignored)
└── frontend/
    ├── package.json
    ├── next.config.ts
    ├── tailwind.config.ts
    ├── tsconfig.json
    └── src/app/
        ├── layout.tsx
        ├── globals.css
        └── page.tsx
```

---

## Dev Commands

```bash
# Backend
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
playwright install chromium
uvicorn main:app --reload --port 8000

# Frontend
cd frontend
npm install
npm run dev       # runs on localhost:3000
```
