"""Reference black-hole orientation from LAL post-Newtonian modes.

For each case, finds the angle of the heavier black hole at a few inspiral
times by matching the surrogate's (2,2), (2,1) and (3,3) modes to LAL's PN
modes (LAL convention, heavier body on +x at zero orbital phase). The odd-m
modes fix which hole is where. PN tail terms leave a ~0.15 rad ambiguity
between orbital and wave phase at these separations, so tests compare
loosely; the point is to catch quarter- and half-turn convention errors.

Usage:
    uv run python gen_orientation_golden.py data/NRHybSur3dq8.h5 ../tests/golden/orientation_lal.json
"""

import argparse
import json
import warnings
from pathlib import Path

import lal
import lalsimulation as ls
import numpy as np

CASES = [(1.5, 0.0, 0.0), (2.0, 0.0, 0.0), (4.0, 0.3, -0.2), (8.0, 0.0, 0.5)]
TIMES = [-5000.0, -4000.0, -3000.0]
MODES = [(2, 2), (2, 1), (3, 3)]


def series(val: float):
    x = lal.CreateREAL8TimeSeries("x", lal.LIGOTimeGPS(0), 0, 1, lal.DimensionlessUnit, 1)
    x.data.data[:] = val
    return x


def heavier_angle(h: dict, v: float, m1: float, m2: float) -> tuple[float, float]:
    pn = {}
    for l, m in MODES:
        out = ls.CreateSimInspiralPNModeCOMPLEX16TimeSeriesLALConvention(
            series(v), series(0.0), m1 * lal.MSUN_SI, m2 * lal.MSUN_SI, 1e6 * lal.PC_SI, -1, l, m)
        pn[(l, m)] = out.data.data[0]
    # h_sur(l,m) = h_pn(l,m; phase 0) * exp(-i m alpha), alpha = heavier hole's angle.
    a22 = -np.angle(h[(2, 2)] / pn[(2, 2)]) / 2
    a33 = -np.angle(h[(3, 3)] / pn[(3, 3)]) / 3
    a21 = -np.angle(h[(2, 1)] / pn[(2, 1)])

    def mismatch(a):
        return abs(np.angle(np.exp(3j * (a - a33)))) + abs(np.angle(np.exp(1j * (a - a21))))

    best = min([a22, a22 + np.pi], key=mismatch)
    return float(np.angle(np.exp(1j * best))), float(mismatch(best))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("h5", type=Path)
    ap.add_argument("out", type=Path)
    args = ap.parse_args()

    from gwsurrogate.surrogate import NRHybSur3dq8

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        s = NRHybSur3dq8(str(args.h5))._sur_dimless

    rows = []
    for q, c1, c2 in CASES:
        m1, m2 = q / (1 + q), 1 / (1 + q)
        for t in TIMES:
            ts = t + np.arange(-2.0, 3.0)
            _, h, _ = s([q, c1, c2], fM_low=0, fM_ref=0, timesM=ts, mode_list=MODES, do_not_align=True)
            phi22 = -np.unwrap(np.angle(h[(2, 2)]))
            v = (np.gradient(phi22, ts)[2] / 2) ** (1 / 3)
            angle, mis = heavier_angle({k: h[k][2] for k in MODES}, v, m1, m2)
            if mis > 0.1:
                raise RuntimeError(f"odd modes disagree for q={q} t={t}: mismatch {mis:.3f}")
            rows.append({"q": q, "chi1": c1, "chi2": c2, "t": t, "heavier_angle": angle})
            print(rows[-1], f"mismatch {mis:.3f}")
    args.out.write_text(json.dumps({"source": "LAL PN modes (LAL convention) vs surrogate", "cases": rows}, indent=1))
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
