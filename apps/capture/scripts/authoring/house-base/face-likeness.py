"""
Renders the house base's face the way the clay expression sheet draws it, expression by expression,
and measures how far its features are from the sheet's. Run by `house-face-likeness.ts`, as:

  Blender -b --python face-likeness.py -- <wardrobe.glb> <clay-expressions.png> <mixes.json> <out dir>

mixes.json: {"faces": [{"name", "sheetIndex", "mix": {channel: weight}, "eyePitchDeg", "eyeYawDeg"}]}.
The sheet's heads sit in a row on a grey ground (sheet.py's GROUND); head `sheetIndex` is the n-th
from the left. Both the sheet's head and the base's are framed alike: from the head's top to the chin,
centred on the midline, in a square `FRAME` px across whose side is `SPAN` head heights.

Features, as three classes of pixels in that frame:
- dark: brows, lashes, the iris and pupil, the mouth's line or opening;
- white: the eyes' whites and the teeth;
- (skin: the rest of the head).
On the sheet they are read by colour inside the face (between the ears): dark is a luminance under
`DARK` of the skin's median, white a bright pixel of low saturation. On the base they are the
materials themselves, rendered flat. Per face: the intersection over union of each class, and the
boxes of the eyes (white and iris together), the brows and the mouth, in head heights.

Writes <out>/face-likeness.json, and per face <name>-sheet.png, <name>-base.png (lit) and
<name>-mask.png (sheet's features in red, base's in cyan, both white).

Blender: +Z up, the base faces -Y; the camera looks along +Y, so +X is the image's right.
"""
import bpy, json, math, os, sys
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sheet import GROUND, load_png  # noqa: E402

argv = sys.argv[sys.argv.index("--") + 1:]
GLB, SHEET, MIXES, OUT = argv[0], argv[1], argv[2], argv[3]
os.makedirs(OUT, exist_ok=True)
FACES = json.load(open(MIXES))["faces"]

FRAME = 512    # px across each framed head
SPAN = 1.25    # the frame's side in head heights (top to chin)
DARK = 0.7     # the sheet's dark class: luminance under this share of the skin's median
WHITE = (0.9, 0.36)  # its white class: luminance over this share of the skin's median, saturation (max - min) under this
FACE_HALF = 0.3  # features are read within this many head heights of the midline (the ears and the head's shaded edge lie outside)
FACE_ROWS = (0.12, 0.93)  # and between these shares of the head's height from its top
NOSE = (0.1, 0.6, 0.735)  # less the nose: half width, from and to (head heights)
PIECE = 40     # px: a feature piece smaller than this is shading
PIECE_HALF = 0.26  # a piece centred further from the midline (head heights) is the head's shaded edge
EYE_ROWS = (0.41, 0.63)  # head heights from the top: a dark piece centred above is a brow, below the mouth


def save_png(path, rgb):
    h, w = rgb.shape[:2]
    img = bpy.data.images.new(os.path.basename(path), w, h, alpha=False)
    a = np.ones((h, w, 4), dtype=np.float32)
    a[:, :, :3] = np.clip(rgb, 0, 1)
    img.pixels.foreach_set(a[::-1].ravel())
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    bpy.data.images.remove(img)


def load(path):
    img = bpy.data.images.load(path)
    w, h = img.size
    px = np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4)[::-1]
    bpy.data.images.remove(img)
    return px


def resize(a, out_h, out_w):
    """Area-averaging when shrinking, nearest when growing, of an (h, w, c) array."""
    ys = np.clip(((np.arange(out_h) + 0.5) * a.shape[0] / out_h).astype(int), 0, a.shape[0] - 1)
    xs = np.clip(((np.arange(out_w) + 0.5) * a.shape[1] / out_w).astype(int), 0, a.shape[1] - 1)
    return a[ys][:, xs]


def lum(rgb):
    return 0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2]


def components(mask, min_px):
    """Connected pieces of a mask (4-neighbour), largest first, as boolean arrays."""
    h, w = mask.shape
    seen = np.zeros_like(mask)
    out = []
    for y0, x0 in zip(*np.where(mask)):
        if seen[y0, x0]:
            continue
        stack, pts = [(y0, x0)], []
        seen[y0, x0] = True
        while stack:
            y, x = stack.pop()
            pts.append((y, x))
            for yy, xx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
                if 0 <= yy < h and 0 <= xx < w and mask[yy, xx] and not seen[yy, xx]:
                    seen[yy, xx] = True
                    stack.append((yy, xx))
        if len(pts) >= min_px:
            m = np.zeros_like(mask)
            m[tuple(np.array(pts).T)] = True
            out.append(m)
    return sorted(out, key=lambda m: -m.sum())


# --- The sheet's heads --------------------------------------------------------------------------------
sheet = load_png(SHEET)
H_, W_ = sheet.shape[:2]
ground = GROUND / 255.0
fig = np.abs(sheet - ground).max(axis=2) > 0.08
# The row of large heads: the tallest run of rows that hold figure pixels (the title, the rules, the
# labels and the small rows are all shorter runs); then each head is a run of columns in it.
def spans(on, least):
    e = np.flatnonzero(np.diff(np.concatenate([[0], on.astype(int), [0]])))
    return [(int(a), int(b)) for a, b in zip(e[::2], e[1::2]) if b - a >= least]


top, bottom = max(spans(fig.sum(axis=1) > 0.05 * W_, 1), key=lambda r: r[1] - r[0])
runs = spans(fig[top:bottom].sum(axis=0) > 5, int(0.03 * W_))
if len(runs) < len(FACES):
    raise SystemExit(f"expected at least {len(FACES)} heads on the sheet, found {len(runs)}: {runs}")


def sheet_head(index):
    """The index-th head framed: (FRAME, FRAME, 3) and its mask."""
    a, b = runs[index]
    m = fig[top:bottom, a:b]
    # The head alone: the largest piece (a label's letters are not attached to it).
    r = np.where(m.sum(axis=1) > 0)[0]
    t, btm = top + r.min(), top + r.max()
    h = btm - t + 1
    # The midline: the middle of the cranium (the ears are not always alike), a tenth of the way down.
    row = fig[t + h // 10, a:b]
    xs = np.where(row)[0]
    mid = a + (xs.min() + xs.max()) / 2
    side = SPAN * h
    x0, y0 = mid - side / 2, (t + btm) / 2 - side / 2
    ys = np.clip((y0 + (np.arange(FRAME) + 0.5) * side / FRAME).astype(int), 0, H_ - 1)
    xs = (x0 + (np.arange(FRAME) + 0.5) * side / FRAME).astype(int)
    ok = (xs >= a - 4) & (xs < b + 4)
    img = np.tile(ground, (FRAME, FRAME, 1)).astype(np.float32)
    img[:, ok] = sheet[ys][:, np.clip(xs[ok], 0, W_ - 1)]
    inside = (ys >= top) & (ys < bottom)
    img[~inside] = ground
    return img


def zone():
    """Where features are read, on the sheet and on the base alike: the face between the ears, under the
    crown and above the chin's edge, less the nose (its shadows are dark on the sheet; it carries no feature)."""
    f = SPAN / FRAME
    x = (np.arange(FRAME) + 0.5 - FRAME / 2) * f
    y = (np.arange(FRAME) + 0.5) * f - (SPAN - 1) / 2
    X, Y = np.meshgrid(x, y)
    face = (np.abs(X) < FACE_HALF) & (Y > FACE_ROWS[0]) & (Y < FACE_ROWS[1])
    nose = (np.abs(X) < NOSE[0]) & (Y > NOSE[1]) & (Y < NOSE[2])
    return face & ~nose


ZONE = zone()


def sheet_classes(img):
    head = np.abs(img - ground).max(axis=2) > 0.08
    l = lum(img)
    skin = float(np.median(l[head]))
    sat = img.max(axis=2) - img.min(axis=2)
    white = head & ZONE & (l > WHITE[0] * skin) & (sat < WHITE[1])
    dark = head & ZONE & (l < DARK * skin)
    return dark, white, head


# --- The base, bald and without glasses ---------------------------------------------------------------
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o)
bpy.ops.import_scene.gltf(filepath=GLB)
for o in list(bpy.data.objects):
    if o.name.startswith(("Hair_", "Glasses_")):
        bpy.data.objects.remove(o)
meshes = [o for o in bpy.data.objects if o.type == "MESH"]
body = next(o for o in meshes if o.name.startswith("HouseBase_Body"))
rig = next(o for o in bpy.data.objects if o.type == "ARMATURE")
scene = bpy.context.scene


def world_co(o):
    a = np.empty(len(o.data.vertices) * 3)
    o.data.vertices.foreach_get("co", a)
    M = np.array(o.matrix_world)
    return a.reshape(-1, 3) @ M[:3, :3].T + M[:3, 3]


bpy.context.view_layer.update()
V = world_co(body)
gi = body.vertex_groups["Head"].index
w_head = np.array([next((g.weight for g in v.groups if g.group == gi), 0.0) for v in body.data.vertices])
eye_objs = [o for o in meshes if o.name.startswith("Eye")]
eye_c = np.array([world_co(o).mean(axis=0) for o in eye_objs])
head_top = float(V[:, 2].max())
chin = float(V[(w_head > 0.99) & (V[:, 1] < eye_c[:, 1].mean() + 0.02), 2].min())
head_h = head_top - chin
mid_x = float(eye_c[:, 0].mean())

scene.render.resolution_x = scene.render.resolution_y = FRAME
scene.render.film_transparent = True
scene.view_settings.view_transform = "Standard"
cam_data = bpy.data.cameras.new("Cam")
cam_data.type = "ORTHO"
cam_data.ortho_scale = SPAN * head_h
cam = bpy.data.objects.new("Cam", cam_data)
scene.collection.objects.link(cam)
cam.location = (mid_x, -10, (head_top + chin) / 2)
cam.rotation_euler = (math.pi / 2, 0, 0)
scene.camera = cam
for name, rot, energy in (("Key", (math.radians(50), 0, math.radians(-35)), 3.0),
                          ("Fill", (math.radians(70), 0, math.radians(50)), 1.2),
                          ("Rim", (math.radians(60), 0, math.radians(180)), 1.5)):
    ld = bpy.data.lights.new(name, "SUN")
    ld.energy = energy
    ld.angle = math.radians(25)
    lo = bpy.data.objects.new(name, ld)
    lo.rotation_euler = rot
    scene.collection.objects.link(lo)
world = bpy.data.worlds.new("Ground")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (0.28, 0.28, 0.28, 1)
scene.world = world

# The class of each material, as a flat colour for the workbench pass: dark red, white green, skin blue.
CLASS = {"brow": "dark", "lash": "dark", "mouth": "dark", "eye_iris": "dark", "eye_pupil": "dark", "eye_limbus": "dark",
         "eye_sclera": "white", "eye_glint": "white", "teeth": "white"}
FLAT = {"dark": (1, 0, 0, 1), "white": (0, 1, 0, 1), "skin": (0, 0, 1, 1)}
for m in bpy.data.materials:
    key = m.name.split(".")[0].replace("HouseBase_", "")
    m.diffuse_color = FLAT[CLASS.get(key, "skin")]
EEVEE = "BLENDER_EEVEE_NEXT" if "BLENDER_EEVEE_NEXT" in [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items] else "BLENDER_EEVEE"


def render(engine):
    scene.render.engine = engine
    if engine == "BLENDER_WORKBENCH":
        scene.display.shading.light = "FLAT"
        scene.display.shading.color_type = "MATERIAL"
        scene.display.render_aa = "OFF"
    else:
        scene.eevee.taa_render_samples = 32
    scene.render.filepath = os.path.join(OUT, "_render.png")
    bpy.ops.render.render(write_still=True)
    return load(scene.render.filepath)


from mathutils import Matrix  # noqa: E402


def pose(face):
    keys = body.data.shape_keys.key_blocks
    for k in keys[1:]:
        k.value = float(face["mix"].get(k.name, 0.0))
    for side in ("Left", "Right"):
        pb = rig.pose.bones[f"{side}Eye"]
        pb.matrix_basis = Matrix.Identity(4)
        bpy.context.view_layer.update()
        piv = pb.head.copy()
        # Pitch about the head's left-right axis (down is positive), yaw about its up axis (the image's right is positive).
        R = Matrix.Rotation(math.radians(face.get("eyeYawDeg", 0.0)), 4, "Z") @ Matrix.Rotation(math.radians(face.get("eyePitchDeg", 0.0)), 4, "X")
        pb.matrix = Matrix.Translation(piv) @ R @ Matrix.Translation(-piv) @ pb.matrix
    bpy.context.view_layer.update()


def iou(a, b):
    u = (a | b).sum()
    return float((a & b).sum() / u) if u else 1.0


def box(mask):
    """[x0, y0, x1, y1] in head heights from the midline and from the head's top (y down); None if empty."""
    if not mask.any():
        return None
    ys, xs = np.where(mask)
    f = SPAN / FRAME
    y_top = (SPAN - 1) / 2
    return [round(float((xs.min() - FRAME / 2) * f), 3), round(float(ys.min() * f - y_top), 3),
            round(float((xs.max() + 1 - FRAME / 2) * f), 3), round(float((ys.max() + 1) * f - y_top), 3)]


def features(dark, white):
    """The eyes, the brows and the mouth from the two classes, piece by piece (a piece is a connected run of
    feature pixels, of either class, at least `PIECE` px; smaller ones and those centred beyond `PIECE_HALF`
    of the midline are shading and dropped): a piece that holds white above `EYE_ROWS[1]` is an eye, and
    white lower is the mouth's (teeth); a dark piece centred above `EYE_ROWS[0]` is a brow, one between the
    two rows an eye (a closed lid's lash line), one lower the mouth. Returns the boxes and areas, the
    three masks, and the classes with the dropped pieces taken out."""
    f = SPAN / FRAME
    y_top = (SPAN - 1) / 2
    parts = {k: np.zeros_like(dark) for k in ("brow", "eye", "mouth")}
    for piece in components(dark | white, PIECE):
        ys, xs = np.where(piece)
        cx, cy = (xs.mean() + 0.5 - FRAME / 2) * f, (ys.mean() + 0.5) * f - y_top
        if abs(cx) > PIECE_HALF:
            continue
        wy = np.where(piece & white)[0]
        if len(wy) and ((wy.mean() + 0.5) * f - y_top) < EYE_ROWS[1]:
            kind = "eye"
        elif len(wy) or cy >= EYE_ROWS[1]:
            kind = "mouth"
        else:
            kind = "brow" if cy < EYE_ROWS[0] else "eye"
        parts[kind] |= piece
    half = FRAME // 2
    out = {}
    for name, m in parts.items():
        for side, sl in ((("L", slice(0, half)), ("R", slice(half, FRAME))) if name != "mouth" else (("", slice(0, FRAME)),)):
            part = np.zeros_like(m)
            part[:, sl] = m[:, sl]
            out[name + side] = box(part)
    px = FRAME / SPAN
    out["areas"] = {"brow": round(float(parts["brow"].sum() / px ** 2), 4), "eyeWhite": round(float((white & parts["eye"]).sum() / px ** 2), 4),
                    "eyeDark": round(float((dark & parts["eye"]).sum() / px ** 2), 4), "mouth": round(float(parts["mouth"].sum() / px ** 2), 4)}
    kept = parts["brow"] | parts["eye"] | parts["mouth"]
    return out, parts, dark & kept, white & kept


report = {"sheet": os.path.basename(SHEET), "glb": os.path.basename(GLB), "frame": {"px": FRAME, "spanHeadHeights": SPAN},
          "units": "boxes [x0, y0, x1, y1] in head heights (top to chin): x from the midline, y down from the head's top; areas in square head heights",
          "faces": {}}
for face in FACES:
    name = face["name"]
    s_img = sheet_head(face["sheetIndex"])
    s_dark, s_white, s_head = sheet_classes(s_img)
    pose(face)
    ids = render("BLENDER_WORKBENCH")
    look = render(EEVEE)
    a = ids[:, :, 3] > 0.5
    b_dark = a & ZONE & (ids[:, :, 0] > 0.5) & (ids[:, :, 1] < 0.5)
    b_white = a & ZONE & (ids[:, :, 1] > 0.5) & (ids[:, :, 0] < 0.5)
    lit = look[:, :, :3] * look[:, :, 3:] + ground * (1 - look[:, :, 3:])
    s_feat, s_parts, s_dark, s_white = features(s_dark, s_white)
    b_feat, b_parts, b_dark, b_white = features(b_dark, b_white)
    s_any, b_any = s_dark | s_white, b_dark | b_white
    report["faces"][name] = {
        "iou": {"features": round(iou(s_any, b_any), 4), "dark": round(iou(s_dark, b_dark), 4), "white": round(iou(s_white, b_white), 4),
                **{k: round(iou(s_parts[k], b_parts[k]), 4) for k in ("brow", "eye", "mouth")}},
        "sheet": s_feat, "base": b_feat,
    }
    over = np.tile(np.array((0.2, 0.2, 0.2), dtype=np.float32), (FRAME, FRAME, 1))
    over[s_head] = (0.35, 0.35, 0.35)
    over[s_any & ~b_any] = (1, 0.25, 0.25)
    over[b_any & ~s_any] = (0.25, 0.9, 1)
    over[s_any & b_any] = (1, 1, 1)
    save_png(os.path.join(OUT, f"{name}-sheet.png"), s_img)
    save_png(os.path.join(OUT, f"{name}-base.png"), lit)
    save_png(os.path.join(OUT, f"{name}-mask.png"), over)
os.remove(os.path.join(OUT, "_render.png"))
f = report["faces"]
report["mean"] = {k: round(float(np.mean([x["iou"][k] for x in f.values()])), 4) for k in ("features", "dark", "white", "brow", "eye", "mouth")}
json.dump(report, open(os.path.join(OUT, "face-likeness.json"), "w"), indent=2)
print("HOUSE_FACE_LIKENESS_DONE", json.dumps(report["mean"]))
