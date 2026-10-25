"""The burnt globe (styleguide 3.4) for the Quick Look USDZ (9.5): a port of
`fitCloche` and `clocheSeedOffset` (`packages/xr-ui-core/src/cloche.ts`) and
of the burn rules in `clocheBurn.ts`, and the geometry that carries the
globe where RealityKit has no shader: the burning fronts, marched from the
same seeded noise the web's shell discards by, as thin emissive tubes, and
the embers the web draws out of focus.

`build(shape, seed)` is the form: it returns named parts (meshes and their
materials) in the dome's own space, and the converter writes whatever parts
it is given.

Standard library only, so the golden-vector check runs on any python3. The
TypeScript is the source of truth: `test_cloche.py` holds this file to
`packages/xr-ui-core/src/fixtures/cloche-golden.json`, which the TypeScript
tests check too. Values come from the generated design tokens; none is copied.
"""

import json
import math
from pathlib import Path


def _tokens():
    here = Path(__file__).resolve().parent
    for directory in (here, *here.parents):
        candidate = directory / "packages/design-tokens/src/generated/tokens.json"
        if candidate.is_file():
            return json.loads(candidate.read_text())
    raise FileNotFoundError("Design tokens not found (packages/design-tokens/src/generated/tokens.json)")


TOKENS = _tokens()


def token(name):
    return TOKENS[name]


def srgb_to_linear(hex_colour):
    channels = [int(hex_colour[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return tuple(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in channels)


# ---- the fit (fitCloche) -------------------------------------------------


def cloche_value(base, radii, exponent, point):
    return sum(abs((point[i] - base[i]) / radii[i]) ** exponent for i in range(3))


def fit_cloche(points):
    """The dome around every drawn point: foot on the lowest, the content's
    proportions, scaled until the furthest point is inside, plus the margin;
    never lower than the minimum height share. None with no points."""
    if not points:
        return None
    lower = [min(p[i] for p in points) for i in range(3)]
    upper = [max(p[i] for p in points) for i in range(3)]
    height = max(upper[1] - lower[1], 0.05)
    half_x = (upper[0] - lower[0]) / 2
    half_z = (upper[2] - lower[2]) / 2
    base = [(lower[0] + upper[0]) / 2, lower[1], (lower[2] + upper[2]) / 2]
    exponent = token("edge.cloche.exponent")
    radii = [max(half_x, height / 2), height, max(half_z, height / 2)]
    furthest = max(cloche_value(base, radii, exponent, p) for p in points)
    scale = (furthest ** (1 / exponent) if furthest > 0 else 1) * token("edge.cloche.fitMargin")
    radii = [r * scale for r in radii]
    radii[1] = max(radii[1], token("edge.cloche.minHeightShare") * max(radii[0], radii[2]))
    shade_scale = token("edge.cloche.shadeScale")
    return {
        "base": base,
        "radii": radii,
        "exponent": exponent,
        "shade": {"center": list(base), "radiusX": max(half_x, 0.05) * shade_scale, "radiusZ": max(half_z, 0.05) * shade_scale},
    }


def cloche_point(shape, d):
    """The point on the full superellipsoid in the direction `d`."""
    n, base, radii = shape["exponent"], shape["base"], shape["radii"]
    k = sum(abs(c) ** n for c in d) ** (1 / n)
    return [base[i] + d[i] / k * radii[i] for i in range(3)]


def cloche_normal(shape, point):
    """The outward unit normal at a point on the superellipsoid."""
    n, base, radii = shape["exponent"], shape["base"], shape["radii"]
    gradient = []
    for i in range(3):
        local = (point[i] - base[i]) / radii[i]
        gradient.append(math.copysign(abs(local) ** (n - 1), local) / radii[i])
    length = math.sqrt(sum(g * g for g in gradient)) or 1
    return [g / length for g in gradient]




def seed_offset(seed):
    """A hologram's id as the shader's noise offset, 0 to 100 (FNV-1a over UTF-16 code units)."""
    value = 2166136261
    data = seed.encode("utf-16-le")
    for i in range(0, len(data), 2):
        value = ((value ^ (data[i] | data[i + 1] << 8)) * 16777619) & 0xFFFFFFFF
    return (value % 10000) / 100


# ---- the burn rules (clocheBurn.ts), in the dome's space: foot at the origin, y up


def _fract(x):
    return x - math.floor(x)


def _hash(x, y, z):
    a, b, c = _fract(x * 0.1031), _fract(y * 0.1031), _fract(z * 0.1031)
    d = a * (c + 31.32) + b * (b + 31.32) + c * (a + 31.32)
    return _fract((a + d + (b + d)) * (c + d))


def noise(x, y, z):
    """Value noise, 0 to 1 (hash without sine), as `clocheBurn.ts` and its GLSL."""
    ix, iy, iz = math.floor(x), math.floor(y), math.floor(z)

    def s(t):
        return t * t * (3 - 2 * t)

    fx, fy, fz = s(x - ix), s(y - iy), s(z - iz)

    def h(dx, dy, dz):
        return _hash(ix + dx, iy + dy, iz + dz)

    def mix(a, b, t):
        return a + (b - a) * t

    return mix(
        mix(mix(h(0, 0, 0), h(1, 0, 0), fx), mix(h(0, 1, 0), h(1, 1, 0), fx), fy),
        mix(mix(h(0, 0, 1), h(1, 0, 1), fx), mix(h(0, 1, 1), h(1, 1, 1), fx), fy),
        fz,
    )


def burn_noise(p):
    """`clocheBurnNoise`: the burn noise's fbm at a point in noise space."""
    x, y, z = p
    return 0.55 * noise(x, y, z) + 0.3 * noise(x * 2.13 + 7.1, y * 2.13 + 7.1, z * 2.13 + 7.1) + 0.15 * noise(x * 4.7 + 3.3, y * 4.7 + 3.3, z * 4.7 + 3.3)


def _wider(shape):
    return max(shape["radii"])


def burn_at(shape, offset, local):
    """`clocheBurnAt`: below 0 the shell has burnt away, 0 is a burning front."""
    k = token("edge.cloche.burnFrequency") / _wider(shape)
    return burn_noise([c * k + offset for c in local]) - token("edge.cloche.burnThreshold")


def _smoothstep(edge0, edge1, x):
    t = min(max((x - edge0) / (edge1 - edge0), 0), 1)
    return t * t * (3 - 2 * t)


def tear_at(shape, offset, local):
    """`clocheTearAt`: how whole a front burns, 0 (torn away) to 1."""
    k = token("edge.cloche.burnFrequency") / _wider(shape)
    frequency = token("edge.cloche.tearFrequency")
    at = [(c * k + offset) * frequency + offset * 1.3 for c in local]
    return _smoothstep(token("edge.cloche.tearFrom"), token("edge.cloche.tearTo"), noise(*at))


def local_point(shape, d):
    """`clocheLocalPoint`: the point on the dome in a direction from its foot."""
    radii, n = shape["radii"], shape["exponent"]
    k = sum(abs(d[i] / radii[i]) ** n for i in range(3)) ** (1 / n) or 1
    return [c / k for c in d]


def normal_at(shape, p):
    """`clocheNormalAt`: the dome's outward unit normal at a point on it."""
    radii, n = shape["radii"], shape["exponent"]
    g = [math.copysign(abs(p[i] / radii[i]) ** (n - 1), p[i]) / radii[i] if p[i] else 0.0 for i in range(3)]
    length = math.sqrt(sum(c * c for c in g)) or 1
    return [c / length for c in g]


def random(offset):
    """`clocheRandom`: the seeded generator, so one hologram's embers sit in the same places everywhere."""
    state = [(math.floor(offset * 1000) % 2147483646) + 1]

    def next_value():
        state[0] = (state[0] * 16807) % 2147483647
        return state[0] / 2147483647

    return next_value


def _random_direction(next_value, foot=1):
    polar = math.acos(1 - next_value() ** (1 / foot))
    around = next_value() * math.pi * 2
    return [math.sin(polar) * math.cos(around), math.cos(polar), math.sin(polar) * math.sin(around)]


def burn_fronts(shape, offset, count):
    """`clocheBurnFronts`: up to `count` points on the burning fronts."""
    next_value = random(offset + 11)
    sites = []
    i = 0
    while i < count * 40 and len(sites) < count:
        point = local_point(shape, _random_direction(next_value))
        if abs(burn_at(shape, offset, point)) < 0.02:
            sites.append({"point": point, "normal": normal_at(shape, point)})
        i += 1
    return sites


def embers(shape, offset, count=None):
    """`clocheEmbers`: positions, the dome's normals under them, and four seeds each."""
    count = int(token("edge.cloche.emberCount")) if count is None else count
    next_value = random(offset + 5)
    spread = token("edge.cloche.emberSpread") * _wider(shape)
    result = []
    for _ in range(count):
        point = local_point(shape, _random_direction(next_value, 1.25))
        normal = normal_at(shape, point)
        off = (next_value() - 0.3) * spread
        position = [point[0] + normal[0] * off, max(0, point[1] + normal[1] * off), point[2] + normal[2] * off]
        result.append({"position": position, "normal": normal, "seeds": [next_value() for _ in range(4)]})
    return result


# ---- the Quick Look geometry ---------------------------------------------

TUBE_SIDES = 6


def _direction(polar, around):
    return [math.sin(polar) * math.cos(around), math.cos(polar), math.sin(polar) * math.sin(around)]


def _cross(a, b):
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]


def _unit(v):
    length = math.sqrt(sum(c * c for c in v)) or 1
    return [c / length for c in v]


class _Mesh:
    def __init__(self):
        self.points, self.normals, self.indices = [], [], []

    def add_ring(self, centre, tangent, outward, radius):
        side = _unit(_cross(tangent, outward))
        up = _unit(_cross(side, tangent))
        start = len(self.points)
        for k in range(TUBE_SIDES):
            angle = 2 * math.pi * k / TUBE_SIDES
            normal = [math.cos(angle) * up[i] + math.sin(angle) * side[i] for i in range(3)]
            self.points.append([centre[i] + normal[i] * radius for i in range(3)])
            self.normals.append(normal)
        return start

    def join(self, a, b):
        for k in range(TUBE_SIDES):
            k2 = (k + 1) % TUBE_SIDES
            self.indices += [a + k, b + k2, b + k, a + k, a + k2, b + k2]

    def tube(self, rings, closed):
        """A tube through `rings` (centre, tangent, outward, radius); an open one tapers shut at its ends."""
        starts = [self.add_ring(*ring) for ring in rings]
        for a, b in zip(starts, starts[1:] + (starts[:1] if closed else [])):
            self.join(a, b)

    def export(self):
        return {"points": self.points, "normals": self.normals, "indices": self.indices}


def front_lines(shape, offset):
    """The burning fronts: the zero level set of `burn_at` over the dome,
    marched on a grid of directions, as polylines of dome points. Each is
    (points, closed); a front that reaches the floor ends there."""
    radii = shape["radii"]
    wider = _wider(shape)
    samples = token("edge.cloche.quickLook.samples")
    around_steps = max(48, math.ceil(2 * math.pi * samples * max(radii[0], radii[2]) / wider))
    polar_steps = max(12, math.ceil(math.pi / 2 * samples * max(radii[1], (radii[0] + radii[2]) / 2) / wider))
    angles = [(math.pi / 2 * i / polar_steps, [2 * math.pi * j / around_steps for j in range(around_steps)]) for i in range(polar_steps + 1)]
    values = [[burn_at(shape, offset, local_point(shape, _direction(polar, around))) for around in arounds] for polar, arounds in angles]

    crossings = {}

    def crossing(key, a, b):
        # The front between grid nodes a and b, interpolated in (polar, around).
        if key not in crossings:
            (ia, ja), (ib, jb) = a, b
            va, vb = values[ia][ja % around_steps], values[ib][jb % around_steps]
            t = va / (va - vb)
            polar = math.pi / 2 * (ia + (ib - ia) * t) / polar_steps
            around = 2 * math.pi * (ja + (jb - ja) * t) / around_steps
            crossings[key] = local_point(shape, _direction(polar, around))
        return key

    links = {}
    for i in range(polar_steps):
        for j in range(around_steps):
            corners = [(i, j), (i, j + 1), (i + 1, j + 1), (i + 1, j)]
            inside = [values[ci][cj % around_steps] >= 0 for ci, cj in corners]
            edges = [
                (("a", i, j), corners[0], corners[1]),
                (("p", i, (j + 1) % around_steps), corners[1], corners[2]),
                (("a", i + 1, j), corners[3], corners[2]),
                (("p", i, j), corners[0], corners[3]),
            ]
            cut = [index for index, pair in enumerate(((0, 1), (1, 2), (3, 2), (0, 3))) if inside[pair[0]] != inside[pair[1]]]
            if len(cut) == 2:
                pairs = [tuple(cut)]
            elif len(cut) == 4:
                centre = sum(values[ci][cj % around_steps] for ci, cj in corners) / 4 >= 0
                pairs = [(0, 1), (2, 3)] if centre == inside[0] else [(0, 3), (1, 2)]
            else:
                continue
            for first, second in pairs:
                keys = [crossing(edges[e][0], edges[e][1], edges[e][2]) for e in (first, second)]
                links.setdefault(keys[0], []).append(keys[1])
                links.setdefault(keys[1], []).append(keys[0])

    lines, seen = [], set()
    # Open fronts first, from an end (a crossing with one link), then the loops.
    for start in sorted(links, key=lambda key: len(links[key])):
        if start in seen:
            continue
        chain, previous, current = [start], None, start
        seen.add(start)
        closed = False
        while True:
            following = [key for key in links[current] if key != previous]
            if not following:
                break
            nxt = following[0]
            if nxt == start:
                closed = True
                break
            if nxt in seen:
                break
            chain.append(nxt)
            seen.add(nxt)
            previous, current = current, nxt
        if len(chain) >= 2:
            lines.append(([crossings[key] for key in chain], closed))
    return lines


def _octahedron(mesh, centre, size):
    axes = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
    start = len(mesh.points)
    for axis in axes:
        mesh.points.append([centre[i] + axis[i] * size for i in range(3)])
        mesh.normals.append(list(axis))
    for x in (0, 1):
        for y in (2, 3):
            for z in (4, 5):
                a, b, c = axes[x], axes[y], axes[z]
                # Wound outward: counter-clockwise seen from outside.
                outward = sum(_cross([b[i] - a[i] for i in range(3)], [c[i] - a[i] for i in range(3)])[i] * (a[i] + b[i] + c[i]) for i in range(3)) > 0
                mesh.indices += [start + x, start + y, start + z] if outward else [start + x, start + z, start + y]


def _heat_colour(heat):
    """The web's ember colour for a heat (ember to gold to cream)."""
    ember = srgb_to_linear(token("edge.ember.color"))
    gold = srgb_to_linear(token("edge.core.color"))
    cream = srgb_to_linear(token("edge.highlight.color"))
    a = _smoothstep(0.2, 0.7, heat)
    colour = [ember[i] + (gold[i] - ember[i]) * a for i in range(3)]
    b = _smoothstep(0.85, 1.0, heat)
    return [colour[i] + (cream[i] - colour[i]) * b for i in range(3)]


# The embers' heats, binned: one material each.
EMBER_HEATS = (("EmbersCool", 0.0, 0.45, 0.2), ("EmbersWarm", 0.45, 0.9, 0.65), ("EmbersHot", 0.9, 1.01, 0.95))


def build(shape, seed):
    """The burnt globe, in the dome's own space (its foot's centre at the
    origin), as named parts: each a mesh (points, normals, triangle indices)
    with its material (linear diffuse and emissive colours, opacity). Also a
    summary for the readback."""
    offset = seed_offset(seed)
    local = dict(shape, base=[0.0, 0.0, 0.0])
    wider = _wider(shape)
    radius = token("edge.cloche.quickLook.frontRadius") * wider
    tear_min = token("edge.cloche.quickLook.tearMin")
    cream_share = token("edge.cloche.quickLook.creamShare")
    char_share = token("edge.cloche.quickLook.charShare")
    gold_tubes, cream_tubes, char_tubes = _Mesh(), _Mesh(), _Mesh()
    lines = front_lines(local, offset)
    front_vertices = 0
    for points, closed in lines:
        count = len(points)
        rings = []
        for index, point in enumerate(points):
            before = points[index - 1] if (index > 0 or closed) else point
            after = points[(index + 1) % count] if (index + 1 < count or closed) else point
            tangent = _unit([after[i] - before[i] for i in range(3)])
            outward = normal_at(local, point)
            # Toward the shell that remains: where the burn rises.
            side = _unit(_cross(outward, tangent))
            probe = 0.5 * radius
            ahead = burn_at(local, offset, local_point(local, [point[i] + side[i] * probe for i in range(3)]))
            behind = burn_at(local, offset, local_point(local, [point[i] - side[i] * probe for i in range(3)]))
            if ahead < behind:
                side = [-c for c in side]
            rings.append((point, tangent, outward, side, tear_at(local, offset, point)))
        # Torn into dashes where the tear is low, as the shader's `tear`; a dash swells with it.
        runs, run = [], []
        for ring in rings:
            if ring[4] >= tear_min:
                run.append(ring)
            elif run:
                runs.append(run)
                run = []
        if run:
            runs.append(run)
        whole = closed and len(runs) == 1 and len(runs[0]) == count
        for run in runs:
            if len(run) < 2:
                continue
            front_vertices += len(run)
            widths = [radius * (0.45 + 0.55 * ring[4]) for ring in run]
            if not whole:
                widths[0] = widths[-1] = 0.0
            gold_tubes.tube([(p, t, o, w) for (p, t, o, _, _), w in zip(run, widths)], whole)
            # The cream core shows just past the gold's outer face; the char is a
            # shoulder attached to the gold on the shell's side, torn with it.
            cream_tubes.tube([([p[i] + o[i] * w * (1.1 - cream_share) for i in range(3)], t, o, w * cream_share) for (p, t, o, _, _), w in zip(run, widths)], whole)
            char_tubes.tube([(local_point(local, [p[i] + s[i] * w * (1 + 0.5 * char_share) for i in range(3)]), t, o, w * char_share) for (p, t, o, s, _), w in zip(run, widths)], whole)

    # The embers the web draws out of focus (seed x within the resting share), the first few hundred.
    rest = token("edge.cloche.emberRestShare")
    wanted = int(token("edge.cloche.quickLook.embers"))
    size = token("edge.cloche.emberSize") * token("edge.cloche.quickLook.emberScale") * wider
    ember_meshes = {name: _Mesh() for name, *_ in EMBER_HEATS}
    baked = 0
    for ember in embers(local, offset):
        if baked >= wanted:
            break
        if ember["seeds"][0] > rest:
            continue
        heat = 0.5 + 0.5 * math.sin(ember["seeds"][3] * 40)
        name = next(name for name, low, high, _ in EMBER_HEATS if low <= heat < high)
        _octahedron(ember_meshes[name], ember["position"], size * (0.6 + ember["seeds"][3]) / 2)
        baked += 1

    gold = srgb_to_linear(token("edge.core.color"))
    cream = srgb_to_linear(token("edge.highlight.color"))
    char = srgb_to_linear(token("edge.char.color"))
    front_glow = token("edge.cloche.quickLook.frontGlow")
    ember_glow = token("edge.cloche.quickLook.emberGlow")
    parts = [
        {"name": "Fronts", "mesh": gold_tubes.export(), "diffuse": gold, "emissive": [c * front_glow for c in gold]},
        {"name": "FrontsCream", "mesh": cream_tubes.export(), "diffuse": cream, "emissive": [c * token("edge.cloche.quickLook.creamGlow") for c in cream]},
        {"name": "FrontsChar", "mesh": char_tubes.export(), "diffuse": char, "emissive": [0.0, 0.0, 0.0]},
    ]
    for name, _, _, heat in EMBER_HEATS:
        colour = _heat_colour(heat)
        parts.append({"name": name, "mesh": ember_meshes[name].export(), "diffuse": colour, "emissive": [c * ember_glow for c in colour]})
    for part in parts:
        part["opacity"] = 1.0
    return {
        "parts": [part for part in parts if part["mesh"]["indices"]],
        "summary": {
            "form": "burnt-globe",
            "seedOffset": offset,
            "fronts": len(lines),
            "frontVertices": front_vertices,
            "frontRadius": radius,
            "embers": baked,
            "emberSize": size,
        },
    }
