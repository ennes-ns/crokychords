import math
import numpy as np
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

