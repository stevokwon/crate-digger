import tempfile

import librosa
import numpy as np
import pyrubberband as pyrb
import soundfile as sf
from scipy.signal import butter, sosfilt


def detect_bpm(filepath: str) -> float:
    """Detect BPM using librosa beat tracker."""
    y, sr = librosa.load(filepath, sr=None, mono=True)
    tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
    # librosa >= 0.10 returns a scalar; older versions return 1-element array
    return float(np.atleast_1d(tempo)[0])


def time_stretch_to_bpm(filepath: str, source_bpm: float, target_bpm: float) -> str:
    """Time-stretch audio so its BPM matches target_bpm. Returns path to a WAV tempfile."""
    y, sr = librosa.load(filepath, sr=44100, mono=False)
    ratio = target_bpm / source_bpm

    if y.ndim == 1:
        stretched = pyrb.time_stretch(y, sr, ratio)
    else:
        # Process each channel independently
        channels = [pyrb.time_stretch(y[ch], sr, ratio) for ch in range(y.shape[0])]
        stretched = np.stack(channels, axis=0)

    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    if stretched.ndim == 1:
        sf.write(tmp.name, stretched, sr)
    else:
        sf.write(tmp.name, stretched.T, sr)
    return tmp.name


def mix_tracks(
    deck_a_path: str,
    deck_b_path: str,
    crossfader: float,
    eq_bass_a: float,
    eq_bass_b: float,
) -> str:
    """
    Blend two audio files and return path to a WAV tempfile.

    crossfader: 0.0 = full Deck A, 1.0 = full Deck B (equal-power law)
    eq_bass_a/b: gain multiplier for bass frequencies (0–2, 1 = flat)
    """
    SR = 44100

    y_a, _ = librosa.load(deck_a_path, sr=SR, mono=True)
    y_b, _ = librosa.load(deck_b_path, sr=SR, mono=True)

    # Zero-pad the shorter track
    max_len = max(len(y_a), len(y_b))
    y_a = np.pad(y_a, (0, max_len - len(y_a)))
    y_b = np.pad(y_b, (0, max_len - len(y_b)))

    # Equal-power crossfade
    gain_a = float(np.cos(crossfader * np.pi / 2))
    gain_b = float(np.sin(crossfader * np.pi / 2))

    # Bass EQ
    y_a = _apply_bass_gain(y_a, SR, eq_bass_a)
    y_b = _apply_bass_gain(y_b, SR, eq_bass_b)

    mix = gain_a * y_a + gain_b * y_b

    # Normalize to prevent clipping
    peak = np.max(np.abs(mix))
    if peak > 1.0:
        mix = mix / peak

    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    sf.write(tmp.name, mix, SR)
    return tmp.name


def _apply_bass_gain(y: np.ndarray, sr: int, gain: float) -> np.ndarray:
    """Isolate bass (< 250 Hz) via Butterworth low-pass, apply gain, recombine."""
    sos = butter(4, 250 / (sr / 2), btype="low", output="sos")
    bass = sosfilt(sos, y)
    highs = y - bass
    return highs + bass * gain
