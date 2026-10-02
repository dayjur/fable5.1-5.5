#!/usr/bin/env python3
"""
PIPSQUEAK — procedural sound-effects synthesizer / renderer.

    python3 audio/sfx.py out/events.json work/sfx.wav [--verify] [--dry]

Reads a timeline  {"fps":24, "duration":240, "events":[...]}  and renders a stereo
48 kHz float32 wav (peak <= 0.9).  Every event is synthesized from scratch with
numpy/scipy (no samples), panned with constant power from its "x", summed into a
per-room bus, and each bus is convolved once with a synthetic impulse response.

Event schema (all events):
    t      seconds (float)                      required
    type   string                               required
    x      0..1 screen position (L -> R)        default 0.5
    gain   linear multiplier                    default 1
    room   roost|tunnel|crack|cathedral|sky|none  default "none"
    dur    seconds, continuous sounds           type-specific default
    x_end  0..1, pan sweep target (whoosh/flock, or any event)   optional
    gain_end  linear, gain ramps gain -> gain_end over the sound (water_rush/wind, or any event)

Type-specific fields are documented on each generator below (see GENERATORS).
Everything is deterministic: each event gets a RandomState seeded from
crc32(type | t | x).
"""
import json
import sys
import time
import zlib
import warnings
from collections import Counter
from functools import lru_cache

import numpy as np
from numpy.random import RandomState
from scipy import signal
from scipy.interpolate import CubicSpline
from scipy.io import wavfile

SR = 48000
TWO_PI = 2.0 * np.pi

# --------------------------------------------------------------------------------------
# small DSP toolkit
# --------------------------------------------------------------------------------------


def nsamp(sec):
    return max(1, int(round(float(sec) * SR)))


def tline(n):
    return np.arange(n, dtype=np.float64) / SR


def seed_for(ev):
    key = "%s|%.4f|%.3f" % (ev.get("type", "?"), float(ev.get("t", 0.0)), float(ev.get("x", 0.5)))
    return zlib.crc32(key.encode("utf-8")) & 0xFFFFFFFF


def sub_rng(rng):
    """Derive an independent RandomState from another (keeps determinism)."""
    return RandomState(int(rng.randint(0, 2**31 - 1)))


def white(rng, n):
    return rng.standard_normal(n)


_PINK_B = np.array([0.049922035, -0.095993537, 0.050612699, -0.004408786])
_PINK_A = np.array([1.0, -2.494956002, 2.017265875, -0.522189400])


def pink(rng, n):
    x = signal.lfilter(_PINK_B, _PINK_A, rng.standard_normal(n + 2000))[2000:]
    return x / (np.std(x) + 1e-9)


def brown(rng, n):
    x = signal.lfilter([1.0], [1.0, -0.998], rng.standard_normal(n + 4000))[4000:]
    return x / (np.std(x) + 1e-9)


def _clampf(f, lo=10.0, hi=SR * 0.49):
    return float(min(max(f, lo), hi))


@lru_cache(maxsize=4096)
def _sos(btype, f1, f2, order):
    wn = f1 if f2 is None else [f1, f2]
    return signal.butter(order, wn, btype=btype, fs=SR, output="sos")


def _r(f):
    return float("%.4g" % f)  # rounding key so the sos cache gets hits


def lowpass(x, fc, order=2):
    return signal.sosfilt(_sos("low", _r(_clampf(fc)), None, order), x)


def highpass(x, fc, order=2):
    return signal.sosfilt(_sos("high", _r(_clampf(fc)), None, order), x)


def bandpass(x, lo, hi, order=2):
    lo = _clampf(lo)
    hi = _clampf(hi)
    if hi <= lo * 1.02:
        hi = lo * 1.02
    return signal.sosfilt(_sos("band", _r(lo), _r(hi), order), x)


def peak_filter(x, fc, q):
    """Resonant 2nd-order peaking band-pass (iirpeak)."""
    b, a = signal.iirpeak(_clampf(fc), q, fs=SR)
    return signal.lfilter(b, a, x)


def rbj_sos(kind, fc, q):
    """RBJ cookbook biquad as one sos row. kind: 'bp' (0 dB peak), 'lp', 'hp'."""
    fc = np.clip(fc, 10.0, SR * 0.47)
    w0 = TWO_PI * fc / SR
    c = np.cos(w0)
    s = np.sin(w0)
    alpha = s / (2.0 * q)
    if kind == "bp":
        b0, b1, b2 = alpha, 0.0 * c, -alpha
    elif kind == "lp":
        b0, b1, b2 = (1 - c) / 2, 1 - c, (1 - c) / 2
    else:  # hp
        b0, b1, b2 = (1 + c) / 2, -(1 + c), (1 + c) / 2
    a0 = 1 + alpha
    return np.stack([b0 / a0, b1 / a0, b2 / a0, np.ones_like(a0), (-2 * c) / a0, (1 - alpha) / a0], axis=-1)


def tv_filter(x, fc, q=1.0, kind="bp", block=128):
    """Time-varying biquad: fc (and optionally q) are arrays the length of x."""
    n = len(x)
    fc = np.broadcast_to(np.asarray(fc, dtype=np.float64), (n,))
    q = np.broadcast_to(np.asarray(q, dtype=np.float64), (n,))
    out = np.empty(n)
    zi = np.zeros((1, 2))
    idx = np.arange(0, n, block)
    coefs = rbj_sos(kind, fc[idx], q[idx])
    for k, i in enumerate(idx):
        out[i:i + block], zi = signal.sosfilt(coefs[k][None, :], x[i:i + block], zi=zi)
    return out


def sweep(f0, f1, n, exp=True):
    u = np.linspace(0.0, 1.0, n, endpoint=False)
    if exp:
        return f0 * (f1 / f0) ** u
    return f0 + (f1 - f0) * u


def osc(freqs, phase0=0.0):
    return np.sin(TWO_PI * np.cumsum(freqs) / SR + phase0)


def tone(freqs, harmonics=((1, 1.0),), phase0=0.0):
    ph = TWO_PI * np.cumsum(freqs) / SR + phase0
    out = np.zeros(len(freqs))
    for k, a in harmonics:
        out += a * np.sin(k * ph)
    return out


def env_exp(n, tau, t0=0.0):
    t = tline(n)
    return np.exp(-np.maximum(t - t0, 0.0) / tau)


def env_ad(n, attack, tau, curve=1.0):
    """Attack to 1 over `attack` s (power curve) then exponential decay with `tau`."""
    t = tline(n)
    a = np.clip(t / max(attack, 1e-4), 0, 1) ** curve
    d = np.exp(-np.maximum(t - attack, 0.0) / tau)
    return a * d


def hann(n):
    return np.hanning(n) if n > 1 else np.ones(n)


def fade_io(x, fi=0.3, fo=None):
    """Smooth (raised-cosine) fade in/out; durations clipped to a third of the signal."""
    n = len(x)
    if fo is None:
        fo = fi
    ni = min(nsamp(fi), n // 3)
    no = min(nsamp(fo), n // 3)
    y = x.copy()
    if ni > 1:
        y[:ni] *= 0.5 - 0.5 * np.cos(np.pi * np.arange(ni) / ni)
    if no > 1:
        y[-no:] *= 0.5 + 0.5 * np.cos(np.pi * np.arange(no) / no)
    return y


def slow_random(rng, n, rate_hz, clip=2.5):
    """Smooth random control signal, ~unit std, with features at about rate_hz."""
    k = max(4, int(n * rate_hz / SR) + 4)
    pts = rng.standard_normal(k)
    cs = CubicSpline(np.linspace(0, n, k), pts)
    return np.clip(cs(np.arange(n)), -clip, clip)


def norm_peak(x, peak=1.0):
    m = np.max(np.abs(x)) if len(x) else 0.0
    return x * (peak / m) if m > 1e-9 else x


def overlay(parts, min_len=0):
    """parts: iterable of (offset_seconds, array). Returns the mixed array."""
    parts = [(nsamp(o) if o > 0 else 0, np.asarray(a, dtype=np.float64)) for o, a in parts if len(a)]
    n = max([o + len(a) for o, a in parts] + [min_len, 1])
    out = np.zeros(n)
    for o, a in parts:
        out[o:o + len(a)] += a
    return out


def comb_tail(x, delay, fb=0.5, taps=6, lp=4000.0):
    """Sonar-like pitched echo tail: decaying, progressively darker taps."""
    d = nsamp(delay)
    out = np.zeros(len(x) + d * taps)
    out[:len(x)] += x
    y = x
    for k in range(1, taps + 1):
        y = lowpass(y, lp * (0.85 ** k)) * fb
        out[k * d:k * d + len(y)] += y
    return out


def tick_train(rng, n, rate_start, rate_end=None, amp=(0.3, 1.0)):
    """Sparse random impulses with rate ramping rate_start -> rate_end (per second)."""
    if rate_end is None:
        rate_end = rate_start
    rmax = max(rate_start, rate_end, 1e-3)
    out = np.zeros(n)
    t = 0.0
    T = n / SR
    while True:
        t += rng.exponential(1.0 / rmax)
        if t >= T:
            break
        r = rate_start + (rate_end - rate_start) * (t / T)
        if rng.uniform() < r / rmax:
            i = int(t * SR)
            if i < n:
                out[i] += rng.uniform(*amp) * rng.choice([-1.0, 1.0])
    return out


def soft_sat(x, drive=1.5):
    return np.tanh(x * drive) / np.tanh(drive)


# --------------------------------------------------------------------------------------
# generators  (each: ev dict, rng -> mono float64 array at 48 kHz)
# --------------------------------------------------------------------------------------


def gen_drip(ev, rng):
    """'size' 0.5-2 scales pitch (inverse) and decay (direct)."""
    size = float(ev.get("size", 1.0))
    ps = 1.0 / np.sqrt(size)
    # plink: fast pitch drop 2.4k -> 900 Hz over 30 ms then hold, with a touch of FM
    n = nsamp(0.045 + 0.18 * size)
    n_drop = nsamp(0.03)
    f = np.concatenate([sweep(2400 * ps, 900 * ps, n_drop), np.full(n - n_drop, 900 * ps)])
    f = f * (1 + 0.012 * rng.standard_normal())
    body = tone(f, ((1, 1.0), (2, 0.25), (3.01, 0.08))) * env_ad(n, 0.002, 0.03 * size, 0.5)
    mod = osc(f * 1.5) * 0.3 * env_exp(n, 0.02)
    body = body * (1 + mod)
    # click: tiny band-passed noise burst
    nc = nsamp(0.004)
    click = bandpass(white(rng, nc), 2500 * ps, 7000 * ps) * env_exp(nc, 0.0012) * 0.5
    # ripple tail: faint shimmering noise with 6-12 Hz amplitude wobble
    nr = nsamp(0.25 + 0.25 * size)
    tr = tline(nr)
    rip = bandpass(white(rng, nr), 1200 * ps, 4200 * ps)
    rip *= (0.55 + 0.45 * np.sin(TWO_PI * rng.uniform(6, 12) * tr)) * np.exp(-tr / (0.09 * size)) * 0.07
    # a quieter secondary "plip" bounce
    nb = nsamp(0.06 * size)
    bounce = osc(sweep(1500 * ps, 700 * ps, nb)) * env_ad(nb, 0.002, 0.018 * size) * 0.25
    out = overlay([(0, body * 0.55), (0, click), (0.012, rip), (0.045 + 0.03 * size, bounce)])
    return out * 0.7


_PING = {
    # who: (f0, f1, dur, gain, tail_delay, tail_fb, tail_taps, tail_lp)
    "pip": (3200, 1800, 0.060, 0.14, 0.019, 0.42, 5, 6000),
    "nan": (900, 500, 0.180, 0.55, 0.052, 0.55, 8, 3200),
    "tobi": (2400, 1100, 0.120, 0.45, 0.031, 0.50, 7, 5000),
    "mira": (2600, 2300, 0.070, 0.36, 0.027, 0.50, 7, 6000),
    "flock": (3000, 2000, 0.050, 0.22, 0.023, 0.40, 4, 6000),
    "gus": (1900, 1700, 0.045, 0.16, 0.017, 0.35, 4, 5000),
}


def _ping_voice(who, rng, size):
    f0, f1, dur, gain, tdel, tfb, ttaps, tlp = _PING[who]
    n = nsamp(dur)
    jit = 1 + 0.03 * rng.standard_normal()
    if who == "pip":
        core = tone(sweep(f0 * jit, f1 * jit, n), ((1, 1.0), (2, 0.12))) * env_ad(n, 0.004, dur * 0.45, 0.6)
    elif who == "nan":
        core = tone(sweep(f0 * jit, f1 * jit, n), ((1, 1.0), (2, 0.5), (3, 0.25), (4, 0.12))) * env_ad(n, 0.012, dur * 0.5, 0.7)
        nw = nsamp(0.4)
        whoom = lowpass(osc(sweep(120, 70, nw)), 200) * env_ad(nw, 0.03, 0.12) * 0.9
        core = overlay([(0, core), (0, whoom)])
    elif who == "tobi":
        harm = tuple((k, 1.0 / k) for k in range(1, 9))  # sawtooth-ish
        core = lowpass(tone(sweep(f0 * jit, f1 * jit, n), harm), 7000)
        core = soft_sat(core, 2.2) * env_ad(n, 0.004, dur * 0.5, 0.5)
    elif who == "mira":
        bell = ((1, 1.0), (2.76, 0.35), (5.4, 0.12))
        c1 = tone(sweep(f0 * jit, f1 * jit, n), bell) * env_ad(n, 0.003, dur * 0.5, 0.5)
        c2 = tone(sweep(f0 * 1.19 * jit, f1 * 1.19 * jit, n), bell) * env_ad(n, 0.003, dur * 0.5, 0.5)
        core = overlay([(0, c1), (0.11, c2 * 0.85)])
    elif who == "flock":
        fa = np.exp(rng.uniform(np.log(2200), np.log(5200)))
        fb_ = fa * rng.uniform(0.5, 0.75)
        n = nsamp(rng.uniform(0.035, 0.08))
        core = tone(sweep(fa, fb_, n), ((1, 1.0), (2, 0.2))) * env_ad(n, 0.003, 0.02, 0.5)
    else:  # gus
        t = tline(n)
        f = 1900 * jit * (1 + 0.06 * np.sin(TWO_PI * 35 * t))
        core = osc(f) * env_ad(n, 0.004, 0.015, 0.5)
    core = norm_peak(core, 1.0) * gain * (0.35 + 0.65 * size)
    taps = max(2, int(round(ttaps * (0.4 + 0.6 * size))))
    return comb_tail(core, tdel * (1 + 0.1 * rng.uniform(-1, 1)), tfb, taps, tlp)


def gen_ping(ev, rng):
    """'who' pip|nan|tobi|mira|flock|gus ; 'size' 0..1 loudness/ring size."""
    who = str(ev.get("who", "pip"))
    if who not in _PING:
        warnings.warn("ping: unknown who=%r, using pip" % who)
        who = "pip"
    size = float(np.clip(ev.get("size", 0.6), 0, 1))
    return _ping_voice(who, rng, size)


def gen_shout(ev, rng):
    """'size' 1.0 = cathedral shout, 0.8 = valley hello. 'echo' (bool) forces/suppresses
    the 4 valley echoes; default on for room == sky or size < 0.95."""
    size = float(ev.get("size", 1.0))
    room = ev.get("room", "none")
    echo = bool(ev.get("echo", room == "sky" or size < 0.95))
    # sub-bass thump
    ns = nsamp(0.9)
    sub = osc(sweep(62, 34, ns)) * env_ad(ns, 0.006, 0.28) * 0.9
    nt = nsamp(0.05)
    thump = lowpass(white(rng, nt), 160) * env_exp(nt, 0.012) * 0.6
    # rising whoosh 0.6 s
    nw = nsamp(0.6)
    tw = tline(nw)
    fc = 250 * (14.0) ** (tw / 0.6)
    whoosh = tv_filter(pink(rng, nw), fc, 1.2, "bp")
    whoosh *= np.sin(np.pi * np.clip(tw / 0.6, 0, 1) ** 0.6) ** 1.3
    whoosh = norm_peak(whoosh, 0.6)
    # shimmering tail 3 s: detuned sines + resonant noise
    nsh = nsamp(3.0)
    tsh = tline(nsh)
    shim = np.zeros(nsh)
    for base in (330, 495, 660, 990, 1320, 1980):
        for det in (-0.009, -0.004, 0.0, 0.004, 0.009):
            shim += np.sin(TWO_PI * base * (1 + det) * tsh + rng.uniform(0, TWO_PI)) / (base / 330.0) ** 0.5
    shim = shim / np.max(np.abs(shim)) * env_ad(nsh, 0.15, 0.95, 1.5) * 0.28
    res = np.zeros(nsh)
    pn = pink(rng, nsh)
    for fcr in (1200, 2400, 3600):
        res += peak_filter(pn, fcr, 25)
    res = norm_peak(res, 1) * env_ad(nsh, 0.08, 1.2, 1.0) * 0.22
    core = norm_peak(overlay([(0, sub), (0, thump), (0, whoosh), (0.08, shim), (0.05, res)]), 0.85)
    parts = [(0, core)]
    if echo:
        src = core[:nsamp(1.4)] * fade_io(np.ones(nsamp(1.4)), 0.0, 0.5)
        for delay, g, lp in ((0.30, 0.45, 3500), (0.65, 0.30, 2200), (1.10, 0.20, 1400), (1.70, 0.13, 900)):
            parts.append((delay, lowpass(src, lp) * g))
    return overlay(parts) * size


def gen_thunder(ev, rng):
    """'dist' 0..1 (0 = overhead). Transient is at t exactly."""
    d = float(np.clip(ev.get("dist", 0.5), 0, 1))
    dur = 2.3 + 1.7 * d + rng.uniform(0, 0.4)
    n = nsamp(dur)
    t = tline(n)
    rumble = brown(rng, n)
    rumble = lowpass(rumble, 380 - 270 * d, 2) + 0.4 * bandpass(white(rng, n), 40, 160 - 60 * d)
    attack = 0.012 + 0.6 * d
    lumps = 1 + 0.6 * np.clip(slow_random(rng, n, 2.5), -1, 2) * (0.3 + 0.7 * d)
    env = env_ad(n, attack, dur / 3.2, 1.2) * lumps
    rumble = norm_peak(rumble * env, 0.85 * (1 - 0.55 * d))
    parts = [(0, rumble)]
    if d < 0.4:
        k = 1 - d / 0.4
        nc = nsamp(0.09)
        crack = bandpass(white(rng, nc), 900, 7500) * env_exp(nc, 0.03) * 0.95
        nr = nsamp(0.5)
        tear = bandpass(white(rng, nr), 250, 2500) * env_ad(nr, 0.004, 0.18, 0.5)
        tear *= 1 + 0.5 * np.sign(slow_random(rng, nr, 40))  # ragged
        parts.append((0, crack * k))
        parts.append((0, tear * 0.55 * k))
    return norm_peak(overlay(parts), 0.9 - 0.45 * d)


def gen_rumble(ev, rng):
    """'dur' default 2."""
    dur = float(ev.get("dur", 2.0))
    n = nsamp(dur)
    base = lowpass(brown(rng, n), 110) + 0.5 * bandpass(white(rng, n), 50, 260)
    lumps = (0.45 + 0.55 * np.clip(slow_random(rng, n, 3.0), -1, 2.5) ** 2 / 4)
    cracks = signal.fftconvolve(tick_train(rng, n, 2.0, 2.0, (0.3, 1.0)),
                                bandpass(white(rng, nsamp(0.06)), 200, 800) * env_exp(nsamp(0.06), 0.015))[:n]
    out = base * lumps + cracks * 0.35
    return fade_io(norm_peak(out, 0.6), 0.3, min(0.5, dur / 3))


def _impact(rng, f0, water=False):
    nk = nsamp(0.25)
    f = np.concatenate([sweep(f0, f0 * 0.6, nsamp(0.02)), np.full(nk - nsamp(0.02), f0 * 0.6)])
    clunk = tone(f, ((1, 1.0), (2, 0.3), (2.9, 0.15))) * env_ad(nk, 0.002, rng.uniform(0.03, 0.09), 0.5)
    thud = bandpass(white(rng, nk), f0 * 0.5, f0 * 3.2) * env_ad(nk, 0.003, 0.04, 0.5)
    nc = nsamp(0.003)
    click = highpass(white(rng, nc), 3000) * env_exp(nc, 0.001)
    parts = [(0, clunk * 0.5), (0, thud * 0.6), (0, click * 0.35)]
    if water:
        parts.append((0.005, gen_splash({"size": rng.uniform(0.3, 0.5)}, sub_rng(rng)) * 0.6))
    return overlay(parts)


def gen_rockfall(ev, rng):
    """4-10 impacts over ~0.8 s + debris. 'water' bool (default True) lets some hit water."""
    k = int(rng.randint(4, 11))
    water = bool(ev.get("water", True))
    times = np.sort(rng.uniform(0, 0.8, k))
    times[0] = 0.0
    parts = []
    for i, ti in enumerate(times):
        f0 = np.exp(rng.uniform(np.log(170), np.log(650)))
        parts.append((ti, _impact(rng, f0, water and rng.uniform() < 0.4) * rng.uniform(0.5, 1.0)))
    n = nsamp(1.5)
    deb = signal.fftconvolve(tick_train(rng, n, 70, 4, (0.1, 0.4)),
                             bandpass(white(rng, nsamp(0.01)), 1500, 6500) * env_exp(nsamp(0.01), 0.002))[:n]
    parts.append((0.05, lowpass(deb, 7000) * 0.3 * env_exp(n, 0.7)))
    return norm_peak(overlay(parts), 0.75)


def gen_splash(ev, rng):
    """'size' 0.3-2."""
    s = float(ev.get("size", 1.0))
    sq = np.sqrt(s)
    nb = nsamp(0.08 * sq)
    plop = osc(sweep(220 / sq, 90 / sq, nb)) * env_ad(nb, 0.003, 0.06 * sq, 0.5)
    nbd = nsamp(0.5 * sq)
    body = bandpass(white(rng, nbd), 250 / sq, 1800 / sq) * env_ad(nbd, 0.008, 0.11 * sq, 0.6)
    nsp = nsamp(0.3 + 0.6 * s)
    gran = np.clip(slow_random(rng, nsp, 30), 0, None) ** 2
    spray = bandpass(white(rng, nsp), 2500, 9000) * gran * env_ad(nsp, 0.03, 0.25 * sq, 1.0)
    parts = [(0, plop * 0.55), (0, body * 0.75), (0.01, spray * 0.18)]
    for _ in range(int(rng.randint(2, 5))):
        parts.append((rng.uniform(0.25, 0.9) * sq,
                      gen_drip({"size": rng.uniform(0.5, 0.9)}, sub_rng(rng)) * rng.uniform(0.15, 0.35)))
    return norm_peak(overlay(parts), 0.7) * min(1.0, 0.5 + 0.5 * s)


def gen_wave(ev, rng):
    """A wave slapping a ledge, 1-1.5 s."""
    dur = float(ev.get("dur", rng.uniform(1.0, 1.5)))
    n = nsamp(dur)
    t = tline(n)
    u = np.clip(t / dur, 0, 1)
    swell = bandpass(pink(rng, n), 150, 1500) * np.sin(np.pi * u ** 0.7) ** 2
    wash = highpass(white(rng, n), 1500) * np.clip((u - 0.42) / 0.58, 0, 1) ** 0.5 * (1 - u) ** 1.5
    wash *= 0.6 + 0.4 * np.clip(slow_random(rng, n, 25), -1, 1)
    parts = [(0, swell * 0.5), (0, wash * 0.22),
             (0.4 * dur, gen_splash({"size": 1.3}, sub_rng(rng)) * 0.75)]
    return fade_io(norm_peak(overlay(parts), 0.7), 0.05, 0.3)


def gen_water_rush(ev, rng):
    """Continuous rushing water: 'dur', gain ramps via 'gain_end' (handled by renderer)."""
    dur = float(ev.get("dur", 4.0))
    n = nsamp(dur)
    pn = pink(rng, n)
    lfo = 0.7 + 0.3 * np.clip(slow_random(rng, n, 1.2), -1, 1)
    mid = bandpass(pn, 200, 2800) * lfo
    low = lowpass(brown(rng, n), 150) * (0.8 + 0.2 * np.clip(slow_random(rng, n, 0.4), -1, 1))
    hiss = highpass(white(rng, n), 3000) * (0.6 + 0.4 * np.clip(slow_random(rng, n, 2.5), -1, 1))
    out = mid * 0.5 + low * 0.35 + hiss * 0.12
    return fade_io(out / (np.std(out) + 1e-9) * 0.12, 0.35)


def gen_wind(ev, rng):
    """Continuous wind: 'dur', gain ramp via 'gain_end'."""
    dur = float(ev.get("dur", 4.0))
    n = nsamp(dur)
    gust = np.clip(0.5 + 0.5 * slow_random(rng, n, 0.15) / 1.5, 0, 1)
    pn = pink(rng, n)
    fc1 = 380 * 2.0 ** (1.4 * np.clip(slow_random(rng, n, 0.12), -1.5, 1.5) + gust)
    layer1 = tv_filter(pn, fc1, 1.6, "bp", 512)
    fc2 = 1400 * 2.0 ** (0.8 * np.clip(slow_random(rng, n, 0.25), -1.5, 1.5))
    whistle = tv_filter(pn, fc2, 9.0, "bp", 512) * gust ** 2
    low = lowpass(brown(rng, n), 120) * (0.5 + 0.5 * gust)
    out = layer1 * (0.45 + 0.55 * gust) * 0.5 + whistle * 0.35 + low * 0.3
    return fade_io(out / (np.std(out) + 1e-9) * 0.1, 0.4)


def gen_rain(ev, rng):
    """Distant rain outside the cave: 'dur'."""
    dur = float(ev.get("dur", 4.0))
    n = nsamp(dur)
    bed = bandpass(pink(rng, n), 500, 4500) * (0.85 + 0.15 * np.clip(slow_random(rng, n, 0.3), -1, 1))
    nk = nsamp(0.004)
    kernel = bandpass(white(rng, nk), 2000, 7000) * env_exp(nk, 0.0012)
    drops = signal.fftconvolve(tick_train(rng, n, 70, 70, (0.2, 1.0)), kernel)[:n]
    low = lowpass(brown(rng, n), 180)
    out = lowpass(bed * 0.5 + drops * 0.6, 2800) + low * 0.15
    return fade_io(out / (np.std(out) + 1e-9) * 0.07, 0.4)


def gen_cave_amb(ev, rng):
    """Cave ambience: drone + air + self-generated tiny drips (~1 per 4 s). 'dur'."""
    dur = float(ev.get("dur", 10.0))
    n = nsamp(dur)
    t = tline(n)
    drone = np.zeros(n)
    for f, a in ((38.0, 1.0), (57.2, 0.6), (76.5, 0.35), (114.3, 0.15)):
        am = 0.6 + 0.4 * np.sin(TWO_PI * rng.uniform(0.04, 0.1) * t + rng.uniform(0, TWO_PI))
        drone += a * am * np.sin(TWO_PI * f * t + rng.uniform(0, TWO_PI))
    drone = drone / 2.1 * 0.09 + lowpass(brown(rng, n), 70) * 0.04
    air = bandpass(pink(rng, n), 300, 2500) * (0.6 + 0.4 * np.clip(slow_random(rng, n, 0.2), -1, 1)) * 0.02
    parts = [(0, drone + air)]
    tt = rng.exponential(4.0) + 1.0
    while tt < dur - 0.6:
        parts.append((tt, gen_drip({"size": rng.uniform(0.6, 1.6)}, sub_rng(rng)) * rng.uniform(0.15, 0.4)))
        tt += rng.exponential(4.0) + 0.5
    return fade_io(overlay(parts, n)[:n], 0.5)


def _flaps(rng, dur, rate, size):
    """Wing beats: rate (per s), size 0.2 (pup) .. 1 (large)."""
    n = nsamp(dur)
    fc = 520 / np.sqrt(max(size, 0.05))
    parts = []
    tb = rng.uniform(0, 0.4) / rate
    period_jit = 1.0
    while tb < dur:
        period = (1.0 / rate) * period_jit
        nb = nsamp(min(0.28, 0.75 * period))
        body = bandpass(white(rng, nb), fc * 0.5, fc * 2.1) * env_ad(nb, 0.012, 0.045 * (0.6 + 0.8 * size), 0.8)
        nw = nsamp(0.12)
        whump = osc(sweep(95 / np.sqrt(size + 0.1), 55, nw)) * env_ad(nw, 0.01, 0.05) * 0.35 * size
        nsn = nsamp(0.004)
        snap = highpass(white(rng, nsn), 2500) * env_exp(nsn, 0.0012) * 0.22
        a = rng.uniform(0.7, 1.0)
        parts.append((tb, overlay([(0, body), (0, whump), (0, snap)]) * a))
        period_jit = float(np.clip(period_jit * (1 + 0.05 * rng.standard_normal()), 0.85, 1.15))
        tb += period
    out = overlay(parts, n)[:n] if parts else np.zeros(n)
    return out * 0.7 * (0.4 + 0.6 * size)


def gen_wingflap(ev, rng):
    """'dur', 'rate' beats/s (default 6), 'size' 0.2 pup .. 1 large."""
    dur = float(ev.get("dur", 2.0))
    rate = float(ev.get("rate", 6.0))
    size = float(ev.get("size", 0.5))
    return fade_io(_flaps(rng, dur, rate, size), 0.3)


def gen_flock(ev, rng):
    """Crowd of bats: 'dur', 'density' 0..1, pan sweep 'x' -> 'x_end' (renderer)."""
    dur = float(ev.get("dur", 6.0))
    density = float(np.clip(ev.get("density", 0.5), 0, 1))
    n = nsamp(dur)
    count = int(6 + 30 * density)
    parts = []
    for _ in range(count):
        L = rng.uniform(0.4, 1.0) * dur
        start = rng.uniform(0, max(dur - L, 0.0))
        r = sub_rng(rng)
        fl = _flaps(r, L, rng.uniform(5, 9), rng.uniform(0.5, 1.2))
        parts.append((start, fl * hann(len(fl)) * rng.uniform(0.4, 1.0)))
    nch = int(dur * (2 + 12 * density))
    for _ in range(nch):
        parts.append((rng.uniform(0, dur - 0.2), _ping_voice("flock", sub_rng(rng), rng.uniform(0.2, 0.8)) * rng.uniform(0.3, 0.8)))
    rush = bandpass(pink(rng, n), 200, 1500) * hann(n) * 0.12 * density
    parts.append((0, rush))
    out = overlay(parts, n)[:n] / np.sqrt(count / 8.0)
    return fade_io(out, 0.4)


def gen_heartbeat(ev, rng):
    """'dur', 'bpm' (default 80), optional 'bpm_end' ramp. Soft lub-dub."""
    dur = float(ev.get("dur", 4.0))
    bpm0 = float(ev.get("bpm", 80.0))
    bpm1 = float(ev.get("bpm_end", bpm0))
    n = nsamp(dur)
    t = tline(n)
    rate = (bpm0 + (bpm1 - bpm0) * t / dur) / 60.0
    phase = np.cumsum(rate) / SR
    beats = np.flatnonzero(np.diff(np.floor(phase)) > 0)
    beats = np.concatenate([[0], beats])
    parts = []
    for b in beats:
        tb = b / SR
        bpm_here = bpm0 + (bpm1 - bpm0) * tb / dur
        nl = nsamp(0.2)
        lub = osc(sweep(72, 44, nl)) * env_ad(nl, 0.012, 0.085, 1.0)
        nd = nsamp(0.15)
        dub = osc(sweep(88, 52, nd)) * env_ad(nd, 0.008, 0.055, 1.0) * 0.7
        gap = 0.17 * np.sqrt(60.0 / bpm_here)
        parts.append((tb, lub * rng.uniform(0.85, 1.0)))
        parts.append((tb + gap, dub * rng.uniform(0.85, 1.0)))
    out = lowpass(overlay(parts, n)[:n], 170)
    return fade_io(out * 0.5, 0.3)


def _breath(rng, dur, inhale):
    n = nsamp(dur)
    t = tline(n)
    u = t / dur
    pn = pink(rng, n)
    if inhale:
        env = u ** 1.6 * np.clip((1 - u) / 0.12, 0, 1) ** 0.7
        f1 = 500 * (1100 / 500) ** u
        f2 = 1300 * (2200 / 1300) ** u
    else:
        env = np.clip(u / 0.08, 0, 1) ** 0.8 * (1 - u) ** 1.4
        f1 = 1000 * (450 / 1000) ** u
        f2 = 2200 * (1200 / 2200) ** u
    flutter = 1 + 0.12 * np.clip(slow_random(rng, n, 8), -1, 1)
    out = tv_filter(pn, f1, 3.0, "bp", 256) + 0.6 * tv_filter(pn, f2, 4.0, "bp", 256) + 0.1 * highpass(pn, 4000)
    out = lowpass(out, 8000) * env * flutter
    return norm_peak(out, 0.3)


def gen_breath_in(ev, rng):
    """'dur' default 1.0 (may be long for the inhale before the shout)."""
    return _breath(rng, float(ev.get("dur", 1.0)), True)


def gen_breath_out(ev, rng):
    """'dur' default 0.9."""
    return _breath(rng, float(ev.get("dur", 0.9)), False)


def gen_gus_on(ev, rng):
    """Glow-worm lights up: rising bling + warm hum. 'dur' of hum (default 1.5)."""
    dur = float(ev.get("dur", 1.5))
    nb = nsamp(1.2)
    nr = nsamp(0.15)
    f = np.concatenate([sweep(500, 1600, nr), np.full(nb - nr, 1600.0)])
    bling = tone(f, ((1, 1.0), (2, 0.4), (3, 0.15))) * env_ad(nb, 0.01, 0.4, 0.8) * 0.2
    nh = nsamp(dur)
    th = tline(nh)
    hum = (np.sin(TWO_PI * 100 * th) + 0.5 * np.sin(TWO_PI * 200.4 * th) + 0.25 * np.sin(TWO_PI * 300.9 * th)) / 1.75
    hum = lowpass(hum * (1 + 0.08 * np.sin(TWO_PI * 8 * th)), 500) * 0.12
    hum = fade_io(hum, 0.3, min(0.4, dur / 3))
    ntk = nsamp(0.006)
    tick = bandpass(white(rng, ntk), 2000, 6000) * env_exp(ntk, 0.0015) * 0.15
    return overlay([(0, tick), (0, bling), (0.05, hum)])


def gen_gus_off(ev, rng):
    """Sad descending fizzle."""
    n = nsamp(0.75)
    t = tline(n)
    u = t / 0.75
    wob = 1 - (0.5 * u) * (0.5 + 0.5 * np.sign(np.sin(TWO_PI * (9 + 10 * u) * t)))
    sw = tone(sweep(1500, 180, n), ((1, 1.0), (2, 0.3))) * (1 - u) ** 0.8 * wob * 0.2
    nc = nsamp(0.85)
    nk = nsamp(0.008)
    kernel = bandpass(white(rng, nk), 2000, 6000) * env_exp(nk, 0.002)
    crackle = signal.fftconvolve(tick_train(rng, nc, 70, 8, (0.2, 1.0)), kernel)[:nc] * 0.15
    npf = nsamp(0.08)
    pfft = lowpass(white(rng, npf), 900) * env_ad(npf, 0.01, 0.025) * 0.15
    return overlay([(0, sw), (0.03, crackle), (0.62, pfft)])


def gen_gus_flicker(ev, rng):
    """Quick electric-ish crackles over 0.5 s."""
    k = int(rng.randint(4, 8))
    parts = []
    for _ in range(k):
        nb = nsamp(rng.uniform(0.008, 0.025))
        burst = bandpass(white(rng, nb), 1200, 5000) * env_ad(nb, 0.001, 0.006, 0.5)
        tb = tline(nb)
        buzz = np.sin(TWO_PI * 900 * tb) * (0.5 + 0.5 * np.sign(np.sin(TWO_PI * 120 * tb))) * env_exp(nb, 0.008) * 0.6
        parts.append((rng.uniform(0, 0.47), (burst + buzz) * rng.uniform(0.15, 0.3)))
    return overlay(parts, nsamp(0.5))


def gen_giggle(ev, rng):
    """Pups giggling: 'n' voices (default 3), 1.2 s."""
    nv = int(ev.get("n", 3))
    parts = []
    for v in range(nv):
        base = np.exp(rng.uniform(np.log(1800), np.log(3200)))
        t0 = rng.uniform(0, 0.25)
        k = int(rng.randint(4, 8))
        gap = rng.uniform(0.1, 0.16)
        for i in range(k):
            dur = rng.uniform(0.06, 0.09)
            n = nsamp(dur)
            t = tline(n)
            u = t / dur
            f = base * (1 + 0.1 * np.sin(np.pi * u)) * (1 - 0.06 * i) * (1 + 0.04 * np.sin(TWO_PI * 25 * t))
            chirp = tone(f, ((1, 1.0), (2, 0.3), (3, 0.1))) * env_ad(n, 0.008, dur * 0.35, 0.6)
            parts.append((t0 + i * gap * (1 + 0.1 * rng.standard_normal()), chirp * rng.uniform(0.6, 1.0) * (1 - 0.08 * i)))
    out = overlay(parts, nsamp(1.2))
    return norm_peak(out, 0.35) * min(1.0, 0.6 + 0.15 * nv)


def gen_whoosh(ev, rng):
    """Camera/flight whoosh: 'dur' 0.3-1.2, pan 'x' -> 'x_end' (renderer)."""
    dur = float(ev.get("dur", 0.6))
    n = nsamp(dur)
    t = tline(n)
    u = t / dur
    fc = 220 * 16.0 ** np.sin(np.pi * u ** 0.8)
    body = tv_filter(pink(rng, n), fc, 1.0, "bp", 128) * np.sin(np.pi * u ** 0.75) ** 1.5
    low = lowpass(brown(rng, n), 300) * np.sin(np.pi * u) ** 2 * 0.5
    return norm_peak(body + low, 0.45)


def gen_swoosh_wing(ev, rng):
    """A single bat passing close: quick flutter + whoosh."""
    fl = _flaps(rng, 0.42, 11.0, 0.9) * hann(nsamp(0.42)) * 1.6
    wh = gen_whoosh({"dur": 0.5}, sub_rng(rng)) * 0.8
    return norm_peak(overlay([(0.0, wh), (0.04, fl)]), 0.5)


def gen_stone_scrape(ev, rng):
    """Claws scrabbling on stone, 0.4 s."""
    k = int(rng.randint(3, 6))
    parts = []
    for _ in range(k):
        dur = rng.uniform(0.04, 0.11)
        n = nsamp(dur)
        wn = white(rng, n)
        grit = 0.5 + 0.5 * np.sign(slow_random(rng, n, rng.uniform(80, 200)))
        hi = peak_filter(wn, rng.uniform(1800, 4500), 6) * grit
        lo = bandpass(wn, 150, 500) * 0.5
        env = env_ad(n, 0.004, dur * 0.4, 0.5)
        parts.append((rng.uniform(0, 0.3), norm_peak(hi + lo, 1) * env * rng.uniform(0.5, 1.0)))
    for _ in range(3):
        nc = nsamp(0.003)
        parts.append((rng.uniform(0, 0.38), highpass(white(rng, nc), 3000) * env_exp(nc, 0.001) * 0.4))
    return norm_peak(lowpass(overlay(parts, nsamp(0.4)), 7000), 0.3)


def gen_crack_burst(ev, rng):
    """Bursting through the final crack: crumble + whoosh + sudden opening."""
    parts = []
    crumble_t = np.sort(rng.uniform(0, 0.5, 6))
    crumble_t[0] = 0.0
    for ti in crumble_t:
        parts.append((ti, _impact(rng, np.exp(rng.uniform(np.log(200), np.log(700))), False) * rng.uniform(0.4, 0.7)))
    nd = nsamp(0.9)
    deb = signal.fftconvolve(tick_train(rng, nd, 80, 5, (0.1, 0.4)),
                             bandpass(white(rng, nsamp(0.01)), 1500, 6500) * env_exp(nsamp(0.01), 0.002))[:nd]
    parts.append((0, deb * 0.4))
    ns = nsamp(0.7)
    parts.append((0.25, osc(sweep(55, 30, ns)) * env_ad(ns, 0.005, 0.25) * 0.7))
    parts.append((0.3, gen_whoosh({"dur": 0.8}, sub_rng(rng)) * 0.9))
    no = nsamp(1.3)
    t = tline(no)
    pn = pink(rng, no)
    narrow = norm_peak(peak_filter(pn, 700, 15), 1)
    wide = norm_peak(bandpass(pn, 100, 10000), 1)
    c = np.clip(t / 0.6, 0, 1)
    c = c * c * (3 - 2 * c)
    opening = (narrow * (1 - c) + wide * c) * env_ad(no, 0.05, 0.45, 0.7) * 0.5
    parts.append((0.3, opening))
    return norm_peak(overlay(parts), 0.8)


def gen_title_hit(ev, rng):
    """Very soft deep sub thud with a glassy shimmer."""
    n = nsamp(3.5)
    t = tline(n)
    sub = osc(sweep(46, 37, n)) * env_ad(n, 0.02, 0.9, 0.7) * 0.28
    shim = np.zeros(n)
    for f, a in ((2093, 1.0), (3136, 0.7), (4186, 0.5), (6272, 0.3)):
        for det in (-0.003, 0.0, 0.003):
            shim += a * np.sin(TWO_PI * f * (1 + det) * t + rng.uniform(0, TWO_PI))
    shim = shim / np.max(np.abs(shim)) * env_ad(n, 0.4, 1.1, 1.3) * 0.03
    sparkle = bandpass(white(rng, n), 4000, 9000) * np.clip(slow_random(rng, n, 20), 0, None) ** 2 * env_ad(n, 0.3, 0.8) * 0.012
    return sub + shim + sparkle


GENERATORS = {
    "drip": gen_drip, "ping": gen_ping, "shout": gen_shout, "thunder": gen_thunder,
    "rumble": gen_rumble, "rockfall": gen_rockfall, "splash": gen_splash, "wave": gen_wave,
    "water_rush": gen_water_rush, "wind": gen_wind, "rain": gen_rain, "cave_amb": gen_cave_amb,
    "wingflap": gen_wingflap, "flock": gen_flock, "heartbeat": gen_heartbeat,
    "breath_in": gen_breath_in, "breath_out": gen_breath_out,
    "gus_on": gen_gus_on, "gus_off": gen_gus_off, "gus_flicker": gen_gus_flicker,
    "giggle": gen_giggle, "whoosh": gen_whoosh, "swoosh_wing": gen_swoosh_wing,
    "stone_scrape": gen_stone_scrape, "crack_burst": gen_crack_burst, "title_hit": gen_title_hit,
}

# --------------------------------------------------------------------------------------
# reverb
# --------------------------------------------------------------------------------------

ROOMS = {
    # name: (rt60, predelay, wet gain, darkening per band (low, mid, high) as RT60 factors)
    "roost": (2.5, 0.012, 0.45, (1.0, 0.8, 0.45)),
    "tunnel": (1.6, 0.008, 0.40, (1.0, 0.7, 0.35)),
    "crack": (0.6, 0.004, 0.30, (1.0, 0.75, 0.5)),
    "cathedral": (4.5, 0.040, 0.55, (1.0, 0.8, 0.4)),
}
SKY_SLAP = (0.350, 10 ** (-18 / 20.0), 2000.0)
ROOM_NAMES = tuple(ROOMS) + ("sky", "none")


def make_ir(rt60, predelay, darken, seed):
    rng = RandomState(seed)
    n = nsamp(rt60 * 1.05)
    t = tline(n)
    pre = int(round(predelay * SR))
    ir = np.zeros((n + pre, 2), dtype=np.float64)
    bands = ((0.0, 350.0), (350.0, 2500.0), (2500.0, 12000.0))
    for ch in range(2):
        w = rng.standard_normal(n)
        acc = np.zeros(n)
        for (lo, hi), f in zip(bands, darken):
            b = lowpass(w, hi, 2) if lo == 0 else bandpass(w, lo, hi, 2)
            acc += b * np.exp(-t / (rt60 * f / 6.908))
        # build-up: diffuse tail grows in over the first ~20 ms, plus sparse early reflections
        acc *= np.clip(t / 0.02, 0, 1) ** 0.5
        for _ in range(8):
            d = int(rng.uniform(0.004, 0.08) * SR)
            if d < n:
                acc[d] += rng.uniform(0.2, 0.6) * rng.choice([-1, 1]) * (1 - d / (0.1 * SR))
        ir[pre:pre + n, ch] += acc
    ir /= np.sqrt(np.sum(ir ** 2) / 2.0) + 1e-12  # unit energy per channel (avg)
    return ir.astype(np.float32)


# --------------------------------------------------------------------------------------
# renderer
# --------------------------------------------------------------------------------------


def pan_gains(x0, x1, n):
    """Constant-power pan; linear sweep x0 -> x1 over n samples."""
    x0 = float(np.clip(x0, 0, 1))
    if x1 is None:
        th = x0 * np.pi / 2
        return np.cos(th), np.sin(th)
    x1 = float(np.clip(x1, 0, 1))
    th = np.linspace(x0, x1, n) * np.pi / 2
    return np.cos(th), np.sin(th)


def soft_limit(x, th=0.6, lim=0.9):
    """Transparent below th, smooth knee asymptotic to lim; never exceeds lim."""
    ax = np.abs(x)
    over = ax > th
    y = x.copy()
    y[over] = np.sign(x[over]) * (th + (lim - th) * np.tanh((ax[over] - th) / (lim - th)))
    return np.clip(y, -lim, lim)


def render(timeline, verbose=True, verify=False, dry_only=False):
    duration = float(timeline.get("duration", 240))
    N = nsamp(duration)
    master = np.zeros((N, 2), dtype=np.float32)
    buses = {}
    counts = Counter()
    skipped = Counter()
    onsets = []
    t_start = time.time()
    events = sorted(timeline.get("events", []), key=lambda e: float(e.get("t", 0)))
    for ev in events:
        typ = ev.get("type")
        gen = GENERATORS.get(typ)
        if gen is None:
            warnings.warn("unknown event type %r at t=%s - skipped" % (typ, ev.get("t")))
            skipped[str(typ)] += 1
            continue
        t0 = float(ev.get("t", 0.0))
        if t0 < 0 or t0 >= duration:
            warnings.warn("event %r at t=%.3f outside 0..%g - skipped" % (typ, t0, duration))
            skipped[str(typ)] += 1
            continue
        rng = RandomState(seed_for(ev))
        try:
            sig = np.asarray(gen(ev, rng), dtype=np.float64)
        except Exception as exc:  # a broken event must not kill the whole render
            warnings.warn("event %r at t=%.3f failed: %s: %s - skipped" % (typ, t0, type(exc).__name__, exc))
            skipped[str(typ)] += 1
            continue
        if not np.all(np.isfinite(sig)):
            warnings.warn("event %r at t=%.3f produced non-finite samples - zeroed" % (typ, t0))
            sig = np.nan_to_num(sig)
        n = len(sig)
        gain = float(ev.get("gain", 1.0))
        if "gain_end" in ev:
            sig = sig * np.linspace(gain, float(ev["gain_end"]), n)
        else:
            sig = sig * gain
        gl, gr = pan_gains(ev.get("x", 0.5), ev.get("x_end"), n)
        i0 = int(round(t0 * SR))
        i1 = min(N, i0 + n)
        m = i1 - i0
        if m <= 0:
            continue
        seg = sig[:m]
        st = np.empty((m, 2), dtype=np.float32)
        st[:, 0] = seg * (gl[:m] if np.ndim(gl) else gl)
        st[:, 1] = seg * (gr[:m] if np.ndim(gr) else gr)
        room = str(ev.get("room", "none"))
        if room not in ROOM_NAMES:
            warnings.warn("event %r at t=%.3f: unknown room %r, using none" % (typ, t0, room))
            room = "none"
        if room == "none" or dry_only:
            master[i0:i1] += st
        else:
            bus = buses.get(room)
            if bus is None:
                bus = buses[room] = np.zeros((N, 2), dtype=np.float32)
            bus[i0:i1] += st
        counts[typ] += 1
        onsets.append((t0, typ, room, float(np.sqrt(np.mean(seg[:nsamp(0.25)] ** 2)))))
    t_synth = time.time() - t_start

    # room buses: dry into master, plus one convolution per room
    t_rev = time.time()
    for room, bus in buses.items():
        master += bus
        nz = np.flatnonzero(np.abs(bus).max(axis=1) > 0)
        if len(nz) == 0:
            continue
        a, b = int(nz[0]), int(nz[-1]) + 1
        if room == "sky":
            delay, g, lp = SKY_SLAP
            d = nsamp(delay)
            e0, e1 = a + d, min(N, b + d)
            for ch in range(2):
                echo = lowpass(bus[a:b, ch].astype(np.float64), lp) * g
                master[e0:e1, ch] += echo[:e1 - e0].astype(np.float32)
        else:
            rt60, pre, wet, darken = ROOMS[room]
            ir = make_ir(rt60, pre, darken, zlib.crc32(room.encode()))
            for ch in range(2):
                w = signal.fftconvolve(bus[a:b, ch], ir[:, ch])
                e1 = min(N, a + len(w))
                master[a:e1, ch] += (w[:e1 - a] * wet).astype(np.float32)
        del bus
    buses.clear()
    t_rev = time.time() - t_rev

    peak_pre = float(np.max(np.abs(master))) if N else 0.0
    out = soft_limit(master.astype(np.float64)).astype(np.float32)
    peak = float(np.max(np.abs(out))) if N else 0.0

    if verbose:
        print("events: %d rendered, %d skipped   synth %.1fs, reverb %.1fs" %
              (sum(counts.values()), sum(skipped.values()), t_synth, t_rev))
        print("per type:")
        for k, v in sorted(counts.items()):
            print("  %-13s %4d" % (k, v))
        if skipped:
            print("skipped:", dict(skipped))
        print("peak before limiter %.3f, after %.3f" % (peak_pre, peak))
        secs = int(np.floor(N / SR))
        rms = np.sqrt(np.mean(out[:secs * SR].reshape(secs, SR, 2).astype(np.float64) ** 2, axis=(1, 2)))
        print("per-second RMS (rows of 10 s):")
        for r in range(0, secs, 10):
            row = rms[r:r + 10]
            print("  %3ds | " % r + " ".join("%.3f" % v for v in row))
        if verify:
            print("event onsets (t, type, room, dry RMS of first 250 ms, mix RMS of the 250 ms after t vs before):")
            for t0, typ, room, drms in onsets:
                i = int(t0 * SR)
                after = np.sqrt(np.mean(out[i:i + nsamp(0.25)].astype(np.float64) ** 2)) if i < N else 0
                before = np.sqrt(np.mean(out[max(0, i - nsamp(0.25)):i].astype(np.float64) ** 2)) if i > 0 else 0
                print("  %7.2f  %-12s %-9s dry %.3f  mix after %.3f  before %.3f" % (t0, typ, room, drms, after, before))
    return out


def main(argv):
    args = [a for a in argv[1:] if not a.startswith("--")]
    flags = set(a for a in argv[1:] if a.startswith("--"))
    if len(args) < 2:
        print(__doc__)
        return 2
    with open(args[0], "r") as fh:
        timeline = json.load(fh)
    out = render(timeline, verify="--verify" in flags, dry_only="--dry" in flags)
    wavfile.write(args[1], SR, out)
    print("wrote %s  (%.1f s, stereo, %d Hz, float32)" % (args[1], len(out) / SR, SR))
    return 0


if __name__ == "__main__":
    warnings.simplefilter("always")
    sys.exit(main(sys.argv))
