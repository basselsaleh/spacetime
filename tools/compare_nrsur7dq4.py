"""Check the exported STSUR002 file against gwsurrogate and surfinBH.

Evaluates nrsur7dq4_ref.py on the exported file and the original models on
the same binaries, and prints the worst error of the modes (relative to the
peak |h22|), the dynamics and the remnant.

Usage:
    uv run python compare_nrsur7dq4.py data/NRSur7dq4.h5 data/fit_7dq4.h5 out/nrsur7dq4_f64.stsur [...]
"""

from __future__ import annotations

import argparse
import shutil
import warnings
from pathlib import Path

import numpy as np

import nrsur7dq4_ref as ref

# Over the trained range: aligned, in-plane, generic, and both spins large.
CASES = [
    (1.0, [0, 0, 0], [0, 0, 0]),
    (1.0, [0.8, 0, 0], [0, 0, 0]),
    (2.0, [0.3, -0.4, 0.5], [-0.6, 0.1, -0.2]),
    (3.0, [0, 0, 0.6], [0, 0, 0.2]),
    (3.0, [0.6, 0, 0.3], [0.2, 0.3, 0]),
    (4.0, [0.8, 0, 0], [0, 0, 0]),
    (4.0, [-0.4, 0.5, -0.45], [0.55, -0.55, 0.1]),
]
# A non-trivial initial frame (tests init_quat), normalized below.
INIT_QUAT = np.array([0.9, 0.2, -0.3, 0.25])


def load_gwsurrogate(h5: Path):
    import gwsurrogate

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return gwsurrogate.LoadSurrogate(str(h5))


def load_surfinbh(h5: Path):
    import surfinBH
    from surfinBH._loadFits import DataPath

    target = Path(DataPath()) / "fit_7dq4.h5"
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(h5, target)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return surfinBH.LoadFits("NRSur7dq4Remnant")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("h5", type=Path)
    ap.add_argument("remnant_h5", type=Path)
    ap.add_argument("files", type=Path, nargs="+")
    args = ap.parse_args()

    sur = load_gwsurrogate(args.h5)
    fit = load_surfinbh(args.remnant_h5)
    iq = INIT_QUAT / np.linalg.norm(INIT_QUAT)

    for path in args.files:
        model = ref.Model(path)
        print(f"== {path}")
        worst = {"sparse": 0.0, "dt1": 0.0, "dyn": 0.0, "mf": 0.0, "chif": 0.0, "vf": 0.0}
        for k, (q, cA, cB) in enumerate(CASES):
            cA, cB = np.array(cA, float), np.array(cB, float)
            quat = iq if k % 2 else None
            opts = {"return_dynamics": True}
            if quat is not None:
                opts["init_quat"] = quat
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                t_s, h_s, _ = sur(q, cA, cB, f_low=0, precessing_opts=dict(opts))
                t_u, h_u, dyn = sur(q, cA, cB, f_low=0, dt=1.0, precessing_opts=dict(opts))
            mine_s = ref.evaluate(model, q, cA, cB, quat)
            mine_u = ref.evaluate(model, q, cA, cB, quat, dt=1.0)
            modes = [(l, m) for l in range(2, 5) for m in range(-l, l + 1)]
            peak = max(np.abs(h_u[(2, 2)]).max(), np.abs(h_u[(2, -2)]).max())
            assert np.allclose(t_s, mine_s.t) and np.allclose(t_u, mine_u.t)
            e_s = max(np.abs(h_s[lm] - mine_s.h[i]).max() for i, lm in enumerate(modes)) / peak
            # gwsurrogate 1.2.0's C spline evaluates the last knot interval
            # (99.8-100 M) with the previous interval's cubic, so skip it.
            ok = t_u <= model.t_coorb[-2]
            e_u = max(np.abs(h_u[lm] - mine_u.h[i])[ok].max() for i, lm in enumerate(modes)) / peak
            okd = t_u <= model.t_ds[-2]  # same spline issue on the dynamics grid
            e_d = max(np.abs(dyn["q_copr"] - mine_u.quat)[:, okd].max(),
                      np.abs(dyn["orbphase"] - mine_u.orbphase)[okd].max(),
                      np.abs(dyn["chiA"] - mine_u.chiA)[okd].max(),
                      np.abs(dyn["chiB"] - mine_u.chiB)[okd].max())

            # Remnant: surfinBH's own fits at our co-orbital spins at -100 M.
            i = int(np.argmin(np.abs(mine_u.t_ds - ref.FIT_NODE_TIME)))
            y = mine_u.y_ds[i]
            c, s = np.cos(y[4]), np.sin(y[4])
            rot = lambda v: np.array([v[0] * c + v[1] * s, -v[0] * s + v[1] * c, v[2]])  # noqa: E731
            chiA_co, chiB_co = rot(y[5:8]), rot(y[8:11])
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                mf_r, chif_r, vf_r, *_ = fit.all(q, chiA_co, chiB_co)
            mf, chif, vf = ref.remnant_coorbital(model, q, chiA_co, chiB_co)
            errs = {"sparse": e_s, "dt1": e_u, "dyn": e_d, "mf": abs(mf - mf_r),
                    "chif": np.abs(chif - chif_r).max(), "vf": np.abs(vf - vf_r).max()}
            for key, v in errs.items():
                worst[key] = max(worst[key], float(v))
            print(f"  q={q} chiA={cA.tolist()} chiB={cB.tolist()} quat={'yes' if quat is not None else 'no'}: "
                  + ", ".join(f"{key} {v:.1e}" for key, v in errs.items()))
        print("  worst: " + ", ".join(f"{key} {v:.1e}" for key, v in worst.items()))


if __name__ == "__main__":
    main()
