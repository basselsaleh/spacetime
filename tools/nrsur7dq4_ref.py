"""Reference reader and evaluator for the STSUR002 (NRSur7dq4) file.

A plain-NumPy re-implementation of gwsurrogate's NRSur7dq4 evaluation that
reads only the exported file: the specification for the Rust port (step 7b)
and the check that the export loses nothing (compare_nrsur7dq4.py).

File layout (all little-endian):

    8 bytes   magic "STSUR002"
    u32       header length in bytes (H)
    H bytes   UTF-8 JSON header
    then three sections, each starting on a multiple of 8 bytes from the file
    start (zero padding), with element counts in header "counts":
    u32       packed basis-function orders ("orders" spans)
    f32       empirical-interpolation bases and polynomial coefficients
              ("basis", "coefs" spans)
    f64       times ("t_ds", "t_coorb") and the remnant GPR data

Header spans are [offset, length] in elements of their section.

Only the reference epoch at the start of the data (gwsurrogate's default,
fM_ref = 0) is supported: the spins are given at t_ds[0] ≈ -4300 M in the
co-orbital frame there, and the ODE is integrated forward only.

Conventions follow gwsurrogate: quaternions are (w, x, y, z); the
coprecessing frame is `quat`, the co-orbital frame quat * z-rotation by the
orbital phase; modes are ordered (2,-2) … (2,2), (3,-3) … (4,4).
"""

from __future__ import annotations

import json
import struct
from dataclasses import dataclass
from math import comb, factorial, sqrt
from pathlib import Path

import numpy as np
from scipy.interpolate import CubicSpline

MAGIC = b"STSUR002"


# ---------------------------------------------------------------- file reading

class Model:
    def __init__(self, path: Path) -> None:
        raw = Path(path).read_bytes()
        if raw[:8] != MAGIC:
            raise ValueError("not an STSUR002 file")
        (n,) = struct.unpack("<I", raw[8:12])
        self.header = h = json.loads(raw[12:12 + n])
        pos = 12 + n
        sections = {}
        for name, dtype in (("u32", "<u4"), ("f32", "<f4"), ("f64", "<f8")):
            pos += -pos % 8
            count = h["counts"][name]
            sections[name] = np.frombuffer(raw, dtype, count, pos)
            pos += count * np.dtype(dtype).itemsize
        if pos != len(raw):
            raise ValueError("file length does not match the section counts")
        self.u32 = sections["u32"].astype(np.int64)
        self.f32 = sections["f32"].astype(np.float64)
        self.f64 = sections["f64"].astype(np.float64)
        fs = h["fit_settings"]
        self.q_offset, self.q_slope = fs["q_fit_offset"], fs["q_fit_slope"]
        self.qmax, self.cmax = fs["q_max_order"], fs["chi_max_order"]
        self.t_ds = self.real(h["t_ds"])
        self.t_coorb = self.real(h["t_coorb"])
        self.dyn = [[self.poly(f) for f in node] for node in h["dynamics"]]
        self.comps = [Component(c["l"], c["m"], c["part"], np.array(c["node_indices"]),
                                self.single(c["basis"]).reshape(len(c["node_indices"]), -1),
                                [self.poly(f) for f in c["fits"]])
                      for c in h["coorbital"]]
        self.remnant = h.get("remnant")

    def real(self, span) -> np.ndarray:
        """An f64-section span."""
        o, n = span
        return self.f64[o:o + n]

    def single(self, span) -> np.ndarray:
        """An f32-section span, widened to f64."""
        o, n = span
        return self.f32[o:o + n]

    def poly(self, f) -> "Poly":
        o, n = f["orders"]
        packed = self.u32[o:o + n]
        orders = (packed[:, None] // 4 ** np.arange(7)) % 4
        return Poly(orders, self.single(f["coefs"]))


@dataclass
class Poly:
    orders: np.ndarray  # (n, 7)
    coefs: np.ndarray   # (n,)


@dataclass
class Component:
    l: int
    m: int
    part: str
    node_indices: np.ndarray
    basis: np.ndarray
    fits: list


# ---------------------------------------------------------------- fits

def fit_params(q: float, chiA: np.ndarray, chiB: np.ndarray) -> np.ndarray:
    """[ln q, χAx, χAy, χ̂, χBx, χBy, χa] from co-orbital-frame spins."""
    eta = q / (1 + q) ** 2
    chi_wt = (q * chiA[2] + chiB[2]) / (1 + q)
    chi_hat = (chi_wt - 38 * eta / 113 * (chiA[2] + chiB[2])) / (1 - 76 * eta / 113)
    chi_a = (chiA[2] - chiB[2]) / 2
    return np.array([np.log(q), chiA[0], chiA[1], chi_hat, chiB[0], chiB[1], chi_a])


def eval_poly(model: Model, p: Poly, x: np.ndarray) -> float:
    base = np.concatenate([[model.q_offset + model.q_slope * x[0]], x[1:]])
    # powers[j, k] = base_j^k
    powers = base[:, None] ** np.arange(4)[None, :]
    terms = np.prod(powers[np.arange(7), p.orders], axis=1)
    return float(p.coefs @ terms)


def gpr(node: dict, model: Model, x: np.ndarray) -> float:
    xt = model.real(node["x_train"]).reshape(-1, 7)
    w = model.real(node["weights"])
    d = (x - xt) * np.asarray(node["inv_length_scale"])
    k = np.exp(-0.5 * np.sum(d * d, axis=1))
    return node["scale"] * float(w @ k) + float(np.dot(node["linear"], x)) + node["offset"]


# ---------------------------------------------------------------- quaternions

def qmul(a, b):
    """Hamilton product of (4, ...) arrays."""
    return np.array([
        a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
        a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
        a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
        a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0]])


def qinv(a):
    return np.array([a[0], -a[1], -a[2], -a[3]]) / np.sum(a * a, axis=0)


def rotate_vec(quat, v):
    """quat v quat⁻¹ for quat (4, N), v (3, N)."""
    vq = np.concatenate([np.zeros((1,) + np.shape(v)[1:]), v])
    return qmul(quat, qmul(vq, qinv(quat)))[1:]


def wigner_d(quat, ell_max: int) -> list[np.ndarray]:
    """W[ell-2][ell+m, ell+m', i]: gwsurrogate's _wignerD_matrices, with
    Ra = w + i z, Rb = y + i x. Rotations about z (|Rb| = 0) and by π about
    an axis in the xy-plane (|Ra| = 0) are special-cased, as in gwsurrogate."""
    ra = quat[0] + 1j * quat[3]
    rb = quat[2] + 1j * quat[1]
    a2, b2 = np.abs(ra) ** 2, np.abs(rb) ** 2
    only_b = a2 < 1e-24
    only_a = ~only_b & (b2 < 1e-24)
    gen = ~only_a & ~only_b
    rag, rbg = ra[gen], rb[gen]
    ratio = b2[gen] / a2[gen]
    out = []
    for ell in range(2, ell_max + 1):
        mat = np.zeros((2 * ell + 1, 2 * ell + 1, ra.size), dtype=complex)
        for m in range(-ell, ell + 1):
            mat[ell + m, ell + m, only_a] = ra[only_a] ** (2 * m)
            sgn = 1.0 if (ell + m) % 2 else -1.0
            mat[ell + m, ell - m, only_b] = sgn * rb[only_b] ** (2 * m)
            for mp in range(-ell, ell + 1):
                c = sqrt(factorial(ell + m) * factorial(ell - m)
                         / (factorial(ell + mp) * factorial(ell - mp)))
                s = 0
                for rho in range(max(0, mp - m), min(ell + mp, ell - m) + 1):
                    s = s + comb(ell + mp, rho) * comb(ell - mp, ell - rho - m) * (-1) ** rho * ratio ** rho
                mat[ell + m, ell + mp, gen] = (c * np.abs(rag) ** (2 * ell - 2 * m)
                                               * rag ** (m + mp) * rbg ** (m - mp) * s)
        out.append(mat)
    return out


def rotate_modes(quat, h):
    """Modes in the frame `quat` → inertial modes (gwsurrogate rotateWaveform)."""
    mats = wigner_d(qinv(quat), 4)
    res = np.zeros_like(h)
    i = 0
    for ell in range(2, 5):
        n = 2 * ell + 1
        res[i:i + n] = np.einsum("abt,bt->at", mats[ell - 2], h[i:i + n])
        i += n
    return res


# ---------------------------------------------------------------- dynamics

def normalize_y(y, normA, normB):
    y = y.copy()
    y[:4] /= np.linalg.norm(y[:4])
    for sl, norm in ((slice(5, 8), normA), (slice(8, 11), normB)):
        n = np.linalg.norm(y[sl])
        y[sl] = y[sl] * norm / n if n > 0 else 0.0
    return y


def dydt(model: Model, q: float, node: int, y: np.ndarray) -> np.ndarray:
    cp, sp = np.cos(y[4]), np.sin(y[4])
    rot = lambda v: np.array([v[0] * cp + v[1] * sp, -v[0] * sp + v[1] * cp, v[2]])  # noqa: E731
    x = fit_params(q, rot(y[5:8]), rot(y[8:11]))
    f = [eval_poly(model, p, x) for p in model.dyn[node]]
    ox = f[0] * cp - f[1] * sp
    oy = f[0] * sp + f[1] * cp
    return np.array([
        -0.5 * y[1] * ox - 0.5 * y[2] * oy,
        -0.5 * y[3] * oy + 0.5 * y[0] * ox,
        0.5 * y[3] * ox + 0.5 * y[0] * oy,
        0.5 * y[1] * oy - 0.5 * y[2] * ox,
        f[2],
        f[3] * cp - f[4] * sp, f[3] * sp + f[4] * cp, f[5],
        f[6] * cp - f[7] * sp, f[6] * sp + f[7] * cp, f[8],
    ])


def ab4_dy(k1, k2, k3, k4, dt1, dt2, dt3, dt4):
    dt12, dt23 = dt1 + dt2, dt2 + dt3
    dt123 = dt12 + dt3
    D1, D2, D3 = dt1 * dt12 * dt123, dt1 * dt2 * dt23, dt2 * dt12 * dt3
    B41, B42, B43 = dt3 * dt23 / D1, -dt3 * dt123 / D2, dt23 * dt123 / D3
    C41, C42, C43 = (dt23 + dt3) / D1, -(dt123 + dt3) / D2, (dt123 + dt23) / D3
    A = k4
    B = k4 * (B41 + B42 + B43) - k1 * B41 - k2 * B42 - k3 * B43
    C = k4 * (C41 + C42 + C43) - k1 * C41 - k2 * C42 - k3 * C43
    D = (k4 - k1) / D1 - (k4 - k2) / D2 + (k4 - k3) / D3
    return dt4 * (A + dt4 * (0.5 * B + dt4 * (C / 3 + dt4 * 0.25 * D)))


def dynamics(model: Model, q: float, chiA0, chiB0, init_quat=None):
    """Integrates from t_ds[0]. Returns (t, y) on the 230 full nodes; y rows are
    [quat(4), orbital phase, χA (3), χB (3)], spins in the coprecessing frame."""
    t = model.t_ds
    dts = np.diff(t)
    chiA0, chiB0 = np.asarray(chiA0, float), np.asarray(chiB0, float)
    normA, normB = np.linalg.norm(chiA0), np.linalg.norm(chiB0)
    y = np.empty((t.size - 3, 11))
    y[0] = np.concatenate([[1, 0, 0, 0, 0], chiA0, chiB0])
    if init_quat is not None:
        y[0, :4] = init_quat
    # Three RK4 steps over the half-node pairs (nodes 0..6).
    ks, hs = [], []
    for i in range(3):
        dt = dts[2 * i]
        k1 = dydt(model, q, 2 * i, y[i])
        k2 = dydt(model, q, 2 * i + 1, y[i] + dt * k1)
        k3 = dydt(model, q, 2 * i + 1, y[i] + dt * k2)
        k4 = dydt(model, q, 2 * i + 2, y[i] + 2 * dt * k3)
        y[i + 1] = normalize_y(y[i] + dt / 3 * (k1 + 2 * k2 + 2 * k3 + k4), normA, normB)
        ks.append(k1)
        hs.append(2 * dt)
    # AB4 on the remaining nodes.
    k1, k2, k3 = ks
    dt1, dt2, dt3 = hs
    for i, dt4 in enumerate(dts[6:]):
        j = 3 + i
        k4 = dydt(model, q, j + 3, y[j])
        y[j + 1] = normalize_y(y[j] + ab4_dy(k1, k2, k3, k4, dt1, dt2, dt3, dt4), normA, normB)
        k1, k2, k3 = k2, k3, k4
        dt1, dt2, dt3 = dt2, dt3, dt4
    return np.concatenate([t[0:6:2], t[6:]]), y


# ---------------------------------------------------------------- waveform

def natural(t_out, t_in, y_in, axis=-1):
    return CubicSpline(t_in, y_in, axis=axis, bc_type="natural")(t_out)


def coorbital_modes(model: Model, q: float, chiA, chiB) -> np.ndarray:
    """chiA, chiB: co-orbital spins on t_coorb, shape (N, 3)."""
    vals = {}
    for c in model.comps:
        nodes = np.array([eval_poly(model, f, fit_params(q, chiA[i], chiB[i]))
                          for f, i in zip(c.fits, c.node_indices)])
        vals[(c.l, c.m, c.part)] = nodes @ c.basis
    h = np.zeros((21, model.t_coorb.size), dtype=complex)
    for ell in range(2, 5):
        base = ell * (ell + 1) - 4
        h[base] = vals[(ell, 0, "real")] + 1j * vals[(ell, 0, "imag")]
        for m in range(1, ell + 1):
            rp, rm = vals[(ell, m, "Re+")], vals[(ell, m, "Re-")]
            ip, im = vals[(ell, m, "Im+")], vals[(ell, m, "Im-")]
            h[base + m] = (rp - rm) + 1j * (im - ip)
            h[base - m] = (rp + rm) + 1j * (ip + im)
    return h


@dataclass
class Result:
    t: np.ndarray          # output times
    h: np.ndarray          # (21, N) inertial modes
    quat: np.ndarray       # (4, N) coprecessing frame
    orbphase: np.ndarray   # (N,)
    chiA: np.ndarray       # (N, 3) inertial frame
    chiB: np.ndarray
    t_ds: np.ndarray       # dynamics nodes and raw dynamics, for the remnant
    y_ds: np.ndarray


def evaluate(model: Model, q, chiA0, chiB0, init_quat=None, dt=None) -> Result:
    chiA0, chiB0 = np.asarray(chiA0, float), np.asarray(chiB0, float)
    normA, normB = np.linalg.norm(chiA0), np.linalg.norm(chiB0)
    tds, y = dynamics(model, q, chiA0, chiB0, init_quat)
    tc = model.t_coorb

    def dyn_on(times):
        cA = natural(times, tds, y[:, 5:8], axis=0)
        cB = natural(times, tds, y[:, 8:11], axis=0)
        for c, n in ((cA, normA), (cB, normB)):
            if n > 0:
                c *= n / np.linalg.norm(c, axis=1, keepdims=True)
        ph = natural(times, tds, y[:, 4])
        qu = natural(times, tds, y[:, :4], axis=0).T
        return cA, cB, ph, qu / np.linalg.norm(qu, axis=0)

    cA, cB, ph, qu = dyn_on(tc)
    cp, sp = np.cos(ph)[:, None], np.sin(ph)[:, None]
    to_coorb = lambda c: np.stack([c[:, 0] * cp[:, 0] + c[:, 1] * sp[:, 0],  # noqa: E731
                                   c[:, 1] * cp[:, 0] - c[:, 0] * sp[:, 0], c[:, 2]], axis=1)
    h_co = coorbital_modes(model, q, to_coorb(cA), to_coorb(cB))
    zrot = np.array([np.cos(ph / 2), 0 * ph, 0 * ph, np.sin(ph / 2)])
    h = rotate_modes(qmul(qu, zrot), h_co)
    t_out = tc
    if dt is not None:
        n = int(np.ceil((tc[-1] - tc[0]) / dt))
        t_out = tc[0] + dt * np.arange(n)
        h = natural(t_out, tc, h)
        cA, cB, ph, qu = dyn_on(t_out)
    return Result(t_out, h, qu, ph, rotate_vec(qu, cA.T).T, rotate_vec(qu, cB.T).T, tds, y)


# ---------------------------------------------------------------- remnant

FIT_NODE_TIME = -100.0


def remnant(model: Model, q: float, res: Result):
    """m_f, χ_f, v_f (inertial frame) from the dynamics node nearest t = -100 M,
    as surfinBH's NRSur7dq4Remnant does when it evolves the spins itself."""
    i = int(np.argmin(np.abs(res.t_ds - FIT_NODE_TIME)))
    y = res.y_ds[i]
    cp, sp = np.cos(y[4]), np.sin(y[4])
    rot = lambda v: np.array([v[0] * cp + v[1] * sp, -v[0] * sp + v[1] * cp, v[2]])  # noqa: E731
    chiA, chiB = rot(y[5:8]), rot(y[8:11])
    mf, chif, vf = remnant_coorbital(model, q, chiA, chiB)
    frame = qmul(y[:4], np.array([np.cos(y[4] / 2), 0, 0, np.sin(y[4] / 2)]))
    to_inertial = lambda v: rotate_vec(frame[:, None], v[:, None])[:, 0]  # noqa: E731
    return mf, to_inertial(chif), to_inertial(vf)


def remnant_coorbital(model: Model, q: float, chiA, chiB):
    """The fits themselves: spins and results in the co-orbital frame at -100 M."""
    r = model.remnant
    x = fit_params(q, np.asarray(chiA, float), np.asarray(chiB, float))
    mf = gpr(r["mf"], model, x)
    chif = np.array([gpr(n, model, x) for n in r["chif"]])
    vf = np.array([gpr(n, model, x) for n in r["vf"]])
    return mf, chif, vf
