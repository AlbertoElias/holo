"""
Generates the fit target (slice 2c2 of docs/features/directed-performance.md): a shape of the clay
base, from Astra's turnaround sheet, made locally by an open-weights image-to-3D model, for `fit.py`
to wrap the house base onto. It is a fitting guide only: nothing of it ships but the moves it gives
the house base's own vertices.

Model: Hunyuan3D-2mv (Tencent, multi-view shape DiT; Tencent Hunyuan 3D 2.0 Community License, which
excludes the EU, the UK and South Korea: the owner reviews whether this guide may stay), run on the
Mac's GPU (MPS) or the CPU. It takes the sheet's front, side and back figures, cut from the sheet on its
grey ground, as RGBA images of the same figure height (the side view mirrored: the model's "left" view
looks to the image's left).

  python generate-target.py <clay-turnaround.png> <out.glb> [--device mps|cpu] [--steps 50] [--seed 12345]
         [--octree 380] [--faces 24000] [--views <dir to write the cut views to>]

Needs: torch, diffusers, transformers, trimesh, pymeshlab, numpy, Pillow, and the Hunyuan3D-2 source
(github.com/Tencent-Hunyuan/Hunyuan3D-2) on PYTHONPATH; the weights in
~/.cache/hy3dgen/tencent/Hunyuan3D-2mv/hunyuan3d-dit-v2-mv/ (config.yaml, model.fp16.safetensors).

The mesh is written as glTF (+Y up, the figure facing +Z, as the model makes it), decimated to
`--faces` triangles: Blender imports it +Z up, facing -Y, as `build.py` stands the human.
"""
import argparse
import os
import time

import numpy as np
from PIL import Image

GROUND = 144  # the sheet's grey


def cut_views(sheet_path):
    """The sheet's four figures as RGBA crops, square, all at one figure height. The figures stand in
    four runs of columns on the grey; the title above and the captions below the floor line are left
    out (the same bands as likeness.py)."""
    from scipy import ndimage

    a = np.asarray(Image.open(sheet_path).convert("RGB")).astype(np.int32)
    H, W = a.shape[:2]
    fig = np.abs(a - GROUND).sum(axis=2) > 24
    top, floor = int(0.1 * H), int(0.885 * H)
    fig[:top] = False
    fig[floor:] = False
    fig[:, : int(0.04 * W)] = False
    fig[fig.sum(axis=1) > 0.5 * W] = False  # rules across the sheet
    cols = fig.sum(axis=0) > 2
    runs, start = [], None
    for x, on in enumerate(list(cols) + [False]):
        if on and start is None:
            start = x
        elif not on and start is not None:
            if x - start > 40:
                runs.append((start, x))
            start = None
    if len(runs) != 4:
        raise SystemExit(f"found {len(runs)} figures on the sheet, not 4")
    views = {}
    for name, (x0, x1) in zip(("front", "three", "side", "back"), runs):
        m = fig[:, x0:x1].copy()
        m = ndimage.binary_closing(m, iterations=3)
        m = ndimage.binary_fill_holes(m)
        lab, n = ndimage.label(m)
        if n > 1:
            m = lab == (np.argmax(np.bincount(lab.ravel())[1:]) + 1)
        rows = np.where(m.any(axis=1))[0]
        y0, y1 = rows.min(), rows.max() + 1
        rgba = np.zeros((y1 - y0, x1 - x0, 4), np.uint8)
        rgba[..., :3] = a[y0:y1, x0:x1]
        rgba[..., 3] = m[y0:y1] * 255
        views[name] = rgba
    # Square, the figure 85% of the side, centred on its columns.
    out = {}
    for name, v in views.items():
        h, w = v.shape[:2]
        side = int(h / 0.85)
        sq = np.zeros((side, side, 4), np.uint8)
        oy, ox = (side - h) // 2, (side - w) // 2
        sq[oy:oy + h, ox:ox + w] = v
        out[name] = Image.fromarray(sq).resize((1024, 1024), Image.LANCZOS)
    out["side"] = out["side"].transpose(Image.FLIP_LEFT_RIGHT)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("sheet")
    ap.add_argument("out")
    ap.add_argument("--device", default="mps")
    ap.add_argument("--steps", type=int, default=50)
    ap.add_argument("--seed", type=int, default=12345)
    ap.add_argument("--octree", type=int, default=380)
    ap.add_argument("--faces", type=int, default=24000)
    ap.add_argument("--views")
    a = ap.parse_args()

    import torch
    from hy3dgen.shapegen import Hunyuan3DDiTFlowMatchingPipeline

    # The surface: the model's marching cubes hangs on the Mac (the MPS grid read straight into
    # scikit-image); the grid is copied to the CPU as float32 first and checked.
    from hy3dgen.shapegen.models.autoencoders import surface_extractors as se
    from skimage import measure

    def run(self, grid_logit, *, mc_level, bounds, octree_resolution, **kwargs):
        g = grid_logit.detach().to("cpu", torch.float32).numpy().copy()
        print(f"grid {g.shape}, {np.isnan(g).sum()} NaN, range {np.nanmin(g):.3f}..{np.nanmax(g):.3f}", flush=True)
        g = np.nan_to_num(g, nan=-1.0)
        v, f, _, _ = measure.marching_cubes(g, mc_level, method="lewiner")
        size, lo, extent = self._compute_box_stat(bounds, octree_resolution)
        return v / size * extent + lo, f

    se.MCSurfaceExtractor.run = run
    views = cut_views(a.sheet)
    if a.views:
        os.makedirs(a.views, exist_ok=True)
        for k, im in views.items():
            im.save(os.path.join(a.views, f"{k}.png"))
    dtype = torch.float16 if a.device != "cpu" else torch.float32
    weights = os.path.expanduser("~/.cache/hy3dgen/tencent/Hunyuan3D-2mv/hunyuan3d-dit-v2-mv")
    pipe = Hunyuan3DDiTFlowMatchingPipeline.from_single_file(
        os.path.join(weights, "model.fp16.safetensors"), os.path.join(weights, "config.yaml"),
        device=a.device, dtype=dtype, use_safetensors=True)
    t = time.time()
    mesh = pipe(
        image={"front": views["front"], "left": views["side"], "back": views["back"]},
        num_inference_steps=a.steps, octree_resolution=a.octree, num_chunks=20000,
        generator=torch.manual_seed(a.seed), output_type="trimesh")[0]
    print(f"generated {len(mesh.faces)} faces in {time.time() - t:.0f} s on {a.device}")
    mesh.export(os.path.splitext(a.out)[0] + ".raw.glb")  # before clean-up, to redo it without the model

    import pymeshlab
    import trimesh
    # Only the largest piece: floaters the decoder leaves around the figure are not the figure.
    mesh.merge_vertices()
    pieces = mesh.split(only_watertight=False)
    print("pieces (faces):", sorted((len(p.faces) for p in pieces), reverse=True)[:5])
    big = max(pieces, key=lambda p: len(p.faces))
    ms = pymeshlab.MeshSet()
    ms.add_mesh(pymeshlab.Mesh(big.vertices, big.faces))
    ms.meshing_decimation_quadric_edge_collapse(targetfacenum=a.faces, preservenormal=True, preservetopology=True)
    m = ms.current_mesh()
    out = trimesh.Trimesh(m.vertex_matrix(), m.face_matrix(), process=True)
    out.export(a.out)
    print("GENERATE_TARGET_DONE", a.out, len(out.vertices), "vertices", len(out.faces), "faces")


if __name__ == "__main__":
    main()
