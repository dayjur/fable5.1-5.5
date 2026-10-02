# PIPSQUEAK

A four-minute 2D animated short, generated entirely from code in this folder: every frame, every
voice, every sound effect and every note of the score.

**Watch:** `out/pipsqueak.mp4` (1920×1080, 24 fps, stereo AAC).

> In a cave where you can only see what sound touches, a bat pup who is too shy to shout must
> find her voice when her living nightlight goes out.

## What is unusual about it

- **The picture is painted by sound.** The cave is pitch black. Every call, drip, splash and
  thunderclap emits an expanding ring that reveals the geometry it sweeps over, with a phosphor
  memory that decays. Rings are clipped by true 2D visibility polygons from their origin, so sound
  casts shadows behind columns and ledges.
- **One timeline drives picture and audio.** The scene direction (`render/scenes.js`) emits every
  ring and sound cue; a dry run exports them to `out/events.json`, which the sound-effects
  synthesizer renders. What you hear is exactly what lit the frame.
- **Real lip sync.** Dialogue is synthesized with Kokoro TTS, then phoneme timings from espeak-ng
  are aligned to the audio envelope to produce a per-frame viseme track for every line.
- **A fully composed score**, written as a note model in Python, rendered through FluidSynth,
  with hard sync points (the hit at 152.0 s, the silence from 106 s to 141 s).
- **A WebGL finale.** The night sky, clouds, moon and valley are a fragment shader, and Pip's
  last shout rolls a reveal ring across the whole landscape inside that shader.
- Deterministic, stateless rendering: any frame can be rendered in isolation, so four Chromium
  workers render in parallel and pipe PNGs straight into ffmpeg.

## Layout

```
script.json          dialogue, characters, scene timings (the screenplay as data)
DESIGN.md            production bible: story beats, art direction, sound plan
render/              the film engine (plain browser JS, driven by Playwright)
  world.js           procedural caves, visibility polygons, rock rendering
  engine.js          sound-reveal compositor, camera, post-processing, tweens
  characters.js      Pip, Nan, Gus, Tobi, Mira: rigs with expressions and visemes
  sky.js             WebGL night sky / valley shader
  scenes.js          direction: blocking, camera, lights, acting, event export
  render.mjs         frame renderer (segments, contact sheets, single frames)
audio/
  voices.py          Kokoro TTS + DSP + lip-sync visemes → work/voices/
  music.py           the score → work/music.wav
  sfx.py             procedural sound effects from events.json → work/sfx.wav
  mix.py             dialogue/sfx/music mix with ducking and limiting → out/mix.wav
build.sh             runs the whole pipeline
```

## Building

```
./build.sh
```

Model files (`work/kokoro-v1.0.onnx`, `work/voices-v1.0.bin`) come from the
[kokoro-onnx releases](https://github.com/thewh1teagle/kokoro-onnx/releases); FluidSynth needs
`/usr/share/sounds/sf2/FluidR3_GM.sf2` (`apt install fluid-soundfont-gm`).

Useful during development:

```
cd render
node render.mjs --frames 500,2860          # single PNG frames into out/frames/
node render.mjs --sheet --every 48         # contact sheet of the whole film
node render.mjs --events                   # export the audio event list
```
