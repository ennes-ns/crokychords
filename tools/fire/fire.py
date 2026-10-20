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
