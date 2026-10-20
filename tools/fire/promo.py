"""~60 s animated showcase of Croky Chords on the Akai Fire (no audio), played twice.

Per loop: OLED title and the progression I-V-vi-IV painted in (one bar per row, 16 sixteenths
per row), two passes of a playhead at 112 BPM, next-chord suggestions rising as bars, a blinking
pixel Croky, then a fade-out. The device is left dark with a blank OLED.

    uv run --no-project --with mido --with python-rtmidi --with pillow python tools/fire/promo.py
"""

from __future__ import annotations

import math
import os
import random
import sys
import time

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fire as F  # noqa: E402

BPM = 112
BEAT = 60 / BPM
BAR = 4 * BEAT
FPS = 30
DEGREE_HUES = {1: 0, 2: 30, 3: 52, 4: 125, 5: 190, 6: 228, 7: 280}  # apps/web music.ts
PROGRESSION = [("I", "C", 1), ("V", "G", 5), ("vi", "Am", 6), ("IV", "F", 4)]
SUGGESTIONS = [("IV", "F", 4, 65), ("I", "C", 1, 15), ("V", "G", 5, 12), ("ii", "Dm", 2, 5)]

# Pixel Croky, 32x32 brand master (one char per pixel, '.' transparent).
CROKY = """\
.....................KKKKKK.....
...................KKBBBBBBKK...
.................KKBBBKKKBBBBK..
...............KKbbBBKWWWKBBBBK.
.............KKLLbccKWPPWWKBBBBK
...........KKLLGCCccKWPPPWKbbbbK
..........KLLGGCCCccKWPPPWKSWPK.
.........KLGGGGCCCCCGKWWWKGSSSSK
........KGGGGGYCCCCGGGKKKGGSSSSK
........KGgGGgYCCCCGGGGGGGGsSSSK
.......KGGGggGYCCccCGGGGGGGKsSSK
......KGGGGGGGYCCCCCCgggggCKKsSK
......KgGGgGGYYCCCCCCCCCCCcK.KSK
.....KGGggGGYYYYCCCCCCccCcK...K.
.....KGGGGGYYYYYYCCCCCCCcK......
.....KGGGGYYYYYYYCCCCCCcK.......
..KKKgggGYYYYYYYYYCCCCcK........
....KKgGLYYYYOYYYYOOOOK.........
.....KgGLYYYOOOOOOOOOK..........
.....KgGLOOORRRRRRRRrK..........
....KKKgLOORRRRRRrrrK...........
....KrKgGLGrrrrrrKFKK...........
...KRrrKGGKKKKKKKKKFFK..........
..KRRrrKKFFK......KFFFK.........
.KRRrrK.KFFFK......KFKFK........
KRRrrK..KFKFK.......K.K.........
KRrKK....K.K....................
KKK.............................""".splitlines()

# Croc for the pads (4x16): G body, Y belly, W eye, T teeth, F feet.
PAD_CROC = [
    "........GGGG....",
    ".GGGGGGGGGGWGGG.",
    "GGYYYYYYYGGGGTGT",
    ".F..F....F..F...",
]
PAD_COLOURS = {"G": (10, 90, 8), "Y": (100, 90, 0), "W": (127, 127, 127), "T": (127, 127, 110), "F": (6, 50, 4)}


def scale(rgb: tuple[int, int, int], k: float) -> tuple[int, int, int]:
    k = max(0.0, min(1.0, k))
    return tuple(round(c * k) for c in rgb)  # type: ignore[return-value]


def mix(a: tuple[int, int, int], b: tuple[int, int, int], k: float) -> tuple[int, int, int]:
    k = max(0.0, min(1.0, k))
    return tuple(round(x + (y - x) * k) for x, y in zip(a, b))  # type: ignore[return-value]


def frame(rgbs: list[tuple[int, int, int]]) -> list[tuple[int, int, int, int]]:
    return [(i, *c) for i, c in enumerate(rgbs)]


def chord_rgb(row: int, light: float = 1.0) -> tuple[int, int, int]:
    return F.hue_rgb(DEGREE_HUES[PROGRESSION[row][2]], light)


# --- OLED frames ------------------------------------------------------------------------------


def oled_text(lines, invert=()):  # noqa: ANN001
    return F.oled_sysex(F.render_lines(lines, invert))


def oled_chord(bar: int, pass_no: int) -> list[int]:
    from PIL import Image, ImageDraw, ImageFont

    token, name, _ = PROGRESSION[bar]
    img = Image.new("1", (F.OLED_W, F.OLED_H), 0)
    d = ImageDraw.Draw(img)
    d.text((2, 0), "Croky Chords", font=ImageFont.load_default(size=11), fill=1)
    d.text((2, 14), token, font=ImageFont.load_default(size=34), fill=1)
    d.text((76, 18), name, font=ImageFont.load_default(size=22), fill=1)
    d.text((2, 52), f"bar {bar + 1}/4  {BPM} BPM  x{pass_no}", font=ImageFont.load_default(size=10), fill=1)
    for b in range(4):  # little bar indicator top right
        x = 100 + b * 7
        d.rectangle((x, 2, x + 4, 8), fill=1 if b <= bar else 0, outline=1)
    px = img.load()
    return F.oled_sysex([[bool(px[x, y]) for x in range(F.OLED_W)] for y in range(F.OLED_H)])


def oled_suggest(k: float) -> list[int]:
    from PIL import Image, ImageDraw, ImageFont

    img = Image.new("1", (F.OLED_W, F.OLED_H), 0)
    d = ImageDraw.Draw(img)
    d.text((2, 0), "Next chord after IV", font=ImageFont.load_default(size=11), fill=1)
    f = ImageFont.load_default(size=11)
    for i, (token, name, _, pct) in enumerate(SUGGESTIONS):
        y = 15 + i * 12
        d.text((2, y), token, font=f, fill=1)
        d.text((22, y), name, font=f, fill=1)
        w = round(60 * pct / 65 * k)
        d.rectangle((44, y + 2, 44 + max(1, w), y + 9), fill=1)
        d.text((108, y), f"{round(pct * k)}%", font=ImageFont.load_default(size=10), fill=1)
    px = img.load()
    return F.oled_sysex([[bool(px[x, y]) for x in range(F.OLED_W)] for y in range(F.OLED_H)])


def croky_pixels(eye_open: bool) -> list[list[bool]]:
    from PIL import Image, ImageDraw, ImageFont

    img = Image.new("1", (F.OLED_W, F.OLED_H), 0)
    for y, row in enumerate(CROKY):
        for x, ch in enumerate(row):
            # outline + light areas read best in 1 bit; a blink empties the eye
            on = ch in "KCYLc" or (ch == "W" and eye_open)
            if on:
                for dy in (0, 1):
                    for dx in (0, 1):
                        img.putpixel((x * 2 + dx, 4 + y * 2 + dy), 1)
    d = ImageDraw.Draw(img)
    d.text((70, 14), "Croky", font=ImageFont.load_default(size=17), fill=1)
    d.text((70, 34), "Chords", font=ImageFont.load_default(size=17), fill=1)
    px = img.load()
    return [[bool(px[x, y]) for x in range(F.OLED_W)] for y in range(F.OLED_H)]


# --- pad scenes -------------------------------------------------------------------------------


def paint_in(t: float) -> list[tuple[int, int, int]]:
    """Columns light up left to right, rows staggered, over one bar."""
    out = []
    for r in range(4):
        for c in range(16):
            k = (t / BAR) * 22 - c - r * 2
            out.append(mix((0, 0, 0), chord_rgb(r, 0.35), k) if k < 1.5 else chord_rgb(r, 0.35))
            if 0 <= k < 1.5:
                out[-1] = mix((127, 127, 127), chord_rgb(r, 0.35), k / 1.5)
    return out


def playback(t: float) -> list[tuple[int, int, int]]:
    """Playhead in sixteenths over 4 bars; the playing bar glows, a column sweeps all rows."""
    pos = (t / BEAT * 4) % 64  # sixteenths
    bar, col = int(pos // 16), pos % 16
    beat_phase = (t / BEAT) % 1.0
    pulse = math.exp(-beat_phase * 5)
    out = []
    for r in range(4):
        for c in range(16):
            base = chord_rgb(r, 0.95 if r == bar else 0.18)
            if r == bar and c // 4 == int(col // 4) and c % 4 == 0:  # downbeat of the current beat
                base = mix(chord_rgb(r, 1.0), (127, 127, 127), 0.35 * pulse)
            d = (col - c) % 16  # distance behind the playhead
            glow = max(0.0, 1 - d / 2.2) if d < 3 else 0.0
            head = (127, 127, 127) if r == bar else (55, 55, 55)
            out.append(mix(base, head, glow))
    return out


def suggest(t: float, dur: float) -> list[tuple[int, int, int]]:
    """Bars rising from the bottom row, 4 columns per suggestion, height ~ percentage."""
    k = 1 - (1 - min(1.0, t / 1.6)) ** 3  # ease out
    fade = min(1.0, (dur - t) / 0.4) if t > dur - 0.4 else 1.0
    out = [(0, 0, 0)] * 64
    for i, (_, _, deg, pct) in enumerate(SUGGESTIONS):
        height = 4 * pct / 65 * k
        for c in range(i * 4, i * 4 + 3):
            for level in range(4):
                fill = max(0.0, min(1.0, height - level))
                row = 3 - level
                if fill > 0:
                    out[row * 16 + c] = F.hue_rgb(DEGREE_HUES[deg], (0.15 + 0.85 * fill) * fade)
    return out


def croc(t: float) -> tuple[list[tuple[int, int, int]], bool]:
    blink = any(a <= t < a + 0.18 for a in (1.0, 1.5, 2.6))
    out = []
    for r, row in enumerate(PAD_CROC):
        for c, ch in enumerate(row):
            if ch == "W" and blink:
                ch = "G"
            out.append(PAD_COLOURS.get(ch, (0, 0, 0)))
    bob = 0.75 + 0.25 * math.sin(t * 6)
    return [scale(c, bob) for c in out], not blink


# --- runner -----------------------------------------------------------------------------------


def run(fire: F.Fire, loops: int = 2) -> None:
    title = oled_text([("Croky Chords", 18), ("I - V - vi - IV", 13), (f"{BPM} BPM", 11)])
    chord_frames = {(b, p): oled_chord(b, p) for b in range(4) for p in (1, 2)}
    sugg_frames = [oled_suggest(i / 8) for i in range(9)]
    croky_open, croky_shut = F.oled_sysex(croky_pixels(True)), F.oled_sysex(croky_pixels(False))
    rnd = random.Random(7)
    dissolve_order = [(x, y) for y in range(F.OLED_H) for x in range(F.OLED_W)]
    rnd.shuffle(dissolve_order)

    for loop in range(loops):
        fire.cc(F.CC_ALL_OFF, 0)
        fire.send(title)
        fire.cc(F.BTN_PLAY, 0)
        scenes = [("paint", BAR), ("play", 8 * BAR), ("suggest", 4.6), ("croc", 3.6), ("fade", 1.6)]
        last_oled = None
        last_pads = None
        for name, dur in scenes:
            start = time.monotonic()
            n = 0
            if name == "play":
                fire.cc(F.BTN_PLAY, 3)
            if name == "suggest":
                fire.cc(F.BTN_PLAY, 0)
                fire.cc(F.BTN_BROWSER, 2)
            if name == "fade":
                pixels = croky_pixels(True)
                snapshot = last_pads or [(0, 0, 0)] * 64
            while True:
                t = time.monotonic() - start
                if t >= dur:
                    break
                oled = None
                if name == "paint":
                    pads = paint_in(t)
                elif name == "play":
                    pads = playback(t)
                    sixteenth = int(t / BEAT * 4)
                    bar, pass_no = (sixteenth // 16) % 4, sixteenth // 64 + 1
                    oled = chord_frames[(bar, pass_no)]
                    fire.cc(F.LED_ROW[bar], 4)
                    for r in range(4):
                        if r != bar:
                            fire.cc(F.LED_ROW[r], 0)
                    fire.cc(F.BTN_PLAY, 3 if (t / BEAT) % 1 < 0.5 else 1)
                elif name == "suggest":
                    pads = suggest(t, dur)
                    oled = sugg_frames[min(8, int(t / 1.6 * 8))]
                elif name == "croc":
                    pads, eye = croc(t)
                    oled = croky_open if eye else croky_shut
                else:  # fade
                    k = 1 - t / dur
                    pads = [scale(c, k * k) for c in snapshot]
                    if n % 3 == 0:
                        cut = int(len(dissolve_order) * min(1.0, t / (dur * 0.9)))
                        for x, y in dissolve_order[:cut]:
                            pixels[y][x] = False
                        oled = F.oled_sysex(pixels)
                if pads != last_pads:
                    fire.pads(frame(pads))
                    last_pads = pads
                if oled is not None and oled is not last_oled:
                    fire.send(oled)
                    last_oled = oled
                n += 1
                time.sleep(max(0.0, start + n / FPS - time.monotonic()))
            for cc in F.LED_ROW:
                fire.cc(cc, 0)
            fire.cc(F.BTN_BROWSER, 0)
        print(f"loop {loop + 1} done", flush=True)
        fire.pads(frame([(0, 0, 0)] * 64))
        fire.oled(F.blank())
        time.sleep(0.4)


def main() -> None:
    fire = F.Fire()
    t0 = time.monotonic()
    try:
        run(fire)
    except KeyboardInterrupt:
        pass
    finally:
        fire.close()  # pads off, LEDs off, blank OLED
        print(f"promo finished in {time.monotonic() - t0:.1f} s", flush=True)


if __name__ == "__main__":
    main()
