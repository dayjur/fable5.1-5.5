#!/usr/bin/env python3
"""
PIPSQUEAK — score.

Composes the film score as MIDI (absolute seconds -> ticks at a fixed 120 BPM),
renders it with FluidSynth (FluidR3_GM) in instrument-group stems, then mixes,
reverberates, gates (hard cut at 106.0, silence until 141), limits and reports in numpy.

    python3 audio/music.py        (from pipsqueak/)

Outputs (all under pipsqueak/work):
    music.wav                 240.000 s, stereo, 48 kHz, peak <= 0.9
    music.mid                 the whole score as one multi-track MIDI file (28 instruments on 16
                              channels: non-overlapping instruments share a channel; tracks that
                              do collide in the tuttis carry a midi_port meta so port-aware DAWs
                              render them exactly)
    music_stems/<stem>.wav    per-group stems (same gain/gating as the mix, dry)
    music_report.txt          RMS-over-time table + sync-point checks

Home key: D major (Pip's theme in major = F# A B, scale degrees 3-5-6).
Cave / title key: B minor (same motif B D E, degrees 1-b3-4), Roost: G major.
"""
import os, sys, math, random, subprocess, shutil
import numpy as np
import mido
import soundfile as sf
from scipy import signal, ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
WORK = os.path.join(ROOT, "work")
STEMS_DIR = os.path.join(WORK, "music_stems")
TMP = os.path.join(WORK, "music_tmp")
SF2 = "/usr/share/sounds/sf2/FluidR3_GM.sf2"

SR = 48000
DUR = 240.0
TPB = 480                      # ticks per beat
TEMPO = 500000                 # 120 BPM -> 960 ticks / second
TPS = TPB * 1_000_000 / TEMPO  # ticks per second

random.seed(1207)
np.random.seed(1207)

# ----------------------------------------------------------------------------
# pitch helpers
# ----------------------------------------------------------------------------
_NOTE = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def P(name):
    """'F#4' -> 66 (C4 = 60)."""
    n = _NOTE[name[0]]
    i = 1
    while i < len(name) and name[i] in "#b":
        n += 1 if name[i] == "#" else -1
        i += 1
    return 12 * (int(name[i:]) + 1) + n


MAJ = [0, 2, 4, 5, 7, 9, 11]
MIN = [0, 2, 3, 5, 7, 8, 10]


def scale(root, mode, lo, hi):
    """all midi notes of the scale within [lo, hi]."""
    out = []
    for p in range(lo, hi + 1):
        if (p - root) % 12 in mode:
            out.append(p)
    return out


# ----------------------------------------------------------------------------
# score model
# ----------------------------------------------------------------------------
class Inst:
    def __init__(self, name, program, stem, pan=64, vol=100, rev=40, drums=False, human=0.006):
        self.name, self.program, self.stem = name, program, stem
        self.pan, self.vol, self.rev, self.drums = pan, vol, rev, drums
        self.human = human
        self.notes = []       # (t, dur, pitch, vel, exact)
        self.expr = []        # (t, value) breakpoints, CC11
        self.bends = []       # (t, value -8192..8191)
        self.mods = []        # (t, value) CC1
        self.channel = None

    # --- writing notes ------------------------------------------------------
    def note(self, t, dur, pitch, vel, exact=False):
        if isinstance(pitch, str):
            pitch = P(pitch)
        self.notes.append((float(t), max(0.03, float(dur)), int(pitch), int(max(1, min(127, vel))), exact))

    def chord(self, t, dur, pitches, vel, exact=False, roll=0.0):
        for i, p in enumerate(pitches):
            self.note(t + i * roll, dur - i * roll, p, vel, exact)

    def swell(self, t0, t1, v0, v1):
        """linear CC11 ramp."""
        self.expr.append((float(t0), int(v0)))
        self.expr.append((float(t1), int(v1)))

    def level(self, t, v):
        self.expr.append((float(t), int(v)))

    def bend(self, t, v):
        self.bends.append((float(t), int(v)))

    def mod(self, t, v):
        self.mods.append((float(t), int(v)))

    # --- analysis -----------------------------------------------------------
    def intervals(self, pre=0.08, post=0.35, gap=0.4):
        if not self.notes:
            return []
        spans = sorted((t - pre, t + d + post) for t, d, _, _, _ in self.notes)
        out = [list(spans[0])]
        for a, b in spans[1:]:
            if a <= out[-1][1] + gap:
                out[-1][1] = max(out[-1][1], b)
            else:
                out.append([a, b])
        return [(max(0.0, a), min(DUR, b)) for a, b in out]

    def expr_at(self, t):
        if not self.expr:
            return 100
        pts = sorted(self.expr)
        if t <= pts[0][0]:
            return pts[0][1]
        for (ta, va), (tb, vb) in zip(pts, pts[1:]):
            if ta <= t <= tb:
                if tb == ta:
                    return vb
                return va + (vb - va) * (t - ta) / (tb - ta)
        return pts[-1][1]


class Score:
    def __init__(self):
        self.insts = {}

    def add(self, *a, **k):
        i = Inst(*a, **k)
        self.insts[i.name] = i
        return i

    def __getattr__(self, name):
        if name in self.__dict__.get("insts", {}):
            return self.insts[name]
        raise AttributeError(name)


# ----------------------------------------------------------------------------
# MIDI writer
# ----------------------------------------------------------------------------
def inst_events(inst, channel):
    """return list of (tick, prio, Message) for one instrument on a channel."""
    ev = []
    ivs = inst.intervals()
    if not ivs:
        return ev

    def tick(t):
        return int(round(max(0.0, t) * TPS))

    def add(t, prio, msg):
        ev.append((tick(t), prio, msg))

    for (a, b) in ivs:
        t0 = max(0.0, a - 0.05)
        if not inst.drums:
            add(t0, 0, mido.Message("program_change", channel=channel, program=inst.program))
        add(t0, 1, mido.Message("control_change", channel=channel, control=7, value=inst.vol))
        add(t0, 1, mido.Message("control_change", channel=channel, control=10, value=inst.pan))
        add(t0, 1, mido.Message("control_change", channel=channel, control=91, value=inst.rev))
        add(t0, 1, mido.Message("control_change", channel=channel, control=1, value=0))
        add(t0, 1, mido.Message("pitchwheel", channel=channel, pitch=0))
        # expression, sampled every 25 ms when it changes
        last = None
        t = t0
        while t <= b:
            v = int(round(inst.expr_at(t)))
            v = max(0, min(127, v))
            if v != last:
                add(t, 2, mido.Message("control_change", channel=channel, control=11, value=v))
                last = v
            t += 0.025
        for (t, v) in inst.bends:
            if a - 0.1 <= t <= b:
                add(t, 2, mido.Message("pitchwheel", channel=channel, pitch=max(-8192, min(8191, v))))
        for (t, v) in inst.mods:
            if a - 0.1 <= t <= b:
                add(t, 2, mido.Message("control_change", channel=channel, control=1, value=v))

    for (t, d, p, v, exact) in inst.notes:
        if exact:
            tt, vv = t, v
        else:
            tt = t + max(-0.010, min(0.010, random.gauss(0, inst.human)))
            vv = int(max(1, min(127, v + random.gauss(0, 4))))
        tt = max(0.0, tt)
        add(tt, 4, mido.Message("note_on", channel=channel, note=p, velocity=vv))
        add(tt + d, 3, mido.Message("note_off", channel=channel, note=p, velocity=0))
    return ev


SHARE_IV = dict(pre=0.08, post=0.35, gap=0.4)   # activity intervals used for channel sharing


def _overlap(ivs, used):
    ov = 0.0
    for (a, b) in ivs:
        for (ua, ub) in used:
            ov += max(0.0, min(b, ub) - max(a, ua))
    return ov


def assign_channels(insts, verbose=False):
    """interval colouring onto the 15 melodic channels (drums -> 9).
    Instruments whose activity never overlaps share a channel (program + CCs are re-sent at
    the start of every phrase). Busiest instruments are placed first; best-fit packing."""
    chans = {c: [] for c in range(16) if c != 9}
    order = sorted((i for i in insts if not i.drums),
                   key=lambda i: -sum(b - a for a, b in i.intervals(**SHARE_IV)))
    total_ov = 0.0
    for inst in insts:
        if inst.drums:
            inst.channel = 9
    for inst in order:
        ivs = inst.intervals(**SHARE_IV)
        cand = []
        for c, used in chans.items():
            cand.append((_overlap(ivs, used), -sum(b - a for a, b in used), c))
        cand.sort()
        ov, _, c = cand[0]
        inst.channel = c
        chans[c].extend(ivs)
        total_ov += ov
        if verbose and ov > 0:
            print(f"  channel sharing: {inst.name} on ch{c} overlaps {ov:.2f} s with {[i.name for i in insts if i.channel == c and i is not inst]}")
    if verbose:
        print(f"  music.mid channel-sharing overlap total: {total_ov:.2f} s")
    return total_ov


def write_midi(insts, path, unique_channels):
    mid = mido.MidiFile(ticks_per_beat=TPB, type=1)
    meta = mido.MidiTrack()
    meta.append(mido.MetaMessage("set_tempo", tempo=TEMPO, time=0))
    meta.append(mido.MetaMessage("time_signature", numerator=4, denominator=4, time=0))
    meta.append(mido.MetaMessage("track_name", name="PIPSQUEAK score", time=0))
    meta.append(mido.MetaMessage("end_of_track", time=int(DUR * TPS)))
    mid.tracks.append(meta)
    if unique_channels:
        c = 0
        for inst in insts:
            if inst.drums:
                inst.channel = 9
            else:
                if c == 9:
                    c += 1
                inst.channel = c
                c += 1
                assert c <= 16, "too many instruments in a stem"
    else:
        assign_channels(insts, verbose=True)
    # port = rank of the instrument on its channel (busiest first). A port-aware player (DAW)
    # renders every instrument on its own channel/port; a single-port player (fluidsynth) gets the
    # minimised-overlap channel sharing from assign_channels().
    port_of = {}
    for c in range(16):
        same = [i for i in insts if i.channel == c and i.notes]
        same.sort(key=lambda i: -sum(b - a for a, b in i.intervals(**SHARE_IV)))
        for r, i in enumerate(same):
            port_of[i.name] = r
    for inst in insts:
        ev = inst_events(inst, inst.channel)
        if not ev:
            continue
        ev.sort(key=lambda e: (e[0], e[1]))
        tr = mido.MidiTrack()
        tr.append(mido.MetaMessage("track_name", name=inst.name, time=0))
        tr.append(mido.MetaMessage("midi_port", port=port_of.get(inst.name, 0), time=0))
        last = 0
        for (tk, _, msg) in ev:
            msg.time = tk - last
            last = tk
            tr.append(msg)
        tr.append(mido.MetaMessage("end_of_track", time=max(0, int(DUR * TPS) - last)))
        mid.tracks.append(tr)
    mid.save(path)


# ----------------------------------------------------------------------------
# THE SCORE
# ----------------------------------------------------------------------------
def build_score():
    S = Score()
    # strings stem
    S.add("vln", 48, "strings", pan=46, vol=100, rev=55)          # string ensemble 1 (melody, ostinato)
    S.add("strs", 49, "strings", pan=72, vol=100, rev=70)         # slow strings (pads, chords)
    S.add("trem", 44, "strings", pan=60, vol=100, rev=60)         # tremolo strings
    S.add("pizz", 45, "strings", pan=52, vol=100, rev=35)         # pizzicato
    S.add("cello", 42, "strings", pan=78, vol=100, rev=55)
    S.add("cbass", 43, "strings", pan=64, vol=100, rev=40)
    # winds stem
    S.add("clar", 71, "winds", pan=44, vol=100, rev=45)
    S.add("bsn", 70, "winds", pan=74, vol=100, rev=40)
    S.add("flute", 73, "winds", pan=40, vol=100, rev=60)
    S.add("oboe", 68, "winds", pan=58, vol=100, rev=55)
    # brass stem
    S.add("horn", 60, "brass", pan=58, vol=100, rev=65)
    S.add("brass", 61, "brass", pan=70, vol=100, rev=55)
    S.add("ohit", 55, "brass", pan=64, vol=100, rev=70, human=0.0)
    # keys stem
    S.add("cel", 8, "keys", pan=54, vol=112, rev=60)
    S.add("mbox", 10, "keys", pan=70, vol=120, rev=65)
    S.add("glock", 9, "keys", pan=78, vol=108, rev=65)
    S.add("harp", 46, "keys", pan=36, vol=100, rev=55)
    S.add("bells", 14, "keys", pan=64, vol=100, rev=80)
    S.add("vibes", 11, "keys", pan=46, vol=100, rev=60)
    S.add("piano", 0, "keys", pan=60, vol=100, rev=75)
    # perc stem
    S.add("timp", 47, "perc", pan=60, vol=100, rev=55, human=0.004)
    S.add("taiko", 116, "perc", pan=64, vol=100, rev=50, human=0.004)
    S.add("drums", 0, "perc", pan=64, vol=100, rev=45, drums=True, human=0.003)
    # atmosphere stem
    S.add("choir", 52, "atmos", pan=64, vol=100, rev=90)
    S.add("padw", 89, "atmos", pan=64, vol=100, rev=70)
    S.add("halo", 94, "atmos", pan=64, vol=100, rev=100)
    S.add("crystal", 98, "atmos", pan=64, vol=100, rev=110)
    S.add("sweep", 95, "atmos", pan=64, vol=100, rev=90)

    compose_cold_open(S)
    compose_roost(S)
    compose_exodus(S)
    compose_quiet_way(S)
    compose_count_and_shout(S)
    compose_flight(S)
    compose_sky(S)
    compose_credits(S)
    return S


# --- motifs ------------------------------------------------------------------
# Pip's theme as semitone offsets from the motif root R (minor 3rd up, then a step).
# In B minor R=B (1 b3 4); in D major R=F# (3 5 6). Durations in beats.
PIP_A = [(0, 1), (3, 1), (5, 2), (None, 1),
         (0, 1), (3, 1), (5, 1), (7, 2), (None, 1)]
PIP_B = [(5, 1), (8, 1), (10, 1), (7, 1.5), (None, .5),
         (5, 1), (3, 1), (0, 2), (None, 1)]
PIP_END = [(0, 1), (3, 1), (5, 1), (8, 3)]           # cadence onto the tonic (R+8)


def play_theme(inst, t, R, beat, seq, vel, legato=0.95, vel_shape=None):
    """play a theme; returns end time."""
    for i, (deg, b) in enumerate(seq):
        d = b * beat
        if deg is not None:
            v = vel if vel_shape is None else vel_shape(i, len(seq))
            inst.note(t, d * legato, R + deg, v)
        t += d
    return t


def nan_theme(cello, t, root, beat, vel):
    """Nan: warm, slow, slightly wry (chromatic lower neighbour at the end)."""
    seq = [(-5, 1), (0, 1), (4, 1.5), (2, .5), (0, 1), (-1, 1), (-3, 1.5), (None, .5),
           (-5, 1), (0, 1), (4, 1), (5, 1), (6, .75), (7, 2.25)]
    for deg, b in seq:
        if deg is not None:
            cello.note(t, b * beat * 0.97, root + deg, vel)
        t += b * beat
    return t


def roll(inst, t0, t1, pitch, v0, v1, step0=0.09, step1=0.045, exact_last=False):
    """accelerating crescendo roll between t0 and t1."""
    t = t0
    while t < t1:
        f = (t - t0) / max(1e-6, t1 - t0)
        step = step0 + (step1 - step0) * f
        inst.note(t, step * 0.9, pitch, v0 + (v1 - v0) * f)
        t += step


def gliss(inst, t0, t1, notes, v0, v1):
    n = len(notes)
    for i, p in enumerate(notes):
        f = i / max(1, n - 1)
        inst.note(t0 + (t1 - t0) * f, 0.25, p, v0 + (v1 - v0) * f)


def ostinato(inst, t0, nbars, bar, chords, vel, pattern=(0, 1, 2, 3, 2, 1), dur_f=0.95, vel_acc=(1.0, .8, .85, .9, .85, .8)):
    """6/8 arpeggio ostinato. chords: list of pitch-lists (len>=4) per bar."""
    e = bar / 6.0
    for k in range(nbars):
        ch = chords[k % len(chords)]
        for j in range(6):
            p = ch[pattern[j] % len(ch)]
            inst.note(t0 + k * bar + j * e, e * dur_f, p, vel * vel_acc[j])


# -----------------------------------------------------------------------------
def compose_cold_open(S):
    # 0-5.5 near silence; single very low drone fades in from 1.0
    S.cbass.note(1.0, 4.6, "B1", 60)
    S.cbass.level(0.0, 0); S.cbass.swell(1.0, 4.5, 0, 55); S.cbass.swell(5.0, 5.6, 55, 20); S.cbass.level(5.65, 90)
    S.padw.note(1.0, 4.6, "B1", 50)
    S.padw.level(0.0, 0); S.padw.swell(1.0, 5.0, 0, 42); S.padw.swell(5.0, 5.6, 42, 20)
    # 5.5 Nan's call: warm low chord swells mp->mf over 1 s, settles by 9
    S.strs.chord(5.5, 4.0, [P("G2"), P("D3"), P("B3"), P("G4")], 84, exact=True)
    S.strs.level(5.45, 60); S.strs.swell(5.5, 6.5, 60, 100); S.strs.swell(7.2, 9.0, 100, 40); S.strs.level(9.6, 60)
    S.horn.chord(5.5, 3.6, [P("G3"), P("D4")], 78, exact=True)
    S.horn.level(5.45, 55); S.horn.swell(5.5, 6.5, 55, 95); S.horn.swell(7.0, 9.0, 95, 30); S.horn.level(9.6, 100)
    S.cello.note(5.5, 3.8, "G2", 80, exact=True)
    S.cello.level(5.45, 60); S.cello.swell(5.5, 6.5, 60, 100); S.cello.swell(7.2, 9.0, 100, 35); S.cello.level(9.6, 100)
    S.cbass.note(5.55, 3.6, "G1", 70, exact=True)
    S.padw.chord(5.5, 4.0, [P("G2"), P("D3")], 60, exact=True); S.padw.swell(5.6, 6.5, 20, 70); S.padw.swell(7.5, 9.2, 70, 0); S.padw.level(9.8, 60)
    # 10-14 TITLE: Pip's music-box motif alone, hesitant, with a small glock shimmer
    for inst, v in ((S.mbox, 72), (S.cel, 40)):
        inst.note(10.0, 0.55, "B4", v)
        inst.note(10.7, 0.5, "D5", v - 4)
        inst.note(11.5, 1.6, "E5", v + 4)
    S.glock.note(12.25, 0.4, "E6", 38); S.glock.note(12.5, 0.4, "B6", 32); S.glock.note(12.8, 0.6, "F#6", 28)
    S.mbox.note(13.25, 0.6, "B4", 58)        # hesitant repeat, alone
    S.halo.chord(10.0, 4.2, [P("B4"), P("F#5")], 40)
    S.halo.level(9.9, 0); S.halo.swell(10.0, 12.0, 0, 30); S.halo.swell(12.5, 14.2, 30, 0); S.halo.level(14.3, 60)


def compose_roost(S):
    # G major, gentle, curious, playful. beat = 0.6 s (100 bpm), bar 2.4 s from 14.0
    b = 0.6
    strs, harp, clar, pizz, cel, glock, brass, bsn = S.strs, S.harp, S.clar, S.pizz, S.cel, S.glock, S.brass, S.bsn
    # soft string chords under the lesson (expression low: dialogue on top)
    strs.level(13.9, 50)
    chords = [(14.0, 2.4, ["G3", "B3", "D4"]), (16.4, 2.4, ["C3", "E4", "G4"]), (18.8, 2.4, ["G3", "B3", "D4"]),
              (21.2, 2.4, ["D3", "F#3", "A3", "C4"]), (23.6, 2.4, ["E3", "G3", "B3"])]
    for t, d, ch in chords:
        strs.chord(t, d * 1.02, [P(x) for x in ch], 58)
    strs.swell(14.0, 16.0, 48, 58); strs.swell(23.6, 26.0, 58, 44)
    # harp arpeggios on chord changes
    harp.chord(14.0, 2.2, [P(x) for x in ["G2", "D3", "G3", "B3", "D4", "G4"]], 64, roll=0.07)
    harp.chord(16.4, 2.2, [P(x) for x in ["C3", "G3", "C4", "E4", "G4"]], 58, roll=0.07)
    harp.chord(18.8, 2.2, [P(x) for x in ["G2", "D3", "G3", "B3", "D4", "G4"]], 60, roll=0.07)
    # clarinet: curious lilting line (14-20.4)
    for t, d, p in [(14.0, .45, "D5"), (14.6, .45, "B4"), (15.2, .9, "G4"), (16.4, .45, "A4"), (17.0, .45, "B4"),
                    (17.6, .45, "C5"), (18.2, 1.1, "D5"), (19.4, .4, "E5"), (19.85, .55, "D5")]:
        clar.note(t, d, p, 62)
    # pizzicato bass on beats
    for t, p in [(14.0, "G2"), (15.2, "D3"), (16.4, "C3"), (17.6, "E3"), (18.8, "G2"), (20.0, "D3"),
                 (21.2, "D3"), (22.4, "A2"), (23.6, "E2"), (24.8, "B2")]:
        pizz.note(t, 0.3, p, 64)
    # celesta offbeat sparkles
    for t, p in [(14.6, "B4"), (15.8, "D5"), (17.0, "E5"), (18.2, "G5"), (19.4, "B5")]:
        cel.note(t, 0.3, p, 40)
    # 20.5 Tobi sting (orange, brash): glock + brass sparkle
    glock.note(20.5, 0.3, "G5", 96, exact=True); glock.note(20.56, 0.3, "B5", 92); glock.note(20.62, 0.5, "D6", 100)
    brass.chord(20.5, 0.28, [P("G4"), P("B4"), P("D5")], 92, exact=True)
    S.timp.note(20.5, 0.4, "G2", 70, exact=True)
    # 22.2 Mira sting (magenta, cool): higher, lighter
    glock.note(22.2, 0.3, "C6", 90, exact=True); glock.note(22.26, 0.3, "E6", 86); glock.note(22.32, 0.5, "G6", 92)
    brass.chord(22.2, 0.24, [P("C5"), P("E5"), P("G5")], 80, exact=True)
    S.vibes.chord(22.2, 1.2, [P("E5"), P("G5"), P("C6")], 70, exact=True)
    # 24.5 "Pip." -> 26 Pip's tiny "hi": a tiny music-box ping
    S.mbox.note(26.1, 0.5, "B5", 34); S.mbox.note(26.55, 0.9, "D6", 28)
    # 27-31 comic deflation: lone bassoon
    for t, d, p, v in [(27.0, .3, "G3", 66), (27.35, .3, "F#3", 62), (27.7, .5, "F3", 60), (28.3, .9, "E3", 56),
                       (29.5, .2, "B2", 68), (29.8, .2, "D3", 64), (30.1, .5, "B2", 70), (30.7, .22, "A2", 58)]:
        bsn.note(t, d, p, v)
    pizz.note(28.4, 0.3, "E2", 52); pizz.note(29.6, 0.3, "B2", 52)
    # 31-38 quieter, suspended (Nan asks; Pip whispers "what if it answers?")
    strs.chord(31.0, 2.3, [P("E3"), P("G3"), P("B3")], 62); strs.level(30.9, 52)
    strs.chord(33.2, 2.5, [P("C3"), P("E3"), P("A3")], 60)
    strs.chord(35.6, 2.5, [P("D3"), P("G3"), P("A3")], 60)          # Dsus4: the question
    strs.swell(35.6, 37.8, 52, 58)
    S.padw.chord(31.0, 7.0, [P("E2"), P("B2")], 50); S.padw.level(30.9, 0); S.padw.swell(31.0, 33.0, 0, 40); S.padw.swell(36.0, 38.0, 40, 0); S.padw.level(38.1, 60)
    S.halo.note(35.8, 2.4, "A5", 45); S.halo.level(35.7, 0); S.halo.swell(35.8, 37.0, 0, 40); S.halo.swell(37.0, 38.2, 40, 0)
    S.cel.note(36.0, 0.5, "A5", 30); S.cel.note(36.6, 0.9, "B5", 26)
    # 38-41 tender: Nan's theme on cello over warm G major strings
    strs.chord(38.0, 3.2, [P("G3"), P("B3"), P("D4"), P("G4")], 60)
    strs.swell(38.0, 39.5, 48, 62); strs.swell(39.5, 41.0, 62, 44)
    harp.chord(38.0, 2.5, [P(x) for x in ["G2", "D3", "G3", "B3", "D4"]], 58, roll=0.08)
    for t, d, p in [(38.0, .55, "D3"), (38.6, .55, "G3"), (39.2, .85, "B3"), (40.1, .45, "A3"), (40.6, .8, "G3")]:
        S.cello.note(t, d, p, 74)
    S.cello.level(37.9, 100)
    # 41-49 Gus: light comedy, bouncy pizzicato + cheeky clarinet, bassoon comments
    walk = [(41.0, "G2"), (41.3, "D3"), (41.6, "G2"), (41.9, "B2"), (42.2, "C3"), (42.5, "E3"), (42.8, "C3"),
            (43.1, "D3"), (43.4, "G2"), (43.7, "F#2"), (44.0, "G2"), (44.3, "A2"), (44.6, "B2"), (44.9, "D3"),
            (45.2, "G2"), (46.4, "C3"), (46.7, "C#3"), (47.0, "D3"), (48.2, "G2"), (48.5, "D3"), (48.8, "G2")]
    for t, p in walk:
        pizz.note(t, 0.22, p, 66)
    for t, d, p in [(41.0, .15, "B4"), (41.3, .15, "D5"), (41.6, .15, "B4"), (42.2, .15, "C5"), (42.8, .15, "E5"),
                    (43.4, .3, "D5"), (44.0, .15, "B4"), (44.3, .15, "C5"), (44.6, .35, "D5")]:
        clar.note(t, d, p, 56)
    # "You're a worm." (45.6) - bassoon low wry comment
    bsn.note(45.75, .22, "C3", 64); bsn.note(46.0, .22, "B2", 60); bsn.note(46.25, .6, "Bb2", 62)
    # "I'm a worm with a career." (47.2) - clarinet cheeky rising tag
    for t, d, p in [(47.35, .14, "D5"), (47.55, .14, "E5"), (47.75, .14, "F#5"), (47.95, .45, "G5")]:
        clar.note(t, d, p, 64)
    S.cel.note(48.5, 0.3, "B5", 36)
    strs.chord(41.0, 4.5, [P("G3"), P("D4")], 44); strs.chord(45.6, 3.6, [P("C3"), P("G3"), P("E4")], 42)
    strs.level(41.0, 40)
    # 49.3-58 anticipation: "Tonight is first flight..." rising towards the launch, exodus hits at 58.0
    strs.chord(49.3, 2.3, [P("G3"), P("B3"), P("D4"), P("G4")], 60)
    strs.chord(51.6, 2.0, [P("C3"), P("G3"), P("E4"), P("G4")], 66)
    strs.chord(53.6, 4.4, [P("D3"), P("A3"), P("D4"), P("F#4")], 76)
    strs.swell(49.3, 53.5, 42, 62); strs.swell(53.6, 57.9, 62, 100)
    # celesta: the motif "follow the song" (B D E in G)
    S.cel.note(54.0, .3, "B4", 50); S.cel.note(54.3, .3, "D5", 52); S.cel.note(54.6, .8, "E5", 56)
    S.glock.note(54.0, .3, "B5", 36); S.glock.note(54.3, .3, "D6", 36); S.glock.note(54.6, .6, "E6", 40)
    # cello: climbing stepwise, accelerating
    t = 50.0
    for p, d in zip(["G2", "A2", "B2", "C3", "D3", "E3", "F#3", "G3", "A3", "B3", "C4", "D4", "E4", "F#4"],
                    [0.9, 0.9, 0.8, 0.75, 0.65, 0.6, 0.5, 0.45, 0.4, 0.35, 0.3, 0.28, 0.26, 0.6]):
        S.cello.note(t, d * 0.95, p, 70 + int(2.5 * (ord(p[0]) % 7)))
        t += d
    S.cello.swell(50.0, 57.9, 60, 110)
    S.trem.chord(53.5, 4.5, [P("D3"), P("A3"), P("D4")], 80)
    S.trem.level(53.4, 25); S.trem.swell(53.5, 58.0, 25, 100)
    S.horn.note(55.5, 2.5, "D4", 80); S.horn.note(55.5, 2.5, "A3", 76)
    S.horn.level(55.4, 40); S.horn.swell(55.5, 57.9, 40, 110)
    roll(S.timp, 55.5, 57.98, P("D2"), 40, 115)
    for t, v in [(55.5, 70), (56.1, 76), (56.6, 82), (57.0, 88), (57.3, 94), (57.55, 100), (57.75, 106), (57.9, 112)]:
        S.taiko.note(t, 0.3, 48, v)
    gliss(S.harp, 57.25, 57.95, scale(P("G2"), MAJ, P("G3"), P("G6")), 60, 100)
    S.pizz.note(55.5, .2, "D2", 70); S.pizz.note(56.1, .2, "D3", 70); S.pizz.note(56.6, .2, "D2", 74)
    S.pizz.note(57.0, .2, "D3", 78); S.pizz.note(57.3, .2, "D2", 80); S.pizz.note(57.55, .2, "D3", 82); S.pizz.note(57.75, .2, "D2", 84)
    S.cbass.note(55.5, 2.45, "D2", 80); S.cbass.level(55.4, 60); S.cbass.swell(55.5, 57.9, 60, 100)
    S.choir.chord(55.5, 2.45, [P("D3"), P("A3"), P("D4")], 70); S.choir.level(55.4, 0); S.choir.swell(55.5, 57.9, 0, 85)


def compose_exodus(S):
    # 58-70: soaring, rhythmic, joyous. G major, 6/8, bar = 0.75 s (16 bars). Peak ~66.
    T0, bar = 58.0, 0.75
    e = bar / 6
    # hit at 58.0
    S.ohit.note(58.0, 1.2, 67, 112, exact=True)
    S.timp.note(58.0, 0.8, "G2", 120, exact=True); S.timp.note(58.0, 0.8, "D2", 110, exact=True)
    S.taiko.note(58.0, 0.6, 48, 120, exact=True); S.taiko.note(58.0, 0.6, 36, 115, exact=True)
    S.drums.note(58.0, 1.0, 49, 115, exact=True); S.drums.note(58.0, 0.5, 36, 110, exact=True)
    S.brass.chord(58.0, 1.4, [P("G3"), P("B3"), P("D4"), P("G4")], 112, exact=True)
    S.bells.note(58.0, 3.0, "G4", 90, exact=True)
    # chords per bar (G major)
    G = [P(x) for x in ["G3", "D4", "G4", "B4", "D5"]]
    C = [P(x) for x in ["C4", "E4", "G4", "C5", "E5"]]
    D = [P(x) for x in ["D4", "F#4", "A4", "D5", "F#5"]]
    Em = [P(x) for x in ["E4", "G4", "B4", "E5", "G5"]]
    GB = [P(x) for x in ["B3", "D4", "G4", "B4", "D5"]]
    prog = [G, G, GB, C, G, D, Em, C, G, C, D, D, Em, C, G, D]
    roots = ["G2", "G2", "B2", "C3", "G2", "D3", "E3", "C3", "G2", "C3", "D3", "D3", "E3", "C3", "G2", "D3"]
    nb = 14    # ostinato runs 58-68.5, then thins
    ostinato(S.vln, T0, nb, bar, prog, 96)
    ostinato(S.pizz, T0, nb, bar, prog, 70)
    S.vln.level(57.9, 95); S.vln.swell(58.0, 66.0, 95, 115); S.vln.swell(66.0, 68.5, 115, 80)
    for k in range(nb):
        t = T0 + k * bar
        r = P(roots[k])
        S.cello.note(t, e * 2.9, r, 92); S.cello.note(t + 3 * e, e * 2.9, r + 7 if k % 2 else r, 84)
        S.cbass.note(t, e * 2.8, r - 12, 96)
        S.timp.note(t, 0.4, r - 12, 100 if k % 4 == 0 else 84)
        S.taiko.note(t, 0.3, 48, 108 if k % 4 == 0 else 86); S.taiko.note(t + 3 * e, 0.3, 36, 76)
        S.drums.note(t, 0.3, 36, 96)
        if k % 2 == 1:
            S.drums.note(t + 3 * e, 0.3, 42, 60)
        # sustained chord pad behind the ostinato
        S.strs.chord(t, bar * 1.05, [p - 12 for p in prog[k][:3]], 88)
    S.strs.level(57.9, 80); S.strs.swell(58.0, 66.0, 80, 110); S.strs.swell(66.0, 70.0, 110, 50)
    # choir swell (wordless), peaks 66
    S.choir.chord(58.0, 8.0, [P("G3"), P("D4"), P("G4"), P("B4")], 90, exact=True)
    S.choir.chord(66.0, 4.0, [P("D4"), P("G4"), P("B4"), P("D5")], 100, exact=True)
    S.choir.level(57.9, 60); S.choir.swell(58.0, 66.0, 60, 120); S.choir.swell(66.0, 70.0, 120, 30)
    # horn calls from Pip's motif in major (B D E = 3 5 6 in G)
    S.horn.level(57.9, 100)
    for t0 in (59.5, 62.5):
        S.horn.note(t0, .36, "B4", 100); S.horn.note(t0 + .375, .36, "D5", 102); S.horn.note(t0 + .75, .72, "E5", 106)
    S.brass.chord(61.0, 0.5, [P("G3"), P("B3"), P("D4")], 100); S.brass.chord(64.0, 0.6, [P("G3"), P("D4"), P("G4")], 108)
    # the soaring version: B D E -> G (peak at 66.0)
    for inst, oc, v in ((S.horn, 0, 112), (S.brass, 0, 96), (S.vln, 12, 110)):
        inst.note(64.0, .72, P("B4") + oc, v); inst.note(64.75, .72, P("D5") + oc, v + 2)
        inst.note(65.5, .48, P("E5") + oc, v + 4); inst.note(66.0, 2.2, P("G5") + oc, v + 8, exact=True)
        inst.note(68.25, 1.4, P("D5") + oc, v - 10)
    S.drums.note(66.0, 1.0, 49, 118, exact=True); S.ohit.note(66.0, 1.0, 67, 100, exact=True)
    S.timp.note(66.0, 0.8, "G2", 118, exact=True); S.taiko.note(66.0, 0.5, 48, 120, exact=True)
    S.bells.note(66.0, 3.0, "G5", 80, exact=True)
    # sparkle: glock + flute high arpeggios 62-66
    for k in range(4):
        t = 62.0 + k * bar
        for j, p in enumerate([P("G5"), P("B5"), P("D6"), P("G6"), P("D6"), P("B5")]):
            S.glock.note(t + j * e, e, p, 72 - 4 * j)
            S.flute.note(t + j * e, e * 0.9, p, 80 - 3 * j)
    gliss(S.harp, 65.4, 66.0, scale(P("G2"), MAJ, P("G3"), P("G6")), 70, 100)
    # 68.5-70: thins to unresolved D (dominant) hanging
    S.strs.chord(68.5, 1.6, [P("D3"), P("A3"), P("D4"), P("F#4")], 80)
    S.trem.chord(68.5, 1.6, [P("A4"), P("D5")], 60); S.trem.level(68.4, 70); S.trem.swell(68.5, 70.2, 70, 20)


def compose_quiet_way(S):
    # 70-80: quiet, uncertain, thinning (Pip chooses the quiet way). E minor add9, unresolved.
    S.strs.chord(70.2, 9.3, [P("E3"), P("B3"), P("F#4"), P("G4")], 60)
    S.strs.level(70.1, 60); S.strs.swell(70.2, 72.0, 60, 46); S.strs.swell(76.0, 79.5, 46, 14); S.strs.level(79.8, 60)
    S.padw.note(70.2, 9.0, "E2", 60); S.padw.level(70.1, 0); S.padw.swell(70.2, 73.0, 0, 55); S.padw.swell(76.0, 79.4, 55, 0)
    S.cbass.note(70.2, 9.0, "E1", 60); S.cbass.level(70.1, 60); S.cbass.swell(74.0, 79.4, 60, 0); S.cbass.level(79.5, 0)
    S.cel.note(72.1, .5, "B4", 44); S.cel.note(72.9, .5, "D5", 42); S.cel.note(73.9, 1.2, "E5", 40)      # hesitant motif
    S.halo.note(75.0, 4.0, "F#5", 50); S.halo.level(74.9, 0); S.halo.swell(75.0, 77.0, 0, 45); S.halo.swell(77.0, 79.5, 45, 0)
    S.mbox.note(78.3, .5, "B4", 36); S.mbox.note(79.0, .9, "D5", 32)
    # 80-98 THE QUIET WAY: drones, glassy harmonics, sparse low piano pulses. B.
    S.cbass.note(79.6, 26.3, "B1", 64); S.cbass.swell(79.6, 82.0, 0, 66); S.cbass.level(93.0, 66)
    S.padw.note(80.0, 26.0, "B1", 60); S.padw.note(80.0, 26.0, "F#2", 50)
    S.padw.level(79.9, 0); S.padw.swell(80.0, 84.0, 0, 64); S.padw.level(93.0, 64)
    for t0, t1, p, v in [(81.0, 86.5, "F#6", 62), (86.0, 92.0, "B5", 56), (91.5, 97.0, "C#6", 58), (96.5, 101.0, "D6", 62)]:
        S.halo.note(t0, t1 - t0, p, 60)
        S.halo.level(t0 - 0.05, 0); S.halo.swell(t0, (t0 + t1) / 2, 0, v); S.halo.swell((t0 + t1) / 2, t1, v, 0)
    for t, p, v in [(83.5, "B6", 52), (86.9, "F#6", 44), (91.2, "F#6", 48), (95.0, "D6", 50), (99.4, "A5", 52), (102.9, "C6", 56)]:
        S.crystal.note(t, 2.5, p, v)
    for t, p, v in [(82.0, "B1", 64), (85.7, "B1", 60), (89.9, "F#1", 62), (93.3, "B1", 66), (97.1, "B1", 62), (100.6, "G1", 68)]:
        S.piano.note(t, 2.8, p, v)
    # thunder at 88.0: orchestral hit + taiko + contrabass + low drums
    S.ohit.note(88.0, 1.5, 48, 100, exact=True)
    S.taiko.note(88.0, 1.0, 36, 118, exact=True); S.taiko.note(88.0, 1.0, 31, 110, exact=True)
    S.cbass.note(88.0, 2.5, "E1", 110, exact=True)
    S.timp.note(88.0, 1.2, "G1", 112, exact=True)
    roll(S.timp, 88.1, 89.6, P("G1"), 70, 20, 0.07, 0.11)
    S.drums.note(88.0, 1.0, 36, 120, exact=True); S.drums.note(88.0, 1.0, 41, 110, exact=True); S.drums.note(88.02, 1.0, 52, 70, exact=True)
    S.trem.chord(88.0, 1.6, [P("B2"), P("F2")], 90, exact=True); S.trem.level(87.9, 90); S.trem.swell(88.1, 89.8, 90, 0); S.trem.level(93.9, 25)
    # 94-106 water rising: tremolo crescendo, rising cello, taiko heartbeat accelerating; hard cut at 106.0
    END = 105.97
    S.trem.chord(94.0, 4.0, [P("B2"), P("F#3"), P("D4")], 80)
    S.trem.chord(98.0, 4.0, [P("B2"), P("F3"), P("D4")], 90)
    S.trem.chord(102.0, END - 102.0, [P("B2"), P("F3"), P("Ab3"), P("D4"), P("F4")], 100)
    S.trem.swell(94.0, 105.9, 25, 115)
    t = 95.0
    for p, d in zip(["B2", "C#3", "D3", "E3", "F3", "F#3", "G3", "G#3", "A3", "Bb3", "B3", "C4", "C#4", "D4", "Eb4", "E4", "F4", "F#4", "G4"],
                    [1.1, 1.0, 0.9, 0.85, 0.8, 0.7, 0.65, 0.6, 0.55, 0.5, 0.45, 0.4, 0.36, 0.33, 0.3, 0.28, 0.26, 0.24, 0.6]):
        S.cello.note(t, min(d * 0.95, END - t), p, 72)
        t += d
    S.cello.swell(95.0, 105.9, 50, 115)
    for t, v in [(100.0, 60), (101.0, 66), (101.9, 72), (102.7, 78), (103.4, 84), (104.0, 90), (104.5, 96),
                 (104.9, 102), (105.25, 108), (105.55, 114), (105.8, 120)]:
        S.taiko.note(t, 0.25, 36, v); S.taiko.note(t + 0.12, 0.2, 48, v - 20)
    roll(S.timp, 103.0, END, P("F1"), 40, 118)
    S.horn.chord(102.0, END - 102.0, [P("F2"), P("B2")], 90); S.horn.level(101.9, 30); S.horn.swell(102.0, 105.9, 30, 115)
    S.brass.chord(104.5, END - 104.5, [P("B3"), P("F4"), P("Ab4"), P("D5")], 100); S.brass.level(104.4, 40); S.brass.swell(104.5, 105.9, 40, 118)
    S.cbass.swell(100.0, 105.9, 55, 110)
    S.choir.chord(103.0, END - 103.0, [P("B3"), P("F4"), P("D5")], 90); S.choir.level(102.9, 20); S.choir.swell(103.0, 105.9, 20, 110)
    S.vln.note(104.0, END - 104.0, "B5", 100); S.vln.note(105.0, END - 105.0, "D6", 104); S.vln.level(103.9, 60); S.vln.swell(104.0, 105.9, 60, 115)
    S.drums.note(105.5, 0.45, 49, 50); S.drums.note(105.5, 0.45, 57, 50)
    # (everything is also hard-gated in numpy at 106.0; 106-141 is silent)


def compose_count_and_shout(S):
    # 141.0 / 143.2 / 145.4: "one, two, three" -> Pip's 3-note motif (B D E) on celesta + low strings
    S.cbass.note(140.9, 11.1, "B1", 50, exact=True); S.cbass.level(140.8, 0); S.cbass.swell(140.9, 142.5, 0, 40); S.cbass.swell(147.0, 151.9, 40, 110)
    for t, p, lo, v in [(141.0, "B4", ["B2", "F#3"], 52), (143.2, "D5", ["D3", "A3"], 56), (145.4, "E5", ["E3", "B3"], 60)]:
        S.cel.note(t, 2.0, p, v, exact=True)
        S.strs.chord(t, 2.15 if t < 145 else 2.6, [P(x) for x in lo], 54, exact=True)
    S.strs.level(140.9, 36); S.strs.swell(145.4, 147.0, 36, 44)
    S.halo.note(145.4, 2.5, "B4", 40); S.halo.level(145.3, 0); S.halo.swell(145.4, 146.6, 0, 30); S.halo.swell(146.6, 148.0, 30, 0)
    # 147-152 crescendo: rising strings, tremolo, snare/taiko roll, horns on A (dominant), into THE SHOUT at 152.0
    END = 151.98
    S.trem.chord(147.0, END - 147.0, [P("D3"), P("A3"), P("D4"), P("F#4")], 90)
    S.trem.level(146.9, 25); S.trem.swell(147.0, 151.9, 25, 118)
    rise = ["B3", "C#4", "D4", "E4", "F#4", "G4", "A4", "B4", "C#5", "D5", "E5", "F#5", "G5", "A5", "B5", "C#6"]
    durs = [0.5, 0.5, 0.42, 0.4, 0.36, 0.33, 0.3, 0.28, 0.25, 0.22, 0.2, 0.18, 0.16, 0.15, 0.14, 0.13]
    t = 147.0
    for p, d in zip(rise, durs):
        S.vln.note(t, d * 0.97, p, 80); t += d
    S.vln.note(t, END - t, "D6", 100); S.vln.note(t + 0.3, END - t - 0.3, "A5", 96)
    S.vln.level(146.9, 50); S.vln.swell(147.0, 151.9, 50, 118)
    S.strs.chord(148.0, END - 148.0, [P("A2"), P("E3"), P("A3"), P("C#4")], 80); S.strs.swell(148.0, 151.9, 44, 110)
    S.cello.note(148.0, END - 148.0, "A2", 80); S.cello.note(150.0, END - 150.0, "E3", 90); S.cello.level(147.9, 40); S.cello.swell(148.0, 151.9, 40, 115)
    roll(S.drums, 147.5, END, 38, 28, 120, 0.055, 0.045)
    roll(S.taiko, 148.0, END, 36, 40, 124, 0.12, 0.05)
    roll(S.timp, 148.0, END, P("A1"), 40, 124, 0.09, 0.045)
    S.horn.chord(148.0, END - 148.0, [P("A3"), P("D4"), P("E4")], 90); S.horn.level(147.9, 30); S.horn.swell(148.0, 151.9, 30, 120)
    S.choir.chord(149.0, END - 149.0, [P("A3"), P("E4"), P("A4"), P("D5")], 100); S.choir.level(148.9, 30); S.choir.swell(149.0, 151.9, 30, 122)
    S.brass.chord(150.5, END - 150.5, [P("A3"), P("C#4"), P("E4"), P("G4")], 100); S.brass.level(150.4, 40); S.brass.swell(150.5, 151.9, 40, 124)
    gliss(S.harp, 151.2, 151.95, scale(P("D2"), MAJ, P("A3"), P("A6")), 70, 110)
    S.sweep.note(149.0, END - 149.0, "A3", 80); S.sweep.level(148.9, 0); S.sweep.swell(149.0, 151.9, 0, 90)
    S.sweep.bend(149.0, -4000); S.sweep.bend(150.5, 0); S.sweep.bend(151.5, 3000); S.sweep.bend(151.95, 6000)
    # 152.0 THE SHOUT: tutti hit + blazing D major with shimmer 152-158 (cave revealed)
    H = 152.0
    S.ohit.note(H, 1.5, 62, 127, exact=True); S.ohit.note(H, 1.5, 50, 120, exact=True)
    S.timp.note(H, 1.5, "D2", 127, exact=True); S.timp.note(H, 1.5, "A2", 120, exact=True)
    roll(S.timp, H + 0.25, 155.5, P("D2"), 100, 50, 0.07, 0.12)
    S.taiko.note(H, 1.5, 48, 127, exact=True); S.taiko.note(H, 1.5, 36, 127, exact=True)
    S.drums.note(H, 2.0, 49, 127, exact=True); S.drums.note(H, 2.0, 57, 127, exact=True); S.drums.note(H, 1.0, 36, 127, exact=True)
    S.drums.note(H + 0.02, 2.0, 52, 110, exact=True)
    S.bells.chord(H, 6.0, [P("D4"), P("A4"), P("D5")], 122, exact=True)
    S.choir.chord(H, 6.0, [P("D3"), P("A3"), P("D4"), P("F#4"), P("A4"), P("D5")], 127, exact=True)
    S.choir.level(151.99, 127); S.choir.swell(152.4, 153.6, 127, 100); S.choir.swell(153.6, 158.0, 100, 86)
    S.brass.chord(H, 3.0, [P("D3"), P("A3"), P("D4"), P("F#4"), P("A4")], 127, exact=True)
    S.brass.chord(155.0, 3.0, [P("G3"), P("D4"), P("G4"), P("B4")], 104, exact=True)
    S.brass.level(151.99, 127); S.brass.swell(152.4, 153.6, 127, 98); S.brass.swell(153.6, 158.0, 98, 86)
    S.horn.chord(H, 6.0, [P("D4"), P("F#4"), P("A4")], 127, exact=True); S.horn.level(151.99, 127); S.horn.swell(152.4, 153.6, 127, 98); S.horn.swell(153.6, 158.0, 98, 86)
    S.vln.chord(H, 6.0, [P("D5"), P("F#5"), P("A5"), P("D6")], 127, exact=True); S.vln.level(151.99, 127); S.vln.swell(152.4, 153.6, 127, 100); S.vln.swell(153.6, 158.0, 100, 88)
    S.strs.chord(H, 6.0, [P("D3"), P("A3"), P("D4"), P("F#4")], 127, exact=True); S.strs.level(151.99, 127); S.strs.swell(152.4, 153.6, 127, 100); S.strs.swell(153.6, 158.0, 100, 88)
    S.trem.chord(H, 6.0, [P("D6"), P("F#6"), P("A6")], 110, exact=True); S.trem.level(151.99, 120); S.trem.swell(152.4, 153.6, 120, 80); S.trem.swell(153.6, 158.0, 80, 55)
    S.cello.chord(H, 6.0, [P("D2"), P("A2")], 127, exact=True); S.cello.level(151.99, 127); S.cello.swell(152.4, 153.6, 127, 100)
    S.cbass.chord(H, 6.0, [P("D2"), P("A1")], 127, exact=True); S.cbass.level(151.99, 127); S.cbass.swell(152.4, 153.6, 127, 100)
    S.padw.chord(H, 6.0, [P("D2"), P("A2"), P("D3")], 110, exact=True); S.padw.level(151.99, 110); S.padw.swell(152.4, 153.6, 110, 85)
    S.sweep.note(H, 6.0, "D4", 100, exact=True); S.sweep.level(151.99, 100); S.sweep.bend(H, 0); S.sweep.swell(153.0, 158.0, 100, 0)
    S.harp.chord(H, 3.0, [P(x) for x in ["D2", "A2", "D3", "F#3", "A3", "D4", "F#4", "A4", "D5", "F#5", "A5", "D6"]], 120, exact=True, roll=0.03)
    # shimmer: glock + celesta + harp arpeggios in 16ths, 152.3-158
    arp = [P(x) for x in ["D5", "F#5", "A5", "D6", "F#6", "A6", "D7", "A6", "F#6", "D6", "A5", "F#5"]]
    arpG = [P(x) for x in ["G5", "B5", "D6", "G6", "B6", "D7", "G7", "D7", "B6", "G6", "D6", "B5"]]
    t = H + 0.3
    i = 0
    while t < 157.9:
        src = arp if (t < 155.0 or t >= 157.0) else arpG
        p = src[i % len(src)]
        S.glock.note(t, 0.12, p, 100 - 38 * (t - H) / 6)
        S.cel.note(t, 0.12, p - 12, 104 - 40 * (t - H) / 6)
        if i % 2 == 0:
            S.harp.note(t, 0.2, p - 12, 100 - 40 * (t - H) / 6)
        t += 0.11; i += 1
    S.flute.note(152.4, 5.4, "A6", 100); S.flute.level(152.3, 100); S.flute.swell(152.8, 158.0, 100, 50)
    S.flute.mod(152.4, 60)
    S.drums.note(155.0, 1.5, 49, 84, exact=True); S.timp.note(155.0, 1.0, "G2", 96, exact=True)
    S.ohit.note(155.0, 1.0, 55, 84, exact=True)


def compose_flight(S):
    # 158-183: fast, heroic, driving. D major, 6/8, bar = 0.75 s. Hits at 164, 170, 176, 182.
    T0, bar = 158.0, 0.75
    e = bar / 6
    Dm = [P(x) for x in ["D4", "A4", "D5", "F#5", "A5"]]
    Bm = [P(x) for x in ["B3", "F#4", "B4", "D5", "F#5"]]
    G = [P(x) for x in ["G3", "D4", "G4", "B4", "D5"]]
    A = [P(x) for x in ["A3", "E4", "A4", "C#5", "E5"]]
    AC = [P(x) for x in ["C#4", "A4", "C#5", "E5", "A5"]]
    Fm = [P(x) for x in ["F#4", "A4", "C#5", "F#5", "A5"]]
    Em = [P(x) for x in ["E4", "B4", "E5", "G5", "B5"]]
    DF = [P(x) for x in ["F#4", "A4", "D5", "F#5", "A5"]]
    cyc1 = [Dm, Dm, Bm, Bm, G, G, A, A]
    cyc3 = [Dm, AC, Bm, Fm, G, DF, Em, A]
    prog = cyc1 + cyc1 + cyc3 + cyc1 + [Dm, Dm]
    rootn = {id(Dm): "D2", id(Bm): "B1", id(G): "G1", id(A): "A1", id(AC): "C#2", id(Fm): "F#1", id(Em): "E2", id(DF): "F#1"}
    nb = 33   # through 182.75
    ostinato(S.vln, T0, nb, bar, prog, 100)
    ostinato(S.pizz, T0, nb, bar, prog, 72)
    S.vln.level(157.99, 100); S.vln.swell(158.0, 164.0, 100, 108); S.vln.swell(170.0, 174.0, 108, 92); S.vln.swell(174.0, 183.0, 92, 118)
    for k in range(nb):
        t = T0 + k * bar
        ch = prog[k]
        r = P(rootn[id(ch)])
        S.cello.note(t, e * 0.95, r + 12, 96); S.cello.note(t + e, e * .9, r + 12, 84); S.cello.note(t + 2 * e, e * .9, r + 19, 88)
        S.cello.note(t + 3 * e, e * .95, r + 12, 94); S.cello.note(t + 4 * e, e * .9, r + 12, 84); S.cello.note(t + 5 * e, e * .9, r + 19, 88)
        S.cbass.note(t, e * 2.8, r, 100); S.cbass.note(t + 3 * e, e * 2.8, r, 90)
        S.timp.note(t, 0.35, r, 104 if k % 2 == 0 else 86)
        S.taiko.note(t, 0.3, 48, 110 if k % 2 == 0 else 90); S.taiko.note(t + 3 * e, 0.3, 36, 84)
        if k % 2 == 1:
            S.taiko.note(t + 5 * e, 0.2, 36, 70)
        S.drums.note(t, 0.3, 36, 100); S.drums.note(t + 3 * e, 0.3, 42, 70)
        S.strs.chord(t, bar * 1.05, [p - 12 for p in ch[:3]], 92)
        if k >= 16 and k % 4 == 3:
            S.drums.note(t + 4 * e, 0.2, 38, 90); S.drums.note(t + 5 * e, 0.2, 38, 100)
    S.strs.level(157.99, 90); S.strs.swell(170.0, 174.0, 90, 70); S.strs.swell(174.0, 183.0, 70, 112)
    # hits
    for t in (164.0, 170.0, 176.0, 182.0):
        S.ohit.note(t, 1.0, 62, 118, exact=True)
        S.drums.note(t, 1.0, 49, 120, exact=True); S.drums.note(t, 0.5, 36, 120, exact=True)
        S.timp.note(t, 0.8, "D2", 124, exact=True); S.taiko.note(t, 0.6, 48, 127, exact=True); S.taiko.note(t, 0.6, 36, 120, exact=True)
        S.brass.chord(t, 0.6, [P("D3"), P("A3"), P("D4"), P("F#4")], 120, exact=True)
        S.bells.note(t, 2.0, "D5", 90, exact=True)
    # horn calls from Pip's motif in major (F# A B) answered by brass; full theme 166-172 and 178-183
    S.horn.level(157.99, 100)
    for t0 in (158.75, 161.75):
        S.horn.note(t0, .36, "F#4", 104); S.horn.note(t0 + .375, .36, "A4", 106); S.horn.note(t0 + .75, .72, "B4", 110)
        S.brass.note(t0 + 1.5, .36, "F#4", 92); S.brass.note(t0 + 1.875, .36, "A4", 94); S.brass.note(t0 + 2.25, .72, "D5", 100)
    # the theme in flight rhythm (beat = dotted quarter 0.375 s)
    seqA = [(0, 2), (3, 2), (5, 4), (0, 2), (3, 2), (5, 2), (7, 4), (5, 2), (8, 2), (10, 2), (7, 2), (12, 4)]
    play_theme(S.horn, 164.0, P("F#4"), 0.375, seqA, 112)
    play_theme(S.vln, 164.0, P("F#5"), 0.375, seqA, 108)           # doubled above the ostinato
    play_theme(S.brass, 170.75, P("F#4"), 0.375, [(0, 2), (3, 2), (5, 4), (0, 2), (3, 2), (5, 2), (7, 4)], 92)
    seqB = [(5, 2), (8, 2), (10, 2), (7, 2), (12, 4), (10, 2), (8, 2), (7, 2), (5, 2), (12, 2), (15, 2), (17, 2), (20, 6)]
    play_theme(S.horn, 176.0, P("F#4"), 0.375, seqB, 116)
    play_theme(S.vln, 176.0, P("F#5"), 0.375, seqB, 112)
    play_theme(S.brass, 176.0, P("F#3"), 0.375, seqB, 100)
    S.horn.swell(178.0, 183.0, 100, 122)
    # choir sustained chord tones, swelling into hits (thinner during Gus 170-174)
    for k in range(0, nb, 2):
        t = T0 + k * bar
        ch = prog[k]
        if 170.0 <= t < 174.0:
            continue
        S.choir.chord(t, bar * 2.05, [ch[1] - 12, ch[2] - 12, ch[3] - 12], 96)
    S.choir.level(157.99, 80)
    for h in (164.0, 170.0, 176.0, 182.0):
        S.choir.swell(h - 1.5, h, 80, 115); S.choir.swell(h, h + 1.0, 115, 80)
    S.choir.swell(179.0, 183.0, 80, 120)
    # glock/flute sparkle fragments on the hits
    for h in (164.0, 176.0):
        for j, p in enumerate([P("D6"), P("F#6"), P("A6"), P("D7")]):
            S.glock.note(h + j * e, e, p, 80); S.flute.note(h + j * e, e, p - 12, 90)
    # 183-185 upward rush: rising glissandi into 185.0
    S.vln.level(183.0, 118)
    gliss(S.vln, 183.0, 184.9, scale(P("D2"), MAJ, P("D4"), P("D7")), 90, 120)
    gliss(S.harp, 183.0, 184.95, scale(P("D2"), MAJ, P("D3"), P("D7")), 80, 115)
    gliss(S.glock, 183.6, 184.95, scale(P("D2"), MAJ, P("D6"), P("D8")), 70, 100)
    gliss(S.flute, 183.3, 184.9, scale(P("D2"), MAJ, P("D5"), P("D7")), 80, 110)
    S.trem.chord(183.0, 2.0, [P("A4"), P("D5"), P("F#5")], 100); S.trem.level(182.9, 60); S.trem.swell(183.0, 184.95, 60, 120)
    S.strs.chord(183.0, 2.0, [P("A2"), P("E3"), P("A3"), P("C#4"), P("G4")], 100); S.strs.swell(183.0, 184.95, 90, 120)
    roll(S.timp, 183.0, 184.97, P("A1"), 60, 124, 0.08, 0.04)
    roll(S.taiko, 183.0, 184.97, 36, 70, 124, 0.1, 0.045)
    roll(S.drums, 183.5, 184.97, 38, 50, 120, 0.05, 0.04)
    S.drums.note(183.0, 2.0, 51, 70)  # ride swell
    S.choir.chord(183.0, 2.0, [P("A3"), P("E4"), P("A4"), P("C#5")], 110); S.choir.swell(183.0, 184.95, 90, 124)
    S.brass.chord(183.0, 2.0, [P("A3"), P("C#4"), P("E4"), P("G4")], 110); S.brass.level(182.9, 90); S.brass.swell(183.0, 184.95, 90, 124)
    S.horn.chord(183.0, 2.0, [P("A3"), P("E4")], 110)
    S.sweep.note(183.0, 2.0, "A3", 90); S.sweep.level(182.9, 0); S.sweep.swell(183.0, 184.9, 0, 90)
    S.sweep.bend(183.0, -8000)
    for i in range(1, 21):
        S.sweep.bend(183.0 + 2.0 * i / 20, int(-8000 + 16000 * i / 20))
    S.cbass.note(183.0, 2.0, "A1", 110); S.cello.note(183.0, 2.0, "A2", 110)


def compose_sky(S):
    # 185-205 THE SKY: suddenly wide and gentle. D major, 72 bpm (beat .8333), bar 3.333 s.
    beat = 60 / 72
    bar = 4 * beat
    T0 = 185.0
    S.drums.note(T0, 3.0, 49, 100, exact=True); S.drums.note(T0 + 0.01, 3.0, 51, 60, exact=True)
    S.bells.note(T0, 5.0, "D5", 92, exact=True); S.timp.note(T0, 2.0, "D2", 110, exact=True)
    S.ohit.note(T0, 1.0, 62, 80, exact=True)
    S.taiko.note(T0, 1.0, 48, 110, exact=True)
    chords = [("D", ["D3", "A3", "D4", "F#4", "A4"]), ("G", ["G2", "D3", "G3", "B3", "D4"]), ("Bm", ["B2", "F#3", "B3", "D4", "F#4"]),
              ("G", ["G2", "D3", "G3", "B3", "D4"]), ("D", ["D3", "A3", "D4", "F#4", "A4"]), ("A", ["A2", "E3", "A3", "C#4", "E4"])]
    for k, (nm, ch) in enumerate(chords):
        t = T0 + k * bar
        pcs = [P(x) for x in ch]
        S.strs.chord(t, bar * 1.03, pcs, 84, exact=(k == 0))
        S.padw.chord(t, bar * 1.05, [pcs[0] - 12, pcs[1] - 12], 70, exact=(k == 0))
        S.cbass.note(t, bar * 0.98, pcs[0] - 12, 70, exact=(k == 0))
        # harp arpeggios flowing in 8ths
        arp = pcs + [pcs[-1] + 12 - 7] if nm != "Bm" else pcs + [pcs[-1] + 5]
        up = sorted(set(arp))
        pat = up + up[-2:0:-1]
        for j in range(8):
            S.harp.note(t + j * beat / 2, beat * 0.9, pat[j % len(pat)], 70 - 3 * (j % 4))
    S.strs.level(184.99, 100); S.strs.swell(185.0, 188.0, 100, 70); S.strs.swell(192.5, 194.0, 70, 46)
    S.strs.swell(201.6, 204.95, 46, 100)
    S.padw.level(184.99, 60); S.padw.swell(192.5, 194.0, 60, 40); S.padw.swell(202.0, 204.9, 40, 70)
    S.harp.level(184.9, 100); S.harp.swell(192.5, 194.0, 100, 78); S.harp.swell(202.0, 204.9, 78, 100)
    S.cbass.level(184.99, 70); S.cbass.swell(192.5, 194.0, 70, 45); S.cbass.swell(202.0, 204.9, 45, 90)
    # choir aah: wide at 185, thin during dialogue, rises into HELLO
    S.choir.chord(T0, 7.0, [P("D3"), P("A3"), P("D4"), P("F#4"), P("A4")], 100, exact=True)
    S.choir.chord(T0 + bar, bar, [P("G3"), P("D4"), P("G4"), P("B4")], 90)
    S.choir.chord(T0 + 2 * bar, bar * 2.0, [P("F#3"), P("B3"), P("D4"), P("F#4")], 80)
    S.choir.chord(T0 + 4 * bar, bar, [P("D3"), P("A3"), P("D4"), P("F#4")], 80)
    S.choir.chord(T0 + 5 * bar, bar, [P("A3"), P("E4"), P("A4"), P("C#5")], 100)
    S.choir.level(184.99, 110); S.choir.swell(185.0, 188.5, 110, 70); S.choir.swell(192.5, 194.0, 70, 35)
    S.choir.swell(201.6, 204.95, 35, 110)
    # Pip's theme fully, tenderly, on strings (horn doubling below) 185.4-192.5, then quiet answers under dialogue
    themeA = [(0, 1), (3, 1), (5, 2), (None, 0), (0, 1), (3, 1), (5, 1), (7, 2.0), (None, 0)]
    play_theme(S.vln, T0 + 0.45, P("F#5"), beat, themeA, 96, legato=0.98)
    play_theme(S.horn, T0 + 0.45, P("F#4"), beat, themeA, 70, legato=0.98)
    S.vln.level(185.3, 85); S.vln.swell(185.4, 187.5, 85, 100); S.vln.swell(190.0, 192.5, 100, 80)
    S.horn.level(185.3, 60); S.horn.swell(185.4, 188.0, 60, 75); S.horn.swell(190.0, 192.5, 75, 50)
    # flute answers quietly between lines (193-202 lighter texture)
    play_theme(S.flute, 193.4, P("F#5"), beat * 0.9, [(5, 1), (8, 1), (10, 1), (7, 1.5)], 52)
    S.flute.level(193.3, 70)
    S.cel.note(197.4, .5, "F#5", 40); S.cel.note(197.9, .5, "A5", 38); S.cel.note(198.4, 1.0, "B5", 42)
    # Nan's theme on cello softly under "I heard you from the moon" (198.6)
    for t, d, p in [(198.8, .8, "A2"), (199.6, .8, "D3"), (200.4, 1.2, "F#3"), (201.6, .6, "E3"), (202.2, 1.4, "D3")]:
        S.cello.note(t, d, p, 60)
    S.cello.level(198.7, 70); S.cello.swell(202.0, 204.95, 70, 100)
    # build into HELLO (205.0)
    S.oboe.note(202.4, 2.5, "E5", 60); S.oboe.level(202.3, 50); S.oboe.swell(202.4, 204.9, 50, 90)
    roll(S.timp, 203.4, 204.98, P("A1"), 40, 110, 0.1, 0.05)
    S.trem.chord(202.5, 2.5, [P("A3"), P("E4"), P("A4")], 80); S.trem.level(202.4, 30); S.trem.swell(202.5, 204.95, 30, 100)
    gliss(S.harp, 204.25, 204.97, scale(P("D2"), MAJ, P("A3"), P("A6")), 70, 105)
    S.horn.chord(203.0, 2.0, [P("A3"), P("E4")], 90); S.horn.level(202.9, 50); S.horn.swell(203.0, 204.95, 50, 105)
    # 205.0 "HELLO!": big warm tutti swell as the ring rolls across the valley (205-209)
    H = 205.0
    S.ohit.note(H, 1.5, 62, 100, exact=True)
    S.drums.note(H, 2.5, 49, 115, exact=True); S.drums.note(H, 1.0, 36, 110, exact=True)
    S.timp.note(H, 1.5, "D2", 122, exact=True); roll(S.timp, H + 0.3, 206.5, P("D2"), 90, 40, 0.08, 0.12)
    S.taiko.note(H, 1.0, 48, 120, exact=True); S.taiko.note(H, 1.0, 36, 110, exact=True)
    S.bells.chord(H, 6.0, [P("D4"), P("A4"), P("D5")], 110, exact=True)
    S.brass.chord(H, 4.2, [P("D3"), P("A3"), P("D4"), P("F#4"), P("A4")], 118, exact=True)
    S.brass.level(204.99, 80); S.brass.swell(H, 206.3, 80, 124); S.brass.swell(206.8, 209.2, 124, 50)
    S.horn.chord(H, 4.2, [P("D4"), P("F#4"), P("A4"), P("D5")], 118, exact=True)
    S.horn.level(204.99, 85); S.horn.swell(H, 206.3, 85, 124); S.horn.swell(206.8, 209.2, 124, 50)
    S.choir.chord(H, 4.3, [P("D3"), P("A3"), P("D4"), P("F#4"), P("A4"), P("D5")], 122, exact=True)
    S.choir.level(204.99, 90); S.choir.swell(H, 206.3, 90, 127); S.choir.swell(206.8, 209.5, 127, 55)
    S.vln.chord(H, 4.3, [P("D5"), P("F#5"), P("A5"), P("D6")], 118, exact=True)
    S.vln.level(204.99, 90); S.vln.swell(H, 206.3, 90, 124); S.vln.swell(206.8, 209.5, 124, 55)
    S.strs.chord(H, 4.3, [P("D3"), P("A3"), P("D4"), P("F#4"), P("A4")], 118, exact=True)
    S.strs.chord(207.0, 2.2, [P("G2"), P("D3"), P("G3"), P("B3"), P("D4")], 100)
    S.strs.level(204.99, 90); S.strs.swell(H, 206.3, 90, 124); S.strs.swell(206.8, 209.5, 124, 55)
    S.trem.chord(H, 4.0, [P("D6"), P("F#6"), P("A6")], 100, exact=True); S.trem.level(204.99, 100); S.trem.swell(206.5, 209.0, 100, 30)
    S.cello.chord(H, 4.2, [P("D2"), P("A2"), P("D3")], 118, exact=True); S.cello.level(204.99, 100); S.cello.swell(206.8, 209.2, 100, 50)
    S.cbass.chord(H, 4.2, [P("D2"), P("A1")], 118, exact=True); S.cbass.level(204.99, 100); S.cbass.swell(206.8, 209.2, 100, 50)
    S.padw.chord(H, 6.0, [P("D2"), P("A2"), P("D3"), P("F#3")], 100, exact=True); S.padw.level(204.99, 90)
    S.harp.chord(H, 3.0, [P(x) for x in ["D2", "A2", "D3", "F#3", "A3", "D4", "F#4", "A4", "D5", "F#5", "A5", "D6"]], 110, exact=True, roll=0.035)
    S.flute.note(H + 0.05, 3.5, "A6", 100); S.flute.level(204.99, 100); S.flute.swell(206.5, 208.8, 100, 40)
    S.glock.chord(H, 2.0, [P("D6"), P("A6"), P("D7")], 100, exact=True, roll=0.04)
    # shimmer 205.3-208.5
    arp = [P(x) for x in ["D5", "F#5", "A5", "D6", "F#6", "A6", "D7", "A6", "F#6", "D6", "A5", "F#5"]]
    t = H + 0.35; i = 0
    while t < 208.5:
        S.glock.note(t, 0.12, arp[i % 12], 90 - 18 * (t - H))
        S.cel.note(t, 0.12, arp[i % 12] - 12, 95 - 20 * (t - H))
        t += 0.115; i += 1
    # 209-216: echoes (harp, celesta, music box answering phrases), fading, panned around
    S.strs.chord(209.3, 7.0, [P("D3"), P("A3"), P("D4"), P("F#4")], 70); S.strs.swell(209.3, 216.0, 50, 36)
    S.padw.chord(211.0, 5.5, [P("D2"), P("A2")], 60); S.padw.swell(211.0, 216.0, 60, 30)
    echoes = [(209.5, S.cel, 0, 72), (210.8, S.harp, -12, 60), (212.1, S.cel, 12, 52), (213.4, S.harp, -24, 46),
              (214.7, S.mbox, 0, 40), (216.0, S.glock, 12, 30)]
    for t, inst, oc, v in echoes:
        inst.note(t, .35, P("F#5") + oc, v); inst.note(t + .4, .35, P("A5") + oc, v - 3); inst.note(t + .8, 1.0, P("B5") + oc, v + 2)
    S.flute.note(211.2, 3.2, "A5", 50); S.flute.level(211.1, 40); S.flute.swell(211.2, 212.5, 40, 60); S.flute.swell(212.5, 214.5, 60, 0); S.flute.level(214.6, 60)
    S.halo.note(212.0, 5.0, "A5", 50); S.halo.level(211.9, 0); S.halo.swell(212.0, 214.5, 0, 35); S.halo.swell(214.5, 217.0, 35, 0)
    # 216-222: final tender cadence (Nan: "Told you. It answers."), resolve to D
    S.strs.chord(216.3, 2.1, [P("G3"), P("B3"), P("D4"), P("G4")], 70)
    S.strs.chord(218.4, 1.3, [P("A3"), P("D4"), P("E4"), P("G4")], 70)
    S.strs.chord(219.7, 1.1, [P("A3"), P("C#4"), P("E4"), P("G4")], 72)
    S.strs.chord(220.8, 3.4, [P("D3"), P("A3"), P("D4"), P("F#4")], 76)
    S.strs.level(216.2, 40); S.strs.swell(216.3, 219.7, 40, 60); S.strs.swell(220.8, 222.2, 62, 54); S.strs.swell(222.2, 224.2, 54, 38)
    for t, d, p in [(216.3, .7, "D3"), (217.0, .7, "G3"), (217.7, 1.0, "B3"), (218.7, .5, "A3"), (219.2, .5, "G3"),
                    (219.7, .55, "F#3"), (220.25, .5, "E3"), (220.8, 2.8, "D3")]:
        S.cello.note(t, d * 0.97, p, 64)
    S.cello.level(216.2, 72); S.cello.swell(220.8, 223.5, 72, 40)
    S.horn.note(220.8, 2.8, "D4", 60); S.horn.note(220.8, 2.8, "A3", 56); S.horn.level(220.7, 50); S.horn.swell(220.8, 221.8, 50, 65); S.horn.swell(221.8, 223.6, 65, 30)
    S.harp.chord(220.8, 2.5, [P(x) for x in ["D2", "A2", "D3", "F#3", "A3", "D4", "F#4"]], 66, roll=0.08)
    S.cel.note(221.0, 1.5, "D5", 46); S.cel.note(221.0, 1.5, "F#5", 40)
    S.cbass.note(220.8, 2.8, "D2", 60); S.cbass.level(220.7, 60); S.cbass.swell(221.5, 223.6, 60, 20)
    S.padw.chord(220.8, 3.0, [P("D2"), P("A2")], 60); S.padw.level(220.7, 50); S.padw.swell(221.8, 223.8, 50, 0); S.padw.level(223.9, 60)


def compose_credits(S):
    # 222-240: music-box / celesta Pip's theme (D major) with soft strings. Last note ~236, silence by 240.
    beat = 0.7
    T0 = 222.6
    seq = [(0, 1), (3, 1), (5, 2), (None, 1),
           (0, 1), (3, 1), (5, 1), (7, 2), (None, 1),
           (5, 1), (8, 1), (10, 1), (7, 1.5), (None, .5),
           (5, 1), (3, 1), (0, 2), (None, 1),
           (0, 1), (3, 1), (5, 1), (8, 3.5)]
    play_theme(S.mbox, T0, P("F#5"), beat, seq, 64, legato=0.9)
    play_theme(S.cel, T0 + 0.012, P("F#4"), beat, seq, 44, legato=0.9)
    end = T0 + sum(b for _, b in seq) * beat          # ~ 236.4
    S.mbox.level(222.5, 100); S.mbox.swell(233.0, 237.0, 100, 70)
    # soft string chords
    chords = [(T0, 3.5, ["D3", "A3", "F#4"]), (T0 + 3.5, 1.4, ["B2", "F#3", "D4"]), (T0 + 4.9, 2.1, ["G2", "D3", "B3"]),
              (T0 + 7.0, 3.5, ["G2", "D3", "G3", "B3"]), (T0 + 10.5, 1.75, ["A2", "E3", "C#4"]), (T0 + 12.25, 1.75, ["D3", "A3", "F#4"]),
              (T0 + 14.0, 1.4, ["B2", "F#3", "D4"]), (T0 + 15.4, 1.4, ["A2", "E3", "C#4"]), (T0 + 16.8, 2.6, ["D3", "A3", "D4", "F#4"]),
              (T0 + 19.4, 4.0, ["D3", "A3", "D4", "F#4"])]
    for t, d, ch in chords:
        S.strs.chord(t, d * 1.03, [P(x) for x in ch], 50)
    S.strs.level(222.5, 30); S.strs.swell(222.6, 226.0, 30, 38); S.strs.swell(234.0, 238.4, 38, 0); S.strs.level(238.5, 0)
    S.cbass.note(T0, 7.0, "D2", 44); S.cbass.note(T0 + 7.0, 3.5, "G1", 40); S.cbass.note(T0 + 10.5, 1.75, "A1", 40)
    S.cbass.note(T0 + 12.25, 4.55, "D2", 40); S.cbass.note(T0 + 16.8, 6.4, "D2", 40)
    S.cbass.level(222.5, 40); S.cbass.swell(234.0, 238.0, 40, 0); S.cbass.level(238.1, 0)
    S.harp.chord(T0 + 7.0, 2.5, [P(x) for x in ["G2", "D3", "G3", "B3", "D4"]], 44, roll=0.09)
    S.harp.chord(T0 + 16.8, 2.5, [P(x) for x in ["D2", "A2", "D3", "F#3", "A3"]], 44, roll=0.09)
    S.glock.note(end - 3.5 * beat, 2.5, "D6", 34)          # final tonic shimmer with the last note
    S.glock.note(end - 3.5 * beat + 0.35, 2.0, "A6", 22)
    S.halo.note(end - 3.5 * beat, 2.6, "D5", 40); S.halo.level(end - 3.6 * beat, 0)
    S.halo.swell(end - 3.5 * beat, end - 2.0 * beat, 0, 30); S.halo.swell(end - 2.0 * beat, end - 0.3, 30, 0)


# ----------------------------------------------------------------------------
# rendering / mixing
# ----------------------------------------------------------------------------
STEM_GAIN = {"strings": 1.00, "winds": 0.80, "brass": 0.90, "keys": 0.95, "perc": 0.95, "atmos": 0.85}
FLUID_OPTS = ["-o", "synth.reverb.active=1", "-o", "synth.reverb.room-size=0.62", "-o", "synth.reverb.damp=0.35",
              "-o", "synth.reverb.width=0.8", "-o", "synth.reverb.level=0.55", "-o", "synth.chorus.active=0",
              "-o", "synth.polyphony=1024", "-o", "synth.gain=1.0"]


def render_stem(midi_path, wav_path, gain=1.0):
    cmd = ["fluidsynth", "-ni", "-q", "-F", wav_path, "-O", "float", "-r", str(SR), "-g", str(gain)] + FLUID_OPTS + [SF2, midi_path]
    return subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def load_fixed(path):
    d, sr = sf.read(path, dtype="float32", always_2d=True)
    assert sr == SR
    n = int(DUR * SR)
    if d.shape[0] < n:
        d = np.vstack([d, np.zeros((n - d.shape[0], d.shape[1]), np.float32)])
    return d[:n, :2].astype(np.float64)


def hall_ir(rt60=2.3, length=2.8, predelay=0.024):
    n = int(length * SR)
    t = np.arange(n) / SR
    ir = np.zeros((n, 2))
    for c in range(2):
        noise = np.random.randn(n)
        # damping: brighter early, darker late (two-band blend)
        lo = signal.sosfilt(signal.butter(2, 1800 / (SR / 2), output="sos"), noise)
        hi = signal.sosfilt(signal.butter(2, 7000 / (SR / 2), output="sos"), noise)
        w = np.exp(-t * 1.6)
        n2 = hi * w + lo * (1 - w) * 1.4
        env = np.exp(-6.908 * t / rt60) * (1 - np.exp(-t * 40))
        ir[:, c] = n2 * env
    # early reflections
    er = np.zeros((n, 2))
    for (ms, g, side) in [(11, .45, 0), (17, .40, 1), (23, .32, 1), (29, .28, 0), (37, .22, 1), (43, .18, 0), (53, .15, 1)]:
        i = int(ms * SR / 1000)
        er[i, side] += g
        er[i, 1 - side] += g * 0.5
    ir = ir / np.sqrt((ir ** 2).sum(0)).max() * 0.9 + er
    pd = int(predelay * SR)
    ir = np.vstack([np.zeros((pd, 2)), ir])
    return ir / np.sqrt((ir ** 2).sum(0)).max()


def convolve_stereo(x, ir):
    out = np.zeros_like(x)
    for c in range(2):
        y = signal.fftconvolve(x[:, c], ir[:, c])[: x.shape[0]]
        out[:, c] = y
    return out


def gate_envelope():
    n = int(DUR * SR)
    env = np.ones(n)
    t = np.arange(n) / SR

    def ramp(t0, t1, v0, v1):
        i0, i1 = int(t0 * SR), int(t1 * SR)
        env[i0:i1] = np.linspace(v0, v1, i1 - i0)

    env[: int(0.95 * SR)] = 0.0
    ramp(0.95, 1.0, 0, 1)
    ramp(106.0, 106.06, 1, 0)
    env[int(106.06 * SR): int(140.7 * SR)] = 0.0
    ramp(140.7, 140.95, 0, 1)
    ramp(239.0, 239.6, 1, 0)
    env[int(239.6 * SR):] = 0.0
    return env


def dark_section():
    """numpy-synthesised: sub drone (-40 dBFS peak) 106.5-140.5 and a low thunder rumble (-24 dBFS peak) at 119.0."""
    n = int(DUR * SR)
    t = np.arange(n) / SR
    out = np.zeros((n, 2))
    sub = np.sin(2 * np.pi * 61.74 * t) * 0.85 + np.sin(2 * np.pi * 30.87 * t) * 0.35   # B1 + B0
    sub = sub / np.abs(sub).max()
    env = np.zeros(n)
    i0, i1, i2, i3 = int(106.5 * SR), int(109.0 * SR), int(139.0 * SR), int(140.6 * SR)
    env[i0:i1] = np.linspace(0, 1, i1 - i0); env[i1:i2] = 1.0; env[i2:i3] = np.linspace(1, 0, i3 - i2)
    # slow breathing on the drone
    env *= 0.8 + 0.2 * np.sin(2 * np.pi * t / 11.0)
    out[:, 0] += sub * env * 10 ** (-40 / 20)
    out[:, 1] += sub * env * 10 ** (-40 / 20)
    # thunder rumble at 119.0
    T, L = 119.0, 2.4
    k0 = int(T * SR); m = int(L * SR)
    tt = np.arange(m) / SR
    r = np.random.randn(m, 2)
    r = signal.sosfilt(signal.butter(4, 90 / (SR / 2), output="sos"), r, axis=0)
    renv = (1 - np.exp(-tt * 60)) * np.exp(-tt * 2.2)
    r = r * renv[:, None]
    r = r / np.abs(r).max() * 10 ** (-24 / 20)
    out[k0: k0 + m] += r
    return out


def limiter(x, ceiling=0.89, hold_ms=40.0, release_ms=120.0):
    """lookahead peak limiter: symmetric max-filter (hold/2 of lookahead), instant attack, one-pole release."""
    peak = np.abs(x).max(1)
    hold = int(hold_ms * SR / 1000) | 1
    env = ndimage.maximum_filter1d(peak, size=hold)
    g = np.minimum(1.0, ceiling / np.maximum(env, 1e-9))
    a = math.exp(-1.0 / (release_ms * SR / 1000))
    gs = signal.lfilter([1 - a], [1, -a], g, zi=[1.0 * a])[0]
    gs = np.minimum(gs, g)              # never less reduction than required (fast attack), slow release
    y = x * gs[:, None]
    return np.clip(y, -ceiling, ceiling), gs


def rms_db(seg):
    v = np.sqrt(np.mean(seg ** 2)) if seg.size else 0.0
    return 20 * math.log10(max(v, 1e-9))


def report(mix, path):
    lines = []
    lines.append("PIPSQUEAK score - RMS over time (2 s windows), dBFS, stereo mix")
    lines.append("t(s)    RMS dB   level")
    n = mix.shape[0]
    win = 2 * SR
    for i in range(0, n, win):
        seg = mix[i: i + win]
        db = rms_db(seg)
        bar = "#" * int(max(0, (db + 60) / 1.5))
        lines.append(f"{i / SR:6.1f}  {db:7.1f}   {bar}")
    lines.append("")
    # checks
    peak = np.abs(mix).max()
    lines.append(f"length: {n / SR:.3f} s   peak: {peak:.3f} ({20 * math.log10(peak):.2f} dBFS)")
    sil = []
    for a in np.arange(106.3, 140.3, 1.0):
        seg = mix[int(a * SR): int((a + 1) * SR)]
        sil.append((a, rms_db(seg)))
    non_thunder = [d for a, d in sil if not (118.3 <= a < 122.0)]
    thunder = [d for a, d in sil if 118.3 <= a < 122.0]
    lines.append(f"silence 106.3-141 (1 s windows, excluding thunder 118.3-122): max RMS {max(non_thunder):.1f} dBFS  "
                 f"-> {'OK' if max(non_thunder) < -40 else 'FAIL'} (< -40)")
    lines.append(f"thunder 119 windows: max RMS {max(thunder):.1f} dBFS (rumble allowed at -24 dBFS peak)")
    tail = rms_db(mix[int(106.3 * SR): int(107.0 * SR)])
    lines.append(f"hard cut: RMS 106.3-107.0 = {tail:.1f} dBFS; RMS 105.0-106.0 = {rms_db(mix[int(105 * SR): int(106 * SR)]):.1f} dBFS")
    # loudest 1 s window
    hop = int(0.25 * SR)
    best, best_t = -999, 0
    sq = mix ** 2
    cs = np.cumsum(sq.mean(1))
    for i in range(0, n - SR, hop):
        v = (cs[i + SR - 1] - (cs[i - 1] if i > 0 else 0)) / SR
        db = 10 * math.log10(max(v, 1e-18))
        if db > best:
            best, best_t = db, i / SR
    hit = rms_db(mix[int(152.0 * SR): int(153.0 * SR)])
    lines.append(f"loudest 1 s window starts at {best_t:.2f} s ({best:.1f} dBFS); RMS 152.0-153.0 = {hit:.1f} dBFS  "
                 f"-> {'OK' if 151.5 <= best_t <= 152.5 else 'CHECK'}")
    for a, b, nm in [(0, 1, "open silence"), (5.5, 6.5, "Nan call swell"), (10, 14, "title"), (58, 59, "exodus hit"),
                     (66, 67, "exodus peak"), (72, 78, "quiet way"), (88, 89, "thunder 88"), (104, 106, "water tension"),
                     (141, 141.5, "count one"), (158, 160, "flight"), (185, 186, "sky open"), (196, 198, "under dialogue"),
                     (205, 206, "HELLO"), (216, 222, "cadence"), (230, 232, "credits"), (238, 240, "end")]:
        lines.append(f"  {nm:18s} {a:6.1f}-{b:6.1f}: {rms_db(mix[int(a * SR): int(b * SR)]):7.1f} dBFS")
    txt = "\n".join(lines)
    with open(path, "w") as f:
        f.write(txt + "\n")
    return txt


def main():
    os.makedirs(WORK, exist_ok=True)
    os.makedirs(STEMS_DIR, exist_ok=True)
    os.makedirs(TMP, exist_ok=True)
    S = build_score()
    insts = list(S.insts.values())
    nn = sum(len(i.notes) for i in insts)
    print(f"score: {len(insts)} instruments, {nn} notes")

    # full score MIDI (channels shared between non-overlapping instruments)
    write_midi(insts, os.path.join(WORK, "music.mid"), unique_channels=False)

    # stems: one MIDI per group, unique channels, rendered in parallel
    stems = {}
    for i in insts:
        stems.setdefault(i.stem, []).append(i)
    procs = []
    for name, group in stems.items():
        mp = os.path.join(TMP, f"{name}.mid")
        wp = os.path.join(TMP, f"{name}.wav")
        write_midi(group, mp, unique_channels=True)
        procs.append((name, wp, render_stem(mp, wp, gain=1.0)))
    for name, wp, p in procs:
        p.wait()
        if p.returncode != 0 or not os.path.exists(wp):
            raise SystemExit(f"fluidsynth failed for stem {name}")
    print("rendered stems")

    gate = gate_envelope()
    mix = np.zeros((int(DUR * SR), 2))
    stem_audio = {}
    for name, wp, _ in procs:
        a = load_fixed(wp) * STEM_GAIN[name]
        pk = np.abs(a).max()
        print(f"  stem {name:8s} peak {pk:.3f}")
        a *= gate[:, None]
        stem_audio[name] = a
        mix += a

    # hall reverb on the bus (keys/atmos get a touch more)
    ir = hall_ir()
    wet = convolve_stereo(mix + 0.5 * (stem_audio["keys"] + stem_audio["atmos"]), ir)
    mix = mix + 0.20 * wet
    mix *= gate[:, None]                       # kills the reverb tail at the hard cut / end
    # gentle high-pass to clean sub-rumble, then section trim: keep 152 the loudest second
    mix = signal.sosfilt(signal.butter(2, 28 / (SR / 2), "high", output="sos"), mix, axis=0)

    # mastering: normalise, limit, ceiling 0.89
    pk = np.abs(mix).max()
    drive = 1.15 / pk
    mix *= drive
    mix, g = limiter(mix, ceiling=0.89)
    print(f"limiter: min gain {g.min():.3f}")
    mix += dark_section()
    mix = np.clip(mix, -0.9, 0.9)

    sf.write(os.path.join(WORK, "music.wav"), mix.astype(np.float32), SR, subtype="PCM_24")
    for name, a in stem_audio.items():
        sf.write(os.path.join(STEMS_DIR, f"{name}.wav"), (a * drive * 0.75).astype(np.float32), SR, subtype="PCM_16")
    txt = report(mix, os.path.join(WORK, "music_report.txt"))
    print(txt)
    shutil.rmtree(TMP, ignore_errors=True)


if __name__ == "__main__":
    main()
