"""Reference remnant properties from surfinBH (NRSur3dq8Remnant) for the Rust tests.

Usage:
    uv run python gen_remnant_golden.py data/fit_3dq8.h5 ../tests/golden/nrsur3dq8remnant.json
"""

import argparse
import json
import shutil
import warnings
from pathlib import Path

from gen_golden import CASES


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("h5", type=Path)
    ap.add_argument("out", type=Path)
    args = ap.parse_args()

    import surfinBH
    from surfinBH._loadFits import DataPath

    # surfinBH loads fits from its own data directory; point it at our copy.
    target = Path(DataPath()) / "fit_3dq8.h5"
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(args.h5, target)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        fit = surfinBH.LoadFits("NRSur3dq8Remnant")

    rows = []
    for q, c1, c2 in CASES:
        mf, chif, vf, *_ = fit.all(q, [0, 0, c1], [0, 0, c2])
        rows.append({"q": q, "chi1": c1, "chi2": c2, "mf": float(mf),
                     "chif": float(chif[2]), "vf": [float(vf[0]), float(vf[1])]})
        print(rows[-1])
    args.out.write_text(json.dumps({"source": "surfinBH NRSur3dq8Remnant", "cases": rows}, indent=1))
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
