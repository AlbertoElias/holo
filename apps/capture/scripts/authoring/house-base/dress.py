"""
The house base's traits that are geometry, each its own mesh carried by the rig, built by `build.py`
(every value from base.json): loose garments (a jumper and trousers) made from the body's clothed
faces, eased away from it and smoothed so the body's shape no longer shows, the body under them
removed; the hair styles, shells cast on the scalp; and the glasses frames. The dressing function
(packages/avatar-look) keeps one hair and one glasses mesh and removes the rest.

Blender space, the human's mesh space: +Z up, the human faces -Y, its left is +X.
"""
import bpy, bmesh, heapq, math
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree
from mathutils.kdtree import KDTree


def smoothstep(e0, e1, x):
    t = np.clip((np.asarray(x, dtype=float) - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def mesh_bvh(V, faces):
    return BVHTree.FromPolygons([Vector(v) for v in V], faces)


def skinned(name, V, faces, weights, mats, rig, like):
    """A mesh object carried by the rig: `weights` is bone -> (vertex indices, weights)."""
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(map(float, v)) for v in V], [], [list(map(int, f)) for f in faces])
    me.update()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    ob.parent = rig
    ob.matrix_world = like.matrix_world.copy()
    for bone, (idx, w) in weights.items():
        g = ob.vertex_groups.new(name=bone)
        by = {}
        for i, x in zip(idx, w):
            if x > 1e-4:
                by.setdefault(round(float(x), 4), []).append(int(i))
        for x, ii in by.items():
            g.add(ii, x, "REPLACE")
    mod = ob.modifiers.new("Armature", "ARMATURE")
    mod.object = rig
    for m in mats:
        me.materials.append(m)
    for p in me.polygons:
        p.use_smooth = True
    return ob


def graph(V, faces):
    """Edge lengths, neighbours and boundary vertices of a face list."""
    n = len(V)
    edges = {}
    for f in faces:
        for a, b in zip(f, f[1:] + f[:1]):
            e = (min(a, b), max(a, b))
            edges[e] = edges.get(e, 0) + 1
    adj = [[] for _ in range(n)]
    for (a, b) in edges:
        w = float(np.linalg.norm(V[a] - V[b]))
        adj[a].append((b, w))
        adj[b].append((a, w))
    boundary = sorted(set(v for e, c in edges.items() if c == 1 for v in e))
    return adj, boundary


def dijkstra(n, adj, sources):
    d = np.full(n, np.inf)
    h = [(0.0, int(s)) for s in sources]
    for _, s in h:
        d[s] = 0.0
    heapq.heapify(h)
    while h:
        dist, i = heapq.heappop(h)
        if dist > d[i]:
            continue
        for j, w in adj[i]:
            if dist + w < d[j]:
                d[j] = dist + w
                heapq.heappush(h, (dist + w, j))
    return d


def smooth(P, adj, pinned, iters, lam=0.5, mu=None):
    """Umbrella smoothing over the mesh graph, pinned vertices held. With `mu` (negative), Taubin's
    alternating steps: bumps go but the shape keeps its volume, where plain smoothing shrinks a tube."""
    src = np.concatenate([np.full(len(n), i) for i, n in enumerate(adj)]).astype(int)
    dst = np.concatenate([np.array([j for j, _ in n], dtype=int) for n in adj])
    deg = np.bincount(src, minlength=len(P)).astype(float)
    free = (~pinned) & (deg > 0)
    P = P.copy()
    for _ in range(iters):
        for k in ((lam,) if mu is None else (lam, mu)):
            acc = np.zeros_like(P)
            np.add.at(acc, src, P[dst])
            mean = acc / np.maximum(deg, 1)[:, None]
            P[free] += k * (mean[free] - P[free])
    return P


def hang(P, P0, used_dom, _unused, toMesh, rig, spec):
    """Trouser legs fall straight: below the knee each leg's cloth stands off its axis at least as far as
    it did higher up (from the knee down), so the calf and the ankle no longer show through."""
    H = spec["hang"]
    for chain in H["chains"]:
        a = np.array(toMesh @ rig.data.bones[chain[0]].head_local)
        b = np.array(toMesh @ rig.data.bones[chain[-1]].head_local)
        axis = b - a
        L = float(np.linalg.norm(axis))
        axis /= L
        idx = np.array([i for i, d in enumerate(used_dom) if d in chain])
        if not len(idx):
            continue
        rel = P[idx] - a
        t = rel @ axis / L
        radial = rel - np.outer(rel @ axis, axis)
        r = np.linalg.norm(radial, axis=1)
        ref = np.cross(axis, (0.0, 0.0, 1.0) if abs(axis[2]) < 0.9 else (1.0, 0.0, 0.0))
        ref /= np.linalg.norm(ref)
        ang = np.arctan2(radial @ np.cross(axis, ref), radial @ ref)
        nb, nt = H["angleBins"], H["heightBins"]
        ab = ((ang + math.pi) / (2 * math.pi) * nb).astype(int) % nb
        tb = np.clip((t * nt).astype(int), 0, nt - 1)
        top = np.full((nb, nt), 0.0)
        np.maximum.at(top, (ab, tb), r)
        k0 = int(H["fromKnee"] * nt)
        for j in range(k0 + 1, nt):  # down the leg: never in from what is above
            top[:, j] = np.maximum(top[:, j], top[:, j - 1])
        # The bins' neighbours round the leg share, so the cloth does not facet.
        top = (np.roll(top, 1, 0) + 2 * top + np.roll(top, -1, 0)) / 4
        want = np.where(tb > k0, top[ab, tb], r)
        grow = np.maximum(want - r, 0.0)[:, None] * (radial / np.maximum(r, 1e-6)[:, None])
        P[idx] = P[idx] + grow
    return P


# --- Garments ---------------------------------------------------------------------------------
def garments(human, rig, slots, G):
    """Replaces the body's top, trouser and (with `shoes` in G) shoe faces with garment meshes; returns them
    and a report."""
    me = human.data
    V = np.array([v.co[:] for v in me.vertices])
    NRM = np.array([v.normal[:] for v in me.vertices])
    polys = [list(p.vertices) for p in me.polygons]
    mat = np.array([p.material_index for p in me.polygons])
    full = mesh_bvh(V, polys)  # the body before anything is removed: what the garments stay outside of
    toMesh = human.matrix_world.inverted() @ rig.matrix_world
    names = {g.index: g.name for g in human.vertex_groups}
    bones = {b.name for b in rig.data.bones}
    dom = []
    for v in me.vertices:
        best = max(((g.weight, names[g.group]) for g in v.groups if names[g.group] in bones), default=(0, ""))
        dom.append(best[1])
    ti, ri = slots.index("top"), slots.index("trousers")
    top_f = [k for k in range(len(polys)) if mat[k] == ti]
    tr_f = [k for k in range(len(polys)) if mat[k] == ri]
    si = slots.index("shoes")
    sh_f = [k for k in range(len(polys)) if mat[k] == si] if "shoes" in G else []

    # The jumper's hem hangs over the trousers: the trouser faces within `hem` of the waist join it too.
    waist = set(v for k in top_f for v in polys[k]) & set(v for k in tr_f for v in polys[k])
    adj_all, _ = graph(V, [polys[k] for k in tr_f])
    d_w = dijkstra(len(V), adj_all, waist)
    hem_f = [k for k in tr_f if max(d_w[v] for v in polys[k]) <= G["top"]["hem"]]
    hem_v = set(v for k in hem_f for v in polys[k])

    def build(face_ids, spec, kind, outside):
        used = sorted(set(v for k in face_ids for v in polys[k]))
        loc = {v: i for i, v in enumerate(used)}
        n = len(used)
        faces = [[loc[v] for v in polys[k]] for k in face_ids]
        P0 = V[used]
        adj, boundary = graph(P0, faces)
        gdom = [dom[v] for v in used]
        # Openings that close on the body (the neck, the wrists; the ankles, the waist under the hem) taper to it.
        taper = [v for v in boundary if gdom[v].startswith(tuple(spec["taperAt"]))]
        dist = dijkstra(n, adj, taper)
        limb = np.array([gdom[i].startswith(tuple(spec["limbBones"])) for i in range(n)])
        ease = np.where(limb, spec["easeLimb"], spec["easeBody"]).astype(float)
        if kind == "top":
            ease = np.where(np.isin(used, list(hem_v)), spec["easeHem"], ease)
        ease = ease * smoothstep(0.0, spec["taper"], dist)
        cuff = spec.get("cuff")
        if cuff:
            # The sleeve ends stand off the wrist by `ease` (m): an opening tapered to the skin lets the hand's skin
            # cross the cloth when the wrist bends, in a saw-tooth line (B-101). The skin goes on under the cuff.
            wrist = [v for v in boundary if gdom[v].startswith(tuple(cuff["at"]))]
            dist_w = dijkstra(n, adj, wrist)
            near = dist_w <= dist + 1e-9
            s_w = smoothstep(0.0, spec["taper"], dist_w)
            ease = np.where(near, ease * s_w + cuff["ease"] * (1 - s_w), ease)
        if "soleBelow" in spec:
            # The sole stays on the floor: faces turned down (normal's z under -soleBelow) take no ease.
            ease = ease * smoothstep(-spec["soleBelow"] - 0.3, -spec["soleBelow"], NRM[used, 2])
        # Where two parts lie close (the inner thighs, an arm by the side), the ease stays under a share of the gap.
        left = np.array([gdom[i].startswith("Left") for i in range(n)])
        right = np.array([gdom[i].startswith("Right") for i in range(n)])
        for mine, theirs in ((limb & left, ~(limb & left)), (limb & right, ~(limb & right)), (~limb, limb)):
            if kind == "trousers" and not (mine & limb).any():
                continue  # the hips have no other part to keep clear of
            others = np.where(theirs)[0]
            if not mine.any() or not len(others):
                continue
            kd = KDTree(len(others))
            for j, i in enumerate(others):
                kd.insert(Vector(P0[i]), j)
            kd.balance()
            for i in np.where(mine)[0]:
                _, _, gap = kd.find(Vector(P0[i]))
                ease[i] = min(ease[i], spec["gapShare"] * gap)
        pinned = np.zeros(n, dtype=bool)
        pinned[taper] = True
        if cuff:
            pinned[wrist] = True
        under = []
        if cuff:
            under = [used[i] for i in range(n) if near[i] and dist_w[i] <= cuff["skinUnder"]]
        ease = smooth(ease[:, None], adj, pinned, 8)[:, 0]  # spread over the surface, so it has no steps
        P = P0 + NRM[used] * ease[:, None]
        rings = []
        if cuff:
            # Each sleeve's opening is one ring: a circle on a plane across the forearm, as wide as the widest point
            # of the opening plus the cuff's ease, so the pinned smoothing that follows makes a clean tube to it.
            for side in ("Left", "Right"):
                ring = [i for i in wrist if gdom[i].startswith(side)]
                if not ring:
                    continue
                hand = toMesh @ rig.data.bones[f"{side}Hand"].head_local
                elbow = toMesh @ rig.data.bones[f"{side}ForeArm"].head_local
                ax = np.array((hand - elbow).normalized())
                c = P0[ring].mean(axis=0)
                rel = P0[ring] - c
                perp = rel - np.outer(rel @ ax, ax)
                rad = np.linalg.norm(perp, axis=1)
                r = rad.mean() + cuff["ease"]
                P[ring] = c + perp / rad[:, None] * r
                rings.append((ring, c, ax, r))
        if "hang" in spec:
            P = hang(P, P0, gdom, None, toMesh, rig, spec)
        for _ in range(spec["rounds"]):
            P = smooth(P, adj, pinned, spec["smooth"], mu=spec["taubin"])
            for i in range(n):
                if ease[i] <= 1e-5:
                    continue
                for bvh, want in [(full, spec["clear"] * ease[i])] + [(b, extra) for b, extra in outside]:
                    # Only a surface within reach pushes: the trousers' waist is nearest to the neck too.
                    hit, nrm, _, _ = bvh.find_nearest(Vector(P[i]), spec["reach"])
                    if hit is None:
                        continue
                    if (Vector(P[i]) - hit).dot(nrm) < want:
                        P[i] = np.array(hit + nrm * want)
        weights = {}
        for i, v in enumerate(used):
            for g in me.vertices[v].groups:
                nm = names[g.group]
                if nm in bones:
                    weights.setdefault(nm, ([], []))
                    weights[nm][0].append(i)
                    weights[nm][1].append(g.weight)
        # Each cuff's edge turns in by one row (a hem), `hem` (m) up the sleeve and in by the cuff's ease, so the
        # sleeve's inside does not show at the opening.
        P = np.asarray(P, dtype=float)
        count, directed = {}, []
        for f in faces:
            for a, b in zip(f, f[1:] + f[:1]):
                key = (min(a, b), max(a, b))
                count[key] = count.get(key, 0) + 1
                directed.append((a, b))
        open_edges = [(a, b) for a, b in directed if count[(min(a, b), max(a, b))] == 1]
        for ring, c, ax, r in rings if cuff and cuff["hem"] > 0 else []:
            on = set(ring)
            edges = [(a, b) for a, b in open_edges if a in on and b in on]
            inner = {}
            for i in ring:
                inner[i] = len(P)
                P = np.vstack([P, c + (P[i] - c) * ((r - 2 * cuff["ease"]) / r) - ax * cuff["hem"]])
                for nm, (idx, w) in weights.items():
                    if i in idx:
                        idx.append(inner[i])
                        w.append(w[idx.index(i)])
            for a, b in edges:  # the face beside has a -> b, so the hem's face runs b -> a
                faces.append([b, a, inner[a], inner[b]])
        shown = ease[ease > 1e-4]
        build.under = set(under)
        return P, faces, weights, {"vertices": n, "maxEaseMm": round(float(ease.max()) * 1000, 1),
                                   "meanEaseMm": round(float(shown.mean()) * 1000, 1) if len(shown) else 0.0}

    for m in (me.materials[ti], me.materials[ri]):
        m.use_backface_culling = False  # the inside shows at the hem and the cuffs
    Pt, Ft, Wt, rt = build(tr_f, G["trousers"], "trousers", [])
    trousers = skinned("HouseBase_Trousers", Pt, Ft, Wt, [me.materials[ri]], rig, human)
    tb = mesh_bvh(Pt, Ft)
    Pj, Fj, Wj, rj = build(top_f + hem_f, G["top"], "top", [(tb, G["top"]["overTrousers"])])
    jumper = skinned("HouseBase_Jumper", Pj, Fj, Wj, [me.materials[ti]], rig, human)
    # The body's faces under the cuffs stay, as skin, so no hole shows inside the sleeve's end.
    keep = [k for k in top_f if all(v in build.under for v in polys[k])]
    for k in keep:
        me.polygons[k].material_index = slots.index("skin")
    keep = set(keep)
    top_f = [k for k in top_f if k not in keep]
    worn, report = [jumper, trousers], {"jumper": rj, "trousers": rt, "hemFaces": len(hem_f)}
    if sh_f:
        # Shoes: the feet eased out and smoothed into one rounded shape (no toes), under the trouser hems.
        Ps, Fs, Ws, rs = build(sh_f, G["shoes"], "shoes", [])
        # The smoothing still rounds the sole under the floor the bare foot stands on: nothing goes below it.
        floor = V[sorted(set(v for k in sh_f for v in polys[k])), 2].min()
        rs["soleBelowFloor"] = int((np.asarray(Ps)[:, 2] < floor - 1e-4).sum())
        Ps = np.asarray(Ps).copy()
        Ps[:, 2] = np.maximum(Ps[:, 2], floor)
        worn.append(skinned("HouseBase_Shoes", Ps, Fs, Ws, [me.materials[si]], rig, human))
        report["shoes"] = rs

    # The body under the garments goes; the openings' rings stay, so the skin meets each garment's edge.
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.faces.ensure_lookup_table()
    bmesh.ops.delete(bm, geom=[bm.faces[k] for k in top_f + tr_f + sh_f], context="FACES_ONLY")
    loose = [v for v in bm.verts if not v.link_faces]
    bmesh.ops.delete(bm, geom=loose, context="VERTS")
    bm.to_mesh(me)
    bm.free()
    me.update()
    return worn, report


# --- Hair -------------------------------------------------------------------------------------
def head_centre(bvh, cx, ze, eye_y):
    """The point the scalp is cast from: on the midline, a little above the eyes, halfway from brow to back."""
    z = ze + 0.015
    front, _, _, _ = bvh.ray_cast(Vector((cx, eye_y - 0.3, z + 0.03)), Vector((0, 1, 0)))
    back, _, _, _ = bvh.ray_cast(Vector((cx, eye_y + 0.5, z + 0.03)), Vector((0, -1, 0)))
    return np.array((cx, (front.y + back.y) / 2, z))


def direction(a, b):
    """a: round from the front (+ toward the human's left), b: up from level."""
    return np.array((math.sin(a) * math.cos(b), -math.cos(a) * math.cos(b), math.sin(b)))


def hair(S, H, bvh, C, land):
    """One hair style as (verts, faces, weights): a shell over the scalp from its hairline up, the locks a
    ripple on its thickness; for the long styles a curtain hanging from the hairline at the sides and back,
    outside the face; a bun for the high bun."""
    cols = H["columns"]
    rows = H["rows"]
    nc = S["curtain"]["rows"] if "curtain" in S else 0

    def scalp(a, b):
        d = direction(a, b)
        hit, _, _, dist = bvh.ray_cast(Vector(C), Vector(d))
        return (dist if hit is not None else 0.09), d

    def lock(a, b):
        L = S.get("locks")
        if not L:
            return 0.0
        if L["kind"] == "ridges":  # locks running front to back, swept
            m = 0.5 + 0.5 * math.cos(L["n"] * a + L.get("sweep", 0.0) * b)
            return L["depth"] * (m * m - 0.4)
        m = (0.5 + 0.5 * math.cos(L["n"] * a + L.get("twist", 0.0) * math.sin(L["m"] * b))) * (0.5 + 0.5 * math.cos(L["m"] * b))
        return L["depth"] * (m - 0.3)  # bumps: coils and twists

    def thickness(a, b, bh):
        t = S["sides"] + (S["top"] - S["sides"]) * float(smoothstep(bh, bh + math.radians(S.get("rise", 35.0)), b))
        t += float(smoothstep(math.radians(100), math.radians(170), abs(a))) * S.get("back", 0.0)
        if S.get("front"):  # a quiff or fringe volume above the forehead
            fa = max(0.0, 1 - abs(a) / math.radians(S.get("frontWidth", 50)))
            fb = float(smoothstep(bh, bh + math.radians(12), b)) * (1 - float(smoothstep(bh + math.radians(25), bh + math.radians(55), b)))
            t += S["front"] * fa * fa * fb
        return t * (1 + lock(a, b))

    V, prof = [], []
    for c in range(cols):
        a = -math.pi + 2 * math.pi * c / cols
        bh = math.radians(float(np.interp(abs(math.degrees(a)), [p[0] for p in S["line"]], [p[1] for p in S["line"]])))
        # Over the brows the hairline stays above the brows raised all the way.
        for _ in range(60):
            r, d = scalp(a, bh)
            p = C + d * r
            if abs(p[0] - C[0]) > land["browHalfWidth"] or p[1] > C[1] or p[2] >= land["hairlineZ"]:
                break
            bh += math.radians(1)
        rS, dS = scalp(a, bh)
        S_pt = C + dS * rS
        col = []
        V.append(C + dS * (rS - H["tuck"]))
        col.append(len(V) - 1)
        t_edge = thickness(a, bh, bh)
        O = C + dS * (rS + t_edge)
        if nc:
            cu = S["curtain"]
            hd = np.array((math.sin(a), -math.cos(a), 0.0))
            amount = float(smoothstep(math.radians(cu["from"]), math.radians(cu["from"] + cu["ramp"]), abs(a)))
            z_end = float(np.interp(abs(math.degrees(a)), [p[0] for p in cu["end"]], [land[p[1]] + p[2] for p in cu["end"]]))
            L = max(0.0, S_pt[2] - z_end) * amount
            run = math.hypot(S_pt[0] - C[0], S_pt[1] - C[1])
            inner = []
            for i in range(nc):
                f = i / (nc - 1)
                z = S_pt[2] - L * f
                hit, _, _, dist = bvh.ray_cast(Vector((C[0], C[1], z)) + Vector(hd) * 0.6, Vector(-hd))
                if hit is not None:
                    run = max(run, 0.6 - dist + cu["clear"])  # hair falls; it never tucks back in under the jaw
                rho = run + cu["flare"] * f ** 1.5 + cu.get("wave", 0.0) * math.cos(cu.get("waves", 0) * a) * f
                inner.append(np.array((C[0], C[1], z)) + hd * rho)
            tc = min(cu["thick"], t_edge) if L < 1e-4 else cu["thick"]
            for i in range(nc):
                V.append(inner[i] if i else S_pt)
                col.append(len(V) - 1)
            for i in reversed(range(1, nc)):
                f = i / (nc - 1)
                V.append(inner[i] + hd * tc * (0.6 + 0.4 * (1 - f)))
                col.append(len(V) - 1)
        for k in range(rows):
            b = bh + (math.radians(H["poleRow"]) - bh) * k / rows
            r, d = scalp(a, b)
            V.append(C + d * (r + thickness(a, b, bh)) if k else O)
            col.append(len(V) - 1)
        prof.append(col)
    rp, dp = scalp(0.0, math.pi / 2)
    V.append(C + dp * (rp + S["top"]))
    pole = len(V) - 1
    F = []
    for c in range(cols):
        A, B = prof[c], prof[(c + 1) % cols]
        for k in range(len(A) - 1):
            F.append([A[k], B[k], B[k + 1], A[k + 1]])
        F.append([A[-1], B[-1], pole])
    V = np.array(V)
    if S.get("bun"):
        bu = S["bun"]
        r, d = scalp(math.radians(bu["at"][0]), math.radians(bu["at"][1]))
        c0 = C + d * (r + S["top"] + bu["radius"] * bu["sink"])
        seg, ring = bu["segments"], bu["rings"]
        base = len(V)
        pts = [c0 + np.array((0, 0, -bu["radius"] * bu["squash"]))]
        for j in range(1, ring):
            phi = math.pi * j / ring
            for i in range(seg):
                th = 2 * math.pi * i / seg
                wob = 1 + bu["twist"] * math.cos(3 * th + 2 * phi)
                pts.append(c0 + np.array((math.sin(phi) * math.cos(th) * wob, math.sin(phi) * math.sin(th) * wob, -math.cos(phi) * bu["squash"])) * bu["radius"])
        pts.append(c0 + np.array((0, 0, bu["radius"] * bu["squash"])))
        V = np.vstack([V, np.array(pts)])
        bot, top = base, base + len(pts) - 1
        at = lambda j, i: base + 1 + (j - 1) * seg + (i % seg)
        for i in range(seg):
            F.append([bot, at(1, i), at(1, i + 1)])
            F.append([top, at(ring - 1, i + 1), at(ring - 1, i)])
            for j in range(1, ring - 1):
                F.append([at(j, i), at(j + 1, i), at(j + 1, i + 1), at(j, i + 1)])
    # Carried by the head; a long curtain's lower part blends to the chest, so it falls with the body.
    w_head = np.where(V[:, 2] >= land["chinZ"], 1.0, smoothstep(land["shoulderZ"] - 0.02, land["chinZ"], V[:, 2]))
    idx = np.arange(len(V))
    weights = {"Head": (idx, w_head)}
    if (w_head < 1).any():
        weights["Spine2"] = (idx, 1 - w_head)
    return V, F, weights


# --- Glasses ----------------------------------------------------------------------------------
def sweep(path, radius, segs, closed):
    """A round tube along a polyline, capped when open."""
    P = [np.asarray(p, dtype=float) for p in path]
    n = len(P)
    V, F = [], []
    for i in range(n):
        a = P[(i - 1) % n] if (closed or i) else P[i]
        b = P[(i + 1) % n] if (closed or i < n - 1) else P[i]
        t = (b - a) / np.linalg.norm(b - a)
        up = np.array((0, 1.0, 0)) if abs(t[1]) < 0.9 else np.array((0, 0, 1.0))
        nrm = np.cross(t, up)
        nrm /= np.linalg.norm(nrm)
        bi = np.cross(t, nrm)
        for s in range(segs):
            ph = 2 * math.pi * s / segs
            V.append(P[i] + radius * (math.cos(ph) * nrm + math.sin(ph) * bi))
    for i in range(n if closed else n - 1):
        j = (i + 1) % n
        for s in range(segs):
            F.append([i * segs + s, j * segs + s, j * segs + (s + 1) % segs, i * segs + (s + 1) % segs])
    if not closed:
        F.append([s for s in range(segs)][::-1])
        F.append([(n - 1) * segs + s for s in range(segs)])
    return V, F


def glasses(kind, Gs, eyes, R, bvh, C, cx):
    """Frames before the eyes and below the brows: two rims, a bridge over the nose, temples back to the ears."""
    V, F = [], []

    def add(vf):
        v, f = vf
        o = len(V)
        V.extend(v)
        F.extend([[i + o for i in face] for face in f])

    K = Gs["kinds"][kind]
    q = Gs["rimPoints"]
    rims = {}
    for side, E in eyes.items():
        sgn = 1.0 if side == "Left" else -1.0
        fc = np.asarray(E) + np.array((sgn * Gs["out"] * R, -Gs["forward"] * R, Gs["drop"] * R))
        pts = []
        e = 2.0 / K["exponent"]
        for i in range(q):  # i = 0 is the outer side, q/4 the top, q/2 the inner side (by the nose)
            th = 2 * math.pi * i / q
            c, s = math.cos(th), math.sin(th)
            pts.append(fc + np.array((sgn * K["width"] * R * math.copysign(abs(c) ** e, c), 0.0, K["height"] * R * math.copysign(abs(s) ** e, s))))
        rims[side] = pts
        add(sweep(pts, Gs["tube"], Gs["tubeSides"], True))
    # The bridge: from each rim's inner top over the nose, a little forward and up.
    k = int(round(q * Gs["bridgeAt"]))
    li, ri = rims["Left"][k], rims["Right"][k]
    mid = (li + ri) / 2 + np.array((0, -Gs["bridgeForward"], Gs["bridgeRise"]))
    add(sweep([(1 - t) ** 2 * li + 2 * (1 - t) * t * mid + t * t * ri for t in np.linspace(0, 1, 9)], Gs["tube"], Gs["tubeSides"], False))
    # The temples: from each rim's outer edge out past the head's side (ears included), then back to the ear.
    for side, pts in rims.items():
        sgn = 1.0 if side == "Left" else -1.0
        start = pts[int(round(q * Gs["templeAt"]))]
        z = start[2]
        path = [start]
        run = abs(start[0] - cx)
        for y in np.linspace(start[1] + 0.006, C[1] + Gs["earBack"], Gs["templePoints"]):
            hit, _, _, dist = bvh.ray_cast(Vector((cx + sgn * 0.4, y, z)), Vector((-sgn, 0, 0)))
            if hit is not None:
                run = max(run, 0.4 - dist + Gs["templeClear"])
            path.append(np.array((cx + sgn * run, y, z)))
        path.append(path[-1] + np.array((0, 0.012, -Gs["hook"])))
        add(sweep(path, Gs["tube"] * 0.85, Gs["tubeSides"], False))
    V = np.array(V)
    return V, F, {"Head": (np.arange(len(V)), np.ones(len(V)))}
