"""
Daily-refreshed genre suggestions backed by yt-dlp YouTube search.
Results are cached to suggestions_cache.json for 24 hours.
"""

import json
import time
from pathlib import Path

import yt_dlp

CACHE_FILE = Path(__file__).parent / "suggestions_cache.json"
CACHE_TTL = 86400  # 24 hours

GENRES = [
    {
        "id": "ukg",
        "label": "UK Garage / 2-Step",
        "query": "UK garage 2step 2025 new",
        "technique": "Bass Swap",
        "tip": "Cut LOW to -12dB on the incoming track. Blend it in on mids/highs only. At the 8-bar mark, kill UKG bass and bring up the new bass simultaneously.",
        "color": "#34d399",
        "vibe": "Nostalgia hit",
    },
    {
        "id": "phonk",
        "label": "Brazilian Phonk / Baile Funk",
        "query": "baile funk phonk brasileiro 2025",
        "technique": "Filter Intro",
        "tip": "Keep Phonk playing. Sweep the FILTER on Baile Funk from LP all the way to OPEN over 16 bars — only hi-hats bleed in first.",
        "color": "#a78bfa",
        "vibe": "Energy escalation",
    },
    {
        "id": "jersey",
        "label": "Jersey Club Edits",
        "query": "jersey club edit remix 2025",
        "technique": "Hot Cue Drop",
        "tip": "Set a hot cue on the drop. Let the intro track ride to bar 8, then cut directly to the cue. No blend — the hard cut IS the move.",
        "color": "#f59e0b",
        "vibe": "Crowd surprise",
    },
    {
        "id": "drill",
        "label": "UK Drill / Acapellas",
        "query": "UK drill acapella instrumental 2025",
        "technique": "EQ Blend",
        "tip": "Cut MID on the UKG instrumental so the drill vocal sits in its own space. Use SYNC to stretch drill (140 BPM) down to UKG tempo.",
        "color": "#f87171",
        "vibe": "Hard contrast",
    },
    {
        "id": "afro",
        "label": "Afrobeats 130 BPM",
        "query": "afrobeats 130bpm dj mix 2025",
        "technique": "Loop Bridge",
        "tip": "Loop the afrobeats outro (8 bars). Use those ~15 seconds to cue up UKG, match levels on VOL, then hard drop on the UKG kick.",
        "color": "#22d3ee",
        "vibe": "Smooth entry",
    },
]


def _search(query: str, max_results: int = 5) -> list[dict]:
    ydl_opts = {
        "extract_flat": True,
        "quiet": True,
        "no_warnings": True,
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(f"ytsearch{max_results}:{query}", download=False)
        tracks = []
        for entry in (info.get("entries") or []):
            if not entry:
                continue
            vid_id = entry.get("id") or entry.get("url", "")
            tracks.append({
                "title": entry.get("title", "Unknown"),
                "url": f"https://www.youtube.com/watch?v={vid_id}",
                "duration": entry.get("duration"),
            })
        return tracks


def get_suggestions() -> list[dict]:
    """Return genre list with cached track suggestions, refreshing stale entries."""
    cache: dict = {}
    if CACHE_FILE.exists():
        try:
            cache = json.loads(CACHE_FILE.read_text())
        except Exception:
            cache = {}

    now = time.time()
    result = []
    dirty = False

    for genre in GENRES:
        gid = genre["id"]
        cached = cache.get(gid, {})
        age = now - cached.get("ts", 0)

        if age < CACHE_TTL and cached.get("tracks"):
            tracks = cached["tracks"]
        else:
            try:
                tracks = _search(genre["query"])
                cache[gid] = {"tracks": tracks, "ts": now}
                dirty = True
            except Exception:
                tracks = cached.get("tracks", [])  # serve stale on error

        result.append({**genre, "tracks": tracks})

    if dirty:
        try:
            CACHE_FILE.write_text(json.dumps(cache))
        except Exception:
            pass

    return result
