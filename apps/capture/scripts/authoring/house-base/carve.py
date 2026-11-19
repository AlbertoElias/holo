"""
The fit target, carved from Astra's clay turnaround alone (slice 2c2 of docs/features/directed-performance.md):
the visual hull of the sheet's four figures, with no generator, so the base's shape comes only from the
owner's sheets and the CC0 MPFB human. Run as:

  Blender -b --python carve.py -- <clay-turnaround.png> <out.glb> [report.json]

The sheet's camera is orthographic-like and not known, so each figure is framed as `likeness.py` frames the
base: its height (head top to sole) is the figure's unit height, its feet on the floor and its middle on the
figure's mean column. A voxel of the figure's space is kept when every view sees it inside that view's
figure: front (0 degrees), three-quarter (45), side (90) and back (180), turned as `likeness.py` turns the
base (about +Z, so the three-quarter and side views face the image's right), and the three-quarter view
mirrored (the figure is left-right symmetric), which is the view from -45 degrees: four axes across the floor
(x, y and the two diagonals), so a section through a limb is an octagon at worst.

Then:
- the three-quarter view's column offset (its figure's mean column is not exactly the figure's centre seen
  from there) is the one, searched, at which the hull's own views best match the sheet's;
- the occupancy is blurred (a Gaussian over a few voxels) and cut at one half, the outer surface taken as
  voxel faces, the largest connected piece kept, smoothed (Taubin, so it does not shrink) and decimated;
- it is written as a GLB, scaled to `HEIGHT` metres, sole at 0, facing -Y (Blender's frame; the exporter
  turns +Z up into glTF's +Y up), its left at +X.

`fit.py` scales and places the target on the human itself, so only the shape matters here.
"""
import bpy, json, math, os, sys
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sheet import Turnaround  # noqa: E402

argv = sys.argv[sys.argv.index("--") + 1:]
SHEET, OUT = argv[0], argv[1]
REPORT = argv[2] if len(argv) > 2 else None
HEIGHT = 1.75
VOXEL = 1 / 360  # of the figure's height (about 5 mm)
BLUR = 1.2  # voxels (Gaussian sigma)
TAUBIN = 4  # rounds, after the projection
FACES = 60000  # after decimation
# The three-quarter drawing is not an exact turn of the front one (its arms hang at another angle), so a strict
# intersection carves the arms thin: its figure is widened by this much (figure heights) before carving.
TQ_SLACK = float(os.environ.get("CARVE_TQ_SLACK", 0.012))
BLUR = float(os.environ.get("CARVE_BLUR", BLUR))
BLUR_XY = float(os.environ.get("CARVE_BLUR_XY", 5.0))  # voxels, across the floor

T = Turnaround(SHEET)
names = ["front", "threeQuarter", "side", "back"]
figs = {}
for name, (a, b) in zip(names, T.runs):
    m, top, sole = T.figure(a, b)
    cols = np.where(m)[1]
    figs[name] = {"mask": m, "top": top, "sole": sole, "mid": float(cols.mean()), "unit": float(sole - top)}


def widen(m, px):
    """The mask grown by px pixels (a disc)."""
    out = m.copy()
    for dy in range(-px, px + 1):
        for dx in range(-px, px + 1):
            if dx * dx + dy * dy <= px * px:
                out |= np.roll(np.roll(m, dy, axis=0), dx, axis=1)
    return out


figs["threeQuarterCarve"] = dict(figs["threeQuarter"], mask=widen(figs["threeQuarter"]["mask"], int(round(TQ_SLACK * figs["threeQuarter"]["unit"]))))


def lookup(name, u, v, offset=0.0, mirror=False):
    """Whether the figure `name` covers the points at u (across, in figure heights from its middle; the
    image's right is +) and v (up from the sole, in figure heights)."""
    f = figs[name]
    uu = -u if mirror else u
    col = np.round(f["mid"] + (uu + offset) * f["unit"]).astype(int)
    row = np.round(f["sole"] - v * f["unit"]).astype(int)
    ok = (col >= 0) & (col < T.W) & (row >= 0) & (row < T.H)
    out = np.zeros(u.shape, dtype=bool)
    out[ok] = f["mask"][row[ok], col[ok]]
    return out


def across(deg, x, y):
    """The image column (figure units) of a point (x, y) when the figure is turned by deg about +Z."""
    t = math.radians(deg)
    return x * math.cos(t) - y * math.sin(t)


# The grid: across from the front figure's widest reach, depth from the side figure's.
def reach(name):
    f = figs[name]
    cols = np.where(f["mask"])[1]
    return (cols.min() - f["mid"]) / f["unit"], (cols.max() - f["mid"]) / f["unit"]


fx0, fx1 = reach("front")
sy0, sy1 = reach("side")  # side: column = -y
pad = 0.02
xs = np.arange(min(fx0, -fx1) - pad, max(-fx0, fx1) + pad, VOXEL)
ys = np.arange(-sy1 - pad, -sy0 + pad, VOXEL)
zs = np.arange(-pad, 1 + pad, VOXEL)
X, Y = np.meshgrid(xs, ys, indexing="ij")


def carve(tq_offset):
    occ = np.zeros((len(xs), len(ys), len(zs)), dtype=bool)
    for k, z in enumerate(zs):
        V = np.full(X.shape, z)
        o = lookup("front", across(0, X, Y), V)
        o &= lookup("back", across(180, X, Y), V)
        o &= lookup("side", across(90, X, Y), V)
        o &= lookup("threeQuarterCarve", across(45, X, Y), V, tq_offset)
        o &= lookup("threeQuarterCarve", across(-45, X, Y), V, tq_offset, mirror=True)
        occ[:, :, k] = o
    return occ


def views_iou(occ, tq_offset=0.0):
    """The hull's own silhouettes against the sheet's, per view, on a raster of the voxel's size (the
    sheet's figure sampled at the raster's cell centres)."""
    out = {}
    idx = np.argwhere(occ)
    P = np.stack([xs[idx[:, 0]], ys[idx[:, 1]], zs[idx[:, 2]]], axis=1)
    us = np.arange(-0.6, 0.6, VOXEL)
    U, Z = np.meshgrid(us, zs, indexing="ij")
    for name, deg in (("front", 0), ("threeQuarter", 45), ("side", 90), ("back", 180)):
        u = across(deg, P[:, 0], P[:, 1])
        hull = np.zeros(U.shape, dtype=bool)
        hull[np.clip(np.round((u - us[0]) / VOXEL).astype(int), 0, len(us) - 1), idx[:, 2]] = True
        drawn = lookup(name, U, Z, tq_offset if name == "threeQuarter" else 0.0)
        u_ = (hull | drawn).sum()
        out[name] = round(float((hull & drawn).sum() / u_), 4) if u_ else 0.0
    return out


# The three-quarter offset: the one at which the hull, seen as the sheet draws it, matches best.
search = {}
for off in np.arange(-0.03, 0.0301, 0.005):
    search[round(float(off), 3)] = float(np.mean(list(views_iou(carve(off), off).values())))
best = max(search, key=search.get)
occ = carve(best)
ious = views_iou(occ, best)


def blur(a, sigmas):
    for ax, sigma in enumerate(sigmas):
        r = int(math.ceil(3 * sigma))
        k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
        k /= k.sum()
        a = np.apply_along_axis(lambda s: np.convolve(s, k, mode="same"), ax, a)
    return a


# Across the floor the blur is wider: a section of the hull is a polygon (one side per view) and a body's is
# round, so its corners, where the hull is fullest, are worn down.
field = blur(occ.astype(np.float32), (BLUR_XY, BLUR_XY, BLUR))
solid = field > 0.5

# The outer surface as voxel faces: a face where a solid voxel meets an empty one, its corners on the grid.
nx, ny, nz = solid.shape
S = np.zeros((nx + 2, ny + 2, nz + 2), dtype=bool)
S[1:-1, 1:-1, 1:-1] = solid
cid = lambda i, j, k: (i * (ny + 3) + j) * (nz + 3) + k  # corner ids on the padded grid
quads = []
for ax in range(3):
    a = S[1:, :, :] if ax == 0 else S[:, 1:, :] if ax == 1 else S[:, :, 1:]
    b = S[:-1, :, :] if ax == 0 else S[:, :-1, :] if ax == 1 else S[:, :, :-1]
    for sign, where in ((1, a & ~b), (-1, ~a & b)):  # solid on the + side, or on the - side
        i, j, k = np.nonzero(where)
        # The face sits between cells c and c+1 along ax, at corner plane c+1.
        c = [i, j, k]
        c[ax] = c[ax] + 1
        e1, e2 = [(ax + 1) % 3, (ax + 2) % 3]
        def corner(d1, d2):
            q = [c[0].copy(), c[1].copy(), c[2].copy()]
            q[e1] = q[e1] + d1
            q[e2] = q[e2] + d2
            return cid(*q)
        ring = [corner(0, 0), corner(1, 0), corner(1, 1), corner(0, 1)]
        if sign > 0:  # the normal points to -ax (out of the solid)
            ring = ring[::-1]
        quads.append(np.stack(ring, axis=1))
quads = np.vstack(quads)
ids, inv = np.unique(quads.ravel(), return_inverse=True)
faces = inv.reshape(-1, 4)
ci = ids // ((ny + 3) * (nz + 3))
cj = (ids // (nz + 3)) % (ny + 3)
ck = ids % (nz + 3)
# Corner c of the padded grid is at the low edge of padded cell c, that is grid coordinate c - 1 - 0.5.
V = np.stack([xs[0] + (ci - 1.5) * VOXEL, ys[0] + (cj - 1.5) * VOXEL, zs[0] + (ck - 1.5) * VOXEL], axis=1)



def sample(F, P):
    """Trilinear samples of the field F (on the voxel centres) at points P, and its gradient (per voxel)."""
    g = np.stack([(P[:, 0] - xs[0]) / VOXEL, (P[:, 1] - ys[0]) / VOXEL, (P[:, 2] - zs[0]) / VOXEL], axis=1)
    i0 = np.clip(np.floor(g).astype(int), 0, np.array(F.shape) - 2)
    t = np.clip(g - i0, 0, 1)
    val = np.zeros(len(P))
    grad = np.zeros((len(P), 3))
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                f = F[i0[:, 0] + dx, i0[:, 1] + dy, i0[:, 2] + dz]
                wx = t[:, 0] if dx else 1 - t[:, 0]
                wy = t[:, 1] if dy else 1 - t[:, 1]
                wz = t[:, 2] if dz else 1 - t[:, 2]
                val += f * wx * wy * wz
                grad[:, 0] += f * (1 if dx else -1) * wy * wz
                grad[:, 1] += f * wx * (1 if dy else -1) * wz
                grad[:, 2] += f * wx * wy * (1 if dz else -1)
    return val, grad / VOXEL


# The voxel faces step a voxel at a time, and a wall that leans a little steps every few voxels, which
# smoothing alone keeps as terraces: so each vertex is moved onto the blurred field's half level (a few
# Newton steps along its gradient, each at most half a voxel), then lightly smoothed (Taubin, no shrinking).
e = np.vstack([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 3]], faces[:, [3, 0]]])
e = np.unique(np.sort(e, axis=1), axis=0)
deg = np.bincount(e.ravel(), minlength=len(V)).astype(float)


def taubin(V, rounds):
    for _ in range(rounds):
        for lam in (0.5, -0.53):
            S_ = np.zeros_like(V)
            np.add.at(S_, e[:, 0], V[e[:, 1]])
            np.add.at(S_, e[:, 1], V[e[:, 0]])
            V = V + lam * (S_ / deg[:, None] - V)
    return V


for _ in range(3):
    V = taubin(V, 2)
    for _ in range(4):
        f, g = sample(field, V)
        step = ((f - 0.5) / np.maximum((g ** 2).sum(axis=1), 1e-6))[:, None] * g
        n = np.linalg.norm(step, axis=1, keepdims=True)
        V = V - step * np.minimum(1, 0.5 * VOXEL / np.maximum(n, 1e-12))
V = taubin(V, TAUBIN)

# Into Blender: keep the largest piece, decimate, export.
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o)
lo = V[:, 2].min()
mesh = bpy.data.meshes.new("SheetHull")
mesh.from_pydata(((V - [0, 0, lo]) * HEIGHT / (V[:, 2].max() - lo)).tolist(), [], faces.tolist())
mesh.update()
obj = bpy.data.objects.new("SheetHull", mesh)
bpy.context.scene.collection.objects.link(obj)
bpy.context.view_layer.objects.active = obj
obj.select_set(True)
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.mesh.separate(type="LOOSE")
bpy.ops.object.mode_set(mode="OBJECT")
parts = [o for o in bpy.data.objects if o.type == "MESH"]
keep = max(parts, key=lambda o: len(o.data.polygons))
pieces = len(parts)
for o in parts:
    if o is not keep:
        bpy.data.objects.remove(o)
bpy.context.view_layer.objects.active = keep
keep.select_set(True)
dec = keep.modifiers.new("Decimate", "DECIMATE")
dec.ratio = min(1.0, FACES / max(1, len(keep.data.polygons) * 2))
bpy.ops.object.modifier_apply(modifier=dec.name)
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True, export_materials="NONE", export_normals=False)

report = {
    "sheet": os.path.basename(SHEET), "voxel": VOXEL, "threeQuarterSlack": TQ_SLACK, "blur": BLUR, "blurAcross": BLUR_XY, "taubin": TAUBIN,
    "threeQuarterOffset": best, "offsetSearch": search, "hullIou": ious,
    "pieces": pieces, "faces": len(keep.data.polygons), "bytes": os.path.getsize(OUT),
}
if REPORT:
    json.dump(report, open(REPORT, "w"), indent=2)
print("HOUSE_CARVE_DONE", json.dumps({"hullIou": ious, "offset": best, "faces": report["faces"]}))
