"""Offline prototype of Phase 3 stage 2: tendex and vortex lines of a binary
black hole from the linearized monopole + mass-quadrupole field
(tendex_field.py) driven by the NRHybSur3dq8 (2,2) mode (tendex_quadrupole.py,
adiabatic quadrupole).

Outputs (into OUTDIR):
  plane.png   tendex lines in the orbital plane at several times
  plane.gif   the same, animated through the merger
  lines3d.png tendex and vortex lines in 3D at one time

Colours: tendex lines red where the eigenvalue is < 0 (stretching), blue where
> 0 (squeezing); vortex lines green / violet for the two twist directions
(eigenvalue > 0 / < 0). Brightness is |eigenvalue| relative to the largest
eigenvalue at that point. Lines are not drawn inside the near zone
(r < max(1/w22, 2a)), where a monopole + quadrupole expansion is not valid.

    env -u VIRTUAL_ENV uv run python tendex_proto.py OUTDIR [--q 3 --chi1 0.6 --chi2 0.2]
"""

from __future__ import annotations

import argparse
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.animation import FuncAnimation, PillowWriter
from matplotlib.collections import LineCollection

import tendex_field as tf
import tendex_quadrupole as tq

BG = "#090a0e"
RED = np.array([1.0, 0.36, 0.22])
BLUE = np.array([0.30, 0.58, 1.0])
GREEN = np.array([0.35, 0.95, 0.55])
VIOLET = np.array([0.80, 0.45, 1.0])


def near_zone_radius(b: tq.Binary, t: float) -> float:
    """As in the app (web/src/waveform.ts): max(1/w22, 2 (2/w22)^(2/3)), w22 held after the peak."""
    t_peak = b.t[np.argmax(np.abs(b.h22))]
    w = max(np.interp(min(t, t_peak), b.t, b.omega22), 1e-3)
    return max(1 / w, 2 * (2 / w) ** (2 / 3))


def fields(points: np.ndarray, t: float, quad: tq.Quadrupole, M: float = 1.0, which: str = "E") -> np.ndarray:
    """E or B at points (..., 3), each at its own retarded time t - r."""
    r = np.linalg.norm(points, axis=-1)
    ider = quad(t - r)
    return (tf.tidal if which == "E" else tf.frame_drag)(points, M, ider)


# ---------------------------------------------------------------- orbital plane


class PlaneField:
    """In-plane 2x2 block of E on a grid in z = 0 (E_xz = E_yz = 0 there by symmetry), bilinearly interpolated."""

    def __init__(self, t: float, quad: tq.Quadrupole, half: float, n: int):
        self.half, self.n = half, n
        xs = np.linspace(-half, half, n)
        X, Y = np.meshgrid(xs, xs, indexing="xy")
        pts = np.stack([X, Y, np.zeros_like(X)], axis=-1)
        E = fields(pts, t, quad)
        self.a, self.b, self.c = E[..., 0, 0], E[..., 0, 1], E[..., 1, 1]
        self.h = 2 * half / (n - 1)

    def at(self, p):
        fx = (p[0] + self.half) / self.h
        fy = (p[1] + self.half) / self.h
        i = int(np.clip(np.floor(fx), 0, self.n - 2))
        j = int(np.clip(np.floor(fy), 0, self.n - 2))
        u, v = fx - i, fy - j

        def lerp(g):
            return (g[j, i] * (1 - u) + g[j, i + 1] * u) * (1 - v) + (g[j + 1, i] * (1 - u) + g[j + 1, i + 1] * u) * v

        return lerp(self.a), lerp(self.b), lerp(self.c)

    def eig(self, p):
        """Both in-plane eigenpairs (small, big) and the out-of-plane eigenvalue."""
        a, b, c = self.at(p)
        mid, rad = (a + c) / 2, np.hypot((a - c) / 2, b)
        th = 0.5 * np.arctan2(2 * b, a - c)  # eigenvector of the larger eigenvalue
        big = np.array([np.cos(th), np.sin(th)])
        small = np.array([-np.sin(th), np.cos(th)])
        return (mid - rad, small), (mid + rad, big), -(a + c)


def trace_plane(field: PlaneField, family: int, rmin: float, half: float, dsep: float):
    """Evenly spaced lines of one in-plane eigenvector family (Jobard-Lefer): new lines are
    seeded at least dsep from existing ones and stop when they come within dsep / 2."""
    dtest = dsep / 2
    ncell = int(2 * half / dtest) + 1
    occupied = np.zeros((ncell, ncell), bool)
    cell = lambda p: (int((p[1] + half) / dtest), int((p[0] + half) / dtest))

    def free_around(c):
        i, j = c
        return not occupied[max(i - 1, 0) : i + 2, max(j - 1, 0) : j + 2].any()
    lines = []

    def direction(p, prev):
        pair = field.eig(p)[family]
        v = pair[1]
        if prev is not None and v @ prev < 0:
            v = -v
        return v

    def walk(seed, sign):
        pts, vals = [], []
        p = seed.copy()
        prev = None
        for _ in range(4000):
            r = np.hypot(*p)
            if r < rmin or abs(p[0]) > half or abs(p[1]) > half:
                break
            v0 = direction(p, prev) * (sign if prev is None else 1)
            ds = 0.4 + 0.01 * r
            k1 = v0
            k2 = direction(p + 0.5 * ds * k1, k1)
            k3 = direction(p + 0.5 * ds * k2, k1)
            k4 = direction(p + ds * k3, k1)
            step = (k1 + 2 * k2 + 2 * k3 + k4) / 6
            q = p + ds * step
            ci = cell(q)
            if not (0 <= ci[0] < ncell and 0 <= ci[1] < ncell):
                break
            if occupied[ci]:
                break
            pts.append(p.copy())
            (ls, _), (lb, _), lz = field.eig(p)
            lam = (ls, lb)[family]
            vals.append((lam, max(abs(ls), abs(lb), abs(lz))))
            prev = step / np.linalg.norm(step)
            p = q
        return pts, vals

    rng = np.random.default_rng(0)
    # Seeds on a jittered grid, nearest the source first so inner structure gets lines.
    g = np.arange(-half + dsep / 2, half, dsep)
    seeds = np.array([[x, y] for x in g for y in g]) + rng.uniform(-0.3, 0.3, (len(g) ** 2, 2)) * dsep
    seeds = seeds[np.argsort(np.hypot(seeds[:, 0], seeds[:, 1]))]
    for s in seeds:
        if np.hypot(*s) < rmin * 1.05:
            continue
        if not free_around(cell(s)):
            continue
        back, vb = walk(s, -1)
        fwd, vf = walk(s, +1)
        pts = back[::-1] + fwd[1:]
        vals = vb[::-1] + vf[1:]
        if len(pts) < 6:
            continue
        for p in pts:
            occupied[cell(p)] = True
        lines.append((np.array(pts), np.array(vals)))
    return lines


def draw_lines(ax, lines, pos, neg, width=1.0):
    segs, cols = [], []
    for pts, vals in lines:
        for k in range(len(pts) - 1):
            lam, scale = vals[k]
            strength = np.clip(abs(lam) / max(scale, 1e-30), 0, 1)
            base = neg if lam < 0 else pos
            segs.append(pts[k : k + 2])
            cols.append((*base, 0.15 + 0.85 * strength))
    ax.add_collection(LineCollection(segs, colors=cols, linewidths=width))


def plane_frame(ax, b, quad, t, half, n=260, dsep=None):
    ax.clear()
    ax.set_facecolor(BG)
    rmin = near_zone_radius(b, t)
    field = PlaneField(t, quad, half, n)
    dsep = dsep or half / 15
    for fam in (0, 1):
        draw_lines(ax, trace_plane(field, fam, rmin, half, dsep), pos=BLUE, neg=RED, width=0.9)
    ax.add_patch(plt.Circle((0, 0), rmin, color="0.45", fill=False, lw=0.6, ls="--"))
    # Holes, schematically: Kepler separation, heavier hole at the orbital angle.
    if t < 0:
        w = np.interp(t, b.t, b.omega22) / 2
        a = w ** (-2 / 3)
        ang = 0.5 * (np.interp(t, b.t, b.phi22) - np.interp(-1000.0, b.t, b.phi22))
        m1, m2 = b.q / (1 + b.q), 1 / (1 + b.q)
        for m, sgn in ((m1, 1), (m2, -1)):
            d = sgn * a * (1 - m)
            ax.plot(d * np.cos(ang), d * np.sin(ang), "o", color="white", ms=2 + 3 * m)
    else:
        ax.plot(0, 0, "o", color="white", ms=5)
    ax.set_xlim(-half, half)
    ax.set_ylim(-half, half)
    ax.set_aspect("equal")
    ax.set_xticks([])
    ax.set_yticks([])
    ax.set_title(f"t = {t:.0f} M", color="0.85", fontsize=10)


# ---------------------------------------------------------------- 3D


def trace_3d(b, quad, t, seeds, which, family, rmin, rmax, steps=24):
    """Lines of eigenvector `family` (0: smallest eigenvalue, 2: largest) of E or B, all seeds at once, both ways."""

    def direction(p, prev):
        F = fields(p, t, quad, which=which)
        lam, vec = np.linalg.eigh(F)
        v = vec[..., :, family]
        if prev is not None:
            v = v * np.sign(np.sum(v * prev, axis=-1, keepdims=True) + 1e-30)
        return v, lam[..., family], np.abs(lam).max(axis=-1)

    out = []
    for sign in (+1, -1):
        p = seeds.copy()
        alive = np.ones(len(p), bool)
        path = [p.copy()]
        vals = []
        prev = None
        for _ in range(steps):
            r = np.linalg.norm(p, axis=-1)
            ds = (0.4 + 0.012 * r)[:, None]
            k1, lam, scale = direction(p, prev)
            if prev is None:
                k1 = k1 * sign
            k2, _, _ = direction(p + 0.5 * ds * k1, k1)
            k3, _, _ = direction(p + 0.5 * ds * k2, k1)
            k4, _, _ = direction(p + ds * k3, k1)
            step = (k1 + 2 * k2 + 2 * k3 + k4) / 6
            step /= np.linalg.norm(step, axis=-1, keepdims=True)
            vals.append(np.stack([lam, scale], -1))
            p = np.where(alive[:, None], p + ds * step, p)
            prev = step
            r = np.linalg.norm(p, axis=-1)
            alive &= (r > rmin) & (r < rmax)
            path.append(np.where(alive[:, None], p, np.nan))
        vals.append(vals[-1])
        out.append((np.array(path), np.array(vals)))
    return out


PANELS_3D = (
    ("E", 0, BLUE, RED, "tendex: stretching family (E, most negative eigenvalue)"),
    ("E", 2, BLUE, RED, "tendex: squeezing family (E, most positive eigenvalue)"),
    ("B", 2, GREEN, VIOLET, "vortex: one twist family (B, most positive eigenvalue)"),
)


def lines3d_figure(path, b, quad, t, rmax):
    rmin = near_zone_radius(b, t)
    rng = np.random.default_rng(3)
    fig = plt.figure(figsize=(18, 6.5), facecolor=BG)
    for k, (which, fam, pos_c, neg_c, title) in enumerate(PANELS_3D):
        ax = fig.add_subplot(1, 3, k + 1, projection="3d", facecolor=BG)
        for family, pos, neg in ((fam, pos_c, neg_c),):
            # One family per panel, fewer and longer lines, seeded in a shell outside the near zone.
            n = 90
            d = rng.normal(size=(n, 3))
            d /= np.linalg.norm(d, axis=1, keepdims=True)
            seeds = d * rng.uniform(0.45 * rmax, 0.75 * rmax, (n, 1))
            for paths, vals in trace_3d(b, quad, t, seeds, which, family, rmin, rmax, steps=60):
                for s in range(n):
                    pts = paths[:, s]
                    ok = np.isfinite(pts[:, 0])
                    pts = pts[ok]
                    v = vals[ok[: len(vals)]][:, s] if ok[: len(vals)].any() else None
                    if len(pts) < 3 or v is None:
                        continue
                    for j in range(min(len(pts), len(v)) - 1):
                        lam, scale = v[j]
                        a = 0.1 + 0.8 * np.clip(abs(lam) / max(scale, 1e-30), 0, 1)
                        ax.plot(*pts[j : j + 2].T, color=(*(neg if lam < 0 else pos), a), lw=0.7)
        u = np.linspace(0, 2 * np.pi, 100)
        ax.plot(rmax * np.cos(u), rmax * np.sin(u), 0, color="0.35", lw=0.6)
        ax.plot([0, 0], [0, 0], [-rmax, rmax], color="0.35", lw=0.6)
        for axis in (ax.xaxis, ax.yaxis, ax.zaxis):
            axis.set_pane_color((0, 0, 0, 0))
            axis.line.set_color((0, 0, 0, 0))
        ax.set_xticks([])
        ax.set_yticks([])
        ax.set_zticks([])
        ax.set_xlim(-rmax, rmax)
        ax.set_ylim(-rmax, rmax)
        ax.set_zlim(-rmax, rmax)
        ax.view_init(elev=28, azim=-60)
        ax.set_title(f"{title}\nt = {t:.0f} M", color="0.85", fontsize=10)
    fig.tight_layout()
    fig.savefig(path, dpi=110, facecolor=BG)
    plt.close(fig)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("outdir", type=Path)
    ap.add_argument("--q", type=float, default=3.0)
    ap.add_argument("--chi1", type=float, default=0.6)
    ap.add_argument("--chi2", type=float, default=0.2)
    ap.add_argument("--frames", type=int, default=48)
    ap.add_argument("--skip-gif", action="store_true")
    args = ap.parse_args()
    args.outdir.mkdir(parents=True, exist_ok=True)

    b = tq.evaluate(args.q, args.chi1, args.chi2)
    quad = tq.Quadrupole(b, "adiabatic")
    half = 150.0

    times = [-600, -200, -40, 30]
    fig, axes = plt.subplots(1, 4, figsize=(18, 4.9), facecolor=BG)
    for ax, t in zip(axes, times):
        plane_frame(ax, b, quad, t, half)
        print(f"plane t = {t}")
    fig.suptitle(
        "Tendex lines in the orbital plane (red: stretching, blue: squeezing; dashed: near zone, not modelled)",
        color="0.85",
    )
    fig.tight_layout()
    fig.savefig(args.outdir / "plane.png", dpi=110, facecolor=BG)
    plt.close(fig)

    lines3d_figure(args.outdir / "lines3d.png", b, quad, -200.0, rmax=120.0)
    print("3d done")

    if not args.skip_gif:
        fig, ax = plt.subplots(figsize=(6, 6), facecolor=BG)
        ts = np.linspace(-500, 60, args.frames)
        anim = FuncAnimation(fig, lambda k: plane_frame(ax, b, quad, ts[k], half, n=220), frames=len(ts))
        anim.save(args.outdir / "plane.gif", writer=PillowWriter(fps=10), dpi=80, savefig_kwargs={"facecolor": BG})
        print("gif done")


if __name__ == "__main__":
    main()
