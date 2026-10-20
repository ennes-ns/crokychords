"""Akai Fire protocol helper: message encoders (pure, stdlib) plus a small port wrapper (mido).

The encoders build raw MIDI byte lists so they can be ported 1:1 to TypeScript (Web MIDI) or
Rust. Protocol notes and sources are in docs/specs/akai-fire-v1.md.
"""

from __future__ import annotations

import colorsys
from collections.abc import Iterable, Sequence

# --- Identity --------------------------------------------------------------------------------

SYSEX_HEADER = [0xF0, 0x47, 0x7F, 0x43]  # Akai, all-call, Fire
CMD_PADS = 0x65  # write pad colours
CMD_OLED = 0x0E  # write OLED bitmap
PORT_MATCH = "FIRE"  # substring of the ALSA/Web MIDI port name ("FL STUDIO FIRE ...")

# --- Inputs (channel 1). Buttons and encoder touches: note on 0x7F / note off. ----------------

PAD_NOTE_FIRST = 0x36  # top-left pad; note = 0x36 + row * 16 + col
ROWS, COLS = 4, 16

ENC_VOLUME, ENC_PAN, ENC_FILTER, ENC_RESONANCE = 0x10, 0x11, 0x12, 0x13  # touch note + turn CC
ENC_SELECT_TURN = 0x76  # CC, relative
BTN_SELECT_PRESS = 0x19

BTN_BANK = 0x1A  # "knob mode" button left of the encoders
BTN_PAT_UP, BTN_PAT_DOWN = 0x1F, 0x20
BTN_BROWSER = 0x21
BTN_GRID_LEFT, BTN_GRID_RIGHT = 0x22, 0x23
BTN_SOLO = (0x24, 0x25, 0x26, 0x27)  # row buttons left of the pads
BTN_STEP, BTN_NOTE, BTN_DRUM, BTN_PERFORM = 0x2C, 0x2D, 0x2E, 0x2F
BTN_SHIFT, BTN_ALT = 0x30, 0x31
BTN_PATTERN = 0x32
BTN_PLAY, BTN_STOP, BTN_REC = 0x33, 0x34, 0x35

BUTTON_NAMES = {
    ENC_VOLUME: "touch VOLUME",
    ENC_PAN: "touch PAN",
    ENC_FILTER: "touch FILTER",
    ENC_RESONANCE: "touch RESONANCE",
    BTN_SELECT_PRESS: "SELECT press",
    BTN_BANK: "BANK",
    BTN_PAT_UP: "PATTERN UP",
    BTN_PAT_DOWN: "PATTERN DOWN",
    BTN_BROWSER: "BROWSER",
    BTN_GRID_LEFT: "GRID LEFT",
    BTN_GRID_RIGHT: "GRID RIGHT",
    **{n: f"SOLO {i + 1}" for i, n in enumerate(BTN_SOLO)},
    BTN_STEP: "STEP",
    BTN_NOTE: "NOTE",
    BTN_DRUM: "DRUM",
    BTN_PERFORM: "PERFORM",
    BTN_SHIFT: "SHIFT",
    BTN_ALT: "ALT",
    BTN_PATTERN: "PATTERN",
    BTN_PLAY: "PLAY",
    BTN_STOP: "STOP",
    BTN_REC: "REC",
}
ENCODER_NAMES = {
    ENC_VOLUME: "VOLUME",
    ENC_PAN: "PAN",
    ENC_FILTER: "FILTER",
    ENC_RESONANCE: "RESONANCE",
    ENC_SELECT_TURN: "SELECT",
}

# --- Outputs: button LEDs are CC (channel 1) on the same number as the button note. -----------

LED_ROW = (0x28, 0x29, 0x2A, 0x2B)  # rectangular LEDs between SOLO buttons and pads
CC_BANK_LEDS = 0x1B  # 0x10 | bitmask (1 channel, 2 mixer, 4 user1, 8 user2)
CC_ALL_OFF = 0x7F  # B0 7F 00: every LED off (pads and buttons)


def pad_note(row: int, col: int) -> int:
    return PAD_NOTE_FIRST + row * COLS + col


def pad_from_note(note: int) -> tuple[int, int] | None:
    i = note - PAD_NOTE_FIRST
    return divmod(i, COLS) if 0 <= i < ROWS * COLS else None


def relative(value: int) -> int:
    """Decode a relative encoder CC value (7-bit two's complement): 1..63 cw, 127..64 ccw."""
    return value - 128 if value >= 64 else value


def _len14(n: int) -> list[int]:
    return [(n >> 7) & 0x7F, n & 0x7F]


def pads_sysex(pads: Iterable[tuple[int, int, int, int]]) -> list[int]:
    """SysEx that sets pads: (index 0..63 = row*16+col, r, g, b) with 7-bit colour channels."""
    body: list[int] = []
    for index, r, g, b in pads:
        body += [index & 0x3F, r & 0x7F, g & 0x7F, b & 0x7F]
    return [*SYSEX_HEADER, CMD_PADS, *_len14(len(body)), *body, 0xF7]


def hue_rgb(hue: float, light: float = 1.0, sat: float = 1.0) -> tuple[int, int, int]:
    """Hue in degrees to 7-bit pad RGB; `light` 0..1 scales brightness."""
    r, g, b = colorsys.hsv_to_rgb((hue % 360) / 360, sat, 1.0)
    return tuple(round(c * 127 * light) for c in (r, g, b))  # type: ignore[return-value]


# OLED: 128x64, 8 bands of 8 rows, pixels packed 7 per byte through this bit mapping.
OLED_W, OLED_H = 128, 64
_BIT_MUTATE = (
    (13, 19, 25, 31, 37, 43, 49),
    (0, 20, 26, 32, 38, 44, 50),
    (1, 7, 27, 33, 39, 45, 51),
    (2, 8, 14, 34, 40, 46, 52),
    (3, 9, 15, 21, 41, 47, 53),
    (4, 10, 16, 22, 28, 48, 54),
    (5, 11, 17, 23, 29, 35, 55),
    (6, 12, 18, 24, 30, 36, 42),
)
_OLED_BYTES = 1171  # ceil(128 * 64 / 7)


def oled_sysex(pixels: Sequence[Sequence[bool]]) -> list[int]:
    """SysEx that writes a full 128x64 frame; `pixels[y][x]` truthy = lit."""
    data = [0] * _OLED_BYTES
    for y in range(OLED_H):
        row = pixels[y]
        for x in range(OLED_W):
            if not row[x]:
                continue
            col = x + OLED_W * (y // 8)
            bit = _BIT_MUTATE[y % 8][col % 7]
            data[col // 7 * 8 + bit // 7] |= 1 << (bit % 7)
    payload = [0x00, 0x07, 0x00, 0x7F, *data]  # bands 0..7, columns 0..127
    return [*SYSEX_HEADER, CMD_OLED, *_len14(len(payload)), *payload, 0xF7]


def blank() -> list[list[bool]]:
    return [[False] * OLED_W for _ in range(OLED_H)]


def oled_bands_sysex(pixels: Sequence[Sequence[bool]], first: int, last: int) -> list[int]:
    """EXPERIMENT, does not work on firmware 0.22: SysEx for bands `first..last` only.

    Guessed packing: restarts at the first band, column index = x + 128 * (band - first). On the
    device (bcdDevice 0.22, 2026-10-20) these messages leave the screen dark, so the web app sends
    full frames only. Kept for `--band-check` and further experiments.
    """
    width = OLED_W
    count = (last - first + 1) * width * 8
    data = [0] * -(-count // 7)
    for band in range(first, last + 1):
        for y in range(band * 8, band * 8 + 8):
            row = pixels[y]
            for x in range(width):
                if not row[x]:
                    continue
                col = x + width * (band - first)
                bit = _BIT_MUTATE[y % 8][col % 7]
                data[col // 7 * 8 + bit // 7] |= 1 << (bit % 7)
    payload = [first, last, 0x00, 0x7F, *data]
    return [*SYSEX_HEADER, CMD_OLED, *_len14(len(payload)), *payload, 0xF7]


# --- Text on the OLED (Pillow, optional) ------------------------------------------------------


def render_lines(lines: Sequence[tuple[str, int] | str], invert_rows: Iterable[int] = ()) -> list[list[bool]]:
    """Render text lines (text or (text, size)) top to bottom; rows in `invert_rows` are inverted."""
    from PIL import Image, ImageDraw, ImageFont

    img = Image.new("1", (OLED_W, OLED_H), 0)
    draw = ImageDraw.Draw(img)
    y = 0
    inverted = set(invert_rows)
    for i, line in enumerate(lines):
        text, size = (line, 10) if isinstance(line, str) else line
        try:
            font = ImageFont.load_default(size=size)
        except TypeError:  # Pillow < 10.1
            font = ImageFont.load_default()
        box = draw.textbbox((0, 0), text, font=font)
        h = max(size, box[3]) + 1
        if i in inverted:
            draw.rectangle((0, y, OLED_W - 1, y + h - 1), fill=1)
            draw.text((2, y), text, font=font, fill=0)
        else:
            draw.text((2, y), text, font=font, fill=1)
        y += h
    px = img.load()
    return [[bool(px[x, yy]) for x in range(OLED_W)] for yy in range(OLED_H)]


# --- Port wrapper (mido + python-rtmidi, ALSA sequencer: the port stays shareable) ------------


class Fire:
    """Opens only the Fire's ports; `close()` clears pads, buttons and OLED and releases them."""

    def __init__(self, match: str = PORT_MATCH) -> None:
        import mido

        self._mido = mido
        ins = [n for n in mido.get_input_names() if match in n]
        outs = [n for n in mido.get_output_names() if match in n]
        if not ins or not outs:
            raise SystemExit(f"No MIDI port containing {match!r} found (is the Fire plugged in?)")
        self.inp = mido.open_input(ins[0])
        self.out = mido.open_output(outs[0])

    def send(self, data: list[int]) -> None:
        if data[0] == 0xF0:
            self.out.send(self._mido.Message("sysex", data=data[1:-1]))
        else:
            self.out.send(self._mido.Message.from_bytes(data))

    def cc(self, number: int, value: int) -> None:
        self.send([0xB0, number, value])

    def pads(self, pads: Iterable[tuple[int, int, int, int]]) -> None:
        self.send(pads_sysex(pads))

    def oled(self, pixels: Sequence[Sequence[bool]]) -> None:
        self.send(oled_sysex(pixels))

    def clear(self, message: Sequence[str] | None = None) -> None:
        self.pads((i, 0, 0, 0) for i in range(ROWS * COLS))
        self.cc(CC_ALL_OFF, 0)
        self.oled(render_lines(list(message)) if message else blank())

    def close(self, message: Sequence[str] | None = None) -> None:
        try:
            self.clear(message)
        finally:
            self.inp.close()
            self.out.close()

    def __enter__(self) -> Fire:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


# --- OLED frame-rate measurement --------------------------------------------------------------
#
#     uv run --no-project --with mido --with python-rtmidi python -I tools/fire/fire.py --oled-fps
#
# Sends full OLED frames (moving stripes; pads and buttons stay dark, no sound) at each rate for at
# most 10 s and reads the kernel's "Tx bytes" counter of the Fire's rawmidi port
# (/proc/asound/cardN/midi0, Linux) to see how far the device lags behind. Bytes sent but never
# transmitted were dropped: the ALSA sequencer drops a SysEx that does not fit in the port's
# 4 KiB output buffer ("MIDI output buffer overrun").


def _tx_counter() -> str | None:
    """Path of the /proc file whose Output 0 counts bytes the Fire's port has transmitted."""
    import glob

    for path in sorted(glob.glob("/proc/asound/card*/midi0")):
        with open(path) as f:
            if PORT_MATCH in f.readline().upper():
                return path
    return None


def _tx_bytes(path: str) -> int:
    with open(path) as f:
        for line in f:
            if line.strip().startswith("Tx bytes"):
                return int(line.split(":")[1])
    return 0


def _stripes(n: int) -> list[list[bool]]:
    return [[(x + y + n * 3) % 16 < 4 for x in range(OLED_W)] for y in range(OLED_H)]


def bench_oled(fire: Fire, fps: float | None, seconds: float, path: str) -> dict[str, float]:
    """Send full frames at `fps` (None: as fast as the device drains them, one frame in flight)."""
    import time

    frames = [oled_sysex(_stripes(n)) for n in range(16)]
    size = len(frames[0])
    tx0 = _tx_bytes(path)
    sent = 0
    max_backlog = 0
    n = 0
    start = time.monotonic()
    while True:
        now = time.monotonic()
        if now - start >= seconds:
            break
        backlog = sent - (_tx_bytes(path) - tx0)
        max_backlog = max(max_backlog, backlog)
        if fps is None:
            if backlog > 0:
                time.sleep(0.0005)
                continue
        else:
            due = start + n / fps
            if now < due:
                time.sleep(min(0.002, due - now))
                continue
        fire.send(frames[n % len(frames)])
        sent += size
        n += 1
    elapsed = time.monotonic() - start
    # Let the device catch up (at most 3 s), then compare what went out with what was sent.
    drain_start = time.monotonic()
    while sent - (_tx_bytes(path) - tx0) > 0 and time.monotonic() - drain_start < 3:
        time.sleep(0.001)
    drain = time.monotonic() - drain_start
    dropped = max(0, sent - (_tx_bytes(path) - tx0))
    return {
        "target": fps or 0.0,
        "frames": n,
        "fps": n / elapsed,
        "max_backlog_frames": max_backlog / size,
        "drain_ms": drain * 1000,
        "dropped_frames": dropped / size,
    }


def band_check(fire: Fire, seconds: float = 8.0) -> None:
    """EXPERIMENT (fails on firmware 0.22: the screen stays dark). Visual check of partial OLED
    updates: blank the screen, then send only bands 1, 3 and 5-6.

    Correct packing shows clean vertical bars, 2 px wide every 8 px, in rows 8-15, 24-31 and 40-55
    and nothing else; scrambled dots mean the device packs partial regions differently.
    """
    import time

    fire.oled(blank())
    bars = [[x % 8 < 2 for x in range(OLED_W)] for _ in range(OLED_H)]
    for first, last in ((1, 1), (3, 3), (5, 6)):
        fire.send(oled_bands_sysex(bars, first, last))
    time.sleep(min(10.0, seconds))
    fire.oled(blank())


def _main() -> None:
    import argparse

    ap = argparse.ArgumentParser(description="Akai Fire OLED frame-rate measurement")
    ap.add_argument("--oled-fps", nargs="*", type=float, default=[10, 20, 30, 60])
    ap.add_argument("--seconds", type=float, default=10.0)
    ap.add_argument("--band-check", action="store_true", help="show the partial-update test pattern")
    args = ap.parse_args()
    if args.band_check:
        with Fire() as fire:
            band_check(fire, args.seconds)
        return
    path = _tx_counter()
    if path is None:
        raise SystemExit("No /proc/asound/card*/midi0 for the Fire (Linux only)")
    seconds = min(10.0, args.seconds)
    with Fire() as fire:
        fire.clear()
        for fps in [*args.oled_fps, None]:
            r = bench_oled(fire, fps, seconds, path)
            label = "max" if fps is None else f"{fps:g}"
            print(
                f"target {label:>4} fps: sent {r['frames']:4d} frames = {r['fps']:5.1f} fps, "
                f"max backlog {r['max_backlog_frames']:4.1f} frames, drain {r['drain_ms']:6.1f} ms, "
                f"dropped {r['dropped_frames']:.1f} frames",
                flush=True,
            )
            fire.oled(blank())


if __name__ == "__main__":
    _main()
