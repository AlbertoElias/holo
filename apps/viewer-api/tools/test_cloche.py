#!/usr/bin/env python3
"""Holds the Python cloche to the TypeScript one (styleguide 3.4, 9.5).

Reads packages/xr-ui-core/src/fixtures/cloche-golden.json, which the
TypeScript tests check against `fitCloche`, `clocheSeedOffset` and the
burnt globe's rules in `clocheBurn.ts`. Standard library only:
`python3 test_cloche.py`.
"""

import json
import math
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cloche  # noqa: E402

GOLDEN = Path(__file__).resolve().parents[3] / "packages/xr-ui-core/src/fixtures/cloche-golden.json"


def close(actual, expected, label, tolerance=1e-9):
    if not math.isclose(actual, expected, rel_tol=tolerance, abs_tol=tolerance):
        raise AssertionError(f"{label}: {actual} != {expected}")


def vectors(actual, expected, label, tolerance=1e-9):
    for a, e in zip(actual, expected, strict=True):
        close(a, e, label, tolerance)


def main():
    golden = json.loads(GOLDEN.read_text())
    for fit in golden["fits"]:
        shape = cloche.fit_cloche(fit["points"])
        for key in ("base", "radii"):
            for i, axis in enumerate("xyz"):
                close(shape[key][i], fit["shape"][key][axis], f"{fit['name']} {key}.{axis}")
        close(shape["exponent"], fit["shape"]["exponent"], f"{fit['name']} exponent")
        close(shape["shade"]["radiusX"], fit["shape"]["shade"]["radiusX"], f"{fit['name']} shade x")
        close(shape["shade"]["radiusZ"], fit["shape"]["shade"]["radiusZ"], f"{fit['name']} shade z")
    if cloche.fit_cloche([]) is not None:
        raise AssertionError("an empty hologram has no dome")
    for entry in golden["seeds"]:
        close(cloche.seed_offset(entry["seed"]), entry["offset"], f"seed {entry['seed']!r}")
    for entry in golden["noise"]:
        close(cloche.burn_noise([c * 9.3 for c in entry["at"]]), entry["value"], f"noise at {entry['at']}")
    samples = 0
    for entry in golden["globe"]:
        fit = next(fit for fit in golden["fits"] if fit["name"] == entry["fit"])
        shape = cloche.fit_cloche(fit["points"])
        offset = cloche.seed_offset(entry["seed"])
        label = f"{entry['fit']} for {entry['seed']!r}"
        next_value = cloche.random(offset)
        for i, value in enumerate(entry["random"]):
            close(next_value(), value, f"{label} random {i}")
        for sample in entry["surface"]:
            point = cloche.local_point(shape, sample["direction"])
            vectors(point, sample["point"], f"{label} dome point")
            vectors(cloche.normal_at(shape, point), sample["normal"], f"{label} normal")
            close(cloche.burn_at(shape, offset, point), sample["burn"], f"{label} burn at {point}")
            close(cloche.tear_at(shape, offset, point), sample["tear"], f"{label} tear at {point}")
            samples += 1
        fronts = cloche.burn_fronts(shape, offset, 12)
        if len(fronts) != len(entry["fronts"]):
            raise AssertionError(f"{label}: {len(fronts)} front sites, expected {len(entry['fronts'])}")
        for site, expected in zip(fronts, entry["fronts"]):
            vectors(site["point"], expected["point"], f"{label} front site")
            vectors(site["normal"], expected["normal"], f"{label} front normal")
        embers = cloche.embers(shape, offset, 64)
        for i, ember in enumerate(embers):
            # The TypeScript keeps embers in 32-bit floats.
            vectors(ember["position"], entry["embers"]["positions"][i * 3:i * 3 + 3], f"{label} ember {i}", 1e-6)
            vectors(ember["normal"], entry["embers"]["normals"][i * 3:i * 3 + 3], f"{label} ember normal {i}", 1e-6)
            vectors(ember["seeds"], entry["embers"]["seeds"][i * 4:i * 4 + 4], f"{label} ember seeds {i}", 1e-6)
    print(f"cloche port matches {len(golden['fits'])} fits, {len(golden['seeds'])} seeds, {len(golden['globe'])} burnt globes ({samples} dome samples)")

if __name__ == "__main__":
    main()
