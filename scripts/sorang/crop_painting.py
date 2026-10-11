# Perspective-crops the keystoned painting screenshot into a square texture.
# Usage: python3 -I scripts/sorang/crop_painting.py <src> <out.jpg> [--size 1024] [--debug <png>]
import argparse

import numpy as np
from PIL import Image, ImageDraw

# Hand-measured corners of the painting in the source screenshot (x, y): TL, TR, BR, BL.
MEASURED = np.array([(174, 152), (1191, 167), (1246, 1220), (107, 1227)], dtype=float)
THRESHOLD = 25  # luma; the background is 0-7, the painting's darkest edge tones ~40
SEARCH = 40  # px scanned outside and inside the measured edge
INTERIOR = (12, 30)  # px past the first hit used to sample the painting's own level


def edge_hit(profile):
    """Sub-pixel index of the background->painting step in a profile read inward.

    The first sample above THRESHOLD is the coarse hit. Next to bright paint the
    screen bloom lifts the background above 25 for ~10 px, so the hit is then
    moved to the half-way crossing between background and the paint just inside.
    """
    above = np.nonzero(profile > THRESHOLD)[0]
    if len(above) == 0 or above[0] == 0:
        return None
    h = above[0]
    inside = profile[h + INTERIOR[0] : h + INTERIOR[1]]
    if len(inside) == 0:
        return None
    bg = float(np.median(profile[:5]))
    level = max(THRESHOLD, bg + 0.5 * (float(np.median(inside)) - bg))
    k = h + np.nonzero(profile[h:] > level)[0][0]
    lo, hi = float(profile[k - 1]), float(profile[k])
    return k - 1 + (level - lo) / (hi - lo)


def side_points(luma, a, b, axis, inward):
    """Edge points along side a->b. axis 0: horizontal side (scan columns), 1: vertical side (scan rows)."""
    h, w = luma.shape
    t0, t1 = (a[0], b[0]) if axis == 0 else (a[1], b[1])
    lo, hi = sorted((t0, t1))
    span = hi - lo
    pts = []
    for t in range(int(np.ceil(lo + 0.1 * span)), int(np.floor(hi - 0.1 * span)) + 1):
        f = (t - t0) / (t1 - t0)
        expected = (a[1] + f * (b[1] - a[1])) if axis == 0 else (a[0] + f * (b[0] - a[0]))
        start = int(round(expected)) - inward * SEARCH
        idx = start + inward * np.arange(2 * SEARCH + INTERIOR[1])
        limit = h if axis == 0 else w
        if idx.min() < 0 or idx.max() >= limit:
            continue
        profile = (luma[idx, t] if axis == 0 else luma[t, idx]).astype(float)
        s = edge_hit(profile)
        if s is None:
            continue
        pos = start + inward * s
        pts.append((t, pos) if axis == 0 else (pos, t))
    return np.array(pts)


def fit_line(pts, axis):
    """Least-squares line with outlier rejection. Returns (m, c, used, rms).

    axis 0: y = m*x + c (horizontal side); axis 1: x = m*y + c (vertical side).
    """
    t, v = (pts[:, 0], pts[:, 1]) if axis == 0 else (pts[:, 1], pts[:, 0])
    keep = np.ones(len(t), dtype=bool)
    for _ in range(5):
        m, c = np.polyfit(t[keep], v[keep], 1)
        r = v - (m * t + c)
        sigma = 1.4826 * np.median(np.abs(r[keep] - np.median(r[keep])))
        new_keep = np.abs(r) < max(1.5, 3 * sigma)
        if np.array_equal(new_keep, keep):
            break
        keep = new_keep
    m, c = np.polyfit(t[keep], v[keep], 1)
    rms = float(np.sqrt(np.mean((v[keep] - (m * t[keep] + c)) ** 2)))
    return m, c, keep, rms


def intersect(h_line, v_line):
    """Intersect y = mh*x + ch with x = mv*y + cv."""
    mh, ch = h_line
    mv, cv = v_line
    y = (mh * cv + ch) / (1 - mh * mv)
    return np.array([mv * y + cv, y])


def homography(src, dst):
    """8 coefficients (a..h) mapping src (u, v) -> dst (x, y) projectively."""
    rows, rhs = [], []
    for (u, v), (x, y) in zip(src, dst):
        rows.append([u, v, 1, 0, 0, 0, -u * x, -v * x])
        rows.append([0, 0, 0, u, v, 1, -u * y, -v * y])
        rhs += [x, y]
    return np.linalg.solve(np.array(rows, float), np.array(rhs, float))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("src")
    ap.add_argument("out")
    ap.add_argument("--size", type=int, default=1024)
    ap.add_argument("--inset", type=float, default=0.005, help="fraction to shrink the quad toward its centre")
    ap.add_argument("--debug", help="write the source with the refined quad drawn on it")
    args = ap.parse_args()

    img = Image.open(args.src).convert("RGB")
    luma = np.asarray(img.convert("L"))
    tl, tr, br, bl = MEASURED

    # (name, a, b, axis, inward step along the scan)
    sides = {
        "top": (tl, tr, 0, +1),
        "bottom": (bl, br, 0, -1),
        "left": (tl, bl, 1, +1),
        "right": (tr, br, 1, -1),
    }
    lines, used_pts = {}, []
    for name, (a, b, axis, inward) in sides.items():
        pts = side_points(luma, a, b, axis, inward)
        m, c, keep, rms = fit_line(pts, axis)
        lines[name] = (m, c)
        used_pts.append(pts[keep])
        print(f"{name:>6}: {keep.sum()}/{len(pts)} edge points, rms {rms:.2f}px")

    refined = np.array(
        [
            intersect(lines["top"], lines["left"]),
            intersect(lines["top"], lines["right"]),
            intersect(lines["bottom"], lines["right"]),
            intersect(lines["bottom"], lines["left"]),
        ]
    )
    for label, p, q in zip(("TL", "TR", "BR", "BL"), refined, MEASURED):
        print(f"{label}: ({p[0]:.1f}, {p[1]:.1f})  measured ({q[0]:.0f}, {q[1]:.0f})  delta {np.hypot(*(p - q)):.1f}px")

    centre = refined.mean(axis=0)
    quad = centre + (refined - centre) * (1 - args.inset)
    # Pixel indices are pixel centres; PIL's transform works in continuous coords (centre = i + 0.5).
    s = args.size
    coeffs = homography([(0, 0), (s, 0), (s, s), (0, s)], quad + 0.5)
    out = img.transform((s, s), Image.Transform.PERSPECTIVE, tuple(coeffs), Image.Resampling.BICUBIC)
    out.save(args.out, "JPEG", quality=92)
    print(f"wrote {args.out} ({s}x{s}, inset {args.inset:.1%})")

    if args.debug:
        dbg = img.copy()
        draw = ImageDraw.Draw(dbg)
        for x, y in np.vstack(used_pts):
            draw.point((x, y), fill=(0, 255, 0))
        draw.polygon([tuple(p) for p in refined], outline=(255, 0, 0), width=2)
        draw.polygon([tuple(p) for p in quad], outline=(0, 200, 255), width=1)
        dbg.save(args.debug)
        print(f"wrote {args.debug}")


if __name__ == "__main__":
    main()
