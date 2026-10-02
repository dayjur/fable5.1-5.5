#!/usr/bin/env python3
"""
PIPSQUEAK — voice department.

script.json  ->  work/voices/<id>.wav        (48 kHz float32 stereo, peak <= 0.9)
             ->  work/voices/lines.json      (timing + viseme / envelope tracks, 24 fps)
             ->  work/voices/report.txt      (duration table + overlap check)
             ->  work/voices/preview_all.wav (all lines in order, 0.4 s gaps)

Pipeline per line
  Kokoro TTS (cached in work/voices/raw/)  ->  sox pitch (semitones*100 cents, cached)
  -> [time warp for shouts]  -> character / style colouring  -> 48 kHz
  -> loudness target (gated RMS)  -> room reverb (synthetic IR, not for bigshout)
  -> peak limiter 0.9  -> write.
  Lip sync: espeak-ng mbrola phoneme durations, stretched sentence-by-sentence onto the
  audible regions of the dry voice, carried through the time warp, then gated by the
  smoothed RMS envelope.

Run:  python3 audio/voices.py            (from pipsqueak/)
      python3 audio/voices.py --force    (ignore caches)
"""
import hashlib
import json
import math
import os
import re
import subprocess
import sys

import numpy as np
import soundfile as sf
from scipy import signal

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, os.pardir))
SCRIPT = os.path.join(ROOT, "script.json")
WORK = os.path.join(ROOT, "work")
OUT = os.path.join(WORK, "voices")
RAW = os.path.join(OUT, "raw")
KOKORO_MODEL = os.path.join(WORK, "kokoro-v1.0.onnx")
KOKORO_VOICES = os.path.join(WORK, "voices-v1.0.bin")

SR_TTS = 24000
SR = 48000
FPS = 24
FORCE = "--force" in sys.argv

# --------------------------------------------------------------------------------------
# Voice design
# --------------------------------------------------------------------------------------
# Per-character colouring on top of script.json's voice / pitch / speed.
CHAR = {
    "pip": dict(lang="en-us", rms_trim=0.0),
    "nan": dict(lang="en-gb", rms_trim=+1.0),
    "gus": dict(lang="en-us", rms_trim=-1.0),
    "tobi": dict(lang="en-us", rms_trim=0.0),
    "mira": dict(lang="en-us", rms_trim=0.0),
}
# Target gated RMS in dBFS per style (before reverb).
RMS_TARGET = {"normal": -20.0, "whisper": -27.0, "hoarse": -23.0, "shout": -13.0, "bigshout": -12.0}
PEAK = 0.9

# Shout shaping: (candidate texts, target audible seconds). Candidates are either plain text
# or IPA (prefixed "ipa:"); the candidate with the longest sustained vowel is chosen.
SHOUT_PLAN = {
    "L00": dict(cands=["PIP!"], target=0.70),
    "L02": dict(cands=["HAAA!", "ipa:hˈɑːː!"], target=0.85),
    "L03": dict(cands=["HEY-O!"], target=0.90),
    "L29": dict(cands=["ipa:hˈɛːɛːɪ!", "ipa:hˈeɪ!", "Hey!", "HEEEEEEY!"], target=2.3),
    "L34": dict(cands=["HELLO!", "ipa:hɛlˈoʊː!"], target=1.6),
}

# Room reverbs.
ROOMS = {
    "roost": dict(rt60=2.5, wet_db=-14.0, predelay=0.025, damp=(1.0, 0.8, 0.55, 0.35), er=8),
    "tunnel": dict(rt60=1.6, wet_db=-15.0, predelay=0.015, damp=(1.0, 0.85, 0.6, 0.4), er=10),
    "crack": dict(rt60=0.7, wet_db=-13.0, predelay=0.005, damp=(1.0, 0.9, 0.5, 0.25), er=14, boxy=True),
    "cathedral": dict(rt60=4.5, wet_db=-12.0, predelay=0.040, damp=(1.0, 0.75, 0.45, 0.25), er=6),
    "sky": dict(slap=True),
    "none": None,
}

# --------------------------------------------------------------------------------------
# Small DSP toolbox
# --------------------------------------------------------------------------------------


def db(x):
    return 20.0 * math.log10(max(x, 1e-12))


def amp(d):
    return 10.0 ** (d / 20.0)


def rbj(kind, f0, fs, q=0.707, gain_db=0.0):
    """RBJ cookbook biquad -> (b, a)."""
    A = 10 ** (gain_db / 40.0)
    w0 = 2 * math.pi * f0 / fs
    cw, sw = math.cos(w0), math.sin(w0)
    alpha = sw / (2 * q)
    if kind == "peak":
        b = [1 + alpha * A, -2 * cw, 1 - alpha * A]
        a = [1 + alpha / A, -2 * cw, 1 - alpha / A]
    elif kind == "lowshelf":
        sa = 2 * math.sqrt(A) * alpha
        b = [A * ((A + 1) - (A - 1) * cw + sa), 2 * A * ((A - 1) - (A + 1) * cw), A * ((A + 1) - (A - 1) * cw - sa)]
        a = [(A + 1) + (A - 1) * cw + sa, -2 * ((A - 1) + (A + 1) * cw), (A + 1) + (A - 1) * cw - sa]
    elif kind == "highshelf":
        sa = 2 * math.sqrt(A) * alpha
        b = [A * ((A + 1) + (A - 1) * cw + sa), -2 * A * ((A - 1) + (A + 1) * cw), A * ((A + 1) + (A - 1) * cw - sa)]
        a = [(A + 1) - (A - 1) * cw + sa, 2 * ((A - 1) - (A + 1) * cw), (A + 1) - (A - 1) * cw - sa]
    else:
        raise ValueError(kind)
    b = np.array(b) / a[0]
    a = np.array(a) / a[0]
    return b, a


def eq(x, kind, f0, fs, q=0.707, gain_db=0.0):
    b, a = rbj(kind, f0, fs, q, gain_db)
    return signal.lfilter(b, a, x).astype(np.float32)


def hp(x, f, fs, order=2):
    sos = signal.butter(order, f, "highpass", fs=fs, output="sos")
    return signal.sosfilt(sos, x).astype(np.float32)


def lp(x, f, fs, order=2):
    sos = signal.butter(order, f, "lowpass", fs=fs, output="sos")
    return signal.sosfilt(sos, x).astype(np.float32)


def bp(x, lo, hi, fs, order=4, zero_phase=True):
    sos = signal.butter(order, [lo, hi], "bandpass", fs=fs, output="sos")
    return (signal.sosfiltfilt(sos, x) if zero_phase else signal.sosfilt(sos, x)).astype(np.float32)


def saturate(x, drive=1.5, mix=1.0):
    y = np.tanh(drive * x) / math.tanh(min(drive, 4.0))
    return (mix * y + (1 - mix) * x).astype(np.float32)


def follower(level, fs, attack, release, block=None):
    """Attack/release envelope follower on a non-negative level signal (block-decimated)."""
    block = block or max(1, fs // 1000)
    n = len(level)
    nb = int(math.ceil(n / block))
    padded = np.concatenate([level, np.zeros(nb * block - n)])
    blk = padded.reshape(nb, block).max(axis=1)
    ca = math.exp(-block / (attack * fs)) if attack > 0 else 0.0
    cr = math.exp(-block / (release * fs))
    out = np.zeros(nb)
    e = 0.0
    for i in range(nb):
        v = blk[i]
        c = ca if v > e else cr
        e = c * e + (1 - c) * v
        out[i] = e
    t_blk = (np.arange(nb) + 0.5) * block
    return np.interp(np.arange(n), t_blk, out).astype(np.float32)


def compress(x, fs, thresh_db=-24.0, ratio=2.5, attack=0.005, release=0.08, makeup_db=0.0):
    env = follower(np.abs(x), fs, attack, release)
    env_db = 20 * np.log10(np.maximum(env, 1e-6))
    over = np.maximum(0.0, env_db - thresh_db)
    gain_db = -over * (1 - 1 / ratio) + makeup_db
    return (x * 10 ** (gain_db / 20)).astype(np.float32)


def limiter(x, fs, ceiling=PEAK):
    """Stereo-linked peak limiter: instant attack, 60 ms release, then a safety clip."""
    level = np.abs(x).max(axis=1) if x.ndim == 2 else np.abs(x)
    env = follower(level, fs, 0.0, 0.06)
    g = np.minimum(1.0, ceiling / np.maximum(env, 1e-9))
    g = lp(g, 400.0, fs)  # soften gain steps
    g = np.minimum(g, ceiling / np.maximum(level, 1e-9))
    y = x * (g[:, None] if x.ndim == 2 else g)
    return np.clip(y, -ceiling, ceiling).astype(np.float32)


def rms_envelope(x, fs, win=0.010, attack=0.012, release=0.07):
    """Smoothed RMS envelope (same length as x)."""
    n = max(1, int(win * fs))
    p = np.convolve(x.astype(np.float64) ** 2, np.ones(n) / n, mode="same")
    r = np.sqrt(np.maximum(p, 0)).astype(np.float32)
    return follower(r, fs, attack, release)


def audible_span(x, fs, rel_db=-40.0, min_abs=1e-4):
    env = rms_envelope(x, fs, attack=0.002, release=0.01)
    thr = max(env.max() * amp(rel_db), min_abs)
    idx = np.where(env > thr)[0]
    if len(idx) == 0:
        return 0, len(x)
    return int(idx[0]), int(idx[-1]) + 1


def gated_rms_db(x, fs, rel_db=-35.0):
    env = rms_envelope(x, fs)
    mask = env > env.max() * amp(rel_db)
    if mask.sum() < 10:
        return db(np.sqrt(np.mean(x ** 2) + 1e-12))
    return db(math.sqrt(float(np.mean(x[mask].astype(np.float64) ** 2)) + 1e-12))


def resample_to(x, fs_in, fs_out):
    if fs_in == fs_out:
        return x.astype(np.float32)
    g = math.gcd(fs_in, fs_out)
    return signal.resample_poly(x, fs_out // g, fs_in // g).astype(np.float32)


def noise_vocode(x, fs, bands, seed, smooth_hz=45.0):
    """Shape white noise with the per-band amplitude envelope of x (breath / whisper layer)."""
    rng = np.random.default_rng(seed)
    noise = rng.standard_normal(len(x)).astype(np.float32)
    out = np.zeros(len(x), np.float32)
    sos_env = signal.butter(2, smooth_hz, "lowpass", fs=fs, output="sos")
    for lo, hi in bands:
        xb = bp(x, lo, hi, fs)
        env = signal.sosfiltfilt(sos_env, np.abs(xb)) * 1.57
        nb = bp(noise, lo, hi, fs)
        nb /= np.sqrt(np.mean(nb ** 2)) + 1e-9
        out += (nb * np.maximum(env, 0)).astype(np.float32)
    return out


def pitch_glide(x, fs, semis_start, dur, onset):
    """Variable-rate resample: pitch rises from semis_start to 0 over `dur` s starting at `onset` s."""
    t = np.arange(len(x)) / fs
    s = np.where((t >= onset) & (t < onset + dur), semis_start * (1 - (t - onset) / dur), 0.0)
    rate = 2.0 ** (s / 12.0)
    pos = np.cumsum(rate) / fs
    pos -= pos[0]
    pos = pos[pos < t[-1]]
    return np.interp(pos, t, x).astype(np.float32)


# ---- phase vocoder with arbitrary time map ---------------------------------------------


def _stft(x, n, hop):
    win = np.hanning(n + 1)[:-1].astype(np.float32)
    xp = np.concatenate([np.zeros(n // 2, np.float32), x.astype(np.float32), np.zeros(n, np.float32)])
    nfr = (len(xp) - n) // hop + 1
    idx = np.arange(n)[None, :] + hop * np.arange(nfr)[:, None]
    return np.fft.rfft(xp[idx] * win, axis=1), win


def pvoc_warp(x, in_pos, n=1024, hop=256):
    """Phase vocoder. in_pos[j] = input sample position for output frame j (monotone)."""
    X, win = _stft(x, n, hop)
    nfr = X.shape[0]
    mag, ph = np.abs(X), np.angle(X)
    omega = 2 * np.pi * hop * np.arange(n // 2 + 1) / n
    dph = ph[1:] - ph[:-1] - omega
    dph -= 2 * np.pi * np.round(dph / (2 * np.pi))
    inst = omega + dph  # phase advance per hop between frame k and k+1
    nout = len(in_pos)
    y = np.zeros(nout * hop + n, np.float32)
    norm = np.zeros_like(y)
    acc = None
    for j, pos in enumerate(in_pos):
        a = pos / hop
        k = int(min(max(math.floor(a), 0), nfr - 2))
        frac = min(max(a - k, 0.0), 1.0)
        m = (1 - frac) * mag[k] + frac * mag[k + 1]
        if acc is None:
            acc = ph[k].copy()
        else:
            acc = acc + inst[k]
        frame = np.fft.irfft(m * np.exp(1j * acc), n) * win
        y[j * hop: j * hop + n] += frame
        norm[j * hop: j * hop + n] += win ** 2
    y = y / np.maximum(norm, 1e-3)
    return y[n // 2: n // 2 + nout * hop].astype(np.float32)


def warp_to_target(x, fs, target_audible, smax=14.0, n=1024, hop=256):
    """
    Time-stretch x so its audible part lasts `target_audible` seconds, stretching steady vowels
    much more than transients (consonants, glides). Returns (y, in_times, out_times) where the
    time arrays map input seconds -> output seconds (for carrying phoneme timings through).
    """
    X, _ = _stft(x, n, hop)
    mag = np.abs(X)
    nfr = mag.shape[0]
    frame_rms = np.sqrt((mag ** 2).sum(axis=1)) / n
    aud = frame_rms > frame_rms.max() * amp(-35.0)
    flux = np.zeros(nfr)
    flux[1:] = np.maximum(0, mag[1:] - mag[:-1]).sum(axis=1) / (mag[1:].sum(axis=1) + 1e-9)
    flux = np.convolve(flux, np.ones(3) / 3, mode="same")
    level = frame_rms / (frame_rms.max() + 1e-12)
    w = (level + 0.05) / (0.12 + flux)  # steady AND loud frames (the sustained vowel) stretch most
    aud_frames = aud.sum()
    hop_s = hop / fs
    target_frames = target_audible / hop_s
    if aud_frames == 0:
        return x, np.array([0, len(x) / fs]), np.array([0, len(x) / fs])

    def stretch_for(c):
        s = np.where(aud, np.clip(c * w, 1.0, smax), 1.0)
        return s

    lo, hi = 0.0, 100.0
    for _ in range(60):
        c = 0.5 * (lo + hi)
        if stretch_for(c)[aud].sum() < target_frames:
            lo = c
        else:
            hi = c
    s = stretch_for(0.5 * (lo + hi))
    out_cum = np.concatenate([[0.0], np.cumsum(s)]) * hop  # output sample at start of input frame k
    in_frames = np.arange(nfr + 1) * hop
    nout = int(out_cum[-1] // hop)
    in_pos = np.interp(np.arange(nout) * hop, out_cum, in_frames)
    y = pvoc_warp(x, in_pos, n, hop)
    return y, in_frames / fs, out_cum / fs


# ---- reverb -----------------------------------------------------------------------------


def make_ir(room, fs, seed=7):
    """Stereo synthetic IR: early reflections + 4-band exponentially decaying noise that darkens
    over time (high bands decay faster)."""
    p = ROOMS[room]
    rng = np.random.default_rng(seed)
    if p.get("slap"):
        ir = np.zeros((int(0.40 * fs), 2), np.float32)
        for ch, t in enumerate((0.320, 0.334)):
            tap = np.zeros(int(0.03 * fs), np.float32)
            tap[0] = 1.0
            tap = lp(tap, 2500.0, fs, order=2)
            i = int(t * fs)
            ir[i: i + len(tap), ch] += tap[: ir.shape[0] - i]
        ir *= amp(-20.0) / np.abs(ir).max()
        return ir, 1.0
    rt60 = p["rt60"]
    length = int((rt60 * 1.15 + p["predelay"] + 0.05) * fs)
    t = np.arange(length) / fs
    ir = np.zeros((length, 2), np.float32)
    bands = [(40, 500), (500, 2000), (2000, 6000), (6000, 16000)]
    for ch in range(2):
        tail = np.zeros(length, np.float32)
        noise = rng.standard_normal(length).astype(np.float32)
        for (lo, hi), m in zip(bands, p["damp"]):
            nb = bp(noise, lo, min(hi, fs * 0.47), fs, order=2)
            env = np.exp(-6.908 * t / (rt60 * m))
            tail += nb * env
        # early reflections: sparse taps 6..80 ms, slightly different per channel
        er = np.zeros(length, np.float32)
        for k in range(p["er"]):
            tt = 0.006 + (0.08 - 0.006) * (k + rng.uniform(0.1, 0.9)) / p["er"]
            g = 0.7 * (1 - k / p["er"]) * rng.uniform(0.5, 1.0) * rng.choice([-1, 1])
            er[int(tt * fs)] += g
        er = lp(er, 6000.0, fs)
        tail *= 1.0 / (np.sqrt(np.mean(tail[: int(0.2 * fs)] ** 2)) + 1e-9)
        tail *= 0.12
        ir[:, ch] = tail + er
        ir[:, ch] *= (t >= 0.004)  # no direct path in the IR
    if p.get("boxy"):
        for ch in range(2):
            ir[:, ch] = eq(ir[:, ch], "peak", 560.0, fs, q=1.4, gain_db=6.0)
            ir[:, ch] = lp(ir[:, ch], 5000.0, fs)
    pd = int(p["predelay"] * fs)
    ir = np.concatenate([np.zeros((pd, 2), np.float32), ir])
    ir /= np.sqrt((ir ** 2).sum(axis=0)).max() + 1e-9  # unit energy -> wet_db is relative to dry
    return ir, amp(p["wet_db"])


_IR_CACHE = {}


def add_room(dry, fs, room):
    """dry mono -> stereo (dry + wet)."""
    if room not in _IR_CACHE:
        _IR_CACHE[room] = make_ir(room, fs) if ROOMS.get(room) else None
    st = np.stack([dry, dry], axis=1).astype(np.float32)
    if _IR_CACHE[room] is None:
        return st
    ir, wet = _IR_CACHE[room]
    n = len(dry) + ir.shape[0] - 1
    out = np.zeros((n, 2), np.float32)
    out[: len(dry)] = st
    for ch in range(2):
        out[:, ch] += wet * signal.fftconvolve(dry, ir[:, ch])[:n].astype(np.float32)
    return out


# --------------------------------------------------------------------------------------
# TTS + caching
# --------------------------------------------------------------------------------------
_KOKORO = None


def kokoro():
    global _KOKORO
    if _KOKORO is None:
        from kokoro_onnx import Kokoro
        _KOKORO = Kokoro(KOKORO_MODEL, KOKORO_VOICES)
    return _KOKORO


def tts_raw(line_id, text, voice, speed, lang):
    """Kokoro output (24 kHz mono), cached by content hash."""
    key = hashlib.md5(f"{text}|{voice}|{speed:.4f}|{lang}".encode()).hexdigest()[:10]
    path = os.path.join(RAW, f"{line_id}_{key}.wav")
    if os.path.exists(path) and not FORCE:
        x, sr = sf.read(path, dtype="float32")
        return x, path
    is_ph = text.startswith("ipa:")
    x, sr = kokoro().create(text[4:] if is_ph else text, voice=voice, speed=speed, lang=lang, is_phonemes=is_ph)
    assert sr == SR_TTS
    x = np.asarray(x, np.float32)
    sf.write(path, x, sr, subtype="FLOAT")
    return x, path


def sox_pitch(raw_path, semitones):
    """sox pitch shift (duration preserving), cached next to the raw file."""
    cents = int(round(semitones * 100))
    if cents == 0:
        x, _ = sf.read(raw_path, dtype="float32")
        return x
    path = raw_path.replace(".wav", f"_p{cents:+d}.wav")
    if not os.path.exists(path) or FORCE:
        subprocess.run(["sox", "-q", raw_path, "-e", "floating-point", "-b", "32", path, "pitch", str(cents)],
                       check=True)
    x, _ = sf.read(path, dtype="float32")
    return x


# --------------------------------------------------------------------------------------
# Phonemes -> visemes
# --------------------------------------------------------------------------------------
VISEME_MAP = {
    "M": {"p", "b", "m"},
    "F": {"f", "v"},
    "O": {"u", "U", "oU", "@U", "w", "o", "O", "OI", "Q"},
    "E": {"i", "I", "e", "eI", "EI", "E", "j", "s", "z", "S", "Z", "I@", "e@"},
    "A": {"a", "A", "aI", "AI", "aU", "0", "@", "V", "3", "r=", "@r", "A@", "U@", "{"},
}
OPEN_WEIGHT = {"rest": 0.0, "A": 1.0, "O": 0.85, "E": 0.7, "L": 0.55, "F": 0.3, "M": 0.05}


def viseme_of(p):
    p = p.replace(":", "").replace("_h", "").replace("~", "")
    if p in ("_", "", "#"):
        return "rest"
    for v, s in VISEME_MAP.items():
        if p in s:
            return v
    if p[0] in "aeiouAEIOUV@{3":
        return "A"
    return "L"


def espeak_phonemes(text, lang):
    """[(phoneme, seconds), ...] from espeak-ng mbrola timing (None on failure)."""
    voices = ["mb-en1", "mb-us1"] if lang == "en-gb" else ["mb-us1", "mb-en1"]
    for v in voices:
        try:
            r = subprocess.run(["espeak-ng", "-v", v, "-q", "--pho", text], capture_output=True, text=True, timeout=20)
        except Exception:
            continue
        seq = []
        for ln in r.stdout.splitlines():
            tk = ln.split()
            if len(tk) >= 2 and tk[1].isdigit():
                seq.append((tk[0], int(tk[1]) / 1000.0))
        if sum(d for _, d in seq) > 0.05 and any(viseme_of(p) != "rest" for p, _ in seq):
            # drop leading / trailing silence
            while seq and viseme_of(seq[0][0]) == "rest":
                seq.pop(0)
            while seq and viseme_of(seq[-1][0]) == "rest":
                seq.pop()
            if seq:
                return seq
    return None


def split_sentences(text):
    parts = [p.strip() for p in re.split(r"(?<=[.!?…])\s+", text.strip()) if p.strip()]
    return parts or [text]


def audible_segments(x, fs, gap=0.14, rel_db=-38.0):
    """Contiguous audible regions (seconds) separated by silences >= gap."""
    env = rms_envelope(x, fs, attack=0.003, release=0.02)
    on = env > env.max() * amp(rel_db)
    segs = []
    i = 0
    n = len(on)
    while i < n:
        if on[i]:
            j = i
            while j < n and on[j]:
                j += 1
            segs.append([i, j])
            i = j
        else:
            i += 1
    merged = []
    for s in segs:
        if merged and (s[0] - merged[-1][1]) / fs < gap:
            merged[-1][1] = s[1]
        else:
            merged.append(s)
    return [(a / fs, b / fs) for a, b in merged]


# Expected loudness per phoneme (mbrola SAMPA), used to align espeak's timeline with the audio.
_PH_LOUD_BY_CLASS = {"A": 0.95, "O": 0.9, "E": 0.85, "L": 0.35, "F": 0.25, "M": 0.1, "rest": 0.0}
_PH_LOUD_EXACT = {
    "m": 0.55, "n": 0.55, "N": 0.55, "l": 0.6, "r": 0.6, "w": 0.7, "j": 0.7,  # voiced sonorants
    "b": 0.2, "d": 0.2, "g": 0.2, "p": 0.06, "t": 0.06, "k": 0.06,  # stops
    "v": 0.4, "z": 0.4, "Z": 0.4, "D": 0.4, "dZ": 0.3,  # voiced fricatives
    "f": 0.22, "s": 0.25, "S": 0.25, "T": 0.2, "h": 0.2, "tS": 0.2, "4": 0.35,  # voiceless
    "@": 0.7, "I": 0.8, "U": 0.8,  # reduced vowels
}
DTW_HOP = 0.010  # s


def ph_loud(p):
    q = p.replace(":", "").replace("_h", "").replace("~", "")
    return _PH_LOUD_EXACT.get(q, _PH_LOUD_BY_CLASS[viseme_of(p)])


def align_dtw(seq, env, fs, s0, s1, pen_h=0.04, pen_v=0.14, lam=0.6):
    """
    Map espeak phonemes onto the audio span [s0, s1] by dynamic time warping the expected
    loudness profile of the phoneme sequence (10 ms grid) against the measured envelope.
    Vowels land on loud regions, stops / pauses on quiet ones. Stretching a phoneme
    (horizontal step) costs pen_h, skipping through phonemes (vertical) costs pen_v, and
    `lam` pulls the path toward the linear mapping so espeak's own durations still count.
    Returns [(start_s, end_s, viseme)].
    """
    hop = int(DTW_HOP * fs)
    i0, i1 = int(s0 * fs), max(int(s1 * fs), int(s0 * fs) + 2 * hop)
    e = env[i0:i1].astype(np.float64)
    e = e[: (len(e) // hop) * hop].reshape(-1, hop).mean(axis=1)
    e = (e / (e.max() + 1e-9)) ** 0.6
    M = len(e)
    # expected profile on the same grid
    prof = []
    for p, d in seq:
        prof += [ph_loud(p)] * max(1, int(round(d / DTW_HOP)))
    prof = np.convolve(np.array(prof), np.ones(3) / 3, mode="same")
    N = len(prof)
    cost = np.abs(prof[:, None] - e[None, :])
    cost += lam * np.abs(np.arange(N)[:, None] / N - np.arange(M)[None, :] / M)
    D = np.full((N, M), np.inf)
    for i in range(N):
        C = np.cumsum(cost[i] + pen_h)
        if i == 0:
            m = np.full(M, np.inf)
            m[0] = cost[0, 0]
        else:
            prev = np.concatenate([[np.inf], D[i - 1, :-1]])
            m = cost[i] + np.minimum(prev, D[i - 1] + pen_v)
        D[i] = C + np.minimum.accumulate(m - C)
    # backtrack
    i, j = N - 1, M - 1
    first_j = np.full(N, -1)
    while True:
        first_j[i] = j
        if i == 0 and j == 0:
            break
        cands = []
        if i > 0 and j > 0:
            cands.append((D[i - 1, j - 1], i - 1, j - 1))
        if i > 0:
            cands.append((D[i - 1, j] + pen_v, i - 1, j))
        if j > 0:
            cands.append((D[i, j - 1] + pen_h, i, j - 1))
        _, i, j = min(cands, key=lambda c: c[0])
    # phoneme boundaries: profile index -> audio time
    out = []
    k = 0
    for p, d in seq:
        n = max(1, int(round(d / DTW_HOP)))
        a = first_j[min(k, N - 1)]
        b = first_j[min(k + n, N - 1)] if k + n < N else M
        out.append((s0 + a * DTW_HOP, s0 + max(b, a) * DTW_HOP, viseme_of(p)))
        k += n
    return out


def phoneme_timeline(text, lang, dry, fs):
    """[(start_s, end_s, viseme)] in the time base of `dry` (mono, pre-warp)."""
    sentences = split_sentences(text)
    segs = audible_segments(dry, fs)
    a0, a1 = audible_span(dry, fs)
    whole = (a0 / fs, a1 / fs)
    if len(sentences) > 1 and len(segs) == len(sentences):
        plan = list(zip(sentences, segs))
    else:
        plan = [(text, whole)]
    env = rms_envelope(dry, fs, attack=0.005, release=0.03)
    timeline = []
    for sent, (s0, s1) in plan:
        seq = espeak_phonemes(sent, lang)
        if not seq:
            timeline.append((s0, s1, "A"))
            continue
        timeline += align_dtw(seq, env, fs, s0, s1)
    return timeline


def frames_from(timeline, env, fs, nframes):
    """Per 24 fps frame: dominant viseme and openness. env: 0..1 envelope at `fs`."""
    frames = []
    peak = []
    for f in range(nframes):
        t0, t1 = f / FPS, (f + 1) / FPS
        i0, i1 = int(t0 * fs), min(int(t1 * fs), len(env))
        e = float(env[i0:i1].max()) if i1 > i0 else 0.0
        best, best_ov = "rest", 0.0
        for (s, e_, v) in timeline:
            ov = min(t1, e_) - max(t0, s)
            if ov > best_ov:
                best, best_ov = v, ov
        if e < 0.04:
            best = "rest"
        openness = OPEN_WEIGHT[best] * (e ** 0.8)
        frames.append([best, round(float(min(1.0, openness)), 3)])
        peak.append(round(e, 3))
    return frames, peak


# --------------------------------------------------------------------------------------
# Character / style processing (mono, 48 kHz in and out)
# --------------------------------------------------------------------------------------


def style_chain(x, fs, who, style, line_id, seed):
    if who == "pip":
        if style == "whisper":
            x = hp(x, 250.0, fs)
            x = compress(x, fs, thresh_db=-26.0, ratio=2.5, attack=0.004, release=0.09)
            breath = noise_vocode(x, fs, [(300, 800), (800, 1600), (1600, 3200), (3200, 6400), (6400, 11000)], seed)
            x = 0.78 * x + 0.55 * breath
            x = lp(x, 11000.0, fs)
        elif style == "hoarse":
            x = lp(x, 5500.0, fs)
            x = hp(x, 160.0, fs)
            t = np.arange(len(x)) / fs
            rng = np.random.default_rng(seed)
            jitter = lp(rng.standard_normal(len(x)).astype(np.float32), 12.0, fs) * 25
            rasp = 1.0 + 0.22 * np.sign(np.sin(2 * np.pi * (68 + jitter) * t))
            x = x * rasp.astype(np.float32)
            x = x + 0.3 * noise_vocode(x, fs, [(1000, 2500), (2500, 6000)], seed + 1)
            x = saturate(x, 2.0, 0.7)
        elif style == "bigshout":
            x = hp(x, 120.0, fs)
            x = eq(x, "peak", 400.0, fs, q=1.0, gain_db=2.0)
            x = eq(x, "peak", 2500.0, fs, q=1.0, gain_db=3.0)
            x = compress(x, fs, thresh_db=-18.0, ratio=3.0, attack=0.003, release=0.12)
            x = saturate(x, 2.2, 0.8)
        else:
            x = hp(x, 150.0, fs)
            x = eq(x, "peak", 3000.0, fs, q=1.0, gain_db=2.0)
            x = compress(x, fs, thresh_db=-24.0, ratio=2.0)
    elif who == "nan":
        x = eq(x, "lowshelf", 180.0, fs, q=0.7, gain_db=3.0)
        x = eq(x, "highshelf", 8000.0, fs, q=0.7, gain_db=-1.5)
        x = saturate(x, 1.4, 0.6)  # tape grit
        if style == "shout":
            x = eq(x, "highshelf", 3000.0, fs, q=0.7, gain_db=2.0)
            x = compress(x, fs, thresh_db=-20.0, ratio=4.0, attack=0.002, release=0.1)
        else:
            x = compress(x, fs, thresh_db=-22.0, ratio=2.0)
    elif who == "gus":
        x = hp(x, 220.0, fs)
        x = eq(x, "peak", 1200.0, fs, q=2.0, gain_db=2.0)
        x = eq(x, "peak", 2600.0, fs, q=1.0, gain_db=6.0)
        x = lp(x, 9000.0, fs)
        x = saturate(x, 1.6, 0.5)
        x = compress(x, fs, thresh_db=-22.0, ratio=2.5)
    elif who in ("tobi", "mira"):
        x = hp(x, 140.0, fs)
        x = eq(x, "highshelf", 4000.0, fs, q=0.7, gain_db=2.0)
        if style == "shout":
            x = eq(x, "peak", 2500.0, fs, q=1.0, gain_db=3.0)
            x = compress(x, fs, thresh_db=-20.0, ratio=4.0, attack=0.002, release=0.1)
            x = saturate(x, 1.5, 0.6)
        else:
            x = compress(x, fs, thresh_db=-22.0, ratio=2.0)
    return x.astype(np.float32)


# --------------------------------------------------------------------------------------
# Per-line rendering
# --------------------------------------------------------------------------------------


def pick_shout_candidate(line, char, speed, lang):
    """Candidates are in preference order; take the first one that gives a usable (>= 0.3 s)
    audible take, otherwise the longest."""
    best = None
    for cand in SHOUT_PLAN[line["id"]]["cands"]:
        x, path = tts_raw(line["id"], cand, char["voice"], speed, lang)
        a0, a1 = audible_span(x, SR_TTS)
        dur = (a1 - a0) / SR_TTS
        if dur >= 0.3:
            return cand, path
        if best is None or dur > best[0]:
            best = (dur, cand, path)
    return best[1], best[2]


def render_line(line, chars, speed_mult=1.0):
    lid, who, style = line["id"], line["who"], line.get("style", "normal")
    char = chars[who]
    cfg = CHAR[who]
    lang = cfg["lang"]
    speed = char["speed"] * speed_mult
    seed = int(hashlib.md5(lid.encode()).hexdigest()[:6], 16)

    # 1. TTS (24 kHz) + pitch shift
    if lid in SHOUT_PLAN:
        text_used, raw_path = pick_shout_candidate(line, char, speed, lang)
    else:
        text_used = line["text"]
        _, raw_path = tts_raw(lid, text_used, char["voice"], speed, lang)
    x = sox_pitch(raw_path, char["pitch_semitones"])

    # 2. tighten leading / trailing silence
    a0, a1 = audible_span(x, SR_TTS)
    x = x[max(0, a0 - int(0.03 * SR_TTS)): min(len(x), a1 + int(0.08 * SR_TTS))]
    x = x / (np.abs(x).max() + 1e-9) * 0.5

    # 3. phoneme timeline in the pre-warp time base
    timeline = phoneme_timeline(line["text"], lang, x, SR_TTS)

    # 4. time warp for shouts (keeps transients, sustains vowels)
    warp = None
    if lid in SHOUT_PLAN:
        target = SHOUT_PLAN[lid]["target"]
        x, in_t, out_t = warp_to_target(x, SR_TTS, target)
        warp = (in_t, out_t)
        if style == "bigshout":
            on = audible_span(x, SR_TTS)[0] / SR_TTS
            x = pitch_glide(x, SR_TTS, -3.0, 0.15, on)
    if warp is not None:
        timeline = [(float(np.interp(s, *warp)), float(np.interp(e, *warp)), v) for s, e, v in timeline]

    # 5. colour, 48 kHz (keep the uncoloured voice for the lip-sync envelope: compression and
    #    breath layers would flatten it)
    x = resample_to(x, SR_TTS, SR)
    clean = x.copy()
    x = style_chain(x, SR, who, style, lid, seed)

    # 6. loudness
    target = RMS_TARGET[style] + cfg["rms_trim"]
    x = (x * amp(target - gated_rms_db(x, SR))).astype(np.float32)
    dry = x
    speech_end = audible_span(dry, SR, rel_db=-45.0)[1] / SR

    # 7. room (never for bigshout: the mix adds the big reverb there)
    room = "none" if style == "bigshout" else line.get("room", "none")
    y = add_room(dry, SR, room)

    # 8. limiter + trim the tail where it has become inaudible
    y = limiter(y, SR)
    lvl = np.abs(y).max(axis=1)
    nz = np.where(lvl > 2e-4)[0]
    end = (int(nz[-1]) if len(nz) else len(y)) + int(0.05 * SR)
    y = y[:end]
    if np.abs(y).max() > PEAK:
        y *= PEAK / np.abs(y).max()

    # 9. lip-sync tracks from the clean dry voice
    env = rms_envelope(clean, SR)
    env = np.concatenate([env, np.zeros(max(0, len(y) - len(env)), np.float32)])[: len(y)]
    norm = float(np.percentile(env, 97)) if env.max() > 0 else 1.0
    env = np.clip(env / max(norm, 1e-6), 0, 1)
    nframes = int(math.ceil(len(y) / SR * FPS))
    frames, peak_env = frames_from(timeline, env, SR, nframes)

    return dict(audio=y, dur=len(y) / SR, speech_dur=speech_end, frames=frames, peak_env=peak_env,
                text_used=text_used, speed=speed, room=room, rms_db=gated_rms_db(dry, SR))


# --------------------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------------------


def scene_of(t, scenes):
    for s in scenes:
        if s["start"] <= t < s["end"]:
            return s["id"]
    return "none"


def main():
    os.makedirs(RAW, exist_ok=True)
    with open(SCRIPT) as f:
        script = json.load(f)
    chars = script["characters"]
    lines = sorted(script["lines"], key=lambda l: l["t"])
    scenes = script["scenes"]

    results = {}
    overlaps = []
    for i, line in enumerate(lines):
        nxt = lines[i + 1] if i + 1 < len(lines) else None
        same_scene = nxt is not None and scene_of(line["t"], scenes) == scene_of(nxt["t"], scenes)
        mult = 1.0
        while True:
            r = render_line(line, chars, mult)
            over = (line["t"] + r["speech_dur"]) - nxt["t"] if same_scene else -1.0
            if over <= 0.1 or mult >= 1.12 - 1e-9:
                break
            mult = min(1.12, mult + 0.03)
            print(f"  {line['id']}: overlaps next by {over:.2f}s -> retry at speed x{mult:.2f}")
        r["over"] = over
        r["mult"] = mult
        results[line["id"]] = r
        path = os.path.join(OUT, f"{line['id']}.wav")
        sf.write(path, r["audio"], SR, subtype="FLOAT")
        print(f"{line['id']} {line['who']:5s} t={line['t']:6.1f} dur={r['dur']:5.2f} speech={r['speech_dur']:4.2f} "
              f"rms={r['rms_db']:6.1f}dB peak={np.abs(r['audio']).max():.2f} room={r['room']:9s} "
              f"text={r['text_used']!r}")
        if same_scene and over > 0.1:
            overlaps.append((line["id"], nxt["id"], over))

    # lines.json
    out_lines = []
    for line in lines:
        r = results[line["id"]]
        out_lines.append(dict(
            id=line["id"], who=line["who"], t=line["t"], dur=round(r["dur"], 4),
            speech_dur=round(r["speech_dur"], 4), file=f"work/voices/{line['id']}.wav",
            style=line.get("style", "normal"), room=r["room"], text=line["text"],
            frames=r["frames"], peakEnv=r["peak_env"]))
    with open(os.path.join(OUT, "lines.json"), "w") as f:
        json.dump({"fps": FPS, "sr": SR, "lines": out_lines}, f)

    # report
    hdr = f"{'id':4s} {'who':5s} {'t':>7s} {'dur':>6s} {'speech':>6s} {'end':>7s} {'next_t':>7s} {'gap':>6s}  status"
    rows = [hdr, "-" * len(hdr)]
    for i, line in enumerate(lines):
        r = results[line["id"]]
        nxt = lines[i + 1] if i + 1 < len(lines) else None
        same = nxt is not None and scene_of(line["t"], scenes) == scene_of(nxt["t"], scenes)
        end = line["t"] + r["speech_dur"]
        gap = (nxt["t"] - end) if same else float("nan")
        if not same:
            status = "scene end"
        elif gap < -0.1:
            status = f"OVERLAP by {-gap:.2f}s (speed x{r['mult']:.2f})"
        elif gap < 0:
            status = "tight"
        else:
            status = "ok" + (f" (speed x{r['mult']:.2f})" if r["mult"] > 1 else "")
        rows.append(f"{line['id']:4s} {line['who']:5s} {line['t']:7.2f} {r['dur']:6.2f} {r['speech_dur']:6.2f} "
                    f"{end:7.2f} {(nxt['t'] if same else float('nan')):7.2f} {gap:6.2f}  {status}")
    rows.append("")
    rows.append("dur = processed file length incl. reverb tail; speech = end of the dry voice (used for overlap check).")
    if overlaps:
        rows.append("UNRESOLVED OVERLAPS (director to shift times):")
        for a, b, o in overlaps:
            rows.append(f"  {a} runs {o:.2f}s into {b}")
    else:
        rows.append("No unresolved overlaps.")
    report = "\n".join(rows)
    with open(os.path.join(OUT, "report.txt"), "w") as f:
        f.write(report + "\n")
    print()
    print(report)

    # preview
    gap = np.zeros((int(0.4 * SR), 2), np.float32)
    parts = []
    for line in lines:
        parts.append(results[line["id"]]["audio"])
        parts.append(gap)
    prev = np.concatenate(parts)
    prev *= min(1.0, PEAK / (np.abs(prev).max() + 1e-9))
    sf.write(os.path.join(OUT, "preview_all.wav"), prev, SR, subtype="FLOAT")
    print(f"\npreview_all.wav: {len(prev) / SR:.1f}s")


if __name__ == "__main__":
    main()
