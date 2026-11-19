"""
The fit (slice 2c2 of docs/features/directed-performance.md): moves the MPFB human onto a target shape
generated from Astra's clay turnaround, keeping its topology, so everything `build.py` adds after it (the
smoothed face and its parts, the face shapes, the rig fitted from the joint cubes, garments, hair,
glasses) is made on the fitted shape and keeps working.

The target (`base.json` `fit.target`, a GLB, made by `generate-target.py`) is clothed and stands in the
sheet's pose, so:

- it is scaled to the human's height (sole to head top), and centred on it;
- the human is first turned into the sheet's stance (the upper arms down, the legs in, about their
  joints, weighted by the rig's weights of each chain), the wrap is found in that stance and turned
  back, so a limb is wrapped onto the same limb;
- each body vertex goes to the nearest point of the target, less an inset along the target's normal
  where the garments will be eased out again (`inset`, per region), refused where the target's surface
  there faces another way or is too far (a ray caught by another limb); the field of moves is smoothed
  over the mesh, `rounds` times, so the surface keeps the human's spacing and no vertex jumps;
- a region with a strength below 1 (the hands, whose fingers the target cannot carry) blends its own
  wrap with the moves of what surrounds it, filled in smoothly (strength 0: it only follows);
- every vertex that is not body (MPFB's helpers: eyes, teeth, tongue; and the joint cubes the rig is
  fitted from) moves with the body vertices nearest to it, so the rig's joints and the eyes follow.

Blender: +Z up, the human faces -Y, its left is +X.
"""
import math
import numpy as np
import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree


def load_target(path):
    """The target GLB's first mesh, in Blender's frame (the importer turns glTF's +Y up into +Z)."""
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    mesh = next(o for o in new if o.type == "MESH")
    dg = bpy.context.evaluated_depsgraph_get()
    m = mesh.evaluated_get(dg).to_mesh()
    M = np.array(mesh.matrix_world)
    V = np.empty(len(m.vertices) * 3)
    m.vertices.foreach_get("co", V)
    V = V.reshape(-1, 3) @ M[:3, :3].T + M[:3, 3]
    F = [list(p.vertices) for p in m.polygons]
    mesh.evaluated_get(dg).to_mesh_clear()
    for o in new:
        bpy.data.objects.remove(o)
    return V, F


def adjacency(n, polys):
    a, b = [], []
    for p in polys:
        for i in range(len(p)):
            a.append(p[i])
            b.append(p[(i + 1) % len(p)])
    e = np.unique(np.sort(np.array([a, b]).T, axis=1), axis=0)
    deg = np.bincount(e.ravel(), minlength=n).astype(float)
    return e, deg


def smooth_field(D, edges, deg, iters, known=None, pinned=None):
    """Uniform Laplacian smoothing of a per-vertex field. `known` (bool): vertices whose value counts (the
    rest start at 0 and are filled from their neighbours); `pinned` (bool): vertices that keep their value."""
    D = D.copy()
    w = np.ones(len(D)) if known is None else known.astype(float)
    D[w == 0] = 0.0
    for _ in range(iters):
        S = np.zeros_like(D)
        W = np.zeros(len(D))
        np.add.at(S, edges[:, 0], D[edges[:, 1]] * w[edges[:, 1], None])
        np.add.at(S, edges[:, 1], D[edges[:, 0]] * w[edges[:, 0], None])
        np.add.at(W, edges[:, 0], w[edges[:, 1]])
        np.add.at(W, edges[:, 1], w[edges[:, 0]])
        new = np.where(W[:, None] > 0, (D * w[:, None] + S) / (w + W)[:, None], D)
        if pinned is not None:
            new[pinned] = D[pinned]
        # Once filled, a vertex counts.
        w = np.maximum(w, (W > 0).astype(float) * 0.5)
        D = new
    return D


def turn(X, pivot, axis, deg, w):
    """Rotates X about pivot and axis by deg * w per vertex (linear blend of a rotation and none)."""
    a = np.radians(deg) * w
    k = np.asarray(axis, float) / np.linalg.norm(axis)
    P = X - pivot
    c, s = np.cos(a)[:, None], np.sin(a)[:, None]
    return pivot + P * c + np.cross(k, P) * s + k * (P @ k)[:, None] * (1 - c)


def fit(X, is_body, body_polys, members, weight_of, bone_names, Pf, target_path, report):
    """Returns the moved X (all vertices) and the moves. A region's bones may end in `*` (every bone
    whose name starts with the rest)."""
    expand = lambda bones: [b for p in bones for b in ([n for n in bone_names if n.startswith(p[:-1])] if p.endswith("*") else [p])]
    N = len(X)
    TV, TF = load_target(target_path)
    body = np.where(is_body)[0]
    # Scale and place the target on the human: sole to head top, the middle of the standing figure.
    h_lo, h_hi = X[body, 2].min(), X[body, 2].max()
    t_lo, t_hi = TV[:, 2].min(), TV[:, 2].max()
    TV = (TV - [0, 0, t_lo]) * ((h_hi - h_lo) / (t_hi - t_lo)) + [0, 0, h_lo]
    band = lambda P, lo, hi: P[(P[:, 2] > h_lo + lo * (h_hi - h_lo)) & (P[:, 2] < h_lo + hi * (h_hi - h_lo))]
    tor_h, tor_t = band(X[body], 0.55, 0.75), band(TV, 0.55, 0.75)
    TV[:, 0] += tor_h[:, 0].mean() - tor_t[:, 0].mean()
    TV[:, 1] += tor_h[:, 1].mean() - tor_t[:, 1].mean()
    TV[:, 1] += Pf.get("forward", 0.0)

    # The sheet's stance.
    st = Pf["stance"]
    P = X.copy()
    chains = {
        "Left": (members["joint-l-shoulder"], ["LeftArm", "LeftForeArm", "LeftHand"], 1.0, st["armDown"]),
        "Right": (members["joint-r-shoulder"], ["RightArm", "RightForeArm", "RightHand"], -1.0, st["armDown"]),
        "LeftLeg": (members["joint-l-upper-leg"], ["LeftUpLeg", "LeftLeg", "LeftFoot", "LeftToeBase"], 1.0, st["legIn"]),
        "RightLeg": (members["joint-r-upper-leg"], ["RightUpLeg", "RightLeg", "RightFoot", "RightToeBase"], -1.0, st["legIn"]),
    }
    fingers = lambda side: [f"{side}Hand{f}{n}" for f in ["Thumb", "Index", "Middle", "Ring", "Pinky"] for n in (1, 2, 3)]
    turns = []
    for name, (joint, bones, sign, deg) in chains.items():
        side = "Left" if name.startswith("Left") else "Right"
        extra = fingers(side) if "Arm" in bones[0] else []
        w = np.clip(weight_of(*bones, *extra), 0, 1)
        # Vertices with no rig weight (helpers, joint cubes) stay put here; they take their moves from
        # the body vertices nearest them at the end.
        pivot = X[joint].mean(axis=0)
        turns.append((pivot, sign, deg, w))
        P = turn(P, pivot, (0, 1, 0), sign * deg, w)

    bvh = BVHTree.FromPolygons([tuple(v) for v in TV], TF)
    edges, deg = adjacency(N, body_polys)
    # Normals of the posed human (area-weighted face normals summed at the vertices).
    def vnormals(Q):
        n = np.zeros_like(Q)
        for p in body_polys:
            a, b, c = Q[p[0]], Q[p[1]], Q[p[2]]
            fn = np.cross(b - a, c - a)
            for i in p:
                n[i] += fn
        return n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)

    # Per-vertex strength and inset, by region (the strongest rig weight of a region's bones).
    reg = Pf["regions"]
    strength = np.ones(N)
    inset = np.zeros(N)
    best = np.zeros(N)
    owner = np.full(N, -1)
    rigid = []  # (region index, its members): a region that moves as a whole
    for ri, r in enumerate(v for v in reg.values() if isinstance(v, dict)):
        w = weight_of(*expand(r["bones"]))
        take = w > best
        strength[take] = r["strength"]
        inset[take] = r["inset"]
        owner[take] = ri
        best = np.maximum(best, w)
        if r.get("rigid"):
            rigid.append(ri)
    rigid = [(ri, np.where((owner == ri) & is_body)[0]) for ri in rigid]
    # Smooth the region values over the mesh, so no seam shows where a region ends.
    strength = smooth_field(strength[:, None], edges, deg, Pf["regionBlend"])[:, 0]
    inset = smooth_field(inset[:, None], edges, deg, Pf["regionBlend"])[:, 0]

    D = np.zeros((N, 3))
    refused = 0
    for rnd, iters in enumerate(Pf["rounds"]):
        Q = P + D
        nq = vnormals(Q)
        raw = np.zeros((N, 3))
        ok = np.zeros(N, dtype=bool)
        far = facing = 0
        dists = []
        for i in body:
            loc, n, _, dist = bvh.find_nearest(Vector(Q[i]))
            if loc is None or dist > Pf["maxDistance"]:
                far += 1
                continue
            dists.append(dist)
            n = np.array(n)
            if np.dot(n, nq[i]) < Pf["minFacing"]:
                facing += 1
                continue
            raw[i] = np.array(loc) - n * inset[i] - P[i]
            ok[i] = True
        # A rigid region (the head: its face is made after the fit and must keep its own shape, and its
        # size is `proportions.head`) moves as a whole, by the mean move that carries its vertices to
        # their matches.
        for ri, idx in rigid:
            m = idx[ok[idx]]
            if len(m) < 50:
                continue
            shift = (P[m] + raw[m] - Q[m]).mean(axis=0)
            raw[idx] = Q[idx] + shift - P[idx]
            ok[idx] = True
            report.setdefault("rigidShiftMm", {})[str(ri)] = np.round(shift * 1000, 1).tolist()
        refused = int((~ok[body]).sum())
        report.setdefault("rounds", []).append({"far": far, "facing": facing, "distMm": round(float(np.median(dists)) * 1000, 1) if dists else None})
        D = smooth_field(raw, edges, deg, iters, known=ok)
    # Strength: regions below 1 keep part of their own shape, filled from what surrounds them.
    full = strength >= 0.999
    filled = smooth_field(D, edges, deg, Pf["fillIterations"], known=full & is_body)
    D = strength[:, None] * D + (1 - strength[:, None]) * filled  # a weak region follows its surroundings
    D = smooth_field(D, edges, deg, Pf["finalSmooth"])

    # Turn the moves back out of the stance (vectors only rotate), in reverse order.
    for pivot, sign, deg_, w in reversed(turns):
        D = turn(D, np.zeros(3), (0, 1, 0), -sign * deg_, w)

    # Non-body vertices: the mean move of the k nearest body vertices, weighted by inverse distance.
    others = np.where(~is_body)[0]
    k = Pf["helperNeighbours"]
    B = X[body]
    for chunk in np.array_split(others, max(1, len(others) // 512)):
        d2 = ((X[chunk, None, :] - B[None, :, :]) ** 2).sum(axis=2)
        nn = np.argpartition(d2, k, axis=1)[:, :k]
        dd = np.take_along_axis(d2, nn, axis=1)
        w = 1.0 / np.maximum(np.sqrt(dd), 1e-4)
        D[chunk] = (D[body][nn] * w[:, :, None]).sum(axis=1) / w.sum(axis=1, keepdims=True)

    # The figure keeps its place over the root: the body's mean move across the floor is taken out (the
    # target is placed by its chest, so the wrap alone carried the whole body some centimetres forward).
    shift = D[body, :2].mean(axis=0)
    D[:, :2] -= shift
    report["recentredMm"] = np.round(-shift * 1000, 1).tolist()

    moved = np.linalg.norm(D[body], axis=1)
    report.update({
        "humanBounds": [np.round(X[body].min(0), 3).tolist(), np.round(X[body].max(0), 3).tolist()],
        "targetBounds": [np.round(TV.min(0), 3).tolist(), np.round(TV.max(0), 3).tolist()],
        "targetVertices": len(TV), "refused": refused,
        "moveMm": {"median": round(float(np.median(moved) * 1000), 1), "p90": round(float(np.percentile(moved, 90) * 1000), 1), "max": round(float(moved.max() * 1000), 1)},
    })
    return X + D, D
