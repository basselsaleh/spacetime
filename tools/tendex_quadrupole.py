"""The binary's mass quadrupole I_ij(t) from the NRHybSur3dq8 (2,2) mode, by
three methods, for driving the linearized tendex/vortex field (tendex_field.py).

The far-zone strain of the field in tendex_field.py is h^TT_ij = (2/r) I''^TT_ij.
The map from the five STF components of I'' to the l = 2 modes is computed
numerically here by projecting that strain onto LAL's -2Y_2m, which also pins
down the LAL polarisation convention (h+ = (h_phph - h_thth)/2, h× sign checked
by the projection residual). Only (2, +-2) is used: (2, +-1) comes from the
current quadrupole and (2, 0) is tiny and memory-free in this surrogate.

The mode gives I'' directly. I and I' need one of:
  adiabatic   K = -h22 / w22^2 (exact for a slowly chirping rotating quadrupole)
  integrated  K'' = h22 integrated twice, started from the adiabatic values
  orbit       I = mu a^2 (n n)^STF with Kepler a(w) and the orbital phase w22/2
where K is the complex (2,2)-mode equivalent of I (I''s mode is h22).

Run directly for the comparison figure:
    env -u VIRTUAL_ENV uv run python tendex_quadrupole.py out.png
"""

from __future__ import annotations

import argparse
import functools
import warnings
from dataclasses import dataclass
from pathlib import Path

import lal
import numpy as np
from scipy.interpolate import CubicSpline

from tendex_field import NDER, stf, stf_matrix

DATA = Path(__file__).parent / "data" / "NRHybSur3dq8.h5"


def _basis_th_ph(theta, phi):
    e_th = np.array([np.cos(theta) * np.cos(phi), np.cos(theta) * np.sin(phi), -np.sin(theta)])
    e_ph = np.array([-np.sin(phi), np.cos(phi), 0.0])
    return e_th, e_ph


@functools.lru_cache(maxsize=1)
def mode_map() -> np.ndarray:
    """A[m + 2, c]: r h_2m produced by unit I''_c (c = xx, yy, xy, xz, yz), LAL convention."""
    nth, nph = 48, 96
    # Gauss-Legendre in cos(theta), uniform in phi: exact for these band-limited patterns.
    x, w = np.polynomial.legendre.leggauss(nth)
    thetas = np.arccos(x)
    phis = 2 * np.pi * np.arange(nph) / nph
    best = None
    for hx_sign in (+1, -1):
        A = np.zeros((5, 5), complex)
        resid = 0.0
        for c in range(5):
            unit = np.zeros(5)
            unit[c] = 1
            h = 2 * stf_matrix(unit)
            pattern = np.zeros((nth, nph), complex)
            Y = np.zeros((5, nth, nph), complex)
            for a, th in enumerate(thetas):
                for b, ph in enumerate(phis):
                    e_th, e_ph = _basis_th_ph(th, ph)
                    hp = 0.5 * (e_ph @ h @ e_ph - e_th @ h @ e_th)
                    hc = hx_sign * (e_th @ h @ e_ph)
                    pattern[a, b] = hp - 1j * hc
                    for m in range(-2, 3):
                        Y[m + 2, a, b] = lal.SpinWeightedSphericalHarmonic(th, ph, -2, 2, m)
            wgt = w[:, None] * (2 * np.pi / nph)
            coef = np.array([np.sum(pattern * np.conj(Y[k]) * wgt) for k in range(5)])
            A[:, c] = coef
            rec = np.tensordot(coef, Y, axes=1)
            resid = max(resid, np.abs(rec - pattern).max() / np.abs(pattern).max())
        if best is None or resid < best[0]:
            best = (resid, hx_sign, A)
    resid, hx_sign, A = best
    assert resid < 1e-10, f"no h× sign projects onto -2Y_2m (residual {resid:.1e})"
    return A


def components_from_22(k22: np.ndarray) -> np.ndarray:
    """STF components (xx, yy, xy, xz, yz) whose (2, +-2) modes are (k22, conj k22). Works on arrays (..., ) -> (..., 5)."""
    A = mode_map()[[0, 4]][:, :3]  # m = -2, +2 rows; xx, yy, xy (planar symmetry: xz = yz = 0)
    rhs = np.stack([np.conj(k22), k22], axis=-1)  # h_{2,-2} = conj(h_22) for l even
    M = np.concatenate([A.real, A.imag])
    b = np.concatenate([rhs.real, rhs.imag], axis=-1)
    sol = np.linalg.lstsq(M, b.reshape(-1, 4).T, rcond=None)[0].T.reshape(k22.shape + (3,))
    out = np.zeros(k22.shape + (5,))
    out[..., :3] = sol
    return out


@dataclass
class Binary:
    q: float
    chi1: float
    chi2: float
    t: np.ndarray
    h22: np.ndarray
    omega22: np.ndarray
    phi22: np.ndarray


def evaluate(q=3.0, chi1=0.6, chi2=0.2, t0=-3000.0, t1=130.0, dt=0.1) -> Binary:
    from gwsurrogate.surrogate import NRHybSur3dq8

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        sur = NRHybSur3dq8(str(DATA))
    t = np.arange(t0, t1 + 1e-9, dt)
    _, h, _ = sur._sur_dimless([q, chi1, chi2], fM_low=0, fM_ref=0, timesM=t, mode_list=[(2, 2)], do_not_align=True)
    h22 = h[(2, 2)]
    phi22 = np.unwrap(-np.angle(h22))  # h22 = A e^{-i phi22}
    omega22 = np.gradient(phi22, t)
    return Binary(q, chi1, chi2, t, h22, omega22, phi22)


OMEGA_HOLD_T = 60.0  # M: after this, h22 is near the noise floor and its phase (hence w22) is noise


def k_adiabatic(b: Binary) -> np.ndarray:
    w = np.where(b.t > OMEGA_HOLD_T, np.interp(OMEGA_HOLD_T, b.t, b.omega22), b.omega22)
    return -b.h22 / w**2


def k_integrated(b: Binary) -> np.ndarray:
    k0 = k_adiabatic(b)
    dk0 = np.gradient(k0, b.t)
    dt = np.diff(b.t)
    v = dk0[0] + np.concatenate([[0], np.cumsum(0.5 * (b.h22[1:] + b.h22[:-1]) * dt)])
    return k0[0] + np.concatenate([[0], np.cumsum(0.5 * (v[1:] + v[:-1]) * dt)])


def orbit_components(b: Binary) -> np.ndarray:
    """I_ij = mu a^2 (n n)^STF, Kepler a = (w22/2)^(-2/3), heavier hole at angle (phi22 - phi22(-1000))/2."""
    mu = b.q / (1 + b.q) ** 2
    w = np.maximum(b.omega22 / 2, 1e-6)
    a = w ** (-2 / 3)
    ang = 0.5 * (b.phi22 - np.interp(-1000.0, b.t, b.phi22))
    n = np.stack([np.cos(ang), np.sin(ang), np.zeros_like(ang)], axis=-1)
    return np.array([stf(mu * a[i] ** 2 * np.outer(n[i], n[i])) for i in range(len(b.t))])


class Quadrupole:
    """I^(n)_c(u) for n = 0..4, by spline: I and I' from K (method), I'' from h22, I''' and I'''' from h22's spline."""

    def __init__(self, b: Binary, method: str = "adiabatic"):
        self.b = b
        self.method = method
        if method == "orbit":
            comps = orbit_components(b)
            self.splines = [CubicSpline(b.t, comps)]
            for _ in range(NDER - 1):
                self.splines.append(self.splines[-1].derivative())
            return
        k = {"adiabatic": k_adiabatic, "integrated": k_integrated}[method](b)
        ks = CubicSpline(b.t, k)
        hs = CubicSpline(b.t, b.h22)
        self.k = [ks, ks.derivative(), hs, hs.derivative(), hs.derivative(2)]

    def __call__(self, u: np.ndarray) -> np.ndarray:
        """(..., 5, NDER) derivatives at retarded times u (clamped to the data range)."""
        u = np.clip(np.asarray(u, float), self.b.t[0], self.b.t[-1])
        if self.method == "orbit":
            return np.stack([s(u) for s in self.splines], axis=-1)
        return np.stack([components_from_22(f(u)) for f in self.k], axis=-1)


def _main() -> None:
    import matplotlib.pyplot as plt

    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("out", type=Path)
    args = ap.parse_args()

    A = mode_map()
    print("mode map (rows m = -2..2, cols xx yy xy xz yz):")
    print(np.array2string(A, precision=4, suppress_small=True))

    b = evaluate()
    # Sign check: at t = -1000 the heavier hole is on +x, so the quadrupole's
    # major axis (from the adiabatic estimate) must be along x.
    i = np.searchsorted(b.t, -1000.0)
    c = components_from_22(k_adiabatic(b)[i])
    print(f"t = -1000: I_xx - I_yy = {c[0] - c[1]:+.3e}, I_xy = {c[2]:+.3e} (expect > 0 and ~0)")
    assert c[0] - c[1] > 0 and abs(c[2]) < 0.2 * (c[0] - c[1])

    rot = lambda comps: 0.5 * np.hypot(comps[..., 0] - comps[..., 1], 2 * comps[..., 2])  # rotating amplitude
    ang = lambda comps: 0.5 * np.arctan2(2 * comps[..., 2], comps[..., 0] - comps[..., 1])
    ad = components_from_22(k_adiabatic(b))
    it = components_from_22(k_integrated(b))
    orb = orbit_components(b)

    fig, ax = plt.subplots(3, 1, figsize=(9, 9), sharex=True)
    for comps, label in [(ad, "adiabatic −h22/ω²"), (it, "twice-integrated h22"), (orb, "PN orbit μa²nn (Kepler)")]:
        ax[0].plot(b.t, rot(comps), label=label)
        ax[1].plot(b.t, np.unwrap(2 * (ang(comps) - ang(ad))) / 2, label=label)
    ax[0].set_ylabel("rotating |I| (M³)")
    ax[0].set_yscale("log")
    ax[0].legend()
    ax[1].set_ylabel("major-axis angle − adiabatic (rad)")
    ax[2].plot(b.t, b.omega22, "k")
    ax[2].set_ylabel("ω22")
    ax[2].set_xlabel("t (M)")
    for a in ax:
        a.axvline(0, color="0.7", lw=0.8)
    ax[0].set_xlim(-1500, 150)
    fig.suptitle(f"Mass quadrupole, q={b.q}, χ1={b.chi1}, χ2={b.chi2}")
    fig.tight_layout()
    fig.savefig(args.out, dpi=110)
    for tt in (-1500, -500, -100, -20, 0, 20, 60):
        j = np.searchsorted(b.t, tt)
        print(f"t={tt:6}: |I| adiabatic {rot(ad[j]):.3e}  integrated {rot(it[j]):.3e}  orbit {rot(orb[j]):.3e}")


if __name__ == "__main__":
    _main()
