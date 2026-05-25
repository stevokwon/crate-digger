import asyncio
import os
import re
import time
from pathlib import Path

from fastapi import BackgroundTasks, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response, StreamingResponse
from pydantic import BaseModel

from ingest_worker import LIBRARY_DIR, ingest_url
from mixer_engine import detect_bpm, mix_tracks, time_stretch_to_bpm
from suggestions import get_suggestions

app = FastAPI(title="Crate Digger API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory BPM cache: { track_id: { bpm, title, filename, duration } }
track_library: dict[str, dict] = {}


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------


class IngestRequest(BaseModel):
    url: str


class MixRequest(BaseModel):
    deck_a: str
    deck_b: str
    crossfader: float = 0.5
    eq_bass_a: float = 1.0
    eq_bass_b: float = 1.0
    target_bpm: float | None = None


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@app.get("/api/tracks")
async def list_tracks():
    tracks = []
    for f in sorted(LIBRARY_DIR.glob("*.mp3"), key=lambda p: p.stat().st_mtime, reverse=True):
        track_id = f.stem
        cached = track_library.get(track_id, {})
        tracks.append(
            {
                "id": track_id,
                "filename": f.name,
                "title": cached.get("title", track_id),
                "bpm": cached.get("bpm"),
                "duration": cached.get("duration"),
            }
        )
    return {"tracks": tracks}


@app.post("/api/ingest")
async def ingest_track(req: IngestRequest, bg: BackgroundTasks):
    async def _task():
        try:
            result = await ingest_url(req.url)
            track_library[result["id"]] = result
        except Exception as e:
            print(f"[ingest error] {req.url}: {e}")

    bg.add_task(_task)
    return {"status": "ingesting", "url": req.url}


@app.post("/api/analyze/{track_id}")
async def analyze_track(track_id: str):
    filepath = LIBRARY_DIR / f"{track_id}.mp3"
    if not filepath.exists():
        raise HTTPException(status_code=404, detail=f"Track '{track_id}' not found in library")

    bpm = detect_bpm(str(filepath))
    track_library.setdefault(track_id, {})["bpm"] = bpm
    return {"track_id": track_id, "bpm": bpm}


@app.post("/api/mix")
async def create_mix(req: MixRequest):
    path_a = LIBRARY_DIR / f"{req.deck_a}.mp3"
    path_b = LIBRARY_DIR / f"{req.deck_b}.mp3"

    if not path_a.exists():
        raise HTTPException(status_code=404, detail=f"Deck A track '{req.deck_a}' not found")
    if not path_b.exists():
        raise HTTPException(status_code=404, detail=f"Deck B track '{req.deck_b}' not found")

    a_path = str(path_a)
    b_path = str(path_b)
    tmp_files: list[str] = []

    if req.target_bpm:
        bpm_a = track_library.get(req.deck_a, {}).get("bpm") or detect_bpm(a_path)
        bpm_b = track_library.get(req.deck_b, {}).get("bpm") or detect_bpm(b_path)

        if abs(bpm_a - req.target_bpm) > 0.5:
            a_path = time_stretch_to_bpm(a_path, bpm_a, req.target_bpm)
            tmp_files.append(a_path)
        if abs(bpm_b - req.target_bpm) > 0.5:
            b_path = time_stretch_to_bpm(b_path, bpm_b, req.target_bpm)
            tmp_files.append(b_path)

    tmp_mix = mix_tracks(a_path, b_path, req.crossfader, req.eq_bass_a, req.eq_bass_b)

    ts = int(time.time())
    mix_name = f"mix-{req.deck_a[:12]}-{req.deck_b[:12]}-{ts}.wav"

    def _cleanup():
        for f in [*tmp_files, tmp_mix]:
            try:
                os.unlink(f)
            except OSError:
                pass

    return FileResponse(
        str(tmp_mix),
        media_type="audio/wav",
        filename=mix_name,
        background=BackgroundTasks([_cleanup]),
    )


@app.delete("/api/library")
async def clear_library():
    """Delete all MP3s from the library and wipe the in-memory cache."""
    deleted = 0
    for f in LIBRARY_DIR.glob("*.mp3"):
        f.unlink()
        deleted += 1
    track_library.clear()
    return {"status": "cleared", "deleted": deleted}


@app.get("/api/suggestions")
async def suggestions_endpoint():
    """Return genre suggestions with yt-dlp-searched tracks. Cached 24h."""
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(None, get_suggestions)
    return {"suggestions": result}



@app.get("/api/audio/{filename}")
async def serve_audio(filename: str, request: Request):
    filepath = LIBRARY_DIR / filename
    if not filepath.exists():
        raise HTTPException(status_code=404, detail="Audio file not found")

    file_size = filepath.stat().st_size
    media_type = "audio/mpeg" if filename.lower().endswith(".mp3") else "audio/wav"
    range_header = request.headers.get("Range")

    if range_header:
        match = re.match(r"bytes=(\d+)-(\d*)", range_header)
        if match:
            start = int(match.group(1))
            end = int(match.group(2)) if match.group(2) else file_size - 1
            end = min(end, file_size - 1)
            chunk_size = end - start + 1
            with open(filepath, "rb") as f:
                f.seek(start)
                data = f.read(chunk_size)
            return Response(
                content=data,
                status_code=206,
                media_type=media_type,
                headers={
                    "Content-Range": f"bytes {start}-{end}/{file_size}",
                    "Accept-Ranges": "bytes",
                    "Content-Length": str(chunk_size),
                },
            )

    # Full file — stream in chunks to avoid Content-Length race with large files
    async def _stream():
        with open(filepath, "rb") as f:
            while True:
                chunk = f.read(65536)
                if not chunk:
                    break
                yield chunk

    return StreamingResponse(
        _stream(),
        media_type=media_type,
        headers={
            "Accept-Ranges": "bytes",
            "Content-Length": str(file_size),
        },
    )
