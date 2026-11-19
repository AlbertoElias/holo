"""
Reads Astra's clay turnaround (clay-turnaround.png): its four figures (front, three-quarter, side, back)
on the sheet's grey ground, without the title, the ruler, the rules and the captions. Shared by
`likeness.py` (the measure) and `carve.py` (the fit target), so both read the figures alike. Blender's
Python (bpy loads the PNG).
"""
import bpy
import numpy as np

GROUND = np.array([144, 144, 144])  # the sheet's grey, sRGB


def load_png(path):
    img = bpy.data.images.load(path)
    w, h = img.size
    px = np.array(img.pixels[:], dtype=np.float32).reshape(h, w, img.channels)[::-1, :, :3]
    bpy.data.images.remove(img)
    return px  # sRGB 0..1 as stored (bpy keeps byte images unconverted in .pixels)


class Turnaround:
    """`sheet` (h, w, 3), `runs` (the four figures' column ranges, left to right) and `figure(a, b)`:
    the figure's mask between columns a and b, its top row and its sole row."""

    def __init__(self, path):
        sheet = load_png(path)
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
        self.sheet, self.fig, self.runs, self.floor_band = sheet, fig, runs, floor_band
        self.H, self.W = H_, W_

    def figure(self, a, b):
        m = np.zeros_like(self.fig)
        m[:, a:b] = self.fig[:, a:b]
        # The floor line and the soft shadow under the feet are wider than the feet: rows wider than the
        # figure's legs at the bottom are cut where the figure's own outline ends (the soles' row).
        rows = np.where(m.any(axis=1))[0]
        top = rows.min()
        # The sole: the lowest row that still holds a shoe colour (darker than the ground by a margin).
        dark = (self.sheet[:, a:b] * 255).mean(axis=2) < 120
        shoe_rows = np.where(dark[: self.floor_band].any(axis=1))[0]
        bottom = shoe_rows.max()
        m[bottom + 1:] = False
        return m, top, bottom
