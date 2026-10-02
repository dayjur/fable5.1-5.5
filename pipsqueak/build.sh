#!/usr/bin/env bash
# Builds PIPSQUEAK from scratch: voices → events → sfx → music → frames → mix → mp4.
# Requirements: python3 (numpy scipy soundfile kokoro-onnx mido), node + playwright (chromium),
# ffmpeg, fluidsynth + FluidR3_GM.sf2, espeak-ng + mbrola voices, sox.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p out work

echo "== voices (Kokoro TTS + lip sync)";   python3 audio/voices.py
echo "== score (MIDI → FluidSynth)";        python3 audio/music.py
echo "== events (dry run of the film)";    (cd render && node render.mjs --events)
echo "== sound effects";                   python3 audio/sfx.py out/events.json work/sfx.wav
echo "== mix";                             python3 audio/mix.py
echo "== frames (4 Chromium workers)";     (cd render && node render.mjs --workers "${WORKERS:-4}" --crf "${CRF:-16}")
echo "== concat + mux"
ffmpeg -y -loglevel error -f concat -safe 0 -i out/segs.txt -c copy out/video.mp4
ffmpeg -y -loglevel error -i out/video.mp4 -i out/mix.wav -c:v copy -c:a aac -b:a 224k -movflags +faststart -shortest out/pipsqueak.mp4
echo "done: out/pipsqueak.mp4"
