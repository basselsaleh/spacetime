"""Reference tidal (E) and frame-drag (B) tensors for the Rust tests, from the
symbolic derivation in tendex_field.py (independent of its closed form).

Usage:
    env -u VIRTUAL_ENV uv run python gen_tendex_golden.py ../tests/golden/tendex_fields.json
"""

import argparse
import json
from pathlib import Path

import numpy as np

import tendex_field as tf


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("out", type=Path)
    args = ap.parse_args()

    rng = np.random.default_rng(2026)
    cases = []
    for _ in range(40):
        p = rng.normal(size=3) * rng.uniform(1.0, 300.0)
        ider = rng.normal(size=(5, tf.NDER)) * np.array([10, 2, 0.5, 0.1, 0.02])  # I^(n) scales like w^n
        m = float(rng.uniform(0.0, 1.0))
        cases.append({
            "p": p.tolist(),
            "M": m,
            "ider": ider.tolist(),  # [component xx, yy, xy, xz, yz][derivative order]
            "E": tf.tidal(p, m, ider).tolist(),
            "B": tf.frame_drag(p, m, ider).tolist(),
        })
    args.out.write_text(json.dumps({"source": "tools/tendex_field.py (sympy)", "cases": cases}))
    print(f"wrote {len(cases)} cases to {args.out}")


if __name__ == "__main__":
    main()
