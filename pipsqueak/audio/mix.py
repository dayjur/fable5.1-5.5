#!/usr/bin/env python3
"""mix.py — final mix: dialogue + sfx + music → out/mix.wav (48 kHz stereo).

Dialogue sits on top (music/sfx are ducked under it), the two big shouts get their rooms
(cathedral reverb at 152 s, valley echoes at 205 s), everything is limited to -1 dBFS.
"""
import json, os, sys
import numpy as np
import soundfile as sf
from scipy.signal import fftconvolve, butter, sosfilt

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SR = 48000
DUR = 240.0
N = int(SR * DUR)

def load(path, gain=1.0):
    d, sr = sf.read(path, dtype='float32', always_2d=True)
    if sr != SR:
        from scipy.signal import resample_poly
        from math import gcd
        g = gcd(sr, SR); d = resample_poly(d, SR // g, sr // g, axis=0).astype(np.float32)
    if d.shape[1] == 1: d = np.repeat(d, 2, axis=1)
    return d[:, :2] * gain

def place(bus, sig, t):
    i = int(round(t * SR)); j = min(N, i + len(sig))
    if j > i: bus[i:j] += sig[:j - i]

def env_follow(x, attack=0.03, release=0.45):
    """peak-ish envelope follower on a mono signal (vectorised in blocks)."""
    hop = 240  # 5 ms
    blocks = np.abs(x[:len(x) // hop * hop]).reshape(-1, hop).max(axis=1)
    out = np.zeros_like(blocks); e = 0.0
    a_up = np.exp(-hop / (attack * SR)); a_dn = np.exp(-hop / (release * SR))
    for k, v in enumerate(blocks):
        e = v + (e - v) * (a_up if v > e else a_dn); out[k] = e
    return np.repeat(out, hop)[:len(x)] if len(out) * hop >= len(x) else np.pad(np.repeat(out, hop), (0, len(x) - len(out) * hop), mode='edge')

def ir(rt60, predelay=0.03, lp=4000.0, seed=1):
    rng = np.random.RandomState(seed)
    n = int(SR * rt60 * 1.2)
    t = np.arange(n) / SR
    noise = rng.randn(n, 2).astype(np.float32)
    dec = np.exp(-6.9 * t / rt60)[:, None]
    h = noise * dec
    # darken over time: 2-band
    sos = butter(2, lp / (SR / 2), output='sos')
    h = sosfilt(sos, h, axis=0)
    h = np.concatenate([np.zeros((int(predelay * SR), 2), np.float32), h.astype(np.float32)])
    h /= np.sqrt((h ** 2).sum(axis=0)).max() + 1e-9
    return h

def lowpass(x, fc):
    sos = butter(2, fc / (SR / 2), output='sos'); return sosfilt(sos, x, axis=0).astype(np.float32)

def main():
    lines = json.load(open(os.path.join(ROOT, 'work/voices/lines.json')))['lines']
    dial = np.zeros((N, 2), np.float32)
    for L in lines:
        sig = load(os.path.join(ROOT, L['file']))
        if L['id'] == 'L29':  # THE SHOUT: dry voice + cathedral reverb bloom
            wet = fftconvolve(sig, ir(4.8, 0.045, 3500, 7), axes=0)[:len(sig) + SR * 6] * 0.42
            dry = np.concatenate([sig, np.zeros((len(wet) - len(sig), 2), np.float32)])
            sig = (dry + wet) * 1.15
        if L['id'] == 'L34':  # HELLO: valley echoes answering
            base = sig.copy()
            tail = np.zeros((len(base) + int(SR * 4.5), 2), np.float32); tail[:len(base)] += base
            for k, (dly, g, fc) in enumerate([(0.75, 0.42, 3200), (1.45, 0.3, 2300), (2.3, 0.2, 1600), (3.3, 0.12, 1100)]):
                e = lowpass(base, fc) * g
                e = e[:, ::-1] if k % 2 else e  # alternate sides a little
                i = int(dly * SR); tail[i:i + len(e)] += e
            sig = tail
        place(dial, sig, L['t'])
    sfx = load(os.path.join(ROOT, 'work/sfx.wav'), 0.9)
    music = load(os.path.join(ROOT, 'work/music.wav'), 1.0)
    sfx = sfx[:N]; music = music[:N]
    if len(sfx) < N: sfx = np.pad(sfx, ((0, N - len(sfx)), (0, 0)))
    if len(music) < N: music = np.pad(music, ((0, N - len(music)), (0, 0)))

    # ducking under dialogue
    denv = env_follow(dial.mean(axis=1), 0.02, 0.5)
    denv = denv / (np.percentile(denv[denv > 1e-4], 90) + 1e-6) if (denv > 1e-4).any() else denv
    denv = np.clip(denv, 0, 1)
    music_g = 10 ** (-7.0 / 20 * denv)   # up to -7 dB
    sfx_g = 10 ** (-3.5 / 20 * denv)
    mix = dial + sfx * sfx_g[:, None] + music * music_g[:, None]

    # gentle bus compression, makeup gain, then a fast peak limiter
    env = env_follow(mix.mean(axis=1), 0.005, 0.25)
    thr = 0.5
    g = np.where(env > thr, (thr + (env - thr) * 0.5) / env, 1.0)
    mix = mix * g[:, None] * 10 ** (4.5 / 20)
    ceiling = 10 ** (-1.0 / 20)
    penv = env_follow(np.abs(mix).max(axis=1), 0.001, 0.08)
    lim = np.where(penv > ceiling, ceiling / np.maximum(penv, 1e-6), 1.0)
    mix = mix * lim[:, None]
    mix = np.clip(mix, -ceiling, ceiling)
    # final soft clip safety
    mix = np.tanh(mix * 1.02) / np.tanh(1.02)
    rms = np.sqrt((mix ** 2).mean())
    print(f'mix: peak {np.abs(mix).max():.3f}  rms {20*np.log10(rms+1e-9):.1f} dBFS')
    # per-10s loudness table
    for k in range(0, 240, 10):
        seg = mix[k * SR:(k + 10) * SR]
        print(f'{k:4d}-{k+10:<4d} {20*np.log10(np.sqrt((seg**2).mean())+1e-9):6.1f} dBFS')
    sf.write(os.path.join(ROOT, 'out/mix.wav'), mix.astype(np.float32), SR, subtype='PCM_24')

if __name__ == '__main__':
    main()
