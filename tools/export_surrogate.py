"""Export a time-trimmed NRHybSur3dq8 surrogate to the app's STSUR001 format.

The full model (~213 MB) covers the whole LIGO band, starting tens of
thousands of orbits before merger. The app only shows the last few thousand M,
so we keep the sparse time samples with t >= --t-start and drop the rest.
Truncating basis columns is exact: each waveform piece is evaluated pointwise
as sum_n node_n(x) * basis[n, t]. The dense 0.1 M merger-ringdown region is
resampled to --dense-dt; tests/golden measures the resulting error.

Format: see crates/physics/src/surrogate/format.rs.

Usage:
    uv run python export_surrogate.py data/NRHybSur3dq8.h5 ../web/public/nrhybsur3dq8.stsur
"""

from __future__ import annotations

import argparse
import json
import struct
import warnings
from pathlib import Path

import numpy as np

MAGIC = b"STSUR001"
ATTRIBUTION = (
    "Waveforms: NRHybSur3dq8 surrogate, V. Varma et al., Phys. Rev. D 99, 064045 "
    "(2019), arXiv:1812.07865. Data: doi:10.5281/zenodo.3348115, CC BY 4.0. "
    "Trimmed to the late inspiral, merger and ringdown."
)


def load_dimless(h5_path: Path):
    from gwsurrogate.surrogate import NRHybSur3dq8

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        sur = NRHybSur3dq8(str(h5_path))
    return sur._sur_dimless


class Blob:
    """Accumulates f64 arrays and hands back [offset, len] spans."""

    def __init__(self) -> None:
        self.chunks: list[np.ndarray] = []
        self.size = 0

    def add(self, arr) -> list[int]:
        a = np.ascontiguousarray(np.asarray(arr, dtype="<f8").ravel())
        span = [self.size, int(a.size)]
        self.chunks.append(a)
        self.size += a.size
        return span

    def bytes(self) -> bytes:
        return b"".join(c.tobytes() for c in self.chunks)


def scalar(v) -> float:
    a = np.asarray(v, dtype=float).ravel()
    if a.size != 1:
        raise ValueError(f"expected a scalar, got shape {np.shape(v)}")
    return float(a[0])


def export_node(node_function, blob: Blob) -> dict:
    """Fold a GPR_fast node (ConstantKernel*RBF + White, linear fit) into
    y(x) = scale * sum_j w_j exp(-0.5|(x-X_j)/l|^2) + linear.x + offset."""
    from gwsurrogate.eval_pysur.evaluate_fit import GPRPredictor

    nf = node_function.node_function
    cls = type(nf).__name__
    if cls != "NRHybSur3dq8Fit":
        raise NotImplementedError(f"node class {cls}")
    fit = dict(nf.fit_data)
    if fit.get("fitType") not in ("GPR", "GPR_fast"):
        raise NotImplementedError(f"fit type {fit.get('fitType')}")

    pred = GPRPredictor(fit)
    gpr = pred.GPR_obj
    prod = gpr.kernel_.k1
    const = float(prod.k1.constant_value)
    length = np.broadcast_to(np.asarray(prod.k2.length_scale, dtype=float), (3,))
    x_train = np.asarray(gpr.X_train_, dtype=float)
    alpha = np.asarray(gpr.alpha_, dtype=float).ravel()
    if x_train.shape != (alpha.size, 3):
        raise ValueError(f"unexpected X_train shape {x_train.shape}")

    y_std, y_mean = scalar(gpr._y_train_std), scalar(gpr._y_train_mean)
    d_std, d_mean = scalar(pred.data_std), scalar(pred.data_mean)
    lin = pred.linearModel
    coef = np.asarray(lin.coef_, dtype=float).ravel()
    intercept = scalar(lin.intercept_)

    return {
        "x_train": blob.add(x_train),
        "weights": blob.add(const * alpha),
        "inv_length_scale": (1.0 / length).tolist(),
        "scale": y_std * d_std,
        "linear": coef.tolist(),
        "offset": y_mean * d_std + d_mean + intercept,
    }


class Grid:
    """Output time grid: the model's own sparse samples before the dense
    (0.1 M) NR region, then a uniform step of `dense_dt` to the end. Basis rows
    are resampled with natural cubic splines, the same interpolant the
    evaluator uses, so the only error is that of the coarser knots."""

    def __init__(self, domain: np.ndarray, t_start: float, dense_dt: float,
                 keep_join: float) -> None:
        # Keep a few samples before t_start so the spline is well-conditioned there.
        first = max(int(np.searchsorted(domain, t_start)) - 3, 0)
        self.keep = np.arange(first, domain.size)
        t = domain[self.keep]
        steps = np.diff(t)
        dense = int(np.argmax(steps < 1.5 * steps.min()))
        # The spline is sensitive to how the knot spacing changes where the
        # sparse inspiral grid meets the dense one, so keep the original dense
        # samples for `keep_join` M past the join before coarsening.
        join_end = int(np.searchsorted(t, t[dense] + keep_join))
        tail = np.arange(t[join_end], t[-1], dense_dt)
        if t[-1] - tail[-1] < 0.5 * dense_dt:
            tail = tail[:-1]
        self.old = t
        self.new = np.concatenate([t[:join_end], tail, t[-1:]])

    def resample(self, rows: np.ndarray) -> np.ndarray:
        from scipy.interpolate import CubicSpline

        rows = rows[:, self.keep]
        return CubicSpline(self.old, rows, axis=1, bc_type="natural")(self.new)


def export_piece(func_sub, grid: Grid, blob: Blob) -> dict:
    basis = grid.resample(np.asarray(func_sub.ei_basis, dtype=float))
    nodes = [export_node(nf, blob) for nf in func_sub.node_functions]
    if basis.shape[0] != len(nodes):
        raise ValueError("basis rows do not match node count")
    return {"basis": blob.add(basis), "nodes": nodes}


def mode_key(k) -> tuple[int, int]:
    if isinstance(k, (tuple, list, np.ndarray)):
        return int(k[0]), int(k[1])
    raise ValueError(f"unrecognised mode key {k!r}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("h5", type=Path)
    ap.add_argument("out", type=Path)
    ap.add_argument("--t-start", type=float, default=-10000.0,
                    help="earliest time kept, in M (default: -10000)")
    ap.add_argument("--dense-dt", type=float, default=1.0,
                    help="time step for the merger-ringdown region, in M (default: 1)")
    ap.add_argument("--keep-join", type=float, default=10.0,
                    help="M of original 0.1 M samples kept after the sparse/dense join (default: 10)")
    args = ap.parse_args()

    s = load_dimless(args.h5)
    domain = np.asarray(s.domain, dtype=float)
    grid = Grid(domain, args.t_start, args.dense_dt, args.keep_join)

    blob = Blob()
    subs = {mode_key(k): v for k, v in s.sur_subs.iteritems()}
    mode22 = subs.pop((2, 2))
    modes = []
    for (l, m), sub in sorted(subs.items()):
        entry = {"l": l, "m": m, "re": None, "im": None}
        for comp in ("re", "im"):
            if comp in sub.func_subs.object_dict:
                entry[comp] = export_piece(sub.func_subs[comp], grid, blob)
        modes.append(entry)

    pmin, pmax = s.param_space.min_vals(), s.param_space.max_vals()
    header = {
        "model": "NRHybSur3dq8",
        "attribution": ATTRIBUTION,
        "time": blob.add(grid.new),
        "taylor_t3_t_ref": float(s.TaylorT3_t_ref),
        "phase_align_time": float(domain[int(s.phaseAlignIdx)]),
        # Trained range; the model is reliable here (q <= 8, |chi| <= 0.8).
        "bounds": {"q": [1.0, 8.0], "chi1": [-0.8, 0.8], "chi2": [-0.8, 0.8]},
        "amp22": export_piece(mode22.func_subs["amp"], grid, blob),
        "phase22": export_piece(mode22.func_subs["phase"], grid, blob),
        "modes": modes,
    }

    head = json.dumps(header, separators=(",", ":")).encode()
    pre = MAGIC + struct.pack("<I", len(head)) + head
    pad = b"\0" * (-len(pre) % 8)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes(pre + pad + blob.bytes())

    print(f"param space min {pmin} max {pmax}")
    print(f"time grid: {grid.new.size} samples (from {grid.old.size}), "
          f"t in [{grid.new[0]:.1f}, {grid.new[-1]:.1f}] M, dense dt {args.dense_dt} M")
    print(f"modes: (2,2) + {[(m['l'], m['m'], [c for c in ('re', 'im') if m[c]]) for m in modes]}")
    print(f"wrote {args.out} ({args.out.stat().st_size / 1e6:.2f} MB)")


if __name__ == "__main__":
    main()
