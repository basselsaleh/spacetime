"""Generate reference waveforms from gwsurrogate for the Rust tests.

Evaluates the full (untrimmed) NRHybSur3dq8 model with gwsurrogate, in its raw
frame (do_not_align=True: heavier black hole on +x at t = -1000 M), and writes
inertial-frame h_lm samples to tests/golden/nrhybsur3dq8.json.

Usage:
    uv run python gen_golden.py data/NRHybSur3dq8.h5 ../tests/golden/nrhybsur3dq8.json
"""

from __future__ import annotations

import argparse
import json
import warnings
from pathlib import Path

import numpy as np

# Spread over the trained range, including the corners and unequal spins.
CASES = [
    (1.0, 0.0, 0.0),
    (1.0, 0.8, 0.8),
    (2.0, 0.5, -0.3),
    (3.5, -0.8, 0.2),
    (5.0, 0.3, 0.6),
    (8.0, -0.4, -0.8),
    (8.0, 0.8, 0.8),
]
MODES = [(2, 2), (2, 1), (2, 0), (3, 3), (3, 2), (4, 4), (5, 5)]
T_START, T_END, DT = -5000.0, 100.0, 10.0


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("h5", type=Path)
    ap.add_argument("out", type=Path)
    args = ap.parse_args()

    from gwsurrogate.surrogate import NRHybSur3dq8

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        sur = NRHybSur3dq8(str(args.h5))
    s = sur._sur_dimless
    times = np.arange(T_START, T_END + 1e-9, DT)

    cases = []
    for q, c1, c2 in CASES:
        t, h, _ = s([q, c1, c2], fM_low=0, fM_ref=0, timesM=times,
                    mode_list=MODES, do_not_align=True)
        assert np.allclose(t, times)
        cases.append({
            "q": q, "chi1": c1, "chi2": c2,
            "modes": [
                {"l": l, "m": m, "re": h[(l, m)].real.tolist(), "im": h[(l, m)].imag.tolist()}
                for (l, m) in MODES
            ],
        })
        print(f"q={q} chi1={c1} chi2={c2}: peak |h22| = {np.abs(h[(2, 2)]).max():.4f}")

    out = {
        "source": "gwsurrogate NRHybSur3dq8, do_not_align=True",
        "t0": T_START, "dt": DT, "n": int(times.size),
        "cases": cases,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out, separators=(",", ":")))
    print(f"wrote {args.out} ({args.out.stat().st_size / 1e6:.2f} MB)")


if __name__ == "__main__":
    main()
