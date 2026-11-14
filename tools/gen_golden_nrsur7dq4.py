"""Reference NRSur7dq4 dynamics, waveforms and remnants for the Rust tests.

Evaluates the original models (gwsurrogate NRSur7dq4, surfinBH
NRSur7dq4Remnant) and writes tests/golden/nrsur7dq4.json:

- dynamics: the raw ODE solution on the 230 full dynamics nodes,
  [quat(4), orbital phase, χA (3), χB (3)] (spins in the coprecessing frame);
- modes: inertial-frame h_lm on every 10th sample of the model's own time
  grid (t_coorb), for a subset of modes. The sparse grid is used because
  gwsurrogate 1.2.0's C spline mis-evaluates the last knot interval when
  resampling (see compare_nrsur7dq4.py);
- remnant: m_f, χ_f, v_f from surfinBH at the co-orbital spins of the
  dynamics node nearest t = -100 M, which is how the app evaluates them.

Spins are given at the start of the data (t ≈ -4300 M), in the co-orbital
frame there; odd-numbered cases also set a non-trivial initial frame
(init_quat).

Usage:
    uv run python gen_golden_nrsur7dq4.py data/NRSur7dq4.h5 data/fit_7dq4.h5 ../tests/golden/nrsur7dq4.json
"""

from __future__ import annotations

import argparse
import json
import warnings
from pathlib import Path

import numpy as np

from compare_nrsur7dq4 import CASES, INIT_QUAT, load_gwsurrogate, load_surfinbh

MODES = [(2, 2), (2, -2), (2, 1), (2, 0), (3, 3), (3, -2), (4, 4), (4, -1)]
STRIDE = 10
FIT_NODE_TIME = -100.0


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("h5", type=Path)
    ap.add_argument("remnant_h5", type=Path)
    ap.add_argument("out", type=Path)
    args = ap.parse_args()

    sur = load_gwsurrogate(args.h5)
    fit = load_surfinbh(args.remnant_h5)
    dyn_sur = sur._sur_dimless.dynamics_sur
    t_ds = np.concatenate([dyn_sur.t[0:6:2], dyn_sur.t[6:]])
    iq = INIT_QUAT / np.linalg.norm(INIT_QUAT)

    cases = []
    for k, (q, cA, cB) in enumerate(CASES):
        cA, cB = np.array(cA, float), np.array(cB, float)
        quat = iq if k % 2 else None
        opts = {} if quat is None else {"init_quat": quat}
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            t, h, _ = sur(q, cA, cB, f_low=0, precessing_opts=opts)
            qd, ph, chiA, chiB, _ = dyn_sur(q, cA, cB, init_quat=quat)
        idx = np.arange(0, t.size, STRIDE)
        y = np.column_stack([qd.T, ph, chiA, chiB])

        i = int(np.argmin(np.abs(t_ds - FIT_NODE_TIME)))
        c, s = np.cos(ph[i]), np.sin(ph[i])
        rot = lambda v: [v[0] * c + v[1] * s, -v[0] * s + v[1] * c, v[2]]  # noqa: E731
        chiA_co, chiB_co = rot(chiA[i]), rot(chiB[i])
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            mf, chif, vf, *_ = fit.all(q, chiA_co, chiB_co)

        cases.append({
            "q": q, "chiA": cA.tolist(), "chiB": cB.tolist(),
            "init_quat": None if quat is None else quat.tolist(),
            "dynamics": y.tolist(),
            "modes": [{"l": l, "m": m, "re": h[(l, m)][idx].real.tolist(),
                       "im": h[(l, m)][idx].imag.tolist()} for (l, m) in MODES],
            "remnant": {"node": i, "chiA_coorb": [float(v) for v in chiA_co],
                        "chiB_coorb": [float(v) for v in chiB_co], "mf": float(mf),
                        "chif": [float(v) for v in chif], "vf": [float(v) for v in vf]},
        })
        print(f"q={q} chiA={cA.tolist()} chiB={cB.tolist()}: peak |h22| {np.abs(h[(2, 2)]).max():.4f}, "
              f"m_f {mf:.5f}, |chi_f| {np.linalg.norm(chif):.4f}")

    out = {
        "source": "gwsurrogate 1.2.0 NRSur7dq4 (fM_ref = 0, f_low = 0) and surfinBH 1.2.7 NRSur7dq4Remnant",
        "t_ds": t_ds.tolist(),
        "mode_time_indices": {"stride": STRIDE, "count": int(idx.size)},
        "cases": cases,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out, separators=(",", ":")))
    print(f"wrote {args.out} ({args.out.stat().st_size / 1e6:.2f} MB)")


if __name__ == "__main__":
    main()
