"""croky_pixels.py -- shared pixel-Croky helpers for the brand scripts (stdlib only).

The pixel master lives in the croky asset repository (`master/croky-{64,32,16}.txt` + `master/palette.json`);
each grid is one character per pixel, `.` is transparent and the letters map to palette names via LEG."""
import json, struct, zlib

LEG = {"K": "outline", "B": "cap", "b": "cap_shade", "W": "eye_white", "P": "pupil", "G": "green",
       "g": "green_dark", "L": "green_light", "S": "beak", "s": "beak_dark", "C": "cream", "c": "cream_shade",
       "Y": "yellow", "O": "orange", "R": "red", "r": "red_dark", "F": "feet"}


def load_grid(path):
    """Rows of the grid file, blank lines dropped, padded to the widest row."""
    rows = [l.rstrip("\n") for l in open(path) if l.strip()]
    w = max(len(r) for r in rows)
    return [r.ljust(w, ".") for r in rows]


def load_palette(path):
    return json.load(open(path))


def colour_of(pal):
    return lambda c: pal[LEG[c]] if c in LEG else None


def runs(rows, ox, oy, colour_of):
    """rows: list of strings; returns {colour: [path-d]} with horizontal runs merged, in grid cells."""
    paths = {}
    for y, line in enumerate(rows):
        x = 0
        while x < len(line):
            col = colour_of(line[x])
            if col is None:
                x += 1
                continue
            x2 = x
            while x2 < len(line) and colour_of(line[x2]) == col:
                x2 += 1
            paths.setdefault(col, []).append(f"M{ox + x} {oy + y}h{x2 - x}v1h{x - x2}z")
            x = x2
    return paths


def bbox(rows):
    """(x0, y0, x1, y1) of the non-transparent cells, x1/y1 exclusive."""
    xs = [x for r in rows for x, c in enumerate(r) if c in LEG]
    ys = [y for y, r in enumerate(rows) if any(c in LEG for c in r)]
    return min(xs), min(ys), max(xs) + 1, max(ys) + 1


def hex_rgba(h):
    h = h.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), 255)


def write_png(path, w, h, pixels):
    """pixels: list of h rows of w (r, g, b, a) tuples. Deterministic 8-bit RGBA PNG."""
    raw = b"".join(b"\0" + b"".join(bytes(p) for p in row) for row in pixels)

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))

    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    open(path, "wb").write(png)
