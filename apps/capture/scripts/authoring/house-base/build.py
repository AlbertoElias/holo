"""
Builds the house base avatar in Blender from CC0 parts, every value from a
parameter file, so the base is re-made by a command and never edited by hand.

Run by `house-base.ts` (which fetches and checks the parts), as:

  Blender -b --python build.py -- <base.json> <faceunits dir> <out.glb> <report.json> [build]

where build is one of base.json's `builds` (default medium).

Parts (credits are written into the file): the MakeHuman base mesh, its
mixamo rig and weights, from MPFB 2 (the add-on is GPL; its output is CC0),
and the ARKit face units of the faceunits01 pack (CC0, Mika Suominen), of
which only the jaw and cheek units are kept, on the skin.

Steps: an MPFB human with the parameter file's macro and shape targets,
baked; the proportions (a larger head, hands) applied to the mesh and to the
kept face units, weighted by the rig's own weights so the rig is then fitted
to the scaled mesh and no bone is scaled; the stylised face: the front of the
face smoothed (nose, lips and sockets taken out), then big eyes, lids with a
lash line, brows, a nose and a mouth built on it, with every face shape the
audition and the mixes use authored for this face; the rig, renamed to the
stock avatar's bone names, with eye and head-top bones added; materials
painted on the body by bone; helper geometry removed; the traits that are geometry (`dress.py`):
loose garments in place of the painted clothes, every hair style and both glasses frames, each its
own mesh for the dressing function to keep or remove; exported as GLB.

Blender: +Z up, the human faces -Y, its left is +X. glTF export turns that
into +Y up, facing +Z.
"""
import bpy, bmesh, json, math, os, sys
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

argv = sys.argv[sys.argv.index("--") + 1:]
P = json.load(open(argv[0]))
FU_DIR, OUT, REPORT = argv[1], argv[2], argv[3]
BUILD = argv[4] if len(argv) > 4 else "medium"
MACRO0 = dict(P["macro"])
P["macro"] = {**P["macro"], **P["builds"][BUILD]["macro"]}
F = P["face"]
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dress

from bl_ext.user_default.mpfb.services.humanservice import HumanService
from bl_ext.user_default.mpfb.services.targetservice import TargetService
from bl_ext.user_default.mpfb.services.locationservice import LocationService

# The 52 ARKit channels; the 8 eyeLook* turn the eye bones instead of a shape.
ARKIT = [
    "browDownLeft", "browDownRight", "browInnerUp", "browOuterUpLeft", "browOuterUpRight", "cheekPuff",
    "cheekSquintLeft", "cheekSquintRight", "eyeBlinkLeft", "eyeBlinkRight", "eyeLookDownLeft", "eyeLookDownRight",
    "eyeLookInLeft", "eyeLookInRight", "eyeLookOutLeft", "eyeLookOutRight", "eyeLookUpLeft", "eyeLookUpRight",
    "eyeSquintLeft", "eyeSquintRight", "eyeWideLeft", "eyeWideRight", "jawForward", "jawLeft", "jawOpen", "jawRight",
    "mouthClose", "mouthDimpleLeft", "mouthDimpleRight", "mouthFrownLeft", "mouthFrownRight", "mouthFunnel", "mouthLeft",
    "mouthLowerDownLeft", "mouthLowerDownRight", "mouthPressLeft", "mouthPressRight", "mouthPucker", "mouthRight",
    "mouthRollLower", "mouthRollUpper", "mouthShrugLower", "mouthShrugUpper", "mouthSmileLeft", "mouthSmileRight",
    "mouthStretchLeft", "mouthStretchRight", "mouthUpperUpLeft", "mouthUpperUpRight", "noseSneerLeft", "noseSneerRight",
    "tongueOut",
]
SHAPES = [c for c in ARKIT if not c.startswith("eyeLook")]
PREFIX = "mixamorig:"
SIDES = {"Left": "l", "Right": "r"}
SIGN = {"Left": 1.0, "Right": -1.0}  # the human's left is +X


def coords(block):
    a = np.empty(len(block.data) * 3, dtype=np.float64)
    block.data.foreach_get("co", a)
    return a.reshape(-1, 3)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


# --- An MPFB human, its modelling targets baked into the mesh; its proportions; the fit ----------------
rig_dir = os.path.join(LocationService.get_mpfb_data("rigs"), "standard")
wjson = json.load(open(os.path.join(rig_dir, "weights.mixamo.json")))["weights"]


def make_human(macro):
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o)
    h = HumanService.create_human(mask_helpers=False, feet_on_ground=True, scale=0.1, macro_detail_dict=macro)
    for name, weight in P.get("targets", {}).items():
        TargetService.load_target(h, TargetService.target_full_path(name), weight=weight, name=name)
    keys = h.data.shape_keys.key_blocks
    basis = coords(keys[0])
    X = basis.copy()
    for k in keys[1:]:
        X += k.value * (coords(k) - basis)
    h.shape_key_clear()
    h.data.vertices.foreach_set("co", X.astype(np.float32).ravel())
    h.data.update()
    return h, X


def weight_of(*bones):
    w = np.zeros(N)
    for b in bones:
        for i, x in wjson.get(PREFIX + b, []):
            w[i] += x
    return np.clip(w, 0, 1)


def centre(group, at=None):
    return (X if at is None else at)[members[group]].mean(axis=0)


# --- Proportions: one map applied to the mesh and to every kept offset ---------------------
def scale_about(at, pivot, s, w):
    return pivot + (at - pivot) * (1 + (s - 1) * w)[:, None]


def proportioner(X):
    pr = P["proportions"]
    w_head = np.clip(weight_of("Head") + pr["head"]["neckShare"] * weight_of("Neck"), 0, 1)
    # MPFB's eye helpers carry no rig weight; they belong to the head in full, or the scale leaves them behind.
    for side in ("l", "r"):
        w_head[members[f"helper-{side}-eye"]] = 1.0
    neck = centre("joint-neck", X)
    out_ref = scale_about(X, neck, pr["head"]["scale"], w_head)

    def proportion(at):
        out = scale_about(at, neck, pr["head"]["scale"], w_head)
        for side in ("Left", "Right"):
            bones = [f"{side}Hand"] + [f"{side}Hand{f}{n}" for f in ["Thumb", "Index", "Middle", "Ring", "Pinky"] for n in (1, 2, 3)]
            wrist = out_ref[members[f"joint-{SIDES[side]}-hand"]].mean(axis=0)
            out = scale_about(out, wrist, pr["hands"]["scale"], weight_of(*bones))
        return out
    return proportion


def standing(base):
    """Stands on the ground, scaled uniformly to the height (head top, helpers excluded); the scale."""
    body = members["body"]
    base[:, 2] -= base[body, 2].min()
    s = P["height"] / base[body, 2].max()
    base *= s
    return s


# The fit (fit.py) is found on the medium build and its moves are added to every build, so the builds
# keep their differences (same topology, same vertex order).
medium_macro = {k: v for k, v in P["macro"].items()}
for k in P["builds"][BUILD]["macro"]:
    medium_macro[k] = P["builds"]["medium"]["macro"].get(k, MACRO0[k])
fit_report = {}
FIT = P.get("fit")
if FIT and FIT.get("enabled", True):
    human, X = make_human(medium_macro)
    groups = {g.index: g.name for g in human.vertex_groups}
    members = {}
    for v in human.data.vertices:
        for g in v.groups:
            members.setdefault(groups[g.group], []).append(v.index)
    members = {k: np.array(v) for k, v in members.items()}
    N = len(X)
    med = proportioner(X)(X)
    standing(med)
    is_body0 = np.zeros(N, dtype=bool)
    is_body0[members["body"]] = True
    polys0 = [list(p.vertices) for p in human.data.polygons if is_body0[list(p.vertices)].all()]
    import fit as fitmod
    _, FIT_MOVES = fitmod.fit(med, is_body0, polys0, members, weight_of, [k[len(PREFIX):] for k in wjson], FIT, os.path.join(os.path.dirname(os.path.abspath(__file__)), FIT["target"]), fit_report)

human, X = make_human(P["macro"])

# --- The face units kept on the skin (the jaw, the cheeks), and mouthSmile to find the mouth corners -----
SKIN = {c: g for c, g in F["skinUnits"].items() if not c.startswith("$")}
human.shape_key_add(name="Basis")
offsets = {}
for c in [*SKIN, "mouthSmileLeft", "mouthSmileRight"]:
    TargetService.load_target(human, os.path.join(FU_DIR, c + ".target"), weight=0.0, name=c)
    off = coords(human.data.shape_keys.key_blocks[c]) - X
    off[np.linalg.norm(off, axis=1) < 1e-6] = 0.0  # float32 noise, so the targets stay sparse
    offsets[c] = off
human.shape_key_clear()

# --- Vertex groups (MPFB's) and rig weights (MPFB's mixamo weights, by vertex index) ------
groups = {g.index: g.name for g in human.vertex_groups}
members = {}
for v in human.data.vertices:
    for g in v.groups:
        members.setdefault(groups[g.group], []).append(v.index)
members = {k: np.array(v) for k, v in members.items()}
N = len(X)

proportion = proportioner(X)
base = proportion(X)
skin_moved = {c: proportion(X + off) - base for c, off in offsets.items()}
s = standing(base)
for c in skin_moved:
    skin_moved[c] *= s * SKIN.get(c, 1.0)
body = members["body"]
if FIT and FIT.get("enabled", True):
    base += FIT_MOVES
    base[:, 2] -= base[body, 2].min()

is_body = np.zeros(N, dtype=bool)
is_body[body] = True
body_polys = [list(p.vertices) for p in human.data.polygons if is_body[list(p.vertices)].all()]
eye_helper = {side: base[members[f"helper-{s_}-eye"]].mean(axis=0) for side, s_ in SIDES.items()}
cx = float((eye_helper["Left"][0] + eye_helper["Right"][0]) / 2)  # the face's midline
ze = float((eye_helper["Left"][2] + eye_helper["Right"][2]) / 2)  # eye height
corners = [base[np.argmax(np.linalg.norm(skin_moved[f"mouthSmile{side}"], axis=1))] for side in ("Left", "Right")]
zm = float((corners[0][2] + corners[1][2]) / 2) + F["mouth"]["raise"]  # mouth height
head_top = base[body][np.argmax(base[body, 2])]

# --- The face smoothed: a depth map of the front, opened (holes filled), closed (bumps taken off) and blurred;
# each face vertex moves by the difference at its place, so the nose, lips and sockets go and what lies behind
# them (the mouth, the eye sockets) moves with the surface in front of it. ------------------------------------
sm = F["smooth"]
g = sm["grid"]
xs = cx + np.arange(-sm["halfWidth"], sm["halfWidth"] + 1e-9, g)
zs = ze + np.arange(-sm["below"], sm["above"] + 1e-9, g)
skin0 = BVHTree.FromPolygons([tuple(v) for v in base], body_polys)
D = np.full((len(zs), len(xs)), np.nan)
for i, z in enumerate(zs):
    for j, x in enumerate(xs):
        hit = skin0.ray_cast(Vector((x, -1.0, z)), Vector((0, 1, 0)))[0]
        if hit is not None:
            D[i, j] = hit.y


def reduce(A, k, fn):
    out = A.copy()
    pad = np.pad(A, k, constant_values=np.nan)
    for di in range(2 * k + 1):
        for dj in range(2 * k + 1):
            out = fn(out, pad[di:di + A.shape[0], dj:dj + A.shape[1]])
    return out


def blur(A, sigma):
    r = int(3 * sigma) + 1
    kern = np.exp(-np.arange(-r, r + 1) ** 2 / (2 * sigma * sigma))
    W, V = (~np.isnan(A)).astype(float), np.nan_to_num(A)
    for axis in (0, 1):
        V = np.apply_along_axis(lambda m: np.convolve(m, kern, "same"), axis, V)
        W = np.apply_along_axis(lambda m: np.convolve(m, kern, "same"), axis, W)
    return np.where(W > 1e-6, V / np.maximum(W, 1e-9), np.nan)


kh, kb = max(1, round(sm["holes"] / g)), max(1, round(sm["bumps"] / g))
smooth = blur(reduce(reduce(reduce(reduce(D, kh, np.fmin), kh, np.fmax), kb, np.fmax), kb, np.fmin), sm["sigma"] / g)
core = sm["core"]
XX, ZZ = np.meshgrid(xs - cx, zs - (ze + core["centre"]))
rho = np.sqrt((XX / core["x"]) ** 2 + (ZZ / np.where(ZZ > 0, core["above"], core["below"])) ** 2)


def sample(A, x, z):
    fx, fz = (x - xs[0]) / g, (z - zs[0]) / g
    j, i = int(np.floor(fx)), int(np.floor(fz))
    if not (0 <= i < len(zs) - 1 and 0 <= j < len(xs) - 1):
        return 0.0
    tx, tz = fx - j, fz - i
    return float((A[i, j] * (1 - tx) + A[i, j + 1] * tx) * (1 - tz) + (A[i + 1, j] * (1 - tx) + A[i + 1, j + 1] * tx) * tz)


w_skull = weight_of("Head")
fade = 1 - smoothstep(core["fade"], 1.0, rho)
D_filled = np.where(np.isnan(D), smooth, D)
for v in np.where(is_body & (w_skull > 0.5) & (base[:, 1] < sm["frontOf"]))[0]:
    x, y, z = base[v]
    w = sample(np.nan_to_num(fade), x, z)
    if w <= 0:
        continue
    # A vertex on the front surface goes onto the smoothed one; one behind it (inside the lips, a socket) stays
    # as far behind, less the tolerance, so nothing of what was hidden comes through.
    behind = max(0.0, y - sample(D_filled, x, z) - sm["tolerance"])
    base[v, 1] = (1 - w) * y + w * (sample(np.nan_to_num(smooth), x, z) + behind)
# The jaw units move the chin and jaw, not the smoothed mouth: they fade out from below the mouth up to it.
jm = F["jawMask"]
keep_jaw = 1 - smoothstep(zm - jm["from"], zm - jm["to"], base[:, 2])
moved = {c: np.zeros((N, 3)) for c in SHAPES}
for c in SKIN:
    moved[c] = skin_moved[c] * (keep_jaw[:, None] if c.startswith("jaw") else 1.0)
skin = BVHTree.FromPolygons([tuple(v) for v in base], body_polys)
def on_skin(x, z, lift=0.0):
    """The skin in front at (x, z), less lift. A ray through a gap left in the face (the mouth's slit, a nostril)
    finds the back of the head, so there the smoothed depth is taken instead."""
    hit = skin.ray_cast(Vector((x, -1.0, z)), Vector((0, 1, 0)))[0]
    y = sample(np.nan_to_num(smooth), x, z)
    if hit is None and y == 0.0:
        raise SystemExit(f"no skin in front at x={x:.3f} z={z:.3f}")
    if hit is None or (y != 0.0 and hit[1] > y + sm["tolerance"]):
        return np.array((x, y - lift, z))
    return np.array((hit[0], hit[1] - lift, hit[2]))


# --- The parts of the face, each added after the body's vertices with its offsets per face shape -----------
ex_v, ex_f, ex_m, ex_off = [], [], [], {c: [] for c in SHAPES}


def add_part(verts, faces, mats, offs, outward):
    """verts (n, 3); faces as local indices; a material slot per face; offs: channel -> (n, 3); outward(p) is
    the way a face at p should look, so each face is turned to face it."""
    first = N + len(ex_v)
    verts = np.asarray(verts, dtype=float)
    for f, m in zip(faces, mats):
        p = verts[f]
        n = np.cross(p[1] - p[0], p[2] - p[0])
        if np.linalg.norm(n) > 1e-9 and np.dot(n, outward(p.mean(axis=0))) < 0:
            f = f[::-1]
        ex_f.append([first + i for i in f])
        ex_m.append(m)
    ex_v.extend(map(tuple, verts))
    for c in SHAPES:
        ex_off[c].extend(offs.get(c, np.zeros((len(verts), 3))))


def grid_faces(cols, rows, first=0):
    return [[first + i * rows + j, first + (i + 1) * rows + j, first + (i + 1) * rows + j + 1, first + i * rows + j + 1]
            for i in range(cols - 1) for j in range(rows - 1)]


front = lambda p: np.array((0.0, -1.0, 0.0))

# The eyes: big spheres a little behind the smoothed surface, so most of each shows.
ey = F["eyes"]
R = ey["radius"]
eyes = {}
for side in SIDES:
    x = cx + SIGN[side] * ey["x"]
    surf = on_skin(x, ze)
    eyes[side] = np.array((x, surf[1] + ey["depth"] * R, ze))

# The lids: shells about each eye, the upper one ending in a dark lash band. A point is at (u, a): u across
# the eye (-1 inner .. 1 outer), a its angle up from straight ahead about the eye's horizontal axis. A lid
# shape moves the lid's edge to a new angle and spreads the rest of the lid over the angles behind it.
ld = F["lids"]


def lid_point(E, r, side, u, a):
    a = math.radians(a)
    c = math.sqrt(max(0.0, 1 - u * u))
    return E + r * np.array((SIGN[side] * u, -c * math.cos(a), c * math.sin(a)))


def lid_angles(back, rows, new_edge):
    t = np.linspace(0, 1, rows)
    return new_edge + t * (back - new_edge)


for side, E in eyes.items():
    for which in ("upper", "lower"):
        L = ld[which]
        r = L["radius"] * R
        us = np.linspace(-1, 1, ld["columns"])
        rows = L["rows"]
        angles = lid_angles(L["back"], rows, L["edge"])
        verts = [lid_point(E, r, side, u, a) for u in us for a in angles]
        faces = grid_faces(len(us), rows)
        lash = [which == "upper" and abs(angles[j] - angles[0]) < L.get("lash", 0) for i in range(len(us) - 1) for j in range(rows - 1)]
        mats = ["lash" if x else "skin" for x in lash]
        offs = {}
        for shape, edges in ld["shapes"].items():
            new = edges[0 if which == "upper" else 1]
            if new is None:
                continue
            moved_angles = lid_angles(L["back"], rows, new)
            target = np.array([lid_point(E, r, side, u, a) for u in us for a in moved_angles])
            # A shape moves each vertex in a straight line, which cuts inside the eye halfway through a long
            # sweep, so the lid would hide behind the eye at a partial weight: the target goes out along its
            # radius until the halfway point clears the eye by `clear`.
            v0 = np.array(verts) - E
            for k, t1 in enumerate(target - E):
                a2, b = np.dot(v0[k], v0[k]), np.dot(v0[k], t1) / np.linalg.norm(t1)
                need = (2 * ld["clear"] * R) ** 2
                if np.dot(v0[k] + t1, v0[k] + t1) < need:
                    q = (-b + math.sqrt(b * b - (a2 - need))) if b * b - (a2 - need) >= 0 else np.linalg.norm(t1)
                    target[k] = E + t1 / np.linalg.norm(t1) * max(q, np.linalg.norm(t1))
            offs[shape + side] = target - np.array(verts)
        add_part(verts, faces, mats, offs, lambda p, E=E: p - E)

# The brows: a thick ribbon riding the skin above each eye, in eye radii from the eye centre: x from the inner
# to the outer end, the lower edge at the inner end, its rise toward the outer end, the arch, the thickness
# (tapering toward the outer end).
bro = F["brows"]
bs = F["browShapes"]
for side, E in eyes.items():
    sg = SIGN[side]
    n, rows = bro["segments"], bro["rows"]
    plan = []  # (t, x, z) in the face's plane
    for i in range(n + 1):
        t = i / n
        u = -bro["inner"] + t * (bro["inner"] + bro["outer"])
        low = bro["low"] + bro["rise"] * t + bro["arch"] * (1 - (2 * t - 1) ** 2)
        thick = bro["thick"] * (1 - bro["taper"] * t * t)
        for j in range(rows):
            plan.append((t, E[0] + sg * u * R, E[2] + (low + thick * j / (rows - 1)) * R))
    verts = np.array([on_skin(x, z, bro["lift"]) for _, x, z in plan])

    def shaped(fn):
        return np.array([on_skin(x + dx, z + dz, bro["lift"]) for (t, x, z), (dx, dz) in zip(plan, (fn(t) for t, _, _ in plan))]) - verts

    offs = {
        f"browDown{side}": shaped(lambda t: (-sg * bs["downIn"] * (1 - t), -(bs["downOuter"] + (bs["downInner"] - bs["downOuter"]) * (1 - t)))),
        f"browOuterUp{side}": shaped(lambda t: (0.0, bs["outerUp"] * t ** 1.5)),
        "browInnerUp": shaped(lambda t: (sg * bs["innerOut"] * (1 - t), bs["innerUp"] * (1 - t) ** 1.5)),
    }
    add_part(verts, grid_faces(n + 1, rows), ["brow"] * (n * (rows - 1)), offs, front)

# The nose: a small round nose on the smoothed face, half out of it.
no = F["nose"]
zn = ze + no["at"] * (zm - ze)
surf = on_skin(cx, zn)
rad = np.array(no["radii"])
nc = surf + np.array((0.0, (1 - 2 * no["out"]) * rad[1], 0.0))
bm_ = bmesh.new()
bmesh.ops.create_uvsphere(bm_, u_segments=12, v_segments=8, radius=1.0)
unit = np.array([v.co[:] for v in bm_.verts])
sphere_f = [[v.index for v in f.verts] for f in bm_.faces]
bm_.free()
nose_v = nc + unit * rad
sneer = {f"noseSneer{side}": np.outer(np.clip(0.5 + SIGN[side] * (nose_v[:, 0] - cx) / (2 * rad[0]), 0, 1), (0, 0, no["sneer"])) for side in SIDES}
add_part(nose_v, sphere_f, ["skin"] * len(sphere_f), sneer, lambda p: p - nc)

# The mouth: a dark shape on the skin between an upper and a lower edge, a teeth row between them that shows
# only when a shape opens it (a smile). Each shape moves the edges in the face's plane; the points then go back
# onto the skin. s runs from the human's right corner (-1) to its left (1).
mo = F["mouth"]
ms = F["mouthShapes"]
cols = mo["columns"]
S_ = np.linspace(-1, 1, cols)
thick = mo["thick"] * np.sqrt(np.clip(1 - S_ ** 2, 0, 1)) + mo["corner"] * mo["thick"]
ROWS = ("upper", "teeth", "lower")
plan = {"upper": thick / 2, "teeth": thick / 2, "lower": -thick / 2}


def mouth_at(d):
    """d: row -> (dx, dz, dy) arrays over the columns; the points, back on the skin."""
    pts = []
    for i, s_ in enumerate(S_):
        for row in ROWS:
            dx, dz, dy = (d.get(row, (0, 0, 0))[k][i] if np.ndim(d.get(row, (0, 0, 0))[k]) else d.get(row, (0, 0, 0))[k] for k in range(3))
            p = on_skin(cx + s_ * mo["halfWidth"] + dx, zm + plan[row][i] + dz, mo["lift"])
            pts.append(p + np.array((0.0, dy, 0.0)))
    return np.array(pts)


mouth_v = mouth_at({})
Z = np.zeros(cols)
mid = np.clip(1 - S_ ** 2, 0, 1)  # 1 at the middle, 0 at the corners


def every(dx=Z, dz=Z, dy=Z):
    return {row: (dx, dz, dy) for row in ROWS}


mouth_shapes = {}
for side in SIDES:
    sg = SIGN[side]
    on = np.clip(sg * S_, 0, 1)  # this side's half, 0 at the middle, 1 at its corner
    sm_, fr, st, pr_, lo, up, di = (ms[k] for k in ("smile", "frown", "stretch", "press", "lowerDown", "upperUp", "dimple"))
    open_ = 0.5 * sm_["open"] * mid
    mouth_shapes[f"mouthSmile{side}"] = {
        "upper": (sg * sm_["out"] * on ** 2, sm_["up"] * on ** 2, Z),
        "teeth": (sg * sm_["out"] * on ** 2, sm_["up"] * on ** 2 - sm_["teeth"] * open_, Z),
        "lower": (sg * sm_["out"] * on ** 2, sm_["up"] * on ** 2 - open_, Z),
    }
    mouth_shapes[f"mouthFrown{side}"] = every(sg * fr["out"] * on ** 2, -fr["down"] * on ** 2)
    mouth_shapes[f"mouthStretch{side}"] = every(sg * st["out"] * on, -st["down"] * on)
    mouth_shapes[f"mouthPress{side}"] = {"upper": (sg * pr_["out"] * on, -pr_["thin"] * on - pr_["down"] * on ** 2, Z), "teeth": (sg * pr_["out"] * on, -pr_["thin"] * on - pr_["down"] * on ** 2, Z), "lower": (sg * pr_["out"] * on, pr_["thin"] * on - pr_["down"] * on ** 2, Z)}
    bump = np.clip(1 - ((sg * S_ - 0.45) / 0.45) ** 2, 0, 1)
    mouth_shapes[f"mouthLowerDown{side}"] = {"lower": (Z, -lo * bump, Z)}
    mouth_shapes[f"mouthUpperUp{side}"] = {"upper": (Z, up * bump, Z), "teeth": (Z, up * bump, Z)}
    mouth_shapes[f"mouthDimple{side}"] = every(sg * di * on, 0.3 * di * on)
fu, pu, ro, sh = ms["funnel"], ms["pucker"], ms["roll"], ms["shrug"]
mouth_shapes["jawOpen"] = {"lower": (Z, -ms["jawOpen"] * mid ** 0.7, Z)}
mouth_shapes["mouthClose"] = {"lower": (Z, thick, Z)}
mouth_shapes["mouthFunnel"] = {"upper": (-fu["in"] * S_, fu["up"] * mid, Z), "teeth": (-fu["in"] * S_, fu["up"] * mid, Z), "lower": (-fu["in"] * S_, -fu["down"] * mid, Z)}
mouth_shapes["mouthPucker"] = every(-pu["in"] * S_, Z, -pu["forward"] * mid)
mouth_shapes["mouthRollLower"] = {"upper": (-ro["in"] * S_, -ro["down"] * np.abs(S_), Z), "teeth": (-ro["in"] * S_, -ro["down"] * np.abs(S_), Z), "lower": (-ro["in"] * S_, ro["thin"] - ro["down"] * np.abs(S_), Z)}
mouth_shapes["mouthRollUpper"] = {"upper": (-ro["in"] * S_, -ro["thin"] - ro["down"] * np.abs(S_), Z), "teeth": (-ro["in"] * S_, -ro["thin"] - ro["down"] * np.abs(S_), Z), "lower": (-ro["in"] * S_, -ro["down"] * np.abs(S_), Z)}
mouth_shapes["mouthShrugLower"] = {"lower": (Z, sh * np.ones(cols), Z)}
mouth_shapes["mouthShrugUpper"] = {"upper": (Z, sh * np.ones(cols), Z), "teeth": (Z, sh * np.ones(cols), Z)}
mouth_shapes["mouthLeft"] = every(ms["side"] * np.ones(cols))
mouth_shapes["mouthRight"] = every(-ms["side"] * np.ones(cols))
mouth_shapes["jawLeft"] = every(ms["jawSide"] * np.ones(cols))
mouth_shapes["jawRight"] = every(-ms["jawSide"] * np.ones(cols))
mouth_shapes["jawForward"] = every(dy=-ms["jawForward"] * np.ones(cols))
mouth_offs = {c: mouth_at(d) - mouth_v for c, d in mouth_shapes.items()}
mouth_faces, mouth_mats = [], []
for i in range(cols - 1):
    for j, mat in ((0, "teeth"), (1, "mouth")):
        a, b = i * 3 + j, (i + 1) * 3 + j
        mouth_faces.append([a, a + 1, b + 1, b])  # facing -Y: the teeth quads are flat at neutral, so set here
        mouth_mats.append(mat)
add_part(mouth_v, mouth_faces, mouth_mats, mouth_offs, front)

# --- The rig: MPFB's mixamo rig fitted to the proportioned mesh, named as the stock avatar -----------------
human.data.vertices.foreach_set("co", base.astype(np.float32).ravel())
human.data.update()
bpy.context.view_layer.objects.active = human
rig = HumanService.add_builtin_rig(human, "mixamo", import_weights=True)
rig.name = rig.data.name = "Armature"
for b in rig.data.bones:
    if b.name.startswith(PREFIX):
        b.name = b.name[len(PREFIX):]
for gr in human.vertex_groups:
    if gr.name.startswith(PREFIX):
        gr.name = gr.name[len(PREFIX):]
bpy.ops.object.select_all(action="DESELECT")
rig.select_set(True)
bpy.context.view_layer.objects.active = rig
bpy.ops.object.mode_set(mode="EDIT")
eb = rig.data.edit_bones
head_bone = eb["Head"]
for side, E in eyes.items():
    b = eb.new(f"{side}Eye")
    b.head = E
    b.tail = (E[0], E[1] - 2 * R, E[2])
    b.parent = head_bone
top = eb.new("HeadTop_End")
top.head = (head_bone.head.x, head_bone.head.y, head_top[2])
top.tail = (top.head.x, top.head.y, head_top[2] + 0.05)
top.parent = head_bone
top.use_deform = False
bpy.ops.object.mode_set(mode="OBJECT")

# --- Join the parts to the body (carried by the head), and the face shapes --------------------------------
n_body_polys = len(human.data.polygons)
pmesh = bpy.data.meshes.new("Face")
pmesh.from_pydata(ex_v, [], [[i - N for i in f] for f in ex_f])
pobj = bpy.data.objects.new("Face", pmesh)
pobj.matrix_world = human.matrix_world  # the parts are in the human's mesh space
bpy.context.scene.collection.objects.link(pobj)
pobj.vertex_groups.new(name="Head").add(list(range(len(ex_v))), 1.0, "REPLACE")
bpy.ops.object.select_all(action="DESELECT")
pobj.select_set(True)
human.select_set(True)
bpy.context.view_layer.objects.active = human
bpy.ops.object.join()
for c in SHAPES:
    moved[c] = np.vstack([moved[c], np.array(ex_off[c])])
base = np.vstack([base, np.array(ex_v)])

human.shape_key_add(name="Basis")
for c in SHAPES:
    k = human.shape_key_add(name=c, from_mix=False)
    k.data.foreach_set("co", (base + moved[c]).astype(np.float32).ravel())
    k.value = 0.0  # the exporter writes each key's value as the mesh's default morph weight
human.data.update()

# --- Materials -----------------------------------------------------------------------------
def material(name, rgb):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*rgb, 1.0)
    bsdf.inputs["Roughness"].default_value = P["roughness"]
    bsdf.inputs["Metallic"].default_value = 0.0
    m.use_backface_culling = True  # exported single-sided, as three.js draws the stock avatar
    return m


col = P["colours"]
slots = ["skin", "top", "trousers", "shoes", "brow", "mouth", "teeth", "lash"]
human.data.materials.clear()
for n in slots:
    human.data.materials.append(material(f"HouseBase_{n}", col[n]))

names = {gr.index: gr.name for gr in human.vertex_groups}
bone_names = {b.name for b in rig.data.bones}
vbone = [""] * len(human.data.vertices)
for v in human.data.vertices:
    best = max(((gw.weight, names[gw.group]) for gw in v.groups if names[gw.group] in bone_names), default=(0, ""))
    vbone[v.index] = best[1]

TOP = ("Spine", "Spine1", "Spine2", "LeftShoulder", "RightShoulder", "LeftArm", "RightArm", "LeftForeArm", "RightForeArm")
LEGS = ("Hips", "LeftUpLeg", "RightUpLeg", "LeftLeg", "RightLeg")
FEET = ("LeftFoot", "RightFoot", "LeftToeBase", "RightToeBase")
for poly in human.data.polygons:
    poly.use_smooth = True
    if poly.index >= n_body_polys:
        poly.material_index = slots.index(ex_m[poly.index - n_body_polys])
        continue
    bones = [vbone[i] for i in poly.vertices]
    slot = "skin"
    # Half or more decides, so a face split between two garments (the waist) or a garment and the neck
    # (the collar) is cloth, not a strip of skin; the feet win, and the toe tips (weighted to no rig bone) are shoe.
    t, l, f = (sum(b in gr for b in bones) for gr in (TOP, LEGS, FEET))
    if f and (f * 2 >= len(bones) or all(b in FEET or b == "" for b in bones)):
        slot = "shoes"
    elif t * 2 >= len(bones) and t >= l:
        slot = "top"
    elif l * 2 >= len(bones):
        slot = "trousers"
    poly.material_index = slots.index(slot)

# The neckline: round the neck the voting above leaves a ragged edge, so a plane through the neck's base,
# tilting down to the front, decides there instead (jumper below, skin above).
cl = P["garments"]["collar"]
neck_v = np.array([v.co[:] for v in human.data.vertices if vbone[v.index] == "Neck"])
z0, y0 = float(neck_v[:, 2].min()) + cl["raise"], float(neck_v[:, 1].mean())
# By position, not by bone: the bone vote is not mirror-symmetric round the shoulders, so the plane rules
# over every skin or cloth face across the shoulders' width from a little below it up.
for poly in human.data.polygons:
    c = poly.center
    if poly.index >= n_body_polys or abs(c.x) > cl["halfWidth"] or c.z < z0 - cl["below"]:
        continue
    if slots[poly.material_index] in ("skin", "top"):
        poly.material_index = slots.index("top" if c.z < z0 + cl["tilt"] * (c.y - y0) else "skin")

# The trouser hems: at the ankles the vote leaves a ragged edge too (and the fit moves it), so a level plane
# `raise` (m) above the top of the feet' faces decides there instead (shoe below, trousers above).
cf = P["garments"]["cuff"]
foot_z = np.array([human.data.vertices[i].co.z for i in range(len(vbone)) if vbone[i] in ("LeftToeBase", "RightToeBase")])
zc = float(foot_z.max()) + cf["raise"]
for poly in human.data.polygons:
    if poly.index >= n_body_polys or abs(poly.center.z - zc) > cf["band"]:
        continue
    if slots[poly.material_index] in ("trousers", "shoes", "skin"):
        poly.material_index = slots.index("shoes" if poly.center.z < zc else "trousers")

# --- Remove helper geometry and joint cubes -----------------------------------------------
drop = set(members["HelperGeometry"].tolist()) | set(members["JointCubes"].tolist())
bm = bmesh.new()
bm.from_mesh(human.data)
bm.verts.ensure_lookup_table()
bmesh.ops.delete(bm, geom=[bm.verts[i] for i in drop], context="VERTS")
bm.to_mesh(human.data)
bm.free()
for gr in list(human.vertex_groups):
    if gr.name.startswith(("helper", "joint", "Helper", "Joint")) or gr.name in ("body", "Left", "Right", "Mid"):
        human.vertex_groups.remove(gr)
for m in list(human.modifiers):
    if m.type != "ARMATURE":
        human.modifiers.remove(m)
human.name = human.data.name = "HouseBase_Body"

# --- The traits that are geometry: garments, hair, glasses (dress.py) ----------------------------
vb = np.array([v.co[:] for v in human.data.vertices])  # the body before the garments replace its clothed faces
gw = lambda name: np.array([next((g.weight for g in v.groups if g.group == human.vertex_groups[name].index), 0.0) for v in human.data.vertices])
w_hd, w_arm = gw("Head"), gw("LeftArm")
brow_v = np.array(ex_v)[[i for f, m in zip(ex_f, ex_m) if m == "brow" for i in (np.array(f) - N)]]
H = P["hair"]
land = {
    "hairlineZ": float(brow_v[:, 2].max()) + max(F["browShapes"]["innerUp"], F["browShapes"]["outerUp"]) + H["browMargin"],
    "browHalfWidth": ey["x"] + F["brows"]["outer"] * R + 0.012,
    "chinZ": float(vb[(w_hd > 0.99) & (vb[:, 1] < eyes["Left"][1] + 0.02), 2].min()),
    "shoulderZ": float(vb[w_arm > 0.5, 2].max()),
}
wear, garment_report = dress.garments(human, rig, slots, P["garments"])
bvh = dress.mesh_bvh(np.array([v.co[:] for v in human.data.vertices]), [list(p.vertices) for p in human.data.polygons])
C = dress.head_centre(bvh, cx, ze, eyes["Left"][1])
hair_mat = material("HouseBase_hair", col["hair"])
hair_mat.use_backface_culling = False  # a curtain's inside shows
frames_mat = material("HouseBase_frames", col["frames"])
hair_report = {}
for style, S in H["styles"].items():
    if style.startswith("$"):
        continue
    hv, hf, hw = dress.hair(S, H, bvh, C, land)
    wear.append(dress.skinned(f"Hair_{style}", hv, hf, hw, [hair_mat], rig, human))
    hair_report[style] = {"vertices": len(hv), "lowestZ": round(float(hv[:, 2].min()), 4)}
glasses_report = {}
for kind in P["glasses"]["kinds"]:
    gv, gf, gwts = dress.glasses(kind, P["glasses"], eyes, R, bvh, C, cx)
    wear.append(dress.skinned(f"Glasses_{kind}", gv, gf, gwts, [frames_mat], rig, human))
    glasses_report[kind] = {"vertices": len(gv), "rimTopAboveEye": round(float(gv[:, 2].max() - ze), 4)}

# --- Eyeballs, each carried by its eye bone ----------------------------------------------
for side, E in eyes.items():
    bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=20, radius=R, location=E)
    eye = bpy.context.active_object
    eye.rotation_euler = (math.pi / 2, 0, 0)  # the pole faces -Y, the way the human looks
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
    eye.name = eye.data.name = f"Eye{side}"
    for n in ("sclera", "iris", "pupil"):
        eye.data.materials.append(material(f"HouseBase_eye_{n}", col[n]) if f"HouseBase_eye_{n}" not in bpy.data.materials else bpy.data.materials[f"HouseBase_eye_{n}"])
    for poly in eye.data.polygons:
        d = poly.center.normalized()
        ang = math.acos(max(-1.0, min(1.0, -d.y)))
        poly.material_index = 2 if ang < ey["pupil"] else 1 if ang < ey["iris"] else 0
        poly.use_smooth = True
    gr = eye.vertex_groups.new(name=f"{side}Eye")
    gr.add(list(range(len(eye.data.vertices))), 1.0, "REPLACE")
    eye.parent = rig
    mod = eye.modifiers.new("Armature", "ARMATURE")
    mod.object = rig

# --- Credits and export ------------------------------------------------------------------
credits = [
    {"part": "body mesh, proportions targets, rig and weights", "title": "MakeHuman base mesh (hm08), mixamo rig", "author": "MakeHuman team", "source": "MPFB 2.0.18 (extensions.blender.org/add-ons/mpfb)", "sourceUrl": "https://extensions.blender.org/add-ons/mpfb/", "licence": "CC0-1.0", "note": "MPFB is GPL-3.0; the human it outputs is CC0"},
    {"part": "the jaw and cheek face shapes", "title": "Faceunits 01", "author": "Mika Suominen", "source": "MakeHuman asset packs", "sourceUrl": "https://static.makehumancommunity.org/assets/assetpacks/faceunits01.html", "licence": "CC0-1.0"},
    {"part": "proportions, the stylised face (eyes, lids, brows, nose, mouth) and its face shapes, the garments, hair styles and glasses frames, materials", "title": "HoloIM house base build script", "author": "HoloIM", "source": "apps/capture/scripts/authoring/house-base", "sourceUrl": "https://github.com/AlbertoElias/holo/tree/main/apps/capture/scripts/authoring/house-base", "licence": "CC0-1.0", "note": "own"},
]
bpy.context.scene["holoimAvatar"] = json.dumps({"name": P["name"], "finish": P["finish"], "build": BUILD, "card": "neutral", "provisional": True, "credits": credits})

bpy.ops.object.select_all(action="SELECT")
bpy.ops.export_scene.gltf(
    filepath=OUT, export_format="GLB", use_selection=False, export_yup=True, export_apply=False,
    export_morph=True, export_morph_normal=False, export_skins=True, export_animations=False,
    export_materials="EXPORT", export_extras=True, export_def_bones=False, export_texcoords=False,
    export_tangents=False, export_cameras=False, export_lights=False,
)

report = {
    "height": P["height"], "vertices": len(human.data.vertices),
    "eyes": {k: {"centre": [round(float(x), 4) for x in v], "radius": R} for k, v in eyes.items()},
    "headTop": round(float(head_top[2]), 4), "mouth": round(zm, 4),
    "bones": [b.name for b in rig.data.bones],
    "materials": {n: sum(1 for p in human.data.polygons if p.material_index == i) for i, n in enumerate(slots)},
    "credits": credits, "build": BUILD, "landmarks": {k: round(v, 4) for k, v in land.items()},
    "garments": garment_report, "hair": hair_report, "glasses": glasses_report, "fit": fit_report,
}
json.dump(report, open(REPORT, "w"), indent=2)
print("HOUSE_BASE_DONE", OUT)
