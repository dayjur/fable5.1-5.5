# PIPSQUEAK — production bible

A ~4 minute 2D animated short. Everything (frames, voices, music, sound effects) is generated
from code in this folder, driven by one shared timeline (`script.json` + `out/events.json`).

## Logline

In a cave where you can only see what sound touches, a bat pup who is too shy to shout must
find her voice when her living nightlight goes out.

## The rule of the world (the technical/creative hook)

The cave is pitch black. The picture is painted by **sound**: every call, drip, splash or
thunderclap emits an expanding ring that *reveals* the geometry it passes over (edges light up
like phosphor, then decay). Different sounds have different colours and ring widths:

| source                | colour            | character of ring |
|-----------------------|-------------------|-------------------|
| water drip            | cold green  #6ff2b0 | thin, fast, small radius |
| Nan (grandmother)     | warm amber  #ffb347 | wide, slow, enormous radius |
| Tobi (brash pup)      | orange      #ff7a3d | wide, loud |
| Mira (pup)            | magenta     #ff5fb0 | medium |
| Pip (whisper)         | pale blue   #a9d6ff | tiny, thin, dies fast |
| Pip (THE SHOUT)       | blue-white  #dff4ff | the biggest ring in the film |
| thunder               | white       #ffffff | instant full-frame flash, decays in ~0.4s |
| Gus (glow-worm)       | green       #8dff6a | not a ring: a steady soft radial light |
| fungal glow (roost)   | teal        #3ddcb0 | steady ambient patches |

Rings are clipped by **sound shadows** (2D visibility polygons from the ring origin), so sound
does not go through rock. Outside the cave (final scene) the world is lit by the moon and the
style opens up into real painted light; Pip's last shout rolls a ring across a whole valley.

## Characters

- **PIP** — bat pup, ~10 in bat years. Tiny, lavender-grey fur, cream belly, enormous round
  ears (inner ear pink), huge eyes (iris pale blue), two tiny fangs. Whispers, apologises,
  counts when scared. Her eyes are always visible in the dark (two catchlights).
- **NAN** — grandmother. Big, brown-grey, white eyebrow tufts, one notched ear, tattered wing
  edge. Hangs upside-down in front of the class, perfectly comfortable. Dry, warm, enormous
  voice. "The dark doesn't bite. It just needs introducing."
- **GUS** — a glow-worm who lives in Pip's chest fur. Green, segmented, little face, big
  mouth, massive confidence, zero courage. Goes out when wet *or* scared. Comic relief and,
  in the dark, the one who asks the right question.
- **TOBI** (orange, brash) and **MIRA** (magenta, cool) — pups in Pip's class. Tobi's joke
  "She said hi to a rock" is the film's first laugh.
- The colony: hundreds of bats as flocking silhouettes.

## Story (beats, seconds)

| t (s)     | scene            | beat |
|-----------|------------------|------|
| 0–14      | COLD OPEN        | Black. Drip rings. Nan's "PIP!" reveals the whole roost in amber. Title. |
| 14–58     | THE ROOST        | Nan's lesson. Tobi and Mira light the chamber. Pip's "hi" lights a pebble. Gus introduced. "Tonight is first flight." |
| 58–80     | EXODUS           | The colony pours out: river of bats, rings everywhere. Pip at a fork chooses "the quiet way". |
| 80–112    | THE QUIET WAY    | Narrow crack lit only by Gus. Thunder flashes reveal something huge ahead. Water. Gus gets wet, goes out. |
| 112–152   | THE DARK         | Only Pip's eyes. Heartbeat. Thunder flash shows the cathedral, the flood, a way up. Gus: "what if it answers?" Pip counts. |
| 152–185   | THE SHOUT        | Pip SHOUTS. A blue-white ring reveals the entire cathedral; camera pulls back with it. Flight: strobing calls, water chasing, Gus relights. Burst through the crack. |
| 185–222   | THE SKY          | Real moonlight. The colony wheeling. Nan: "I heard you from the moon." Pip's "HELLO!" rings across the valley; the valley answers. |
| 222–240   | CREDITS          | Rings on black. |

## Art direction

- 1920×1080, 24 fps, 2.0:1 picture inside letterbox bars (active 1920×960).
- Cave: rock as dark slate polygons with noise texture, edges drawn bright (cool white-blue)
  so rings "etch" them. Stalactites/stalagmites, fungus patches, pebbles, puddles.
- Characters: flat shapes, dark soft outlines, big glossy eyes, squash & stretch. Nothing
  photoreal. Think *Secret of Kells* line economy meets a sonar screen.
- Light: additive bloom on rings, phosphor decay, film grain, vignette, slight chromatic
  aberration on the shout.
- Camera: slow pushes in the roost; one long tracking shot in the exodus; handheld-ish shake
  in the flood; a huge pull-back on the shout; weightless glide in the sky.
- Sky: WebGL fragment shader for moonlit clouds, stars, parallax mountains and sea.

## Sound

- Voices: Kokoro TTS (`work/kokoro-v1.0.onnx`), per-character voice + pitch/formant shift, with
  room reverb matched to the scene (roost = big, crack = tight, cathedral = huge, sky = dry+
  far echoes). Lip sync from phoneme timing (espeak-ng) stretched to the Kokoro audio +
  amplitude envelope → viseme track per line.
- SFX: synthesized in numpy from `out/events.json` (pings, drips, splashes, thunder, wing
  flutter, water rush, heartbeat, breath, rock rumble).
- Music: composed as MIDI in Python, rendered with FluidSynth (FluidR3_GM). Motifs: Pip
  (music box / celesta, a hesitant 3-note figure), Nan (cello), the cave (low drones, glass),
  flight (driving strings + perc), finale (full theme, choir).
- Mix: dialogue ducking, stereo placement by screen position, master limiter.

## Pipeline

```
audio/voices.py   script.json → work/voices/*.wav + work/voices/lines.json (durations, visemes)
render/dry.mjs    scenes → out/events.json (every ping/sfx cue with time + screen position)
audio/sfx.py      events.json → work/sfx.wav
audio/music.py    → work/music.wav
render/render.mjs frames → out/seg_*.mp4 (4 parallel Chromium workers, piped into ffmpeg)
audio/mix.py      voices + sfx + music → out/mix.wav
build.sh          concat + mux → out/pipsqueak.mp4
```
