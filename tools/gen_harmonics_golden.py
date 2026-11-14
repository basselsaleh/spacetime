"""Reference spin-weighted spherical harmonics from LAL for the Rust tests.

Usage:
    uv run python gen_harmonics_golden.py ../tests/golden/swsh_lal.json
"""

import argparse
import json
from pathlib import Path

import lal
import numpy as np


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("out", type=Path)
    args = ap.parse_args()

    rows = []
    for theta in [0.0, 0.3, 1.0, np.pi / 2, 2.0, 2.9, np.pi]:
        for phi in [0.0, 1.1, 4.0]:
            for l in range(2, 6):
                for m in range(-l, l + 1):
                    y = lal.SpinWeightedSphericalHarmonic(theta, phi, -2, l, m)
                    rows.append([theta, phi, l, m, y.real, y.imag])
    args.out.write_text(json.dumps({"s": -2, "rows": rows}))
    print(f"wrote {len(rows)} values to {args.out}")


if __name__ == "__main__":
    main()
