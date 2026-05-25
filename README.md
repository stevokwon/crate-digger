# Crate Digger

A browser-based open-format DJ mixer built for learning to mix. Dig tracks from YouTube and SoundCloud, mix them live on two decks with real-time EQ, filter sweeps, BPM matching, auto-blend, and one-click recording — all without leaving the browser.

---

## Requirements

- Python 3.11+
- Node.js 18+
- [ffmpeg](https://ffmpeg.org/) on your system (`brew install ffmpeg` on macOS)

## Running locally

### Backend

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --port 8000
```

### Frontend

```bash
cd frontend
npm install
npm run dev        # http://localhost:3000
```

---

## Features

### Crate — finding and managing tracks

**Digging tracks**
Paste any YouTube or SoundCloud URL into the input at the top of the crate sidebar and hit **DIG**. The backend downloads the audio as a 320kbps MP3 via yt-dlp and ffmpeg. The track appears in the crate automatically — the UI polls every 3 seconds so large downloads show up once ready.

**Loading tracks onto decks**
Hover a track in the crate and two buttons appear: **A** (loads to Deck A) and **B** (loads to Deck B). The waveform renders and the track is ready to play.

**Clearing the library**
Hit **CLEAR ALL** at the top of the crate to delete all downloaded MP3s from the server and wipe the list.

---

### Mix Ideas panel

Open via **MIX IDEAS** in the header. Shows five genre cards refreshed daily via a YouTube search cache:

| Genre | Mixing technique |
|-------|-----------------|
| UK Garage / 2-Step | Bass Swap |
| Brazilian Phonk / Baile Funk | Filter Intro |
| Jersey Club Edits | Hot Cue Drop |
| UK Drill / Acapellas | EQ Blend |
| Afrobeats 130 BPM | Loop Bridge |

Each card shows the mixing technique name, a step-by-step tip on how to execute it, and up to 5 currently trending tracks in that genre. Hit **DIG THESE** on any card to auto-download all 5 tracks into your crate (up to 5 at a time, with a 1/5…5/5 progress counter).

---

### Decks

Each deck contains a full set of controls for one track.

**Waveform**
A scrollable waveform (Wavesurfer.js) with clickable seek. The progress colour is teal for Deck A and violet for Deck B.

**Play / Pause**
Standard transport. Resumes the Web Audio context on first interaction (browser autoplay policy).

**8-bar Loop**
Hit **LOOP** to set an 8-bar loop starting from the current playhead position. Loop duration is calculated from the detected BPM — if no BPM has been detected yet, it defaults to an 8-second window. Hit LOOP again to cancel.

**Hot Cues (3 per deck)**
Three cue buttons per deck. If a cue is empty, clicking it sets the cue at the current playhead position. If a cue is already set, clicking it jumps the playhead to that position instantly. The small **✕** next to each cue clears it. Cue positions are shown in seconds.

---

### BPM tools (centre column)

**BPM A / BPM B**
Sends the loaded track to the backend for tempo analysis (librosa beat tracking). The detected BPM is shown in the deck header and remembered for the session.

**B←A**
Adjusts Deck B's playback rate so its effective BPM matches Deck A's detected BPM. Deck A stays unchanged.

**A←B**
Adjusts Deck A's playback rate so its effective BPM matches Deck B's detected BPM. Deck B stays unchanged.

Both match buttons clamp the adjustment to the ±15% tempo range. They are disabled until both decks have BPM data.

**SYNC**
Renders a server-side mix WAV. The backend time-stretches whichever track is further from the target BPM (using pyrubberband), then mixes both tracks at the current crossfader position with an equal-power curve. The WAV is streamed directly to the browser and saved to your output folder (see below).

---

### EQ — per deck, real-time

Three sliders controlling Web Audio `BiquadFilterNode` gain, applied instantaneously with no latency:

| Band | Type | Frequency | Range |
|------|------|-----------|-------|
| LOW | Lowshelf | 320 Hz | −12 to +6 dB |
| MID | Peaking (Q=0.5) | 1 kHz | −12 to +6 dB |
| HIGH | Highshelf | 3.2 kHz | −12 to +6 dB |

Classic DJ move: cut LOW on the incoming track (−12 dB), blend in on mids and highs, then simultaneously kill the outgoing track's LOW and restore the incoming one at the 8-bar mark.

---

### Filter sweep — per deck, real-time

A single slider that sweeps through lowpass and highpass:

- **0 → 0.5 (LP):** lowpass cutoff sweeps from 150 Hz up to 22 kHz (fully open)
- **0.5 (OPEN):** filter is effectively bypassed
- **0.5 → 1.0 (HP):** highpass cutoff sweeps from 20 Hz up to 2 kHz

The current mode (LP / OPEN / HP) is shown next to the FILTER label. Great for filtering an incoming track in from just hi-hats (LP sweep open) or thinning out a track before it exits (HP sweep up).

---

### Volume — per deck

Independent volume slider per deck, 0–150%. Controls the first gain node in the audio chain, before EQ and filter. Lets you level-match tracks that were recorded at different loudness before mixing.

---

### Tempo control — per deck

A ±15% playback rate slider (range 0.85×–1.15×) that adjusts `audio.playbackRate` in real-time. The deck header shows the live adjusted BPM as you move the slider. Hit **RST** to snap back to 1.0× instantly.

Note: this changes both pitch and speed together (the browser's native rate control). For pitch-independent time-stretching, use the server-side SYNC export which uses pyrubberband.

---

### Crossfader

The crossfader at the bottom controls the real-time mix ratio between the two decks using an equal-power curve:

- Deck A gain = `cos(x · π/2)`
- Deck B gain = `sin(x · π/2)`

This keeps perceived loudness constant as you move across — the same curve used in hardware DJ mixers. The crossfader position also determines the mix ratio used when you hit SYNC to export.

Moving the slider manually during an AUTO BLEND cancels the automation.

---

### AUTO BLEND

Sits below the crossfader. Automatically animates the crossfader to the opposite side over a selectable duration.

**Duration options:** 8s / 16s / 32s (roughly 4 / 8 / 16 bars at 120 BPM)

**Direction:** the button label shows which way it will move — `AUTO BLEND →B` if the crossfader is currently on A's side, or `A← AUTO BLEND` if it's on B's side.

**Curve:** ease-in-out (quadratic). The fade accelerates through the first half and decelerates through the second, which sounds more musical than a linear sweep.

**Cancel:** a **CANCEL BLEND** button appears mid-animation. Dragging the crossfader manually also cancels it.

If **REC** is running at the same time, the blend is captured live in the recording.

---

### REC — live recording

The **● REC** button (in the crossfader bar) records the live audio output of both decks combined — including all real-time EQ, filter, volume, tempo, and crossfader adjustments — directly from the Web Audio graph using `MediaRecorder`.

- Hit **● REC** to start. The button becomes **■ STOP 00:00** with a live elapsed timer.
- Hit **■ STOP** to finish. The recording is saved immediately to your output folder (or Downloads if no folder is set).
- Format: `.webm` (Chrome), `.ogg` (Firefox), or `.m4a` (Safari), depending on what the browser supports.

Unlike SYNC, REC captures what you actually play in real time — use it to record a live performance, a long blend, or just a section you want to keep.

---

### Output folder

On first visit a modal asks you to choose a local folder where all exports should be saved. This uses the browser's **File System Access API** — no upload, no server storage. Both SYNC (WAV) and REC (WebM/OGG) land in this folder automatically.

The chosen folder is remembered in **IndexedDB** across sessions. Change it anytime via the folder button in the header (`→ folder-name`). If you skip the setup or the browser doesn't support the API, files fall back to the browser's default Downloads folder.

---

## Tech stack

| Layer | Tools |
|-------|-------|
| Frontend | Next.js 16 (Turbopack), React, TypeScript, Tailwind CSS |
| Audio visualisation | Wavesurfer.js v7 |
| Live audio processing | Web Audio API (BiquadFilterNode, GainNode, MediaStreamDestinationNode) |
| Live recording | MediaRecorder API |
| Persistent folder | File System Access API + IndexedDB |
| Backend | FastAPI (Python 3.11), uvicorn |
| BPM detection | librosa |
| Time-stretching | pyrubberband |
| Audio mixing | pydub, scipy (Butterworth EQ, equal-power crossfade) |
| Track sourcing | yt-dlp + ffmpeg |
