"""Export the NRSur7dq4 precessing surrogate (and optionally its remnant fits)
to the app's STSUR002 format.

NRSur7dq4 (Varma et al. 2019, arXiv:1905.09300) has three parts, all exported
here unchanged except for packing:

- Dynamics: at each of the 233 dynamics nodes (t_ds), 9 polynomial fits give
  the ODE right-hand side: the coprecessing-frame rotation rate (2 components,
  co-orbital frame), the orbital frequency, and dχ_A/dt, dχ_B/dt (co-orbital).
- Co-orbital waveform: 42 real components (Re±, Im± for m > 0; real, imag for
  m = 0), each an empirical-interpolation basis on the 2000-sample t_coorb
  grid times polynomial fits evaluated at its node times.
- Remnant (optional): NRSur7dq4Remnant GPR fits for m_f, χ_f and v_f, in the
  co-orbital frame at t = -100 M. Only the parts needed for the fit value are
  kept; the error-estimate data are dropped.

Polynomial fits: value = Σ_i coef_i Π_j B_{o_ij}(x_j), where B_k(x) = x^k and
x_0 is ln q rescaled to [-1, 1]. Each term's 7 orders o_ij (q order ≤ 3, χ
orders ≤ 2) are packed base 4 into one integer, Σ_j o_ij 4^j.

Storage: bases and polynomial coefficients as f32 (1.3e-6 of the peak |h22|
and 8e-7 in the frame dynamics, measured with compare_nrsur7dq4.py); times
and the remnant data as f64. Format: see tools/nrsur7dq4_ref.py (reference
reader and evaluator).

Usage:
    uv run python export_nrsur7dq4.py data/NRSur7dq4.h5 out/nrsur7dq4.stsur \
        --remnant data/fit_7dq4.h5
"""

from __future__ import annotations

import argparse
import json
import struct
from pathlib import Path

import h5py
import numpy as np

MAGIC = b"STSUR002"
ATTRIBUTION = (
    "Waveforms: NRSur7dq4 surrogate, V. Varma et al., Phys. Rev. Research 1, 033015 "
    "(2019), arXiv:1905.09300. Data: doi:10.5281/zenodo.3348115, CC BY 4.0."
)
REMNANT_ATTRIBUTION = (
    " Remnant: NRSur7dq4Remnant, same reference. Data: doi:10.5281/zenodo.3455886,"
    " CC BY 4.0; error-estimate data removed."
)

# gwsurrogate.surrogate.NRSur7dq4: ln q in [-0.01, ln(4.01)] rescaled to [-1, 1].
FIT_SETTINGS = {
    "q_fit_offset": -0.9857019407834238,
    "q_fit_slope": 1.4298059216576398,
    "q_max_order": 3,
    "chi_max_order": 2,
}
DYN_FITS = [("omega_orb", 0), ("omega_orb", 1), ("omega", None),
            ("chiA", 0), ("chiA", 1), ("chiA", 2), ("chiB", 0), ("chiB", 1), ("chiB", 2)]


class Blob:
    """Accumulates arrays of one element type and hands back [offset, len]
    spans, in elements of that type."""

    def __init__(self, dtype: str) -> None:
        self.dtype = dtype
        self.chunks: list[np.ndarray] = []
        self.size = 0

    def add(self, arr) -> list[int]:
        a = np.ascontiguousarray(np.asarray(arr, dtype=self.dtype).ravel())
        span = [self.size, int(a.size)]
        self.chunks.append(a)
        self.size += a.size
        return span

    def bytes(self) -> bytes:
        return b"".join(c.tobytes() for c in self.chunks)


def pack_orders(orders: np.ndarray) -> np.ndarray:
    orders = np.asarray(orders, dtype=np.int64)
    if orders.ndim != 2 or orders.shape[1] != 7:
        raise ValueError(f"bfOrders shape {orders.shape}")
    if orders[:, 0].max(initial=0) > FIT_SETTINGS["q_max_order"] or \
            orders[:, 1:].max(initial=0) > FIT_SETTINGS["chi_max_order"]:
        raise ValueError("basis-function order out of range")
    return (orders * 4 ** np.arange(7)).sum(axis=1)


class Sections:
    """The file's three data sections: u32 (packed orders), f32 (bases and
    polynomial coefficients) and f64 (times and the remnant GPR data)."""

    def __init__(self) -> None:
        self.u32, self.f32, self.f64 = Blob("<u4"), Blob("<f4"), Blob("<f8")


def export_poly(orders, coefs, sec: Sections) -> dict:
    coefs = np.asarray(coefs, dtype=float).ravel()
    packed = pack_orders(orders)
    if packed.size != coefs.size:
        raise ValueError("orders and coefs differ in length")
    return {"orders": sec.u32.add(packed), "coefs": sec.f32.add(coefs)}


def export_dynamics(h: h5py.File, sec: Sections) -> list[list[dict]]:
    nodes = []
    for i in range(h["t_ds"].shape[0]):
        g = h[f"ds_node_{i}"]
        fits = []
        for key, comp in DYN_FITS:
            name = key if comp is None else f"{key}_{comp}"
            fits.append(export_poly(g[f"{name}_bfOrders"][()], g[f"{name}_coefs"][()], sec))
        nodes.append(fits)
    return nodes


def export_coorbital(h: h5py.File, sec: Sections) -> list[dict]:
    comps = []
    for ell in range(2, 5):
        parts = [(0, "real"), (0, "imag")] + [(m, p) for m in range(1, ell + 1)
                                               for p in ("Re+", "Re-", "Im+", "Im-")]
        for m, part in parts:
            name = f"hCoorb_{ell}_{m}_{part}"
            if name not in h:
                raise KeyError(name)
            g = h[name]
            idx = np.asarray(g["nodeIndices"][()], dtype=np.int64).ravel()
            basis = np.asarray(g["EIBasis"][()], dtype=float)
            if basis.shape != (idx.size, h["t_coorb"].shape[0]):
                raise ValueError(f"{name}: basis shape {basis.shape}")
            fits = [export_poly(g["nodeModelers"][f"bfOrders_{k}"][()],
                                g["nodeModelers"][f"coefs_{k}"][()], sec)
                    for k in range(idx.size)]
            comps.append({"l": ell, "m": m, "part": part, "node_indices": idx.tolist(),
                          "basis": sec.f32.add(basis), "fits": fits})
    return comps


def export_gpr7(fit: dict, reals: Blob) -> dict:
    """Fold a 7D GPR fit (ConstantKernel*RBF + WhiteKernel, linear fit
    subtracted) into y(x) = scale·Σ_j w_j exp(-½|(x - X_j)/ℓ|²) + linear·x + offset.
    The same folding as export_surrogate.py's export_gpr, for 7 inputs."""
    from gwsurrogate.eval_pysur.evaluate_fit import GPRPredictor

    fit = dict(fit)
    if fit.get("fitType") not in ("GPR", "GPR_fast"):
        raise NotImplementedError(f"fit type {fit.get('fitType')}")
    k = fit["GPR_params"]["kernel_"]
    names = (k["name"], k["k1"]["name"], k["k1"]["k1"]["name"], k["k1"]["k2"]["name"], k["k2"]["name"])
    if names != ("Sum", "Product", "ConstantKernel", "RBF", "WhiteKernel"):
        raise NotImplementedError(f"kernel {names}")

    pred = GPRPredictor(fit)
    gpr = pred.GPR_obj
    prod = gpr.kernel_.k1
    const = float(prod.k1.constant_value)
    length = np.broadcast_to(np.asarray(prod.k2.length_scale, dtype=float), (7,))
    x_train = np.asarray(gpr.X_train_, dtype=float)
    alpha = np.asarray(gpr.alpha_, dtype=float).ravel()
    if x_train.shape != (alpha.size, 7):
        raise ValueError(f"unexpected X_train shape {x_train.shape}")
    scalar = lambda v: float(np.asarray(v, dtype=float).ravel()[0])  # noqa: E731
    lin = pred.linearModel
    return {
        "x_train": reals.add(x_train),
        "weights": reals.add(const * alpha),
        "inv_length_scale": (1.0 / length).tolist(),
        "scale": scalar(gpr._y_train_std) * scalar(pred.data_std),
        "linear": np.asarray(lin.coef_, dtype=float).ravel().tolist(),
        "offset": scalar(gpr._y_train_mean) * scalar(pred.data_std) + scalar(pred.data_mean)
        + scalar(lin.intercept_),
    }


def export_remnant(h5_path: Path, reals: Blob) -> dict:
    from surfinBH._fit_evaluators.fit_7dq4 import Fit7dq4
    from surfinBH.surfinBH import SurFinBH

    reader = Fit7dq4.__new__(Fit7dq4)
    out = {}
    with h5py.File(h5_path, "r") as h:
        out["mf"] = export_gpr7(SurFinBH._read_dict(reader, h["mf"]), reals)
        for key in ("chif", "vf"):
            out[key] = [export_gpr7(SurFinBH._read_dict(reader, h[key][f"comp_{c}"]), reals)
                        for c in range(3)]
    return out


def write(path: Path, header: dict, sec: Sections) -> None:
    """magic, u32 header length, JSON header, then the u32, f32 and f64
    sections, each starting on a multiple of 8 bytes (zero padding)."""
    head = json.dumps(header, separators=(",", ":")).encode()
    out = MAGIC + struct.pack("<I", len(head)) + head
    for blob in (sec.u32, sec.f32, sec.f64):
        out += b"\0" * (-len(out) % 8)
        out += blob.bytes()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(out)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("h5", type=Path)
    ap.add_argument("out", type=Path)
    ap.add_argument("--remnant", type=Path, default=None,
                    help="NRSur7dq4Remnant fit file (fit_7dq4.h5) to embed")
    args = ap.parse_args()

    sec = Sections()
    with h5py.File(args.h5, "r") as h:
        header = {
            "model": "NRSur7dq4",
            "attribution": ATTRIBUTION,
            "counts": {},  # elements per section, filled in below
            "fit_settings": FIT_SETTINGS,
            # Trained range; gwsurrogate allows q <= 6 and |chi| <= 1 as extrapolation.
            "bounds": {"q": [1.0, 4.0], "chi": 0.8, "q_extrap": 6.0, "chi_extrap": 1.0},
            "t_ds": sec.f64.add(h["t_ds"][()]),
            "t_coorb": sec.f64.add(h["t_coorb"][()]),
            "dynamics": export_dynamics(h, sec),
            "coorbital": export_coorbital(h, sec),
        }
    if args.remnant is not None:
        header["remnant"] = export_remnant(args.remnant, sec.f64)
        header["attribution"] += REMNANT_ATTRIBUTION
    header["counts"] = {"u32": sec.u32.size, "f32": sec.f32.size, "f64": sec.f64.size}
    write(args.out, header, sec)

    print(f"dynamics: {len(header['dynamics'])} nodes x 9 fits; "
          f"co-orbital: {len(header['coorbital'])} components; sections {header['counts']}")
    print(f"wrote {args.out} ({args.out.stat().st_size / 1e6:.2f} MB)")


if __name__ == "__main__":
    main()
