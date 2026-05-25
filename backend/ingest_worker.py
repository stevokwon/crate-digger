import asyncio
from pathlib import Path

import yt_dlp

LIBRARY_DIR = Path(__file__).parent / "library"
LIBRARY_DIR.mkdir(exist_ok=True)


async def ingest_url(url: str) -> dict:
    """Download audio from URL using yt-dlp. Runs in thread to avoid blocking the event loop."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _download, url)


def _download(url: str) -> dict:
    ydl_opts = {
        "format": "bestaudio/best",
        "outtmpl": str(LIBRARY_DIR / "%(title)s.%(ext)s"),
        "postprocessors": [
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": "320",
            }
        ],
        "quiet": True,
        "no_warnings": True,
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=True)
        filename = ydl.prepare_filename(info)
        mp3_path = Path(filename).with_suffix(".mp3")
        return {
            "title": info.get("title", mp3_path.stem),
            "duration": info.get("duration", 0),
            "filename": mp3_path.name,
            "id": mp3_path.stem,
        }
