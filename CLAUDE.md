# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project: Crate Digger MVP (Open-Format DJ App)

## Tech Stack
- Frontend: Next.js (React), Tailwind CSS, TypeScript, Wavesurfer.js
- Backend: FastAPI (Python), yt-dlp, Playwright, Librosa, Pydub, pyrubberband

## Dev Commands

```bash
# Backend
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
playwright install chromium        # one-time, for Bandcamp scraping
uvicorn main:app --reload --port 8000

# Frontend
cd frontend
npm install
npm run dev                        # http://localhost:3000
npm run build && npm start         # production
```

## Coding Guidelines
- **Python Backend:** Use clean async functions for FastAPI endpoints. Keep long-running processes (scraping/mixing) strictly inside background tasks.
- **Audio Processing:** Handle sample rate alignment explicitly in `mixer_engine.py` using librosa. Catch audio clipping errors early.
- **Frontend Components:** Keep UI dark-themed, minimalist, and accessible. Initialize and destroy Wavesurfer instances inside clean `useEffect` cleanup loops to prevent browser memory leaks.

## Active Project Components
- `backend/ingest_worker.py`: Scraping SoundCloud tracks via yt-dlp.
- `backend/mixer_engine.py`: DSP — BPM detection (librosa), time-stretching (pyrubberband), EQ + mix render.
- `backend/main.py`: FastAPI app — `/api/tracks`, `/api/ingest`, `/api/analyze/{id}`, `/api/mix`, `/api/audio/{file}`.
- `frontend/src/app/page.tsx`: 2-Deck browser mixer — waveforms, crossfader, bass EQ, SYNC/mix export.

## Style & Architecture
See `dj-architect.md` for output style. See `SKILL.md` for full functional specs (API contracts, audio pipeline, UI component requirements).

Audio files land in `backend/library/` (gitignored). Frontend polls `/api/tracks` every 3s to pick up new ingests.
