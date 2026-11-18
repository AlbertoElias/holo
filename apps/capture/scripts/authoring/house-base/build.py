"""
Builds the house base avatar in Blender from CC0 parts, every value from a
parameter file, so the base is re-made by a command and never edited by hand.

Run by `house-base.ts` (which fetches and checks the parts), as:

  Blender -b --python build.py -- <base.json> <faceunits dir> <out.glb> <report.json>

Parts (credits are written into the file): the MakeHuman base mesh, its
mixamo rig and weights, from MPFB 2 (the add-on is GPL; its output is CC0),
and the ARKit face units of the faceunits01 pack (CC0, Mika Suominen).

Steps: an MPFB human with the parameter file's macro and shape targets,
baked; the 52 face units read as offsets; the proportions (a larger head,
eyes and hands) applied to the mesh and to every offset, weighted by the rig's
own weights so the rig is then fitted to the scaled mesh and no bone is
scaled; each face unit's offsets multiplied by its gain; the rig, renamed to
the stock avatar's bone names, with eye and head-top bones added; eyeballs;
materials painted on the body by bone (clothes) and by place (brows, lips);
helper geometry removed; exported as GLB.

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


def coords(block):
    a = np.empty(len(block.data) * 3, dtype=np.float64)
    block.data.foreach_get("co", a)
    return a.reshape(-1, 3)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


# --- An MPFB human, its modelling targets baked into the mesh ---------------------------
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o)
human = HumanService.create_human(mask_helpers=False, feet_on_ground=True, scale=0.1, macro_detail_dict=P["macro"])
for name, weight in P.get("targets", {}).items():
    TargetService.load_target(human, TargetService.target_full_path(name), weight=weight, name=name)
keys = human.data.shape_keys.key_blocks
basis = coords(keys[0])
mixed = basis.copy()
for k in keys[1:]:
    mixed += k.value * (coords(k) - basis)
human.shape_key_clear()
human.data.vertices.foreach_set("co", mixed.astype(np.float32).ravel())
human.data.update()

# --- The face units, as offsets on the baked mesh ------------------------------------------
human.shape_key_add(name="Basis")
offsets = {}
for c in SHAPES:
    k = TargetService.load_target(human, os.path.join(FU_DIR, c + ".target"), weight=0.0, name=c)
    off = coords(human.data.shape_keys.key_blocks[c]) - mixed
    off[np.linalg.norm(off, axis=1) < 1e-6] = 0.0  # float32 noise, so the targets stay sparse
    offsets[c] = off
human.shape_key_clear()
# The neutral face: some face units baked in (eyes a little wider open than MPFB's). eyeBlink keeps closing to
# where it closed before, so a blink still shuts the eye.
X = mixed.copy()
for c, w in ((c, w) for c, w in P.get("neutral", {}).items() if not c.startswith("$")):
    X += w * offsets[c]
    if c.startswith("eyeWide"):
        offsets["eyeBlink" + c[len("eyeWide"):]] -= w * offsets[c]

# --- Vertex groups (MPFB's) and rig weights (MPFB's mixamo weights, by vertex index) ------
groups = {g.index: g.name for g in human.vertex_groups}
members = {}
for v in human.data.vertices:
    for g in v.groups:
        members.setdefault(groups[g.group], []).append(v.index)
members = {k: np.array(v) for k, v in members.items()}
rig_dir = os.path.join(LocationService.get_mpfb_data("rigs"), "standard")
wjson = json.load(open(os.path.join(rig_dir, "weights.mixamo.json")))["weights"]
N = len(X)


def weight_of(*bones):
    w = np.zeros(N)
    for b in bones:
        for i, x in wjson.get(PREFIX + b, []):
            w[i] += x
    return np.clip(w, 0, 1)


def centre(group, at=None):
    return (X if at is None else at)[members[group]].mean(axis=0)


# --- Proportions: one map applied to the mesh and to every offset -------------------------
def scale_about(at, pivot, s, w):
    return pivot + (at - pivot) * (1 + (s - 1) * w)[:, None]


pr = P["proportions"]
w_head = np.clip(weight_of("Head") + pr["head"]["neckShare"] * weight_of("Neck"), 0, 1)
# MPFB's eye helpers carry no rig weight; they belong to the head in full, or the scale leaves them behind.
for side in ("l", "r"):
    w_head[members[f"helper-{side}-eye"]] = 1.0


def proportion(at):
    out = at.copy()
    out = scale_about(out, centre("joint-neck", X), pr["head"]["scale"], w_head)
    # Eyes after the head, about where the eyeball is now.
    for side in ("l", "r"):
        eye = members[f"helper-{side}-eye"]
        c_now = out_ref[eye].mean(axis=0)
        r_now = np.linalg.norm(out_ref[eye] - c_now, axis=1).mean()
        d = np.linalg.norm(out - c_now, axis=1)
        w = 1 - smoothstep(pr["eyes"]["inner"] * r_now, pr["eyes"]["outer"] * r_now, d)
        out = scale_about(out, c_now, pr["eyes"]["scale"], w)
    for side in ("Left", "Right"):
        bones = [f"{side}Hand"] + [f"{side}Hand{f}{n}" for f in ["Thumb", "Index", "Middle", "Ring", "Pinky"] for n in (1, 2, 3)]
        w = weight_of(*bones)
        wrist = out_ref[members[f"joint-{SIDES[side]}-hand"]].mean(axis=0)
        out = scale_about(out, wrist, pr["hands"]["scale"], w)
    return out


# The eye and wrist pivots come from the base mesh after the head scale, the same for every offset.
out_ref = scale_about(X, centre("joint-neck", X), pr["head"]["scale"], w_head)
base = proportion(X)
moved = {c: proportion(X + off) - base for c, off in offsets.items()}

# Stand on the ground and scale uniformly to the height (head top, helpers excluded).
body = members["body"]
ground = base[body, 2].min()
base[:, 2] -= ground
s = P["height"] / base[body, 2].max()
base *= s
gains = P.get("gains", {})
for c in moved:
    moved[c] *= s * gains.get(c, 1.0)

human.data.vertices.foreach_set("co", base.astype(np.float32).ravel())
human.data.update()

# --- The rig: MPFB's mixamo rig fitted to the scaled mesh, named as the stock avatar ------
bpy.context.view_layer.objects.active = human
rig = HumanService.add_builtin_rig(human, "mixamo", import_weights=True)
rig.name = rig.data.name = "Armature"
for b in rig.data.bones:
    if b.name.startswith(PREFIX):
        b.name = b.name[len(PREFIX):]
for g in human.vertex_groups:
    if g.name.startswith(PREFIX):
        g.name = g.name[len(PREFIX):]

eyes = {}
for side, s_ in SIDES.items():
    idx = members[f"helper-{s_}-eye"]
    c = base[idx].mean(axis=0)
    r = float(np.linalg.norm(base[idx] - c, axis=1).mean())
    eyes[side] = (c, r)
head_top = base[body][np.argmax(base[body, 2])]

# The brow shapes move the brow, not the lids: their offsets fade out below a band above each eye (in eye radii
# from its centre), so the lids they would drag never count as brow, nor slide under the eyeball.
bs = P["browShapes"]
for c in [c for c in moved if c.startswith(("browDown", "browInnerUp", "browOuterUp"))]:
    keep = np.ones(len(base))
    for ec, er in eyes.values():
        near = np.abs(base[:, 0] - ec[0]) < 2.5 * er
        k = smoothstep(ec[2] + bs["from"] * er, ec[2] + bs["to"] * er, base[:, 2])
        keep = np.where(near, np.minimum(keep, k), keep)
    moved[c] *= keep[:, None]

bpy.ops.object.select_all(action="DESELECT")
rig.select_set(True)
bpy.context.view_layer.objects.active = rig
bpy.ops.object.mode_set(mode="EDIT")
eb = rig.data.edit_bones
head_bone = eb["Head"]
for side, (c, r) in eyes.items():
    b = eb.new(f"{side}Eye")
    b.head = c
    b.tail = (c[0], c[1] - 2 * r, c[2])
    b.parent = head_bone
top = eb.new("HeadTop_End")
top.head = (head_bone.head.x, head_bone.head.y, head_top[2])
top.tail = (top.head.x, top.head.y, head_top[2] + 0.05)
top.parent = head_bone
top.use_deform = False
bpy.ops.object.mode_set(mode="OBJECT")

# The mouth corners: the vertices mouthSmile moves most.
lp = P["lips"]
corners = [base[np.argmax(np.linalg.norm(moved[f"mouthSmile{side}"], axis=1))] for side in ("Left", "Right")]
mouth_c = (corners[0] + corners[1]) / 2
lip_a = abs(corners[0][0] - corners[1][0]) / 2 * lp["width"]

# --- Brows: a ribbon over each brow, riding the skin ---------------------------------------
# Painting the brows on the skin follows the base mesh's polygons and comes out stepped; a ribbon a little in
# front of the skin keeps a clean edge. Each ribbon vertex takes the offsets of the skin face under it, so the
# brow shapes carry it, and is weighted to the head in full.
bro = P["brows"]
is_body = np.zeros(N, dtype=bool)
is_body[members["body"]] = True
body_polys = [list(p.vertices) for p in human.data.polygons if is_body[list(p.vertices)].all()]
skin = BVHTree.FromPolygons([tuple(v) for v in base], body_polys)
rib_v, rib_off, rib_f = [], {c: [] for c in moved}, []
for side, (c, r) in eyes.items():
    sign = 1 if side == "Left" else -1  # the human's left is +X
    first = N + len(rib_v)
    nseg, rows = bro["segments"], 3
    for i in range(nseg + 1):
        t = i / nseg
        u = -bro["inner"] + t * (bro["inner"] + bro["outer"])
        low = bro["low"] + bro["rise"] * t + bro["arch"] * (1 - (2 * t - 1) ** 2)
        thick = bro["thick"] * (1 - bro["taper"] * t * t)
        for j in range(rows):
            v = low + thick * j / (rows - 1)
            x, z = c[0] + sign * u * r, c[2] + v * r
            hit, _, poly, _ = skin.ray_cast(Vector((x, c[1] - 0.3, z)), Vector((0, 1, 0)))
            if hit is None:
                raise SystemExit(f"brow ribbon misses the skin at {side} t={t:.2f}")
            vs = body_polys[poly]
            d = np.linalg.norm(base[vs] - np.array(hit), axis=1)
            w = 1 / np.maximum(d, 1e-5)
            w /= w.sum()
            rib_v.append((hit[0], hit[1] - bro["lift"], hit[2]))
            for k in moved:
                rib_off[k].append((moved[k][vs] * w[:, None]).sum(axis=0))
    for i in range(nseg):
        for j in range(rows - 1):
            a, b = first + i * rows + j, first + (i + 1) * rows + j
            quad = (a, b, b + 1, a + 1)  # faces -Y on the left side
            rib_f.append([q - N for q in (quad if sign > 0 else quad[::-1])])
n_brow = len(rib_v)

# --- The mouth bag: MPFB's mouth is open to the hollow head once its teeth and tongue helpers go, so a dark
# ellipsoid sits behind the lips, carried by the head. It is shrunk until the skin hides it from the front and
# both sides (by a margin), except through the mouth itself.
mb = P["mouthBag"]
bag_c = mouth_c + np.array([0.0, mb["back"], -mb["drop"]])
bm_ = bmesh.new()
bmesh.ops.create_uvsphere(bm_, u_segments=16, v_segments=10, radius=1.0)
unit = np.array([v.co[:] for v in bm_.verts])
bag_f = [[v.index for v in f.verts] for f in bm_.faces]
bm_.free()


def hidden(q):
    for axis, sign in ((1, -1), (0, -1), (0, 1)):  # from the front (-Y), the human's right (-X), its left (+X)
        o = q.copy()
        o[axis] = sign * 2.0
        d = np.zeros(3)
        d[axis] = -sign
        hit, _, _, _ = skin.ray_cast(Vector(o), Vector(d))
        if hit is not None and (q[axis] - hit[axis]) * -sign > mb["margin"]:
            continue
        if axis == 1:  # seen from the front: allowed only through the mouth
            dx, dz = (q[0] - mouth_c[0]) / lip_a, (q[2] - mouth_c[2]) / (lip_a * lp["below"])
            if dx * dx + dz * dz <= 1.0:
                continue
        return False
    return True


radii = np.array(mb["radii"]) * lip_a
for _ in range(60):
    pts = bag_c + unit * radii
    if all(hidden(q) for q in pts):
        break
    radii *= 0.95
else:
    raise SystemExit("mouth bag does not fit inside the head")
first = N + len(rib_v)
rib_v.extend(map(tuple, pts))
for k in moved:
    rib_off[k].extend([np.zeros(3)] * len(pts))
rib_f.extend([[first - N + i for i in f] for f in bag_f])
bag_radii = radii

rmesh = bpy.data.meshes.new("Brows")
rmesh.from_pydata(rib_v, [], rib_f)
robj = bpy.data.objects.new("Brows", rmesh)
robj.matrix_world = human.matrix_world  # the ribbon is in the human's mesh space
bpy.context.scene.collection.objects.link(robj)
robj.vertex_groups.new(name="Head").add(list(range(len(rib_v))), 1.0, "REPLACE")
bpy.ops.object.mode_set(mode="OBJECT")
bpy.ops.object.select_all(action="DESELECT")
robj.select_set(True)
human.select_set(True)
bpy.context.view_layer.objects.active = human
bpy.ops.object.join()
base = np.vstack([base, np.array(rib_v)])
for k in moved:
    moved[k] = np.vstack([moved[k], np.array(rib_off[k])])

# --- The face shapes -----------------------------------------------------------------------
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
slots = ["skin", "top", "trousers", "shoes", "brow", "lips", "mouth"]
human.data.materials.clear()
for n in slots:
    human.data.materials.append(material(f"HouseBase_{n}", col[n]))

names = {g.index: g.name for g in human.vertex_groups}
bone_names = {b.name for b in rig.data.bones}
vbone = [""] * len(human.data.vertices)
for v in human.data.vertices:
    best = max(((g.weight, names[g.group]) for g in v.groups if names[g.group] in bone_names), default=(0, ""))
    vbone[v.index] = best[1]

TOP = ("Spine", "Spine1", "Spine2", "LeftShoulder", "RightShoulder", "LeftArm", "RightArm", "LeftForeArm", "RightForeArm")
LEGS = ("Hips", "LeftUpLeg", "RightUpLeg", "LeftLeg", "RightLeg")
FEET = ("LeftFoot", "RightFoot", "LeftToeBase", "RightToeBase")



# The lips: an ellipse through the mouth corners (the vertices mouthSmile moves most), seen from the front;
# what lies behind the corners inside it is the mouth.


def lips_slot(vs):
    """'lips' for a face in the ellipse turned toward the front and no deeper than `inside` behind the corners,
    'mouth' for the rest of the ellipse (the lips' inner sides and the mouth), else None."""
    p = base[vs].mean(axis=0)
    dz = p[2] - mouth_c[2]
    dx, dz = (p[0] - mouth_c[0]) / lip_a, dz / (lip_a * (lp["above"] if dz > 0 else lp["below"]))
    if dx * dx + dz * dz > 1.0 or p[1] > mouth_c[1] + lp["depth"]:
        return None
    a, b, c = base[vs[0]], base[vs[1]], base[vs[2]]
    n = np.cross(b - a, c - a)
    n /= max(np.linalg.norm(n), 1e-12)
    return "lips" if -n[1] >= lp["facing"] and p[1] < mouth_c[1] + lp["inside"] else "mouth"

for poly in human.data.polygons:
    vs = list(poly.vertices)
    bones = [vbone[i] if i < N else "Head" for i in vs]
    p = base[vs].mean(axis=0)
    slot = "skin"
    # Half or more decides, so a face split between two garments (the waist) or a garment and the neck
    # (the collar) is cloth, not a strip of skin; the feet win, and the toe tips (weighted to no rig bone) are shoe.
    t, l, f = (sum(b in g for b in bones) for g in (TOP, LEGS, FEET))
    if f and (f * 2 >= len(bones) or all(b in FEET or b == "" for b in bones)):
        slot = "shoes"
    elif t * 2 >= len(bones) and t >= l:
        slot = "top"
    elif l * 2 >= len(bones):
        slot = "trousers"
    if min(vs) >= N + n_brow:
        slot = "mouth"
    elif max(vs) >= N:
        slot = "brow"
    elif bones.count("Head") * 2 > len(bones) and lips_slot(vs):
        slot = lips_slot(vs)
    poly.material_index = slots.index(slot)
    poly.use_smooth = True

# --- Remove helper geometry and joint cubes -----------------------------------------------
drop = set(members["HelperGeometry"].tolist()) | set(members["JointCubes"].tolist())
bm = bmesh.new()
bm.from_mesh(human.data)
bm.verts.ensure_lookup_table()
bmesh.ops.delete(bm, geom=[bm.verts[i] for i in drop], context="VERTS")
bm.to_mesh(human.data)
bm.free()
for g in list(human.vertex_groups):
    if g.name.startswith(("helper", "joint", "Helper", "Joint")) or g.name in ("body", "Left", "Right", "Mid"):
        human.vertex_groups.remove(g)
for m in list(human.modifiers):
    if m.type != "ARMATURE":
        human.modifiers.remove(m)
human.name = human.data.name = "HouseBase_Body"

# --- Eyeballs, each carried by its eye bone ----------------------------------------------
ep = P["eye"]
skin_now = np.array([v.co[:] for v in human.data.vertices])
eye_radius = {}
for side, (c, r) in eyes.items():
    # No bigger than the skin in front of the eye's centre allows, so the eyeball never shows through the lids.
    d = skin_now - c
    front = d[:, 1] < 0
    fit = float(np.linalg.norm(d[front], axis=1).min()) - ep["lidGap"]
    eye_radius[side] = min(r * ep["radiusShare"], fit)
# Both eyes the smaller size: the lids' nearest vertex can differ by side once the eyes are scaled up.
eye_radius = dict.fromkeys(eye_radius, min(eye_radius.values()))
for side, (c, r) in eyes.items():
    bpy.ops.mesh.primitive_uv_sphere_add(segments=24, ring_count=16, radius=eye_radius[side], location=c + np.array([0.0, ep.get("back", 0.0), 0.0]))
    eye = bpy.context.active_object
    eye.rotation_euler = (math.pi / 2, 0, 0)  # the pole faces -Y, the way the human looks
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
    eye.name = eye.data.name = f"Eye{side}"
    for n in ("sclera", "iris", "pupil"):
        eye.data.materials.append(material(f"HouseBase_eye_{n}", col[n]) if f"HouseBase_eye_{n}" not in bpy.data.materials else bpy.data.materials[f"HouseBase_eye_{n}"])
    for poly in eye.data.polygons:
        d = poly.center.normalized()
        ang = math.acos(max(-1.0, min(1.0, -d.y)))
        poly.material_index = 2 if ang < ep["pupil"] else 1 if ang < ep["iris"] else 0
        poly.use_smooth = True
    g = eye.vertex_groups.new(name=f"{side}Eye")
    g.add(list(range(len(eye.data.vertices))), 1.0, "REPLACE")
    eye.parent = rig
    mod = eye.modifiers.new("Armature", "ARMATURE")
    mod.object = rig

# --- Credits and export ------------------------------------------------------------------
credits = [
    {"part": "body mesh, proportions targets, rig and weights", "title": "MakeHuman base mesh (hm08), mixamo rig", "author": "MakeHuman team", "source": "MPFB 2.0.18 (extensions.blender.org/add-ons/mpfb)", "sourceUrl": "https://extensions.blender.org/add-ons/mpfb/", "licence": "CC0-1.0", "note": "MPFB is GPL-3.0; the human it outputs is CC0"},
    {"part": "the 52 ARKit face shapes", "title": "Faceunits 01", "author": "Mika Suominen", "source": "MakeHuman asset packs", "sourceUrl": "https://static.makehumancommunity.org/assets/assetpacks/faceunits01.html", "licence": "CC0-1.0"},
    {"part": "proportions, face-shape gains, brows, eyes and materials", "title": "HoloIM house base build script", "author": "HoloIM", "source": "apps/capture/scripts/authoring/house-base", "sourceUrl": "https://github.com/AlbertoElias/holo/tree/main/apps/capture/scripts/authoring/house-base", "licence": "CC0-1.0", "note": "own"},
]
bpy.context.scene["holoimAvatar"] = json.dumps({"name": P["name"], "finish": P["finish"], "card": "neutral", "provisional": True, "credits": credits})

bpy.ops.object.select_all(action="SELECT")
bpy.ops.export_scene.gltf(
    filepath=OUT, export_format="GLB", use_selection=False, export_yup=True, export_apply=False,
    export_morph=True, export_morph_normal=False, export_skins=True, export_animations=False,
    export_materials="EXPORT", export_extras=True, export_def_bones=False, export_texcoords=False,
    export_tangents=False, export_cameras=False, export_lights=False,
)

report = {
    "height": P["height"], "vertices": len(human.data.vertices),
    "eyes": {k: {"centre": [round(float(x), 4) for x in v[0]], "helperRadius": round(v[1], 4), "radius": round(eye_radius[k], 4)} for k, v in eyes.items()},
    "headTop": round(float(head_top[2]), 4),
    "mouthBag": {"centre": [round(float(x), 4) for x in bag_c], "radii": [round(float(x), 4) for x in bag_radii]},
    "bones": [b.name for b in rig.data.bones],
    "materials": {n: sum(1 for p in human.data.polygons if p.material_index == i) for i, n in enumerate(slots)},
    "credits": credits,
}
json.dump(report, open(REPORT, "w"), indent=2)
print("HOUSE_BASE_DONE", OUT)
