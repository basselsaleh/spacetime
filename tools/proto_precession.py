"""Offline prototype for Phase 5: how precession reads in the app's slices.

Evaluates NRSur7dq4 from the exported file (nrsur7dq4_ref.py) in the proposed
display frame and renders what the app would show: r·h₊ on the plane
perpendicular to J (top) and on the x-z plane through J (side), with the
holes, the orbital angular momentum direction and the near-zone fill. Writes
to out/ (gitignored):

    precession_<case>.png        top and side slices at a few times
    precession_<case>_axes.png   L̂ and the spins over time
    precession_<case>.gif        top and side views, animated

Display frame: +z along the total angular momentum J at the start of the data
(t ≈ -4300 M), with L̂ there in the x-z plane (positive x). J = L + S_A + S_B
uses the 2PN orbital angular momentum of a circular orbit without spin terms
(Blanchet, Living Rev. Rel. 17, 2 (2014), from memory), at the orbital
frequency the dynamics surrogate gives at t_ds[0]. This only chooses the axes:
any constant rotation of the frame leaves the physics unchanged.

Usage:
    uv run python proto_precession.py out/nrsur7dq4.stsur [--case q4-inplane] [--no-gif]
"""

from __future__ import annotations

import argparse
from pathlib import Path

import lal
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
from matplotlib.animation import FuncAnimation, PillowWriter  # noqa: E402

import nrsur7dq4_ref as ref  # noqa: E402

CASES = {
    # name: (q, chiA, chiB), spins in the co-orbital frame at t ≈ -4300 M
    "q4-inplane": (4.0, [0.8, 0.0, 0.0], [0.0, 0.0, 0.0]),
    "q2-generic": (2.0, [0.5, 0.4, 0.3], [-0.5, 0.2, 0.4]),
    "q3-aligned": (3.0, [0.0, 0.0, 0.6], [0.0, 0.0, 0.2]),
}
MODES = [(l, m) for l in range(2, 5) for m in range(-l, l + 1)]
HALF = 450.0      # M, half-width of the views (the app's default framing)
GAIN = 1.5        # look.ts
DT = 0.5          # M, output sampling (linear interpolation per pixel)
LOOP_START = -2500.0


# ---------------------------------------------------------------- frame

def l_orb_2pn(eta: float, omega: float) -> float:
    x = omega ** (2 / 3)
    return eta / np.sqrt(x) * (1 + (1.5 + eta / 6) * x + (27 / 8 - 19 * eta / 8 + eta ** 2 / 24) * x ** 2)


def quat_between(a, b):
    """Unit quaternion rotating unit vector a onto unit vector b."""
    a, b = a / np.linalg.norm(a), b / np.linalg.norm(b)
    c = np.dot(a, b)
    if c < -1 + 1e-12:
        axis = np.cross(a, [1.0, 0, 0]) if abs(a[0]) < 0.9 else np.cross(a, [0, 1.0, 0])
        axis /= np.linalg.norm(axis)
        return np.concatenate([[0.0], axis])
    v = np.cross(a, b)
    qv = np.concatenate([[1 + c], v])
    return qv / np.linalg.norm(qv)


def j_frame(model: ref.Model, q: float, chiA0, chiB0):
    """init_quat putting J(t_ds[0]) on +z and L̂ there in the x-z plane."""
    chiA0, chiB0 = np.asarray(chiA0, float), np.asarray(chiB0, float)
    y0 = np.concatenate([[1, 0, 0, 0, 0], chiA0, chiB0])
    omega0 = ref.dydt(model, q, 0, y0)[4]
    mA, mB = q / (1 + q), 1 / (1 + q)
    J = l_orb_2pn(mA * mB, omega0) * np.array([0, 0, 1.0]) + mA ** 2 * chiA0 + mB ** 2 * chiB0
    q1 = quat_between(J, np.array([0, 0, 1.0]))
    L = ref.rotate_vec(q1[:, None], np.array([[0.0], [0.0], [1.0]]))[:, 0]
    az = np.arctan2(L[1], L[0])
    qz = np.array([np.cos(-az / 2), 0, 0, np.sin(-az / 2)])
    return ref.qmul(qz, q1), omega0, J


# ---------------------------------------------------------------- binary

def pn_separation(omega_orb, eta):
    """binary.rs: 2PN harmonic-coordinate separation, no spin terms."""
    x = np.maximum(omega_orb, 1e-6) ** (2 / 3)
    return 1 / (x * (1 + (1 - eta / 3) * x + (1 - 65 * eta / 12) * x * x))


class Binary:
    def __init__(self, model: ref.Model, q, chiA0, chiB0):
        self.q = q
        self.init_quat, self.omega0, self.J = j_frame(model, q, chiA0, chiB0)
        self.res = ref.evaluate(model, q, chiA0, chiB0, self.init_quat, dt=DT)
        r = self.res
        self.mA, self.mB = q / (1 + q), 1 / (1 + q)
        self.chiAmag, self.chiBmag = np.linalg.norm(chiA0), np.linalg.norm(chiB0)
        self.omega = np.gradient(r.orbphase, r.t)
        ipk = int(np.argmin(np.abs(r.t)))
        self.omega_nz = self.omega.copy()
        self.omega_nz[ipk:] = self.omega[:ipk + 1].max()
        frame = ref.qmul(r.quat, np.array([np.cos(r.orbphase / 2), 0 * r.t, 0 * r.t, np.sin(r.orbphase / 2)]))
        self.xhat = ref.rotate_vec(frame, np.tile([[1.0], [0], [0]], (1, r.t.size))).T
        self.lhat = ref.rotate_vec(r.quat, np.tile([[0.0], [0], [1]], (1, r.t.size))).T
        self.sep = pn_separation(self.omega, self.mA * self.mB)
        h22 = r.h[MODES.index((2, 2))]
        y22 = lal.SpinWeightedSphericalHarmonic(np.pi / 2, 0, -2, 2, 2).real
        self.peak = 2 * np.abs(h22).max() * y22
        mf, chif, vf = ref.remnant(model, q, self.res)
        # ref.remnant returns vectors in the evaluation frame, i.e. this one.
        self.mf, self.chif, self.vf = mf, chif, vf
        # Harmonic θ table, like the app's.
        self.theta = np.linspace(0, np.pi, 2049)
        self.ytab = np.array([[lal.SpinWeightedSphericalHarmonic(th, 0, -2, l, m) for th in self.theta]
                              for (l, m) in MODES])

    def at(self, t):
        i = int(np.clip(round((t - self.res.t[0]) / DT), 0, self.res.t.size - 1))
        return i

    def near_zone(self, t):
        w = 2 * self.omega_nz[self.at(min(t, 0.0))]
        return max(1 / w, 2 * (2 / w) ** (2 / 3))

    def holes(self, t):
        """[(position, radius, kind)] at source time t."""
        if t < -10:
            i = self.at(t)
            a = self.sep[i]
            out = []
            for m, chi, sign, kind in ((self.mA, self.chiAmag, 1, "A"), (self.mB, self.chiBmag, -1, "B")):
                pos = sign * (1 - m) * a * self.xhat[i]
                out.append((pos, m * (1 + np.sqrt(1 - chi ** 2)), kind))
            return out
        drift = self.vf * max(t, 0.0)
        c = np.linalg.norm(self.chif)
        return [(drift, self.mf * (1 + np.sqrt(1 - c ** 2)), "f")]

    def strain(self, t, pts):
        """r·h₊ / color unit at points (N, 3); NaN where the data don't reach."""
        r = np.linalg.norm(pts, axis=1)
        th = np.arccos(np.clip(pts[:, 2] / np.maximum(r, 1e-9), -1, 1))
        ph = np.arctan2(pts[:, 1], pts[:, 0])
        x = (t - r - self.res.t[0]) / DT
        ok = (x >= 0) & (x <= self.res.t.size - 1)
        i = np.clip(np.floor(x).astype(int), 0, self.res.t.size - 2)
        f = np.clip(x - i, 0, 1)
        h = self.res.h[:, i] * (1 - f) + self.res.h[:, i + 1] * f
        j = th / np.pi * (self.theta.size - 1)
        j0 = np.clip(np.floor(j).astype(int), 0, self.theta.size - 2)
        g = j - j0
        y = self.ytab[:, j0] * (1 - g) + self.ytab[:, j0 + 1] * g
        ms = np.array([m for _, m in MODES])[:, None]
        s = np.sum(h * y * np.exp(1j * ms * ph[None, :]), axis=0)  # the modes are r·h already
        val = s.real / self.peak
        val[~ok] = np.nan
        return val


# ---------------------------------------------------------------- drawing

def colorize(val, r, rnz):
    cmap = matplotlib.colormaps["berlin"]
    x = GAIN * val
    s = x / np.sqrt(1 + x * x)
    rgb = cmap(0.5 + 0.5 * np.nan_to_num(s))[..., :3]
    rgb[np.isnan(val)] = (0.06, 0.07, 0.09)
    rgb[r < rnz] = matplotlib.colors.to_rgb("#1c2230")
    return rgb


def view(b: Binary, t, plane, n):
    u = np.linspace(-HALF, HALF, n)
    U, V = np.meshgrid(u, u[::-1])
    if plane == "top":
        pts = np.stack([U, V, 0 * U], axis=-1).reshape(-1, 3)
    else:
        pts = np.stack([U, 0 * U, V], axis=-1).reshape(-1, 3)
    val = b.strain(t, pts).reshape(n, n)
    r = np.hypot(U, V)
    return colorize(val, r, b.near_zone(t))


def project(v, plane):
    return (v[0], v[1]) if plane == "top" else (v[0], v[2])


def draw(ax, b: Binary, t, plane, n):
    ax.imshow(view(b, t, plane, n), extent=[-HALF, HALF, -HALF, HALF], interpolation="bilinear")
    ax.set_xlim(-HALF, HALF)
    ax.set_ylim(-HALF, HALF)
    ax.set_xticks([])
    ax.set_yticks([])
    for pos, rad, kind in b.holes(t):
        x, y = project(pos, plane)
        ax.add_patch(plt.Circle((x, y), max(rad, 4), color="black", ec="#dfe6ff", lw=0.8, zorder=3))
    i = b.at(min(t, -10))
    lx, ly = project(b.lhat[i] * 140, plane)
    ax.annotate("", (lx, ly), (0, 0), arrowprops=dict(arrowstyle="->", color="white", lw=1.2), zorder=4)
    ax.text(lx, ly, " L̂", color="white", fontsize=8, zorder=4)
    if plane == "side":
        ax.annotate("", (0, 140), (0, 0), arrowprops=dict(arrowstyle="->", color="#9aa3b5", lw=0.8, ls="--"))
        ax.text(0, 145, "J", color="#9aa3b5", fontsize=8, ha="center")


def figure_slices(b: Binary, name: str, out: Path):
    times = [-2000, -1400, -900, -500, -150, 80]
    fig, axes = plt.subplots(2, len(times), figsize=(2.6 * len(times), 5.6), facecolor="#0b0d12")
    for k, t in enumerate(times):
        for row, plane in enumerate(("top", "side")):
            ax = axes[row, k]
            draw(ax, b, t, plane, 300)
            if row == 0:
                ax.set_title(f"t = {t} M", color="white", fontsize=9)
        axes[0, 0].set_ylabel("plane ⊥ J (top)", color="white")
        axes[1, 0].set_ylabel("x-z plane (side)", color="white")
    fig.suptitle(f"{name}: r·h₊, display frame z ∥ J(−4300 M)", color="white")
    fig.tight_layout()
    fig.savefig(out, dpi=110, facecolor=fig.get_facecolor())
    plt.close(fig)


def figure_axes(b: Binary, name: str, out: Path):
    r = b.res
    tilt = np.degrees(np.arccos(np.clip(b.lhat[:, 2], -1, 1)))
    az = np.degrees(np.unwrap(np.arctan2(b.lhat[:, 1], b.lhat[:, 0])))
    fig, ax = plt.subplots(1, 2, figsize=(10, 3.4))
    pre = r.t < 0
    ax[0].plot(r.t[pre], tilt[pre], label="L̂ tilt from J")
    for chi, lab in ((r.chiA, "χ_A"), (r.chiB, "χ_B")):
        n = np.linalg.norm(chi, axis=1)
        if n.max() > 0:
            ax[0].plot(r.t[pre], np.degrees(np.arccos(np.clip(chi[pre, 2] / n[pre], -1, 1))), label=f"{lab} tilt from J")
    ax[0].set_xlabel("t (M)")
    ax[0].set_ylabel("degrees")
    ax[0].axvline(LOOP_START, color="gray", lw=0.6, ls=":")
    ax[0].legend(fontsize=8)
    ax[1].plot(r.t[pre], az[pre] - az[0])
    ax[1].set_xlabel("t (M)")
    ax[1].set_ylabel("L̂ azimuth about J (deg)")
    ax[1].axvline(LOOP_START, color="gray", lw=0.6, ls=":")
    fig.suptitle(f"{name}: precession of L̂ in the display frame")
    fig.tight_layout()
    fig.savefig(out, dpi=110)
    plt.close(fig)
    i = b.at(LOOP_START)
    cycles = (az[b.at(0)] - az[i]) / 360
    print(f"  L̂ tilt from J at loop start {tilt[i]:.1f}°, range over loop "
          f"[{tilt[i:b.at(0)].min():.1f}°, {tilt[i:b.at(0)].max():.1f}°]; {cycles:.2f} precession cycles in the loop")
    print(f"  remnant: m_f {b.mf:.4f}, |χ_f| {np.linalg.norm(b.chif):.3f}, χ_f tilt from J "
          f"{np.degrees(np.arccos(b.chif[2] / np.linalg.norm(b.chif))):.1f}°, |v_f| {np.linalg.norm(b.vf) * 299792.458:.0f} km/s")


def animation(b: Binary, name: str, out: Path, frames: int = 90):
    times = np.linspace(LOOP_START, 150, frames)
    fig, axes = plt.subplots(1, 2, figsize=(7.2, 3.8), facecolor="#0b0d12")
    title = fig.suptitle("", color="white", fontsize=10)

    def update(k):
        t = times[k]
        for ax, plane in zip(axes, ("top", "side")):
            ax.clear()
            draw(ax, b, t, plane, 240)
        axes[0].set_title("plane ⊥ J", color="white", fontsize=9)
        axes[1].set_title("x-z plane", color="white", fontsize=9)
        title.set_text(f"{name}   t = {t:.0f} M")
        return []

    anim = FuncAnimation(fig, update, frames=frames)
    anim.save(out, writer=PillowWriter(fps=12), savefig_kwargs={"facecolor": fig.get_facecolor()})
    plt.close(fig)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("model", type=Path)
    ap.add_argument("--case", choices=sorted(CASES), action="append")
    ap.add_argument("--no-gif", action="store_true")
    ap.add_argument("--out", type=Path, default=Path("out"))
    args = ap.parse_args()
    model = ref.Model(args.model)
    for name in args.case or list(CASES):
        q, cA, cB = CASES[name]
        b = Binary(model, q, cA, cB)
        print(f"{name}: q={q} χA={cA} χB={cB}; ω_orb(t0) = {b.omega0:.4f}, "
              f"L̂ tilt from J at t0 {np.degrees(np.arccos(b.lhat[0, 2])):.1f}°")
        figure_slices(b, name, args.out / f"precession_{name}.png")
        figure_axes(b, name, args.out / f"precession_{name}_axes.png")
        if not args.no_gif:
            animation(b, name, args.out / f"precession_{name}.gif")
        print(f"  wrote {args.out}/precession_{name}*.png" + ("" if args.no_gif else " and .gif"))


if __name__ == "__main__":
    main()
