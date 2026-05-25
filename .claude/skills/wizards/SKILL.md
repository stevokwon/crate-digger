# Skill: Build Open-Format DJ MVP Engine

When the user types `/wizard build-engine`, follow these sequential development phases:

## Phase 1: Ingestion Setup (`backend/ingest_worker.py`)
- Read web selectors for SoundCloud track lists using Playwright.
- Implement yt-dlp fallback download parameters.
- Clean text titles via regex and write records cleanly to `data/catalog.json`.

## Phase 2: DSP Mixer Engine (`backend/mixer_engine.py`)
- Call `librosa.beat.beat_track` to pinpoint beat grids.
- Apply `pyrubberband.pyrb.time_stretch` to match tracks of differing BPMs (e.g., Rap vocals to UKG beats).
- Safely slice 8-bar loops and drop overlays using Pydub.

## Phase 3: Frontend Interface (`frontend/src/app/page.tsx`)
- Build a dark-themed 2-Deck visual workflow.
- Mount independent wavesurfer.js wrappers.
- Implement the HTML5 Web Audio API crossfader mapping to modulate volume levels between left and right channels smoothly.