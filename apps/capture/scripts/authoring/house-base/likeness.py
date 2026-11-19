"""
Renders a house-base wardrobe the way clay-turnaround.png draws the base, and measures how far its
silhouette is from the sheet's, view by view. Run by `house-likeness.ts`, as:

  Blender -b --python likeness.py -- <wardrobe.glb> <clay-turnaround.png> <out dir>

The sheet's four figures (front, three-quarter, side, back) are found on its grey ground; the base,
bald and without glasses as the sheet draws it, is turned to each view (the sheet's three-quarter and
side views face the image's right) and rendered with an orthographic camera twice: a flat mask and a
lit render on the sheet's grey. The sheet's camera is not known, so the framing is the sheet's own:
each mask is scaled so the figure's height (head top to sole) is the sheet figure's, its feet on the
sheet's floor line and its middle on the sheet figure's (the mean column of the mask). Then per view,
the intersection over union of the two masks for the whole figure and for the head (from the head top
down to the chin, a fifth of the height on the sheet: `headShare`).

Writes <out>/likeness.json, <out>/<view>-mask.png (sheet in red, base in cyan, both white),
<out>/<view>-base.png (the lit render, framed as the sheet's crop) and <out>/<view>-sheet.png.

Blender: +Z up, the base faces -Y; the camera looks along +Y, so +X is the image's right.
"""
import bpy, json, math, os, sys
import numpy as np

argv = sys.argv[sys.argv.index("--") + 1:]
GLB, SHEET, OUT = argv[0], argv[1], argv[2]
os.makedirs(OUT, exist_ok=True)

GROUND = np.array([144, 144, 144])  # the sheet's grey, sRGB
VIEWS = [("front", 0.0), ("threeQuarter", 45.0), ("side", 90.0), ("back", 180.0)]
HEAD_SHARE = 0.2
RES = 1600  # render size (px) before the mask is scaled to the sheet's figure


def load_png(path):
    img = bpy.data.images.load(path)
    w, h = img.size
    px = np.array(img.pixels[:], dtype=np.float32).reshape(h, w, img.channels)[::-1, :, :3]
    bpy.data.images.remove(img)
    return px  # sRGB 0..1 as stored (bpy keeps byte images unconverted in .pixels)


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


# --- The sheet: its four figures on the grey ground, the floor line, the frame lines dropped ------------
sheet = load_png(SHEET)
H_, W_ = sheet.shape[:2]
diff = np.abs(sheet * 255 - GROUND).sum(axis=2)
fig = diff > 30
# The title, the ruler on the left and the captions below the floor are not figures.
top_band, floor_band = int(0.1 * H_), int(0.885 * H_)
fig[:top_band] = False
fig[floor_band:] = False
fig[:, : int(0.04 * W_)] = False
fig[fig.sum(axis=1) > 0.5 * W_] = False  # the rules across the sheet (under the title, the floor)
cols = fig.sum(axis=0)
runs, start = [], None
for x, c in enumerate(cols):
    if c > 5 and start is None:
        start = x
    if c <= 5 and start is not None:
        runs.append((start, x))
        start = None
runs = [r for r in runs if r[1] - r[0] > 0.01 * W_]
if len(runs) != 4:
    raise SystemExit(f"expected four figures on the sheet, found {len(runs)}: {runs}")


def sheet_figure(a, b):
    m = np.zeros_like(fig)
    m[:, a:b] = fig[:, a:b]
    # The floor line and the soft shadow under the feet are wider than the feet: rows wider than the
    # figure's legs at the bottom are cut where the figure's own outline ends (the soles' row).
    rows = np.where(m.any(axis=1))[0]
    top = rows.min()
    # The sole: the lowest row that still holds a shoe colour (darker than the ground by a margin).
    dark = (sheet[:, a:b] * 255).mean(axis=2) < 120
    shoe_rows = np.where(dark[: floor_band].any(axis=1))[0]
    bottom = shoe_rows.max()
    m[bottom + 1:] = False
    return m, top, bottom


# --- The base, bald and without glasses (the sheet's base wears neither) ---------------------------------
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o)
bpy.ops.import_scene.gltf(filepath=GLB)
for o in list(bpy.data.objects):
    if o.name.startswith(("Hair_", "Glasses_")):
        bpy.data.objects.remove(o)
meshes = [o for o in bpy.data.objects if o.type == "MESH"]
pivot = bpy.data.objects.new("Turn", None)
bpy.context.scene.collection.objects.link(pivot)
for o in bpy.data.objects:
    if o.parent is None and o is not pivot:
        o.parent = pivot
dg = bpy.context.evaluated_depsgraph_get()


def extent():
    pts = []
    for o in meshes:
        e = o.evaluated_get(bpy.context.evaluated_depsgraph_get())
        m = e.to_mesh()
        a = np.empty(len(m.vertices) * 3)
        m.vertices.foreach_get("co", a)
        a = a.reshape(-1, 3) @ np.array(o.matrix_world)[:3, :3].T + np.array(o.matrix_world)[:3, 3]
        pts.append(a)
        e.to_mesh_clear()
    return np.vstack(pts)


P0 = extent()
height = float(P0[:, 2].max() - P0[:, 2].min())
mid_z = float((P0[:, 2].max() + P0[:, 2].min()) / 2)

scene = bpy.context.scene
scene.render.resolution_x = scene.render.resolution_y = RES
scene.render.film_transparent = True
scene.view_settings.view_transform = "Standard"
cam_data = bpy.data.cameras.new("Cam")
cam_data.type = "ORTHO"
cam_data.ortho_scale = height * 1.25
cam = bpy.data.objects.new("Cam", cam_data)
scene.collection.objects.link(cam)
cam.location = (0, -10, mid_z)
cam.rotation_euler = (math.pi / 2, 0, 0)
scene.camera = cam

# Light for the look render: a soft key from the upper left front, a fill from the right, a rim behind,
# on the sheet's grey (the world colour is the ground, so the clay reads as on the sheet).
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
world.node_tree.nodes["Background"].inputs[1].default_value = 1.0
scene.world = world


def render(path, engine):
    scene.render.engine = engine
    if engine == "BLENDER_WORKBENCH":
        scene.display.shading.light = "FLAT"
        scene.display.shading.color_type = "SINGLE"
        scene.display.shading.single_color = (1, 1, 1)
    else:
        scene.eevee.taa_render_samples = 32
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    img = bpy.data.images.load(path)
    w, h = img.size
    px = np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4)[::-1]
    bpy.data.images.remove(img)
    return px


def resample(a, out_h, out_w):
    """Nearest-neighbour resize of an (h, w[, c]) array."""
    ys = np.clip((np.arange(out_h) + 0.5) * a.shape[0] / out_h, 0, a.shape[0] - 1).astype(int)
    xs = np.clip((np.arange(out_w) + 0.5) * a.shape[1] / out_w, 0, a.shape[1] - 1).astype(int)
    return a[ys][:, xs]


def iou(a, b):
    u = (a | b).sum()
    return float((a & b).sum() / u) if u else 0.0


# --- The stance: the sheet's arms hang lower and its feet stand closer than the base's rest pose, and the
# rest pose is the rig's, not the shape. So the upper arms and legs are turned in the image's plane (about
# the front-back axis, at the shoulder and hip joints) by the angles that best fit the front view's mask,
# searched on a grid; the same pose is used in every view and the angles are reported. --------------------
from mathutils import Matrix, Vector
arm_obj = next(o for o in bpy.data.objects if o.type == "ARMATURE")
REST = {}


def pose(arm_deg, leg_deg):
    bpy.context.view_layer.objects.active = arm_obj
    for name, sign, deg in (("LeftArm", 1, arm_deg), ("RightArm", -1, arm_deg), ("LeftUpLeg", 1, leg_deg), ("RightUpLeg", -1, leg_deg)):
        pb = arm_obj.pose.bones[name]
        pb.matrix_basis = Matrix.Identity(4)
        bpy.context.view_layer.update()
        M = pb.matrix.copy()
        piv = Vector(pb.head)
        R = Matrix.Translation(piv) @ Matrix.Rotation(math.radians(sign * deg), 4, "Y") @ Matrix.Translation(-piv)
        pb.matrix = R @ M
        bpy.context.view_layer.update()


def front_iou(arm_deg, leg_deg, a, b):
    pose(arm_deg, leg_deg)
    pivot.rotation_euler = (0, 0, 0)
    bpy.context.view_layer.update()
    m = render(os.path.join(OUT, "_search.png"), "BLENDER_WORKBENCH")[:, :, 3] > 0.5
    sm, st, sb = sheet_figure(a, b)
    rows, cols_ = np.where(m)
    crop = m[rows.min():rows.max() + 1, cols_.min():cols_.max() + 1]
    s_h = sb - st + 1
    crop = resample(crop, s_h, max(1, int(round(crop.shape[1] * s_h / crop.shape[0]))))
    x0 = int(round(np.where(sm)[1].mean() - np.where(crop)[1].mean()))
    placed = np.zeros_like(sm)
    xa, xb = max(0, x0), min(W_, x0 + crop.shape[1])
    placed[st:sb + 1, xa:xb] = crop[:, xa - x0:xb - x0]
    return iou(sm, placed)


best_arm = max(range(-12, 25, 3), key=lambda d: front_iou(d, 0, *runs[0]))
best_leg = max(range(-4, 7, 1), key=lambda d: front_iou(best_arm, d, *runs[0]))
pose(best_arm, best_leg)
os.remove(os.path.join(OUT, "_search.png"))

report = {"pose": {"armDownDeg": best_arm, "legInDeg": best_leg}, "sheet": os.path.basename(SHEET), "glb": os.path.basename(GLB), "camera": "orthographic, framed to each sheet figure's height, feet and mean column", "headShare": HEAD_SHARE, "views": {}}
tmp = os.path.join(OUT, "_render.png")
for (view, deg), (a, b) in zip(VIEWS, runs):
    pivot.rotation_euler = (0, 0, math.radians(deg))
    bpy.context.view_layer.update()
    mask_px = render(tmp, "BLENDER_WORKBENCH")
    look_px = render(tmp, "BLENDER_EEVEE_NEXT" if "BLENDER_EEVEE_NEXT" in [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items] else "BLENDER_EEVEE")
    base_m = mask_px[:, :, 3] > 0.5
    rows, cols_ = np.where(base_m)
    bt, bb, bl, br = rows.min(), rows.max(), cols_.min(), cols_.max()
    sm, st, sb = sheet_figure(a, b)
    s_h = sb - st + 1
    scale = s_h / (bb - bt + 1)
    # The base's crop, scaled to the sheet figure's height, placed with its feet on the sheet's soles and
    # its mean column on the sheet figure's mean column.
    crop = base_m[bt:bb + 1, bl:br + 1]
    crop_look = look_px[bt:bb + 1, bl:br + 1]
    ch, cw = s_h, max(1, int(round((br - bl + 1) * scale)))
    crop = resample(crop, ch, cw)
    crop_look = resample(crop_look, ch, cw)
    s_mid = np.where(sm)[1].mean()
    c_mid = np.where(crop)[1].mean()
    x0 = int(round(s_mid - c_mid))
    placed = np.zeros_like(sm)
    placed_look = np.zeros((H_, W_, 4), dtype=np.float32)
    xa, xb = max(0, x0), min(W_, x0 + cw)
    placed[st:sb + 1, xa:xb] = crop[:, xa - x0:xb - x0]
    placed_look[st:sb + 1, xa:xb] = crop_look[:, xa - x0:xb - x0]
    head_rows = slice(st, st + int(round(HEAD_SHARE * s_h)))
    hs, hb = np.zeros_like(sm), np.zeros_like(sm)
    hs[head_rows], hb[head_rows] = sm[head_rows], placed[head_rows]
    # Widths at landmark heights (share of the height from the top), sheet against base, in sheet px.
    widths = {}
    for name, share in (("cranium", 0.06), ("eyes", 0.1), ("cheeks", 0.13), ("neck", 0.21), ("chest", 0.3), ("waist", 0.42), ("hips", 0.5), ("knees", 0.72), ("ankles", 0.95)):
        r = st + int(share * s_h)
        widths[name] = {"sheet": int(sm[r].sum()), "base": int(placed[r].sum())}
    report["views"][view] = {
        "iou": round(iou(sm, placed), 4),
        "headIou": round(iou(hs, hb), 4),
        "sheetFigurePx": [int(st), int(sb)],
        "widthsPx": widths,
    }
    # The figure's crop of the sheet, the base framed the same, and the masks overlaid.
    cx0, cx1 = max(0, int(s_mid) - (sb - st) // 3), min(W_, int(s_mid) + (sb - st) // 3)
    cy0, cy1 = max(0, st - 20), min(H_, sb + 20)
    ground = GROUND / 255.0
    look = placed_look[:, :, :3] * placed_look[:, :, 3:] + ground * (1 - placed_look[:, :, 3:])
    over = np.zeros((H_, W_, 3), dtype=np.float32)
    over[sm & ~placed] = (1, 0.25, 0.25)
    over[placed & ~sm] = (0.25, 0.9, 1)
    over[sm & placed] = (1, 1, 1)
    save_png(os.path.join(OUT, f"{view}-sheet.png"), sheet[cy0:cy1, cx0:cx1])
    save_png(os.path.join(OUT, f"{view}-base.png"), look[cy0:cy1, cx0:cx1])
    save_png(os.path.join(OUT, f"{view}-mask.png"), over[cy0:cy1, cx0:cx1])
os.remove(tmp)
v = report["views"]
report["meanIou"] = round(float(np.mean([x["iou"] for x in v.values()])), 4)
report["meanHeadIou"] = round(float(np.mean([x["headIou"] for x in v.values()])), 4)
json.dump(report, open(os.path.join(OUT, "likeness.json"), "w"), indent=2)
print("HOUSE_LIKENESS_DONE", json.dumps({k: (x["iou"], x["headIou"]) for k, x in v.items()}))
