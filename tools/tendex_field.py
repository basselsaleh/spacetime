"""Tidal (E) and frame-drag (B) tensors of a mass monopole plus a time-varying
mass quadrupole in linearized gravity, derived symbolically.

Metric (harmonic gauge, G = c = 1, trace-reversed perturbation, retarded time
u = t - r, I_ij the STF mass quadrupole):

    hbar^00 = 4M/r + 2 d_i d_j [I_ij(u)/r]
    hbar^0i = -2 d_j [I'_ij(u)/r]
    hbar^ij = 2 I''_ij(u)/r

This is an exact vacuum solution of the linearized Einstein equations for any
I_ij(u) (it satisfies the gauge condition identically), with near, intermediate
and far terms and retardation. Riemann is linearized:

    R_abcd = 1/2 (h_ad,bc + h_bc,ad - h_ac,bd - h_bd,ac)
    E_ij = R_0i0j,   B_ij = 1/2 eps_ipq R_pqj0

The B convention is the one used by Nichols et al. 2011 (from memory; it only
sets the sign of B). Geodesic deviation: d^2 xi_i/dt^2 = -E_ij xi_j, so an
eigenvalue < 0 stretches along its eigenvector and > 0 squeezes.

The fields are polynomials in the derivatives I^(n)(u) (n = 0..4) with
coefficients depending on position. They are built with symbols I<c>_<n> for
the five independent STF components c and lambdified with common
subexpressions.

Run directly to check the result:
    env -u VIRTUAL_ENV uv run python tendex_field.py
"""

from __future__ import annotations

import functools

import numpy as np
import sympy as sp

COMPONENTS = ("xx", "yy", "xy", "xz", "yz")  # zz = -xx - yy (trace-free)
NDER = 5  # I, I', I'', I''', I''''
_x, _y, _z = sp.symbols("x y z", real=True)
_X = (_x, _y, _z)
_r = sp.sqrt(_x**2 + _y**2 + _z**2)
_M = sp.Symbol("M")
# One extra derivative order so differentiating the top order is defined (it never survives).
_I = {c: [sp.Symbol(f"I{c}_{n}") for n in range(NDER + 1)] for c in COMPONENTS}


def _imat(n: int) -> sp.Matrix:
    d = {c: _I[c][n] for c in COMPONENTS}
    return sp.Matrix(
        [
            [d["xx"], d["xy"], d["xz"]],
            [d["xy"], d["yy"], d["yz"]],
            [d["xz"], d["yz"], -d["xx"] - d["yy"]],
        ]
    )


def _dt(f):
    """d/dt: every I^(n)(u) becomes I^(n+1)(u)."""
    return sum(sp.diff(f, _I[c][n]) * _I[c][n + 1] for c in COMPONENTS for n in range(NDER))


def _d(f, mu: int):
    """Partial derivative along coordinate mu (0 = t, 1..3 = x, y, z), with u = t - r."""
    if mu == 0:
        return _dt(f)
    i = mu - 1
    return sp.diff(f, _X[i]) - _X[i] / _r * _dt(f)


@functools.lru_cache(maxsize=1)
def _build():
    i0, i1, i2 = _imat(0), _imat(1), _imat(2)
    hb00 = 4 * _M / _r + 2 * sum(_d(_d(i0[i, j] / _r, i + 1), j + 1) for i in range(3) for j in range(3))
    hb0 = [-2 * sum(_d(i1[i, j] / _r, j + 1) for j in range(3)) for i in range(3)]
    hbij = 2 * i2 / _r
    # Lower indices with eta = diag(-1, 1, 1, 1) and undo the trace reversal
    # (trace of hbar = -hbar^00, since I'' is trace-free).
    h = [[None] * 4 for _ in range(4)]
    h[0][0] = hb00 / 2
    for i in range(3):
        h[0][i + 1] = h[i + 1][0] = -hb0[i]
        for j in range(3):
            h[i + 1][j + 1] = hbij[i, j] + (hb00 / 2 if i == j else 0)

    def riemann(a, b, c, d):
        return (
            _d(_d(h[a][d], b), c) + _d(_d(h[b][c], a), d) - _d(_d(h[a][c], b), d) - _d(_d(h[b][d], a), c)
        ) / 2

    E = sp.Matrix(3, 3, lambda i, j: riemann(0, i + 1, 0, j + 1))
    eps = sp.LeviCivita
    B = sp.Matrix(
        3,
        3,
        lambda i, j: sum(
            eps(i, p, q) * riemann(p + 1, q + 1, j + 1, 0) for p in range(3) for q in range(3) if p != q
        )
        / 2,
    )
    args = [_x, _y, _z, _M] + [_I[c][n] for c in COMPONENTS for n in range(NDER)]
    fE = sp.lambdify(args, list(E), modules="numpy", cse=True)
    fB = sp.lambdify(args, list(B), modules="numpy", cse=True)
    return fE, fB


def _call(f, p, M, ider):
    """p: (..., 3) points; ider: (5, NDER) derivatives of the STF components. Returns (..., 3, 3)."""
    p = np.asarray(p, dtype=float)
    ider = np.asarray(ider, dtype=float)
    comps = [ider[..., c, n] for c in range(5) for n in range(NDER)]
    vals = f(p[..., 0], p[..., 1], p[..., 2], M, *comps)
    vals = [np.broadcast_to(np.asarray(v, dtype=float), p.shape[:-1]) for v in vals]
    return np.stack(vals, axis=-1).reshape(p.shape[:-1] + (3, 3))


def tidal(p, M, ider):
    """E_ij at points p for monopole M and quadrupole derivatives ider[c, n] at u = t - r.

    ider is either one (5, NDER) array for every point, or (..., 5, NDER) with
    each point's own retarded-time values.
    """
    return _call(_build()[0], p, M, ider)


def frame_drag(p, M, ider):
    """B_ij (see `tidal`)."""
    return _call(_build()[1], p, M, ider)


def stf(m: np.ndarray) -> np.ndarray:
    """The five independent components (xx, yy, xy, xz, yz) of a symmetric 3x3 matrix's trace-free part."""
    m = m - np.trace(m) / 3 * np.eye(3)
    return np.array([m[0, 0], m[1, 1], m[0, 1], m[0, 2], m[1, 2]])


def stf_matrix(c) -> np.ndarray:
    xx, yy, xy, xz, yz = c
    return np.array([[xx, xy, xz], [xy, yy, yz], [xz, yz, -xx - yy]])


# ---------------------------------------------------------------- closed form
#
# By rotational covariance E and B are built from n = x/r and each STF
# derivative Q = I^(k) (Qn = Q n, Qnn = n Q n) with radial coefficients, which
# sympy extracts from the field on the z axis. With s = r^-(5-k):
#
#   E_ij = M/r^3 (d_ij - 3 n_i n_j)
#        + sum_k s [a Q_ij + b (n_i Qn_j + Qn_i n_j) + c d_ij Qnn + d n_i n_j Qnn]
#   B_ij = sum_k s [e sym(eps_ipq n_p Q_qj) + f sym(eps_ipq n_p Qn_q n_j)]
#
# with sym(X)_ij = (X_ij + X_ji)/2. The k = 4 row is the transverse-traceless
# projection: far away E = -(1/r) (d^4 I/dt^4)^TT. crates/physics/src/tendex.rs
# implements this; `_check` verifies it against the symbolic field.

E_COEF = ((-3, 15, 7.5, -52.5), (-3, 15, 7.5, -52.5), (-3, 9, 1.5, -22.5), (-2, 4, -1, -5), (-1, 1, -0.5, -0.5))
B_COEF = ((0, 0), (-3, 15), (-3, 15), (-2, 6), (-1, 1))
_EPS = np.zeros((3, 3, 3))
_EPS[0, 1, 2] = _EPS[1, 2, 0] = _EPS[2, 0, 1] = 1
_EPS[0, 2, 1] = _EPS[2, 1, 0] = _EPS[1, 0, 2] = -1


def closed_form(p, M, ider):
    """E and B at one point from the closed form above (ider: (5, NDER))."""
    p = np.asarray(p, float)
    r = np.linalg.norm(p)
    n = p / r
    E = M / r**3 * (np.eye(3) - 3 * np.outer(n, n))
    B = np.zeros((3, 3))
    for k in range(NDER):
        Q = stf_matrix(ider[:, k])
        Qn = Q @ n
        Qnn = n @ Qn
        s = r ** -(5 - k)
        a, b, c, d = E_COEF[k]
        E += s * (a * Q + b * (np.outer(n, Qn) + np.outer(Qn, n)) + c * Qnn * np.eye(3) + d * Qnn * np.outer(n, n))
        e, f = B_COEF[k]
        X1 = np.einsum("ipq,p,qj->ij", _EPS, n, Q)
        X2 = np.outer(np.einsum("ipq,p,q->i", _EPS, n, Qn), n)
        B += s * (e * (X1 + X1.T) / 2 + f * (X2 + X2.T) / 2)
    return E, B


# ---------------------------------------------------------------- checks


def _check() -> None:
    rng = np.random.default_rng(1)
    ider = rng.normal(size=(5, NDER))
    M = 0.7
    pts = rng.normal(size=(20, 3)) * 5

    E = tidal(pts, M, ider)
    B = frame_drag(pts, M, ider)
    scale = np.abs(E).max()
    sym = max(np.abs(E - E.swapaxes(-1, -2)).max(), np.abs(B - B.swapaxes(-1, -2)).max()) / scale
    tr = max(np.abs(np.trace(E, axis1=-2, axis2=-1)).max(), np.abs(np.trace(B, axis1=-2, axis2=-1)).max()) / scale
    print(f"symmetric: {sym:.1e}   traceless: {tr:.1e}")
    assert sym < 1e-12 and tr < 1e-12

    # Static limit: E_ij = d_i d_j Phi, Phi = -M/r - (3/2) I_kl x_k x_l / r^5 (Newtonian), B = 0.
    static = ider.copy()
    static[:, 1:] = 0
    I0 = stf_matrix(static[:, 0])
    Es = tidal(pts, M, static)
    Bs = frame_drag(pts, M, static)
    xs, ys, zs = sp.symbols("xs ys zs")
    rs = sp.sqrt(xs**2 + ys**2 + zs**2)
    Xs = sp.Matrix([xs, ys, zs])
    phi = -M / rs - sp.Rational(3, 2) * (Xs.T * sp.Matrix(I0) * Xs)[0] / rs**5
    hess = sp.lambdify((xs, ys, zs), sp.hessian(phi, (xs, ys, zs)), "numpy")
    En = np.array([np.array(hess(*q), dtype=float) for q in pts])
    err = np.abs(Es - En).max() / np.abs(En).max()
    print(f"static limit vs Newtonian tidal field: {err:.1e}   |B| static: {np.abs(Bs).max():.1e}")
    assert err < 1e-12 and np.abs(Bs).max() < 1e-12

    # Far zone: r E_ij -> -(I'''')^TT_ij and B_ij -> eps_ipq n_p E_qj (outgoing wave).
    # The quadrupole field is evaluated at one retarded time, so set every point to a large r.
    for R in (1e4, 1e6):
        n = rng.normal(size=(10, 3))
        n /= np.linalg.norm(n, axis=1, keepdims=True)
        E = tidal(n * R, M=0.0, ider=ider)
        B = frame_drag(n * R, M=0.0, ider=ider)
        I4 = stf_matrix(ider[:, 4])
        errE, errB = 0.0, 0.0
        for k in range(len(n)):
            P = np.eye(3) - np.outer(n[k], n[k])
            tt = P @ I4 @ P - 0.5 * P * np.trace(P @ I4)
            errE = max(errE, np.abs(R * E[k] + tt).max() / np.abs(tt).max())
            eps = np.zeros((3, 3, 3))
            eps[0, 1, 2] = eps[1, 2, 0] = eps[2, 0, 1] = 1
            eps[0, 2, 1] = eps[2, 1, 0] = eps[1, 0, 2] = -1
            bexp = np.einsum("ipq,p,qj->ij", eps, n[k], E[k])
            errB = max(errB, np.abs(B[k] - bexp).max() / np.abs(bexp).max())
        print(f"far zone r = {R:.0e}: r·E vs -I''''^TT {errE:.1e}   B vs n×E {errB:.1e}")
    assert errE < 1e-3 and errB < 1e-3
    worst = 0.0
    for _ in range(30):
        p = rng.normal(size=3) * rng.uniform(1, 50)
        d = rng.normal(size=(5, NDER))
        m = rng.uniform(0, 2)
        Ec, Bc = closed_form(p, m, d)
        E0, B0 = tidal(p, m, d), frame_drag(p, m, d)
        worst = max(worst, np.abs(Ec - E0).max() / np.abs(E0).max(), np.abs(Bc - B0).max() / np.abs(B0).max())
    print(f"closed form vs symbolic: {worst:.1e}")
    assert worst < 1e-12
    print("all checks passed")


if __name__ == "__main__":
    _check()
