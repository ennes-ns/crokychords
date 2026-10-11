"""Trace a small RGBA pixel-art image into SVG: pixel-perfect (rect runs) and smoothed (contours)."""
import sys, math
from PIL import Image, ImageFilter
import numpy as np

src, out_pixel, out_smooth, ncol, scale = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), int(sys.argv[5])
blur = float(sys.argv[6]) if len(sys.argv) > 6 else scale*0.55
CH = int(sys.argv[8]) if len(sys.argv) > 8 else 3
OVERLAY = len(sys.argv) > 11 and sys.argv[11].startswith('ov')
OVMIN, OVMAX, OVDIV = (float(x) for x in (sys.argv[12].split(',') if len(sys.argv) > 12 else ('2','9','14')))
MODE = int(sys.argv[10]) if len(sys.argv) > 10 else int(scale*1.5)
EPS = float(sys.argv[9]) if len(sys.argv) > 9 else 0.6
vb = int(sys.argv[7]) if len(sys.argv) > 7 else 1  # viewBox divisor for pre-upscaled input
im = Image.open(src).convert('RGBA')
W, H = im.size
a = np.array(im)
alpha = a[..., 3]
# composite onto opaque for quantization, keep alpha mask
rgb = Image.fromarray(a[..., :3])
q = rgb.quantize(colors=ncol*2, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
pal0 = q.getpalette()[: 3 * ncol * 2]
idx0 = np.array(q)
# merge palette entries closer than `merge_dist` (drops the five near-blacks)
cols = [tuple(pal0[3*i:3*i+3]) for i in range(ncol*2)]
counts = np.bincount(idx0[alpha > 127].ravel(), minlength=ncol*2)
order = np.argsort(-counts)
reps, remap = [], {}
for i in order:
    c = np.array(cols[i])
    for j, rc in enumerate(reps):
        if np.linalg.norm(c - np.array(cols[rc])) < 22: remap[i] = j; break
    else:
        remap[i] = len(reps); reps.append(i)
ncol = len(reps)
idx = np.vectorize(lambda v: remap[v])(idx0)
idx = np.where(alpha > 127, idx, -1)
colors = {j: '#%02x%02x%02x' % cols[r] for j, r in enumerate(reps)}

def hexcol(i): return colors[i]

# ---------- pixel-perfect: merge horizontal runs ----------
def pixel_svg():
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" shape-rendering="crispEdges">']
    for ci in range(ncol):
        d = []
        for y in range(H):
            x = 0
            while x < W:
                if idx[y, x] == ci:
                    x0 = x
                    while x < W and idx[y, x] == ci: x += 1
                    d.append(f'M{x0} {y}h{x-x0}v1h-{x-x0}z')
                else:
                    x += 1
        if d: parts.append(f'<path fill="{hexcol(ci)}" d="{"".join(d)}"/>')
    parts.append('</svg>')
    return '\n'.join(parts)

# ---------- smooth: upscale, blur, requantize to palette, trace contours ----------
def smooth_masks():
    big = Image.fromarray(idx.astype(np.int16)).resize((W*scale, H*scale), Image.NEAREST)
    bigidx = np.array(big)
    # blur each class mask and pick argmax -> rounded region borders
    stack = []
    for ci in range(-1, ncol):
        m = Image.fromarray(((bigidx == ci) * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(blur))
        stack.append(np.array(m).astype(np.float32))
    lab = np.argmax(np.stack(stack), axis=0) - 1
    # majority filter to kill speckles, applied a few times
    limg = Image.fromarray((lab + 1).astype(np.uint8))
    for _ in range(3): limg = limg.filter(ImageFilter.ModeFilter(MODE | 1))
    lab = np.array(limg).astype(np.int32) - 1
    return lab

def contours(mask):
    """Boundary polygons of a binary mask via edge chaining (pixel grid edges)."""
    h, w = mask.shape
    pad = np.zeros((h+2, w+2), bool); pad[1:-1, 1:-1] = mask
    edges = {}  # directed edges, inside on the left: start -> end
    def add(p, q): edges.setdefault(p, []).append(q)
    ys, xs = np.nonzero(pad)
    for y, x in zip(ys, xs):
        if not pad[y-1, x]: add((x, y), (x+1, y))        # top edge, going right
        if not pad[y, x+1]: add((x+1, y), (x+1, y+1))    # right edge, going down
        if not pad[y+1, x]: add((x+1, y+1), (x, y+1))    # bottom, going left
        if not pad[y, x-1]: add((x, y+1), (x, y))        # left, going up
    polys = []
    while edges:
        start = next(iter(edges))
        poly = [start]; cur = start
        while True:
            nxts = edges.get(cur)
            if not nxts: break
            nxt = nxts.pop()
            if not nxts: del edges[cur]
            if nxt == start: break
            poly.append(nxt); cur = nxt
        if len(poly) >= 4: polys.append([(x-1, y-1) for x, y in poly])
    return polys

def rdp(pts, eps):
    if len(pts) < 3: return pts
    def perp(p, a, b):
        ax, ay = a; bx, by = b; px, py = p
        dx, dy = bx-ax, by-ay
        if dx == dy == 0: return math.hypot(px-ax, py-ay)
        return abs(dy*px - dx*py + bx*ay - by*ax) / math.hypot(dx, dy)
    dmax, imax = 0, 0
    for i in range(1, len(pts)-1):
        d = perp(pts[i], pts[0], pts[-1])
        if d > dmax: dmax, imax = d, i
    if dmax > eps:
        return rdp(pts[:imax+1], eps)[:-1] + rdp(pts[imax:], eps)
    return [pts[0], pts[-1]]

def chaikin(pts, n=2):
    for _ in range(n):
        out = []
        for i in range(len(pts)):
            p, q = pts[i], pts[(i+1) % len(pts)]
            out.append((0.75*p[0]+0.25*q[0], 0.75*p[1]+0.25*q[1]))
            out.append((0.25*p[0]+0.75*q[0], 0.25*p[1]+0.75*q[1]))
        pts = out
    return pts

def smooth_svg():
    if OVERLAY: return overlay_svg()
    lab = smooth_masks()
    s = scale
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W/vb:g} {H/vb:g}">']
    order = sorted(range(ncol), key=lambda ci: -(lab == ci).sum())
    for ci in order:
        mask = lab == ci
        if mask.sum() < (s*s*0.5): continue
        d = []
        for poly in contours(mask):
            area = abs(sum(poly[i][0]*poly[(i+1)%len(poly)][1] - poly[(i+1)%len(poly)][0]*poly[i][1] for i in range(len(poly))))/2
            if area < s*s*1.5: continue
            poly = rdp(poly + [poly[0]], eps=s*EPS)[:-1]
            if len(poly) < 3: continue
            pts = chaikin(poly, CH)
            d.append('M' + ' '.join(f'{x/s/vb:.1f},{y/s/vb:.1f}' for x, y in pts) + 'Z')
        if d: parts.append(f'<path fill="{hexcol(ci)}" fill-rule="evenodd" d="{" ".join(d)}"/>')
    parts.append('</svg>')
    return '\n'.join(parts)

def overlay_svg():
    big = np.array(Image.fromarray(idx.astype(np.int16)).resize((W*scale, H*scale), Image.NEAREST))
    s = scale
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W/vb:g} {H/vb:g}">']
    order = sorted(range(ncol), key=lambda ci: -(big == ci).sum())
    for ci in order:
        raw = (big == ci)
        if raw.sum() < s*s*0.5: continue
        # label connected components roughly by blurring the whole class mask with a radius
        # that scales with the class area, so thin features keep their shape
        r = min(OVMAX, max(OVMIN, math.sqrt(raw.sum()) / OVDIV))
        m = np.array(Image.fromarray((raw*255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(r))) > 120
        d = []
        for poly in contours(m):
            area = abs(sum(poly[i][0]*poly[(i+1)%len(poly)][1] - poly[(i+1)%len(poly)][0]*poly[i][1] for i in range(len(poly))))/2
            if area < s*s*1.0: continue
            poly = rdp(poly + [poly[0]], eps=max(1.0, r*0.5))[:-1]
            if len(poly) < 3: continue
            pts = chaikin(poly, CH)
            d.append('M' + ' '.join(f'{x/s/vb:.1f},{y/s/vb:.1f}' for x, y in pts) + 'Z')
        if d: parts.append(f'<path fill="{hexcol(ci)}" fill-rule="evenodd" d="{" ".join(d)}"/>')
    parts.append('</svg>')
    return '\n'.join(parts)

open(out_pixel, 'w').write(pixel_svg())
open(out_smooth, 'w').write(smooth_svg())
print('palette:', colors)
