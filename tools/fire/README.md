# tools/fire: Akai Fire prototypes

Stand-alone Python prototypes for the Akai Fire controller integration
(spec: `docs/specs/akai-fire-v1.md`). Nothing here is part of the app; the web implementation
ports `fire.py`'s encoders to TypeScript.

| File | What |
|---|---|
| `fire.py` | Protocol helper: pad colour SysEx, OLED bitmap SysEx, button/encoder numbers, a port wrapper that opens only the Fire and clears it on close |
| `demo.py` | Interactive prototype of the recommended v1 mapping (timeline rows 1–3, palette row 4, SELECT encoder suggestions, transport) |
| `oled_font.py` | Rasterises the Pixel theme's font (Departure Mono, 7 x 11 cell) into `apps/web/src/midi/fire/font.ts` for the OLED |
| `promo.py` | ~60 s animation (no input, no audio) for filming: title, I–V–vi–IV, playhead at 112 BPM, suggestion bars, blinking Croky, fade-out |

## Run

Needs `uv` (pinned in `mise.toml`) and the Fire plugged in. Dependencies are pulled per run; nothing is
installed globally.

```bash
eval "$(mise env -s bash)"
RUN="uv run --no-project --with mido --with python-rtmidi --with pillow python -I"
$RUN tools/fire/demo.py --monitor --seconds 30   # print every pad/button/encoder event
$RUN tools/fire/demo.py                          # interactive demo, Ctrl+C to quit
$RUN tools/fire/promo.py                         # the animation
$RUN tools/fire/fire.py --oled-fps 10 20 30 60   # OLED frame-rate measurement (Linux, 10 s per rate)
$RUN tools/fire/fire.py --band-check             # partial OLED update experiment (stays dark on firmware 0.22)
$RUN tools/fire/oled_font.py                     # regenerate the OLED font (needs --with fonttools --with brotli)
```

The frame-rate measurement sends full OLED frames (pads and LEDs stay dark, no sound) at each rate
and then as fast as the device drains them, reads the kernel's `Tx bytes` counter of the Fire's
port in `/proc/asound/cardN/midi0`, and prints the frames sent, the largest backlog, how long the
backlog took to drain and how many frames were dropped. The OLED is blanked afterwards.

The scripts use the ALSA sequencer (Linux) or CoreMIDI, so other MIDI software can stay connected;
they open only ports whose name contains `FIRE` and on exit turn every LED off and blank the OLED.
Nothing is written to the device permanently. On Windows close any other program that holds the Fire
first (ports are exclusive there).

## demo.py controls

| Control | Effect |
|---|---|
| Tap chord pad (rows 1–3) | select (tap again: deselect) |
| Tap palette pad (row 4) | pads 1–7 insert I…vii°, pads 9–16 insert a suggestion after the selection |
| SHIFT + palette pad | replace the selected chord |
| Hold a chord + tap a later pad | the chord ends there |
| ALT + tap chord | remove |
| Tap the dim pad after the end | append the top suggestion |
| SELECT turn / press | move suggestion cursor / insert it (SHIFT + turn: move selection) |
| VOLUME | selected chord length ±1 beat |
| RESONANCE | tempo |
| PLAY / STOP | run / stop the playhead (silent) |
| GRID ◀ ▶ | previous / next chord |
| PATTERN UP / DOWN | scroll the timeline by 4 bars |
| PATTERN | undo |

The suggestion percentages in the demo are a small stand-in table, not the real n-gram data.
