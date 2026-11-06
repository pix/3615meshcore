#!/usr/bin/env python3
"""minitel_render.py - photo-realistic Minitel 2 showing a 3615 MESHCORE screen dump.

    python3 -I minitel_render.py dump [dump2 ...] [-o out.png|out.gif] [--size 1920x1440|4k]
                                 [--angle [DEG]] [--style desk|night|studio]
                                 [--framing full|front|screen] [--screen-only] [--blink ...]

Pure numpy + Pillow (opencv/scipy used when present for speed). The scene is ray-marched:
an unbranded charcoal Minitel-2-like case with a deep bezel, a spherical CRT face, the pull-out
keyboard, a desk and a wall; the CRT shading models the phosphor raster, beam spot,
halation, tinted glass, refraction through the faceplate and room reflections. See README.md.
"""
import argparse
import math
import os
import sys
import time

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from minitel_screen import parse_dump, render_dots, glyph_for, CELL_H  # noqa: E402

try:
    import cv2
    cv2.setNumThreads(os.cpu_count() or 4)
except ImportError:  # pragma: no cover
    cv2 = None
try:
    from scipy import ndimage
except ImportError:  # pragma: no cover
    ndimage = None

F = np.float32


# ============================================================ small image helpers

def gblur(img, sigma):
    """Gaussian blur of a 2D or HxWxC float32 image."""
    if sigma <= 0.05:
        return img
    if cv2 is not None:
        k = int(sigma * 3) * 2 + 1
        return cv2.GaussianBlur(img, (k, k), sigma, borderType=cv2.BORDER_REFLECT)
    if ndimage is not None:
        s = (sigma, sigma, 0) if img.ndim == 3 else sigma
        return ndimage.gaussian_filter(img, s, mode="reflect")
    # numpy fallback: separable FFT-free box approximation (3 boxes ~ gaussian)
    out = img
    r = max(1, int(round(sigma * 1.0)))
    for ax in (0, 1):
        for _ in range(3):
            c = np.cumsum(np.pad(out, [(r + 1, r) if a == ax else (0, 0) for a in range(out.ndim)], mode="edge"), axis=ax)
            sl_hi = [slice(None)] * out.ndim
            sl_lo = [slice(None)] * out.ndim
            sl_hi[ax] = slice(2 * r + 1, None)
            sl_lo[ax] = slice(0, -2 * r - 1)
            out = (c[tuple(sl_hi)] - c[tuple(sl_lo)]) / (2 * r + 1)
    return out.astype(F)


def resize(img, w, h):
    if cv2 is not None:
        interp = cv2.INTER_AREA if w < img.shape[1] else cv2.INTER_LINEAR
        return cv2.resize(img, (w, h), interpolation=interp)
    chans = [img] if img.ndim == 2 else [img[..., i] for i in range(img.shape[2])]
    out = [np.asarray(Image.fromarray(c).resize((w, h), Image.BILINEAR)) for c in chans]
    return out[0] if img.ndim == 2 else np.stack(out, -1)


def sample(img, x, y):
    """Bilinear sample of 2D/3D image at float pixel coords x, y (1D arrays); zero outside."""
    if cv2 is not None:
        mx = x.astype(F).reshape(1, -1)
        my = y.astype(F).reshape(1, -1)
        out = cv2.remap(img, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
        return out.reshape(-1) if img.ndim == 2 else out.reshape(-1, img.shape[2])
    if ndimage is not None:
        if img.ndim == 2:
            return ndimage.map_coordinates(img, [y, x], order=1, mode="constant").astype(F)
        return np.stack([ndimage.map_coordinates(img[..., c], [y, x], order=1, mode="constant")
                         for c in range(img.shape[2])], -1).astype(F)
    h, w = img.shape[:2]
    x0 = np.floor(x).astype(int)
    y0 = np.floor(y).astype(int)
    fx = (x - x0).astype(F)
    fy = (y - y0).astype(F)
    def at(yy, xx):
        ok = (xx >= 0) & (xx < w) & (yy >= 0) & (yy < h)
        v = img[np.clip(yy, 0, h - 1), np.clip(xx, 0, w - 1)]
        return v * (ok[:, None] if img.ndim == 3 else ok)
    if img.ndim == 3:
        fx, fy = fx[:, None], fy[:, None]
    return (at(y0, x0) * (1 - fx) * (1 - fy) + at(y0, x0 + 1) * fx * (1 - fy)
            + at(y0 + 1, x0) * (1 - fx) * fy + at(y0 + 1, x0 + 1) * fx * fy)


def hash_noise(shape, seed, sigma):
    rng = np.random.default_rng(seed)
    n = rng.standard_normal(shape).astype(F)
    return gblur(n, sigma) * (1.0 / max(1e-3, 0.28 / max(sigma, 0.3)) if sigma > 0.3 else 1.0)


def value_noise_2d(x, y, scale, seed=0):
    """Smooth 2D value noise at arbitrary points (x, y in mm), roughly in [-1, 1]."""
    rng = np.random.default_rng(seed)
    grid = rng.uniform(-1, 1, (257, 257)).astype(F)
    gx = (x / scale) % 256
    gy = (y / scale) % 256
    x0 = np.clip(np.floor(gx).astype(np.int32), 0, 255)
    y0 = np.clip(np.floor(gy).astype(np.int32), 0, 255)
    fx = gx - x0
    fy = gy - y0
    fx = fx * fx * (3 - 2 * fx)
    fy = fy * fy * (3 - 2 * fy)
    a = grid[y0, x0]
    b = grid[y0, x0 + 1]
    c = grid[y0 + 1, x0]
    d = grid[y0 + 1, x0 + 1]
    return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy


# ============================================================ vector helpers (arrays of shape (N,3) or tuples of 1D)

def norm3(v):
    return v / np.maximum(np.linalg.norm(v, axis=-1, keepdims=True), 1e-9)


def dot3(a, b):
    return np.sum(a * b, axis=-1)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def smin(a, b, k):
    h = np.clip(0.5 + 0.5 * (b - a) / k, 0, 1)
    return b * (1 - h) + a * h - k * h * (1 - h)


def smax(a, b, k):
    return -smin(-a, -b, k)


def sd_round_box(px, py, pz, cx, cy, cz, hx, hy, hz, r):
    qx = np.abs(px - cx) - (hx - r)
    qy = np.abs(py - cy) - (hy - r)
    qz = np.abs(pz - cz) - (hz - r)
    out = np.sqrt(np.maximum(qx, 0) ** 2 + np.maximum(qy, 0) ** 2 + np.maximum(qz, 0) ** 2)
    return out + np.minimum(np.maximum(np.maximum(qx, qy), qz), 0) - r


def sd_rrect2(x, y, hx, hy, r):
    qx = np.abs(x) - hx + r
    qy = np.abs(y) - hy + r
    return np.sqrt(np.maximum(qx, 0) ** 2 + np.maximum(qy, 0) ** 2) + np.minimum(np.maximum(qx, qy), 0) - r


# ============================================================ scene (units: mm, world y up, desk at y=0, camera toward +z)

class Scene:
    """Generic, unbranded terminal modelled on the Philips Minitel 2: charcoal box, front
    bezel with a deep asymmetric screen recess (wider right bezel with a red power LED),
    two moulded grooves along the top of the bezel, a raised hump on top, side vents, and
    a pull-out keyboard tray with light grey keys under the screen."""

    def __init__(self):
        self.tilt = math.radians(4.0)          # face leans back slightly
        self.S = np.array([0.0, 160.0, 0.0])  # centre of the bezel opening, on the face plane
        c, s = math.cos(self.tilt), math.sin(self.tilt)
        self.ex = np.array([1.0, 0.0, 0.0])
        self.ey = np.array([0.0, c, -s])       # up along the face
        self.ez = np.array([0.0, s, c])        # face normal
        # case box (world): centre, half sizes, edge radius
        self.case = (0.0, 134.0, -130.0, 133.0, 134.0, 172.0, 9.0)   # ~square front
        self.case_top = 268.0
        self.slot_y = 54.0                     # keyboard slot under the bezel
        # bezel opening (face-local): outer half size + radius, inner (glass) half size + radius
        self.open_out = (106.0, 81.0, 7.0)
        self.open_in = (90.0, 69.0, 13.0)
        self.in_c = (0.0, 1.5)                 # inner opening centre (left/right bezels equal)
        self.taper = 24.0
        self.hole_depth = 60.0
        # CRT faceplate: sphere apex depth and radius, glass thickness
        self.glass_apex = -21.0
        self.glass_R = 560.0
        self.glass_thick = 9.0
        # raster (phosphor image area) half size, face-local mm, centred on the inner opening
        self.raster = (78.0, 59.0)
        self.barrel = 0.035
        # power LED on the right bezel (face-local)
        right = self.case[0] + self.case[3] - self.S[0]
        self.led = (0.5 * (self.open_out[0] + right), -14.0)
        # keyboard tray (world)
        self.kb_x = 127.0
        self.kb_z0, self.kb_z1 = -80.0, 132.0
        self.kb_h_back, self.kb_h_front = 46.0, 33.0   # top height at z=0 and at the front
        self.key_h = 5.5
        self._build_keys()

    # ---------- face-local transform
    def to_local(self, px, py, pz):
        dx, dy, dz = px - self.S[0], py - self.S[1], pz - self.S[2]
        return dx, dy * self.ey[1] + dz * self.ey[2], dy * self.ez[1] + dz * self.ez[2]

    def vec_to_world(self, vx, vy, vz):
        return (vx * self.ex[0] + vy * self.ey[0] + vz * self.ez[0],
                vx * self.ex[1] + vy * self.ey[1] + vz * self.ez[1],
                vx * self.ex[2] + vy * self.ey[2] + vz * self.ez[2])

    def local_to_world(self, lx, ly, lz):
        wx, wy, wz = self.vec_to_world(lx, ly, lz)
        return wx + self.S[0], wy + self.S[1], wz + self.S[2]

    # ---------- keyboard layout (tray top coordinates: x, z), Minitel 2 style
    def _build_keys(self):
        pz = 14.5
        z0 = 9.0
        keys = []   # (x, z, half_x, half_z, label, colour)  colour: 0 grey, 1 green, 2 dark
        fn = [("Sommaire", "Annulation", "Retour", "Répétition"), ("Guide", "Correction", "Suite", "Envoi")]
        for i in range(2):
            for j in range(4):
                lab = fn[i][j]
                keys.append((-58.0 + j * 28.0, z0 + i * pz, 12.6, 5.6, lab, 1 if lab == "Envoi" else 0))
        keys.append((62.0, z0, 7.0, 5.6, "←", 2))       # power-ish keys, darker
        keys.append((90.0, z0, 7.0, 5.6, "↓", 2))
        keys.append((-114.0, z0 + pz, 9.5, 5.6, "Connexion Fin", 0))
        keys.append((-89.0, z0 + pz, 7.0, 5.6, "Fnct", 2))
        rows = [("<,;:?!\"'()-", 0.0), ("AZERTYUIOP", 5.0), ("QSDFGHJKLM", 8.5), ("WXCVBN.@", 12.0)]
        pad = ["123", "456", "789", "*0#"]
        for i, (labels, off) in enumerate(rows):
            zz = z0 + (i + 2) * pz
            for j, lab in enumerate(labels):
                keys.append((-114.0 + off + j * 15.0, zz, 6.4, 5.8, lab, 0))
            for j, lab in enumerate(pad[i]):
                keys.append((84.0 + j * 15.0, zz, 6.4, 5.8, lab, 0))
        zz = z0 + 6 * pz
        keys.append((-116.0, zz, 6.4, 5.8, "↑", 0))
        keys.append((-101.0, zz, 6.4, 5.8, "↓", 0))
        keys.append((-42.0, zz, 46.0, 5.8, "", 0))
        keys.append((22.0, zz, 6.4, 5.8, "←", 0))
        keys.append((37.0, zz, 6.4, 5.8, "→", 0))
        self.keys = np.array([k[:4] for k in keys], np.float64)
        self.key_labels = [k[4] for k in keys]
        self.key_color = np.array([k[5] for k in keys], np.int8)
        self.key_rows_z = z0 + pz * np.arange(7)
        self.row_keys, self.row_ids = [], []
        for i in range(7):
            sel = np.nonzero(np.abs(self.keys[:, 1] - self.key_rows_z[i]) < 1)[0]
            self.row_keys.append(self.keys[sel])
            self.row_ids.append(sel)

    def kb_top_y(self, pz):
        t = np.clip(pz / self.kb_z1, 0, 1)
        return self.kb_h_back + (self.kb_h_front - self.kb_h_back) * t

    # ---------- SDFs
    def sd_case(self, px, py, pz):
        cx, cy, cz, hx, hy, hz, r = self.case
        body = sd_round_box(px, py, pz, cx, cy, cz, hx, hy, hz, r)
        lx, ly, lz = self.to_local(px, py, pz)
        body = smax(body, lz, 2.5)                                  # front face (slightly tilted)
        # raised hump on top (tube housing), with a sloped front
        hump = sd_round_box(px, py, pz, 0.0, self.case_top, -205.0, 82.0, 13.0, 100.0, 7.0)
        hump = np.maximum(hump, (py - self.case_top - 11.0) * 0.8 + (pz + 108.0) * 0.6)
        body = smin(body, hump, 3.0)
        # moulded grooves along the top of the bezel and side vents
        top_l = (self.case_top - self.S[1]) / self.ey[1]
        gro = np.minimum(np.abs(ly - (top_l - 9.0)), np.abs(ly - (top_l - 14.0))) - 0.7
        gro = np.maximum(np.maximum(gro, lx - 30.0), -(lz + 0.9))
        body = np.maximum(body, -gro)
        vz = np.abs(((pz + 3.5) % 7.0) - 3.5) - 1.2
        vent = np.maximum(np.maximum(vz, np.abs(pz + 205.0) - 70.0),
                          np.maximum(np.abs(py - 150.0) - 70.0, -(np.abs(px) - hx + 2.5)))
        body = np.maximum(body, -vent)
        # keyboard slot under the bezel
        slot = np.maximum(np.maximum(np.abs(px) - (self.kb_x + 2.0), py - self.slot_y), -(pz + 90.0))
        body = smax(body, -slot, 1.5)
        # bezel opening: rounded-rect tunnel tapering from the face down to the glass
        t = np.clip(-lz / self.taper, 0, 1)
        t = t * (1.6 - 0.6 * t)
        ocx, ocy = self.in_c[0] * t, self.in_c[1] * t
        hx2 = self.open_out[0] + (self.open_in[0] - self.open_out[0]) * t
        hy2 = self.open_out[1] + (self.open_in[1] - self.open_out[1]) * t
        rr = self.open_out[2] + (self.open_in[2] - self.open_out[2]) * t
        d2 = sd_rrect2(lx - ocx, ly - ocy, hx2, hy2, rr)
        hole = np.maximum(d2 * 0.75, -(lz + self.hole_depth))
        case = smax(body, -hole, 1.6)
        # power LED: small lens slightly proud of the bezel
        led = np.maximum(sd_rrect2(lx - self.led[0], ly - self.led[1], 1.6, 3.2, 0.8), np.abs(lz - 0.3) - 0.6)
        return np.minimum(case, led)

    def sd_glass(self, px, py, pz):
        lx, ly, lz = self.to_local(px, py, pz)
        R = self.glass_R
        cz = self.glass_apex - R
        gx, gy = lx - self.in_c[0], ly - self.in_c[1]
        sph = np.sqrt(gx * gx + gy * gy + (lz - cz) ** 2) - R
        lim = sd_rrect2(gx, gy, self.open_in[0] + 3.0, self.open_in[1] + 3.0, self.open_in[2])
        return np.maximum(np.maximum(sph, lim), -(lz + self.hole_depth))

    def sd_keyboard(self, px, py, pz):
        kx = self.kb_x
        top = self.kb_top_y(pz)
        slab = sd_round_box(px, py, pz, 0.0, 30.0, 0.5 * (self.kb_z0 + self.kb_z1),
                            kx, 30.0, 0.5 * (self.kb_z1 - self.kb_z0), 4.0)
        slope = (self.kb_h_front - self.kb_h_back) / self.kb_z1
        topd = (py - top) / math.sqrt(1 + slope * slope)
        slab = smax(slab, topd, 2.0)
        # front lip chamfer
        lip = (py - (self.kb_h_front + 2.0)) * 0.6 + (pz - (self.kb_z1 - 14.0)) * 0.8
        slab = smax(slab, lip, 2.0)
        return slab

    def _key_index(self, px, pz):
        rz = self.key_rows_z
        ri = np.clip(np.round((pz - rz[0]) / (rz[1] - rz[0])), 0, len(rz) - 1).astype(np.int32)
        kid = np.zeros(px.shape, np.int32)
        for i, tab in enumerate(self.row_keys):
            m = ri == i
            if not m.any():
                continue
            dx = np.maximum(np.abs(px[m][:, None] - tab[None, :, 0]) - tab[None, :, 2], 0)
            kid[m] = self.row_ids[i][np.argmin(dx, 1)]
        return kid

    def sd_keys(self, px, py, pz):
        top = self.kb_top_y(pz) - 2.0
        qy = (py - top) - self.key_h * 0.5
        k = self.keys[self._key_index(px, pz)]
        side = 0.16 * np.clip(-qy + self.key_h * 0.5, 0, 6)  # keys flare toward the base
        return sd_round_box(px, qy, pz, k[:, 0], 0.0, k[:, 1], k[:, 2] - 0.9 + side, self.key_h * 0.5,
                            k[:, 3] - 0.9 + side, 1.5)

    def _keys_masked(self, px, py, pz):
        out = np.full(px.shape, 1e4, F)
        m = (py < self.kb_h_back + 12) & (pz > self.key_rows_z[0] - 10) & (pz < self.key_rows_z[-1] + 10)
        if m.any():
            out[m] = self.sd_keys(px[m], py[m], pz[m])
        # outside the key block: distance to its bounding box (a conservative lower bound)
        rz = self.key_rows_z
        bound = np.maximum(np.maximum(py - (self.kb_h_back + 4.0), np.abs(px) - self.kb_x),
                           np.maximum(rz[0] - 8.0 - pz, pz - rz[-1] - 8.0))
        return np.where(m, out, np.maximum(bound, 0.5))

    def sdf(self, px, py, pz):
        d = np.minimum(self.sd_case(px, py, pz), self.sd_glass(px, py, pz))
        # keyboard only evaluated near it; elsewhere use the distance to that region (conservative)
        ylim, zlim, xlim = self.slot_y + 12, self.kb_z0 - 10, self.kb_x + 10
        bound = np.maximum(np.maximum(py - ylim, zlim - pz), np.abs(px) - xlim)
        near_kb = bound < 0
        d = np.where(near_kb, d, np.minimum(d, bound + 0.5))
        if near_kb.any():
            sub = (px[near_kb], py[near_kb], pz[near_kb])
            dk = np.minimum(self.sd_keyboard(*sub), self._keys_masked(*sub))
            d[near_kb] = np.minimum(d[near_kb], dk)
        return d

    def material(self, px, py, pz):
        dc = self.sd_case(px, py, pz)
        dg = self.sd_glass(px, py, pz)
        dk = self.sd_keyboard(px, py, pz)
        dkey = self._keys_masked(px, py, pz)
        mat = np.argmin(np.stack([dc, dg, dk, dkey]), 0) + 1  # 1 case, 2 glass, 3 tray, 4 key
        lx, ly, lz = self.to_local(px, py, pz)
        led = (mat == 1) & (np.abs(lx - self.led[0]) < 2.2) & (np.abs(ly - self.led[1]) < 3.8) & (lz > -0.5)
        mat[led] = 5
        return mat

    def bbox(self):
        hx = self.case[3] + 6
        return np.array([-hx, -1.0, -305.0]), np.array([hx, 285.0, self.kb_z1 + 2.0])


# ============================================================ lighting environment

class Light:
    def __init__(self, direction, color, intensity, half_w, half_h, softness, mullions=0, up=(0, 1, 0), diffuse=1.0):
        self.d = norm3(np.array(direction, float))
        u = np.array(up, float)
        self.t1 = norm3(np.cross(u, self.d)) if abs(np.dot(u, self.d)) < 0.99 else np.array([1.0, 0, 0])
        self.t2 = np.cross(self.d, self.t1)
        self.color = np.array(color, F) * intensity
        self.hw, self.hh, self.soft = half_w, half_h, softness
        self.mullions = mullions
        self.kd = diffuse

    def radiance(self, dirs, extra_soft=0.0):
        """Radiance seen along dirs (N,3) - a soft rectangle (window/softbox) in direction space."""
        cd = dirs @ self.d
        ok = cd > 0.05
        a = (dirs @ self.t1) / np.maximum(cd, 0.05)
        b = (dirs @ self.t2) / np.maximum(cd, 0.05)
        s = self.soft + extra_soft
        m = smoothstep(self.hw + s, self.hw - s, np.abs(a)) * smoothstep(self.hh + s, self.hh - s, np.abs(b))
        if self.mullions and extra_soft < 0.08:
            bar = 0.006 + s * 0.3
            mul = smoothstep(bar * 0.4, bar, np.abs(a)) * smoothstep(bar * 0.4, bar, np.abs(b - self.hh * 0.25))
            m = m * (0.35 + 0.65 * mul)
        # energy spreads when blurred
        area = (2 * self.hw) * (2 * self.hh)
        spread = area / ((2 * self.hw + 2 * extra_soft) * (2 * self.hh + 2 * extra_soft))
        return (m * ok * spread)[:, None] * self.color[None, :]

    def solid_angle(self):
        return 4 * self.hw * self.hh / (1 + self.hw ** 2 + self.hh ** 2) ** 1.5 * 1.0


STYLES = {
    # ambient sky/ground, lights, desk albedo, wall albedo, screen brightness, exposure
    "desk": dict(
        amb_top=(0.050, 0.052, 0.058), amb_bot=(0.020, 0.016, 0.012),
        lights=[dict(direction=(-0.75, 0.55, 0.55), color=(1.0, 1.0, 1.04), intensity=1.25,
                     half_w=0.42, half_h=0.36, softness=0.10, mullions=1),
                dict(direction=(0.35, 0.92, 0.35), color=(1.05, 0.92, 0.80), intensity=0.5,
                     half_w=0.28, half_h=0.28, softness=0.18),
                # second window behind the photographer: mostly seen as a reflection on the glass
                dict(direction=(-0.30, 0.17, 0.94), color=(0.95, 1.0, 1.06), intensity=3.0,
                     half_w=0.10, half_h=0.075, softness=0.02, mullions=1, diffuse=0.02),
                # the lit room behind the photographer: broad, dim, seen only in reflections
                dict(direction=(0.15, 0.25, 1.0), color=(1.0, 0.96, 0.9), intensity=0.35,
                     half_w=0.9, half_h=0.35, softness=0.35, diffuse=0.0)],
        desk=(0.17, 0.10, 0.058), desk_gloss=0.05, wall=(0.30, 0.29, 0.27), screen=1.25, exposure=1.0,
        wall_z=-760.0),
    "night": dict(
        amb_top=(0.004, 0.005, 0.008), amb_bot=(0.002, 0.002, 0.002),
        lights=[dict(direction=(0.7, 0.45, 0.4), color=(1.0, 0.75, 0.5), intensity=0.22,
                     half_w=0.12, half_h=0.12, softness=0.1)],
        desk=(0.15, 0.09, 0.05), desk_gloss=0.07, wall=(0.22, 0.22, 0.24), screen=2.0, exposure=1.7,
        wall_z=-760.0),
    "studio": dict(
        amb_top=(0.06, 0.06, 0.065), amb_bot=(0.03, 0.03, 0.03),
        lights=[dict(direction=(-0.55, 0.75, 0.45), color=(1.0, 1.0, 1.0), intensity=1.1,
                     half_w=0.5, half_h=0.5, softness=0.08),
                dict(direction=(0.9, 0.25, -0.35), color=(0.9, 0.95, 1.0), intensity=0.9,
                     half_w=0.1, half_h=0.5, softness=0.05)],
        desk=(0.32, 0.32, 0.33), desk_gloss=0.04, wall=(0.32, 0.32, 0.33), screen=2.0, exposure=1.0,
        wall_z=-900.0, seamless=True),
}


class Env:
    def __init__(self, style):
        self.st = style
        self.lights = [Light(**ld) for ld in style["lights"]]
        self.amb_top = np.array(style["amb_top"], F)
        self.amb_bot = np.array(style["amb_bot"], F)

    def ambient(self, n):
        t = np.clip(n[:, 1:2] * 0.5 + 0.5, 0, 1)
        return self.amb_bot[None] + (self.amb_top - self.amb_bot)[None] * t

    def radiance(self, dirs, soft=0.0):
        out = self.ambient(dirs) * 1.4
        for L in self.lights:
            out = out + L.radiance(dirs, soft)
        return out

    def diffuse(self, n, shadow=None):
        out = self.ambient(n) * 3.0
        for i, L in enumerate(self.lights):
            nl = np.clip(n @ L.d, 0, 1)
            sh = shadow if (shadow is not None and i == 0) else 1.0
            out = out + (nl * sh * L.kd)[:, None] * L.color[None] * (L.hw * L.hh * 2.2)
        return out


# ============================================================ camera

class Camera:
    FRAMINGS = ("full", "front", "screen")

    def __init__(self, scene, W, H, angle_deg=0.0, elev_deg=None, framing="full", zoom=1.0, dist=1300.0):
        self.W, self.H = W, H
        sc = scene
        if elev_deg is None:
            elev_deg = 13.0 if angle_deg == 0 else 17.0
        az, el = math.radians(angle_deg), math.radians(elev_deg)
        target = np.array([0.0, 150.0, 20.0]) if framing == "full" else sc.S + sc.ey * -12.0
        d = np.array([math.sin(az) * math.cos(el), math.sin(el), math.cos(az) * math.cos(el)])
        self.pos = target + d * dist
        self.fwd = norm3(target - self.pos)
        self.right = norm3(np.cross(self.fwd, [0.0, 1.0, 0.0]))
        self.up = np.cross(self.right, self.fwd)
        self.dist = dist
        # framing: fit points with a shift lens (keeps verticals vertical)
        cx0, hx = sc.case[0], sc.case[3]
        top_l = (sc.case_top - sc.S[1]) / sc.ey[1]
        if framing == "screen":
            pts = [sc.local_to_world(x, y, 0.0) for x in (-128, 128) for y in (-98, 96)]
            fill = 0.98
        elif framing == "front":
            pts = [sc.local_to_world(x - sc.S[0], y, 0.0) for x in (-hx - 4, hx + 4) for y in (-118, top_l + 4)]
            fill = 0.99
        else:
            pts = [(x, y, z) for x in (-hx, hx) for (y, z) in ((sc.case_top, 0.0), (sc.case_top + 13, -110.0),
                                                              (0.0, sc.kb_z1), (sc.kb_h_front, sc.kb_z1))]
            fill = 0.90
        P = np.array(pts, float) - self.pos
        cx = P @ self.right
        cy = P @ self.up
        cz = P @ self.fwd
        tx, ty = cx / cz, cy / cz
        aspect = W / H
        half_w = max((tx.max() - tx.min()) / 2, (ty.max() - ty.min()) / 2 * aspect) / fill / zoom
        self.tan_x = half_w
        self.tan_y = half_w / aspect
        self.off_x = (tx.max() + tx.min()) / 2
        self.off_y = (ty.max() + ty.min()) / 2
        self.f_px = (W / 2) / self.tan_x

    def rays(self, xs, ys):
        """Ray directions (N,3) for pixel centres xs, ys."""
        ndx = ((xs + 0.5) / self.W * 2 - 1) * self.tan_x + self.off_x
        ndy = (1 - (ys + 0.5) / self.H * 2) * self.tan_y + self.off_y
        d = (self.fwd[None] + ndx[:, None] * self.right[None] + ndy[:, None] * self.up[None])
        return norm3(d).astype(F)

    def project(self, P):
        Q = P - self.pos
        cx, cy, cz = Q @ self.right, Q @ self.up, Q @ self.fwd
        tx, ty = cx / cz - self.off_x, cy / cz - self.off_y
        return (tx / self.tan_x + 1) / 2 * self.W - 0.5, (1 - ty / self.tan_y) / 2 * self.H - 0.5, cz


# ============================================================ ray marching

def march(scene, ro, rd, t0, t1, max_steps=140, log=None):
    n = rd.shape[0]
    t = t0.astype(F).copy()
    hit = np.zeros(n, bool)
    active = np.nonzero(t0 < t1)[0]
    step = 0
    while active.size and step < max_steps:
        p = ro[None, :] + rd[active] * t[active, None]
        d = scene.sdf(p[:, 0], p[:, 1], p[:, 2]).astype(F)
        eps = 0.02 + t[active] * 0.00012
        h = d < eps
        hit[active[h]] = True
        t[active] += np.where(h, 0, d * 0.92)
        keep = (~h) & (t[active] < t1[active])
        active = active[keep]
        step += 1
    return t, hit


_JOB = None  # (scene, ro, rd, t0, t1), inherited by forked workers (no pickling of rays)


def _trace_chunk(c):
    """Worker: march a chunk of rays, then material, normal and AO at the hits."""
    sc, ro, rd, t0, t1 = _JOB
    rd, t0, t1 = rd[c], t0[c], t1[c]
    t, hit = march(sc, ro, rd, t0, t1)
    n = rd.shape[0]
    mat = np.zeros(n, np.int8)
    nrm = np.zeros((n, 3), F)
    ao = np.ones(n, F)
    hi = np.nonzero(hit)[0]
    if hi.size:
        P = ro[None] + rd[hi] * t[hi, None]
        mat[hi] = sc.material(P[:, 0], P[:, 1], P[:, 2])
        nn = sdf_normal(sc, P)
        nrm[hi] = nn
        ao[hi] = ambient_occlusion(sc, P, nn)
    return t, hit, mat, nrm, ao


def parallel_trace(sc, ro, rd, t0, t1, workers):
    """Ray-march only the rays that need it (finite t0), split across forked processes."""
    n = rd.shape[0]
    t = t0.copy()
    hit = np.zeros(n, bool)
    mat = np.zeros(n, np.int8)
    nrm = np.zeros((n, 3), F)
    ao = np.ones(n, F)
    todo = np.nonzero(np.isfinite(t0) & (t0 < t1))[0]
    if todo.size == 0:
        return t, hit, mat, nrm, ao
    # interleave so every chunk gets a similar mix of easy and hard rays
    nchunks = max(1, workers * 3)
    chunks = [todo[k::nchunks] for k in range(nchunks)]
    global _JOB
    _JOB = (sc, ro, rd, t0, t1)
    results = None
    if workers > 1:
        try:
            import multiprocessing as mp
            with mp.get_context("fork").Pool(workers) as pool:
                results = pool.map(_trace_chunk, chunks, chunksize=1)
        except (OSError, ValueError, ImportError):
            results = None
    if results is None:
        results = [_trace_chunk(c) for c in chunks]
    _JOB = None
    for c, (tc, hc, mc, nc, ac) in zip(chunks, results):
        t[c], hit[c], mat[c], nrm[c], ao[c] = tc, hc, mc, nc, ac
    return t, hit, mat, nrm, ao


def soft_shadow(scene, P, L, k=10.0, steps=40):
    res = np.ones(P.shape[0], F)
    t = np.full(P.shape[0], 2.0, F)
    act = np.arange(P.shape[0])
    for _ in range(steps):
        if act.size == 0:
            break
        q = P[act] + L[None] * t[act, None]
        d = scene.sdf(q[:, 0], q[:, 1], q[:, 2])
        res[act] = np.minimum(res[act], k * d / t[act])
        t[act] += np.clip(d, 1.0, 40.0)
        keep = (res[act] > 0.001) & (t[act] < 900)
        act = act[keep]
    return np.clip(res, 0, 1)


def sdf_normal(scene, P, e=0.12):
    k = np.array([[1, -1, -1], [-1, -1, 1], [-1, 1, -1], [1, 1, 1]], F)
    n = np.zeros_like(P)
    for v in k:
        q = P + v[None] * e
        n += v[None] * scene.sdf(q[:, 0], q[:, 1], q[:, 2])[:, None]
    return norm3(n)


def ambient_occlusion(scene, P, N, scale=1.0):
    occ = np.zeros(P.shape[0], F)
    w = 1.0
    for h in (1.5, 4.0, 8.0, 14.0, 24.0):
        h = h * scale
        q = P + N * h
        d = scene.sdf(q[:, 0], q[:, 1], q[:, 2])
        occ += w * np.clip(h - d, 0, None) / h
        w *= 0.7
    return np.clip(1 - occ * 0.42, 0, 1)


# ============================================================ CRT phosphor texture

def phosphor_texture(scr, tex_w, tex_h, line_px, dh_up=True, bright=1.0, blink_on=True):
    """Emission image of the raster area (+ margin) with beam spot, scanlines and halation.
    Returns (tex, margin_x_frac, margin_y_frac)."""
    D, cw = render_dots(scr, dh_up=dh_up, blink_on=blink_on)
    nl, nd = D.shape
    # margins so halation can spill past the raster edges
    mx, my = int(nd * 0.06), int(nl * 0.06)
    Dp = np.zeros((nl + 2 * my, nd + 2 * mx), F)
    Dp[my:my + nl, mx:mx + nd] = D
    NL, ND = Dp.shape
    tw = int(tex_w * ND / nd)
    th = int(tex_h * NL / nl)
    # horizontal: video bandwidth (gaussian of ~0.25 of a 40-col dot), dot = box
    dot_w40 = nd / (320.0 if cw == 8 else 480.0) * (480.0 / 320.0 if cw == 6 else 1.0)
    sig = 0.15 if cw == 8 else 0.13   # gaussian sigma in dots: crisp, Minitel video is sharp
    xs = (np.arange(tw) + 0.5) / tw * ND
    k = np.arange(ND)
    def Phi(z):
        return 0.5 * (1 + _erf(z / math.sqrt(2)))
    # sparse-ish band: compute dense but only within +-4 dots
    Hm = np.zeros((ND, tw), F)
    for j0 in range(0, tw, 512):
        xx = xs[j0:j0 + 512]
        Z1 = (xx[None, :] - k[:, None]) / sig
        Z0 = (xx[None, :] - k[:, None] - 1) / sig
        band = np.abs(xx[None, :] - k[:, None] - 0.5) < 5
        vals = np.where(band, Phi(np.where(band, Z1, 0)) - Phi(np.where(band, Z0, 0)), 0)
        Hm[:, j0:j0 + 512] = vals
    L = Dp @ Hm  # (NL, tw)
    # video amplifier peaking (aperture correction): crisper dot edges, as on real monitors
    kx = tw / ND  # texels per dot
    L = np.maximum(L + 0.45 * (L - gblur(L, kx * 0.6)), 0)
    # vertical: gaussian beam per scan line; faint gaps, beam widens when bright
    ys = (np.arange(th) + 0.5) / th * NL
    jj = np.arange(NL) + 0.5
    # suppress scanline modulation when a line is under ~3.5 output px (avoid moire)
    vis = float(np.clip((line_px - 2.6) / 3.0, 0, 1))
    def vmat(sv):
        V = np.exp(-((ys[:, None] - jj[None, :]) ** 2) / (2 * sv * sv)) / (math.sqrt(2 * math.pi) * sv)
        return V.astype(F)
    T_thin = vmat(0.31 + (1 - vis) * 0.05) @ L
    T_fat = vmat(0.35 + (1 - vis) * 0.04) @ L
    b = 0.3 * np.clip(T_fat, 0, 1) ** 2
    T = T_thin * (1 - b) + T_fat * b
    T *= bright
    margin = (mx / ND, my / NL)
    return T.astype(F), margin, (ND, NL)


# ============================================================ renderer

def _erf(x):
    try:
        from scipy.special import erf
        return erf(x)
    except ImportError:  # Abramowitz-Stegun 7.1.26
        sgn = np.sign(x)
        x = np.abs(x)
        t = 1 / (1 + 0.3275911 * x)
        y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * np.exp(-x * x)
        return sgn * y


def parse_size(s):
    presets = {"4k": (3840, 2880), "4K": (3840, 2880), "uhd": (3840, 2160), "hd": (1920, 1440), "1080p": (1920, 1080)}
    if s in presets:
        return presets[s]
    w, h = s.lower().split("x")
    return int(w), int(h)


P4 = np.array([0.80, 0.92, 1.0], F)   # P4 white phosphor, slightly blue
TRANS = 0.62                            # tinted faceplate transmission (one way)


class ScreenTexture:
    """Phosphor emission of one screen state, sampled at raster coordinates."""

    def __init__(self, scr, sc, rw_px, dh_up=True, blink_on=True):
        nd_dots = scr.cols * (8 if scr.cols <= 40 else 6)
        tex_w = int(np.clip(max(rw_px * 2.0, nd_dots * 4), 480, 6400))
        tex_h = int(tex_w * sc.raster[1] / sc.raster[0])
        line_px = rw_px * sc.raster[1] / sc.raster[0] / (scr.rows * CELL_H)
        T, (self.mfx, self.mfy), (ND, NL) = phosphor_texture(scr, tex_w, tex_h, line_px, dh_up=dh_up,
                                                             blink_on=blink_on)
        self.T = T
        self.th, self.tw = T.shape
        self.px_per_dot = rw_px / nd_dots
        # halation in the faceplate glass: tight and gentle (keeps inverse video readable)
        small = resize(T, max(32, self.tw // 4), max(32, self.th // 4))
        mm_per_tex = (2 * sc.raster[0]) / (self.tw * (1 - 2 * self.mfx)) * 4
        halo = (gblur(small, 0.8 / mm_per_tex) * 0.018 + gblur(small, 3.5 / mm_per_tex) * 0.014
                + gblur(small, 12.0 / mm_per_tex) * 0.012)
        self.halo = resize(halo, self.tw, self.th)
        self.soft = gblur(T, max(0.8, self.tw / ND * 0.35))   # defocused beam toward the edges

    def to_tex(self, xc, yc):
        u = (xc * 0.5 + 0.5) * (1 - 2 * self.mfx) + self.mfx
        v = (yc * 0.5 + 0.5) * (1 - 2 * self.mfy) + self.mfy
        return u * self.tw - 0.5, v * self.th - 0.5

    def emission(self, subs, xc, yc, brightness):
        """subs: list of (xc, yc) sub-pixel samples; returns linear emission per pixel."""
        e_sharp = np.zeros(xc.size, F)
        for xs_, ys_ in subs:
            # averaged in perceptual (sqrt) space: 1-dot dark strokes of inverse video stay
            # as readable as bright strokes once gamma-encoded
            e_sharp += np.sqrt(np.maximum(sample(self.T, *self.to_tex(xs_, ys_)), 0)) / len(subs)
        e_sharp = e_sharp * e_sharp
        sx, sy = self.to_tex(xc, yc)
        e_soft = sample(self.soft, sx, sy)
        e_halo = sample(self.halo, sx, sy)
        r2 = np.clip(xc * xc * 0.6 + yc * yc * 0.4, 0, 2)
        defocus = np.clip(r2 * 0.5, 0, 0.4)
        e = e_sharp * (1 - defocus) + e_soft * defocus
        e = e * (1 - 0.12 * r2) + e_halo          # brightness falls off toward the corners
        return (e * brightness).astype(F)


def finish(img, emis, st, rng, grain, exposure_scale=1.0):
    """Lens (bloom, vignetting), filmic tone map, sRGB, optical softness and grain -> uint8."""
    H, W = img.shape[:2]
    scale = W / 1920.0
    glow_src = np.maximum(img - 0.9, 0) * 0.5 + emis[..., None] * P4[None, None] * 0.03
    small = resize(glow_src, max(8, W // 4), max(8, H // 4))
    bloom = gblur(small, 3 * scale) * 0.05 + gblur(small, 12 * scale) * 0.06 + gblur(small, 40 * scale) * 0.06
    img = img + resize(bloom, W, H) * st["exposure"]
    yy, xx = np.mgrid[0:H, 0:W].astype(F)
    rr = ((xx - W / 2) / (W / 2)) ** 2 * 0.8 + ((yy - H / 2) / (H / 2)) ** 2 * 0.6
    img = img * (1 - 0.30 * rr ** 1.2)[..., None]
    x = img * st["exposure"] * 1.25 * exposure_scale
    a, b, c_, d_, e_ = 2.51, 0.03, 2.43, 0.59, 0.14
    x = np.clip((x * (a * x + b)) / (x * (c_ * x + d_) + e_), 0, 1)
    srgb = np.where(x <= 0.0031308, 12.92 * x, 1.055 * np.power(np.maximum(x, 1e-8), 1 / 2.4) - 0.055)
    srgb = gblur(srgb.astype(F), 0.30 * max(1.0, scale))  # optical softness / silhouette AA
    if grain > 0:
        lum = srgb.mean(-1, keepdims=True)
        g = rng.standard_normal((H, W), dtype=F)
        gc = rng.standard_normal((H, W, 3), dtype=F)
        g = gblur(g, 0.6 * max(1, scale))[..., None] * 2.2
        srgb = srgb + (g * 0.010 + gc * 0.0035) * (0.35 + 0.65 * np.sqrt(np.clip(1 - lum, 0, 1))) * grain
    return (np.clip(srgb, 0, 1) * 255 + rng.random((H, W, 3), dtype=F) - 0.5).clip(0, 255).astype(np.uint8)


class PhotoRenderer:
    """Photo of the terminal. prepare() ray-traces and shades everything that does not depend
    on the screen content (once); frame() re-shades only the CRT glass for a screen state."""

    def __init__(self, W=1920, H=1440, angle=0.0, elev=None, style="desk", framing="full", zoom=1.0,
                 aperture=None, dh_up=True, verbose=True, workers=None):
        self.W, self.H = W, H
        self.style, self.framing, self.aperture, self.dh_up = style, framing, aperture, dh_up
        self.verbose = verbose
        self.workers = workers if workers is not None else min(12, os.cpu_count() or 1)
        self.st = STYLES[style]
        self.sc = Scene()
        self.env = Env(self.st)
        self.cam = Camera(self.sc, W, H, angle_deg=angle, elev_deg=elev, framing=framing, zoom=zoom)
        self.t_start = time.time()
        self._tex_cache = {}

    def log(self, msg):
        if self.verbose:
            print(f"  [{time.time() - self.t_start:5.2f}s] {msg}", file=sys.stderr)

    def prepare(self, scr):
        """Trace the scene and shade the static parts. scr sets the screen's light spill."""
        W, H, st, sc, env, cam = self.W, self.H, self.st, self.sc, self.env, self.cam
        workers, dh_up, framing, aperture = self.workers, self.dh_up, self.framing, self.aperture
        log = self.log
        # ---------------- primary rays
        ys, xs = np.mgrid[0:H, 0:W]
        xs = xs.reshape(-1).astype(F)
        ys = ys.reshape(-1).astype(F)
        rd = cam.rays(xs, ys)
        ro = cam.pos.astype(F)
        N = rd.shape[0]
        # background planes: desk (y=0), wall (z=wall_z)
        with np.errstate(divide="ignore", invalid="ignore"):
            t_desk = np.where(rd[:, 1] < -1e-6, -ro[1] / rd[:, 1], np.inf).astype(F)
            t_wall = np.where(rd[:, 2] < -1e-6, (st["wall_z"] - ro[2]) / rd[:, 2], np.inf).astype(F)
        # bbox entry/exit
        bmin, bmax = sc.bbox()
        with np.errstate(divide="ignore", invalid="ignore"):
            inv = 1.0 / rd
            ta = (bmin[None] - ro[None]) * inv
            tb = (bmax[None] - ro[None]) * inv
        tmin = np.nanmax(np.minimum(ta, tb), 1)
        tmax = np.nanmin(np.maximum(ta, tb), 1)
        tbg = np.minimum(t_desk, t_wall)
        t0 = np.maximum(tmin, 0).astype(F)
        t1 = np.minimum(tmax, tbg).astype(F)
        t0[tmax < tmin] = np.inf
        # analytic fast path: flat front face and the spherical glass away from any edge
        fast, t_fast, mat_fast, n_fast = analytic_hits(sc, ro, rd)
        fast &= t_fast < t1
        t0[fast] = np.inf
        t, hit, g_mat, g_nrm, g_ao = parallel_trace(sc, ro, rd, t0, t1, workers)
        log(f"analytic {fast.sum()} rays, marched {np.isfinite(t0).sum()}, hit {hit.sum()}")
        marched_hit = hit.copy()
        t[fast] = t_fast[fast]
        hit |= fast

        color = np.zeros((N, 3), F)
        depth = np.where(hit, t, tbg).astype(F)
        depth = np.where(np.isfinite(depth), depth, 5000).astype(F)
        emis_mask = np.zeros(N, F)  # screen emission (for bloom)

        idx = np.nonzero(hit)[0]
        P = ro[None] + rd[idx] * t[idx, None]
        mat = mat_fast[idx].astype(np.int64)
        Nrm = n_fast[idx]
        AO = np.ones(idx.size, F)
        mi = np.nonzero(marched_hit[idx])[0]
        if mi.size:
            src = idx[mi]
            mat[mi] = g_mat[src]
            Nrm[mi] = g_nrm[src]
            AO[mi] = g_ao[src]
        # glass: analytic inner shadow of the recess (consistent for fast and marched hits)
        gsel = np.nonzero(mat == 2)[0]
        if gsel.size:
            gx, gy, _ = sc.to_local(P[gsel, 0], P[gsel, 1], P[gsel, 2])
            dd = -sd_rrect2(gx - sc.in_c[0], gy - sc.in_c[1], sc.open_in[0], sc.open_in[1], sc.open_in[2])
            AO[gsel] = 1 - 0.75 * np.exp(-np.maximum(dd, 0) / 3.0) - 0.25 * np.exp(-np.maximum(dd, 0) / 14.0)
        log("g-buffer")
        V = -rd[idx]


        # ---------------- screen light spill (from the first screen state)
        D, cw = render_dots(scr, dh_up=dh_up)
        screen_avg = float(D.mean()) * st["screen"]
        self.screen_avg = screen_avg
        p4 = P4
        lc = np.array(sc.local_to_world(sc.in_c[0], sc.in_c[1], sc.glass_apex), F)

        def screen_light(Pw, Nw):
            Lv = lc[None] - Pw
            d2 = np.maximum(np.sum(Lv * Lv, 1), 400.0)
            Ld = Lv / np.sqrt(d2)[:, None]
            cos_s = np.clip(-(Ld @ sc.ez.astype(F)), 0, 1)
            cos_r = np.clip(np.sum(Nw * Ld, 1), 0, 1)
            area = 4 * sc.raster[0] * sc.raster[1]
            return (screen_avg * area * cos_s * cos_r / (math.pi * d2))[:, None] * p4[None]

        # ---------------- plastic (case, keyboard, keys)
        def shade_plastic(sel, albedo, rough, spec, bump=0.0):
            Pm, Nm, Vm, aom = P[sel], Nrm[sel], V[sel], AO[sel]
            if bump > 0:  # fine moulded texture
                nx = value_noise_2d(Pm[:, 0] + Pm[:, 2] * 0.7, Pm[:, 1] + Pm[:, 2] * 0.3, 0.7, 3)
                ny = value_noise_2d(Pm[:, 0] * 0.9 + 40, Pm[:, 1] - Pm[:, 2] * 0.5, 0.7, 4)
                Nm = norm3(Nm + bump * np.stack([nx, ny, nx * ny], 1).astype(F))
            alb = np.broadcast_to(np.asarray(albedo, F), (Pm.shape[0], 3)).copy()
            # large-scale tone variation (dust, wear)
            alb *= (1 + 0.10 * value_noise_2d(Pm[:, 0], Pm[:, 1] + Pm[:, 2], 40.0, 7))[:, None]
            diff = env.diffuse(Nm) * aom[:, None] + screen_light(Pm, Nm) * (0.6 + 0.4 * aom[:, None])
            R = Vm * 0 + (2 * np.sum(Nm * Vm, 1)[:, None] * Nm - Vm)
            R = norm3(R)
            cosv = np.clip(np.sum(Nm * Vm, 1), 0, 1)
            fres = spec + (1 - spec) * (1 - cosv) ** 5
            refl = env.radiance(R, soft=rough) * (fres * (0.35 + 0.65 * aom))[:, None]
            return alb * diff + refl * 0.9

        c = np.zeros((idx.size, 3), F)
        m_case = mat == 1
        m_kb = mat == 3
        m_key = mat == 4
        m_gl = mat == 2
        m_led = mat == 5
        case_alb = (0.060, 0.061, 0.066)   # charcoal grey ABS
        if m_case.any():
            Pm = P[m_case]
            lx, ly, lz = sc.to_local(Pm[:, 0], Pm[:, 1], Pm[:, 2])
            # bezel recess walls catch the glow of the screen
            recess = (smoothstep(-0.5, -4.0, lz) * (np.abs(lx) < sc.open_out[0] + 2)
                      * (np.abs(ly) < sc.open_out[1] + 2))
            col = shade_plastic(m_case, case_alb, 0.24, 0.04, bump=0.05)
            glow = screen_avg * 0.10 * smoothstep(-3, -sc.taper, lz) * recess
            col += glow[:, None] * p4[None] * case_alb[1] * 18
            c[m_case] = col
        if m_kb.any():
            c[m_kb] = shade_plastic(m_kb, case_alb, 0.26, 0.04, bump=0.05)
        if m_key.any():
            Pm = P[m_key]
            legend, kid = key_legends(sc, Pm, Nrm[m_key])
            kc = sc.key_color[kid]
            alb = np.empty((kid.size, 3), F)
            alb[:] = (0.34, 0.34, 0.325)                 # light grey key caps
            alb[kc == 1] = (0.06, 0.26, 0.10)            # green Envoi
            alb[kc == 2] = (0.08, 0.08, 0.085)           # dark keys
            ink = np.where((kc == 0)[:, None], np.array([[0.025, 0.025, 0.03]], F), np.array([[0.5, 0.5, 0.48]], F))
            alb = alb * (1 - legend[:, None]) + ink * legend[:, None]
            c[m_key] = shade_plastic(m_key, alb, 0.20, 0.045, bump=0.03)
        if m_led.any():
            c[m_led] = shade_plastic(m_led, (0.3, 0.02, 0.02), 0.05, 0.05) + np.array([2.2, 0.10, 0.05], F)[None]
        log("plastic")


        # ---------------- CRT glass: geometry and the content-independent terms
        self.glass_pix = None
        if m_gl.any():
            gi = np.nonzero(m_gl)[0]
            pix = idx[gi]
            Pl, nl, vl, cosi, xc, yc = glass_geom(sc, ro, rd[pix])
            lx, ly = Pl[:, 0], Pl[:, 1]
            nw = np.stack(sc.vec_to_world(nl[:, 0], nl[:, 1], nl[:, 2]), 1).astype(F)
            subs = []
            for dx, dy in ((-0.25, -0.25), (0.25, -0.25), (-0.25, 0.25), (0.25, 0.25)):
                rds = cam.rays(xs[pix] + dx, ys[pix] + dy)
                g = glass_geom(sc, ro, rds)
                subs.append((g[4], g[5]))
            irr = env.diffuse(nw) * AO[gi][:, None]
            phos_grey = np.array([0.080, 0.085, 0.082], F)
            inside = smoothstep(1.06, 1.0, np.abs(xc)) * smoothstep(1.06, 1.0, np.abs(yc))
            black = irr * phos_grey * TRANS * TRANS + (0.004 * inside * st["screen"])[:, None] * p4[None]
            black += screen_avg * 0.010 * p4[None] * TRANS        # internal light scatter
            Rl = 2 * cosi[:, None] * nl - vl
            Rw = norm3(np.stack(sc.vec_to_world(Rl[:, 0], Rl[:, 1], Rl[:, 2]), 1).astype(F))
            fres = 0.04 + 0.96 * (1 - cosi) ** 5
            refl = env.radiance(Rw, soft=0.015) * 0.85 + env.radiance(Rw, soft=0.25) * 0.15
            smudge = 1 + 0.15 * value_noise_2d(lx, ly, 9.0, 11) + 0.08 * value_noise_2d(lx, ly, 2.5, 12)
            refl = refl * (fres * np.clip(smudge, 0.4, 2))[:, None]
            aog = AO[gi][:, None]
            self.glass_pix, self.glass_subs, self.glass_xc, self.glass_yc = pix, subs, xc, yc
            self.glass_aog = (0.55 + 0.45 * aog).astype(F)
            self.glass_base = (black * self.glass_aog + refl * aog).astype(F)
            self.rw_px = raster_width_px(sc, cam)
            e = self._emission(scr, True)
            c[gi] = self.glass_base + e[:, None] * P4[None] * TRANS * self.glass_aog
        log("glass")
        color[idx] = c

        # ---------------- background: desk & wall (rendered at full res, blurred later by DOF)
        bg = np.nonzero(~hit)[0]
        if bg.size:
            tb_ = tbg[bg]
            Pb = ro[None] + rd[bg] * np.where(np.isfinite(tb_), tb_, 3000)[:, None]
            is_desk = (t_desk[bg] <= t_wall[bg]) & np.isfinite(t_desk[bg])
            cb = np.zeros((bg.size, 3), F)
            # desk
            di = np.nonzero(is_desk)[0]
            if di.size:
                Pd = Pb[di]
                nd_ = np.tile(np.array([[0, 1, 0]], F), (di.size, 1))
                # soft shadow + contact AO from the terminal (low-res, it is blurred anyway)
                shadow = lowres_desk_shadow(sc, env, cam, xs[bg][di], ys[bg][di], max(4, int(round(4 * W / 1920))))
                # wood: fine grain running front-to-back, a little figure, no banding
                grain_ = (value_noise_2d(Pd[:, 0] * 2.5, Pd[:, 2] * 0.04, 1.0, 21) * 0.5
                          + value_noise_2d(Pd[:, 0] * 0.08 + Pd[:, 2] * 0.01, Pd[:, 2] * 0.006, 1.0, 22) * 0.35)
                alb = np.array(st["desk"], F)[None] * (1 + 0.22 * grain_)[:, None]
                if st.get("seamless"):
                    alb = np.array(st["desk"], F)[None] * np.ones((di.size, 1), F)
                diff = env.diffuse(nd_, shadow=shadow[:, 0]) * shadow[:, 1:2]
                diff += screen_light(Pd, nd_)
                Rd = rd[bg][di] * np.array([1, -1, 1], F)
                cosv = np.clip(-rd[bg][di][:, 1], 0, 1)
                fres = st["desk_gloss"] + (1 - st["desk_gloss"]) * (1 - cosv) ** 5
                cb[di] = alb * diff + env.radiance(Rd, soft=0.3) * (fres * 0.5 * shadow[:, 1])[:, None]
            wi = np.nonzero(~is_desk)[0]
            if wi.size:
                Pw = Pb[wi]
                nw_ = np.tile(np.array([[0, 0, 1]], F), (wi.size, 1))
                alb = np.array(st["wall"], F)[None] * (1 + 0.04 * value_noise_2d(Pw[:, 0], Pw[:, 1], 80, 31))[:, None]
                grad = (1 - 0.35 * np.clip((Pw[:, 1] - 150) / 900, 0, 1))[:, None]
                if st.get("seamless"):
                    grad = (0.75 + 0.35 * np.clip(1 - Pw[:, 1] / 800, 0, 1))[:, None]
                wl = env.diffuse(nw_) * grad
                # pool of light from the window on the wall
                wl *= (1 + 0.6 * np.exp(-((Pw[:, 0] + 350) ** 2 + (Pw[:, 1] - 250) ** 2) / (2 * 380 ** 2)))[:, None]
                cb[wi] = alb * wl + screen_light(Pw, nw_) * alb * 0.6
            color[bg] = cb
        log("background")


        img = color.reshape(H, W, 3)
        depth = depth.reshape(H, W)
        # ---------------- depth of field (focus on the screen); the glass is re-shaded per frame
        f_dist = float(np.linalg.norm(lc - cam.pos))
        ap = aperture if aperture is not None else (14.0 if framing == "full" else 10.0)
        coc = ap * np.abs(depth - f_dist) / np.maximum(depth, 1) * cam.f_px / f_dist  # diameter, px
        self.static = depth_of_field(img, coc * 0.5, hit.reshape(H, W), scale=W / 1920.0).reshape(-1, 3)
        log("depth of field")

    def _emission(self, scr, blink_on):
        key = (id(scr), blink_on)
        if key not in self._tex_cache:
            if len(self._tex_cache) > 4:
                self._tex_cache.clear()
            tex = ScreenTexture(scr, self.sc, self.rw_px, dh_up=self.dh_up, blink_on=blink_on)
            self.log(f"phosphor texture {tex.tw}x{tex.th}, {tex.px_per_dot:.2f} px/dot")
            self._tex_cache[key] = tex.emission(self.glass_subs, self.glass_xc, self.glass_yc, self.st["screen"])
        return self._tex_cache[key]

    def frame(self, scr, blink_on=True, grain=1.0, seed=1):
        img = self.static.copy()
        emis = np.zeros(self.W * self.H, F)
        if self.glass_pix is not None:
            e = self._emission(scr, blink_on)
            img[self.glass_pix] = self.glass_base + e[:, None] * P4[None] * TRANS * self.glass_aog
            emis[self.glass_pix] = e * TRANS
        out = finish(img.reshape(self.H, self.W, 3), emis.reshape(self.H, self.W), self.st,
                     np.random.default_rng(seed), grain)
        self.log("post")
        return out


class ScreenOnlyRenderer:
    """Just the tube face, straight on: curved raster, glow, black level, rounded glass edge
    and a faint reflection, on black. No ray tracing: fast, suits GIFs."""

    def __init__(self, W=1280, H=960, style="desk", dh_up=True, verbose=True, margin=0.03):
        self.W, self.H, self.dh_up, self.verbose = W, H, dh_up, verbose
        self.st = STYLES[style]
        self.sc = sc = Scene()
        self.t_start = time.time()
        self._tex_cache = {}
        hx, hy = sc.open_in[0], sc.open_in[1]
        mm_per_px = max(2 * hx / (W * (1 - 2 * margin)), 2 * hy / (H * (1 - 2 * margin)))
        self.rw_px = 2 * sc.raster[0] / mm_per_px

        def coords(dx, dy):
            yy, xx = np.mgrid[0:H, 0:W].astype(F)
            lx = (xx + 0.5 + dx - W / 2) * mm_per_px
            ly = -(yy + 0.5 + dy - H / 2) * mm_per_px
            return lx.ravel(), ly.ravel()
        lx, ly = coords(0, 0)

        def raster(lx_, ly_):
            xn, yn = lx_ / sc.raster[0], -ly_ / sc.raster[1]
            return xn / (1 - sc.barrel * yn * yn), yn / (1 - sc.barrel * 0.8 * xn * xn)
        self.xc, self.yc = raster(lx, ly)
        self.subs = [raster(*coords(dx, dy)) for dx, dy in ((-0.25, -0.25), (0.25, -0.25), (-0.25, 0.25), (0.25, 0.25))]
        # glass edge (the bezel's inner lip) and its shadow, a reflection sheen, black level
        d = sd_rrect2(lx, ly, hx, hy, sc.open_in[2])
        self.mask = smoothstep(0.6, -0.6, d).astype(F)
        dd = np.maximum(-d, 0)
        ao = 1 - 0.75 * np.exp(-dd / 3.0) - 0.25 * np.exp(-dd / 14.0)
        self.aog = (0.55 + 0.45 * ao).astype(F)
        u, v = lx / hx, ly / hy
        sheen = 0.010 * np.exp(-((u + 0.55) ** 2 / 0.10 + (v - 0.55) ** 2 / 0.05)) + 0.004 * (v * 0.5 + 0.5)
        black = 0.010 + 0.004 * smoothstep(1.06, 1.0, np.abs(self.xc)) * smoothstep(1.06, 1.0, np.abs(self.yc))
        self.base = ((black * self.aog + sheen * ao)[:, None] * np.array([0.95, 1.0, 1.0], F)[None]).astype(F)

    def log(self, msg):
        if self.verbose:
            print(f"  [{time.time() - self.t_start:5.2f}s] {msg}", file=sys.stderr)

    def prepare(self, scr):
        pass

    def frame(self, scr, blink_on=True, grain=1.0, seed=1):
        key = (id(scr), blink_on)
        if key not in self._tex_cache:
            if len(self._tex_cache) > 4:
                self._tex_cache.clear()
            tex = ScreenTexture(scr, self.sc, self.rw_px, dh_up=self.dh_up, blink_on=blink_on)
            self._tex_cache[key] = tex.emission(self.subs, self.xc, self.yc, self.st["screen"])
        e = self._tex_cache[key] * self.mask
        img = (self.base + e[:, None] * P4[None] * TRANS * self.aog[:, None]) * self.mask[:, None]
        out = finish(img.reshape(self.H, self.W, 3).astype(F), (e * TRANS).reshape(self.H, self.W), self.st,
                     np.random.default_rng(seed), grain * 0.6, exposure_scale=1.0)
        self.log("frame")
        return out


def render(scr, W=1920, H=1440, angle=0.0, elev=None, style="desk", framing="full", zoom=1.0,
           aperture=None, dh_up=True, seed=1, grain=1.0, verbose=True, workers=None, blink_on=True):
    """One still: returns (uint8 HxWx3, seconds)."""
    t0 = time.time()
    r = PhotoRenderer(W, H, angle, elev, style, framing, zoom, aperture, dh_up, verbose, workers)
    r.prepare(scr)
    return r.frame(scr, blink_on=blink_on, grain=grain, seed=seed), time.time() - t0


def analytic_hits(sc, ro, rd):
    """Exact hits on the flat part of the front face and on the open part of the glass.
    Returns (mask, t, material, normal); rays outside the mask must be ray-marched."""
    n = rd.shape[0]
    lo = np.array(sc.to_local(*ro), float)
    ldx, ldy, ldz = sc.to_local(rd[:, 0] + sc.S[0], rd[:, 1] + sc.S[1], rd[:, 2] + sc.S[2])
    with np.errstate(divide="ignore", invalid="ignore"):
        tp = np.where(ldz < -1e-6, -lo[2] / ldz, np.inf).astype(F)
    px = lo[0] + ldx * tp
    py = lo[1] + ldy * tp
    mask = np.zeros(n, bool)
    t = np.full(n, np.inf, F)
    mat = np.zeros(n, np.int8)
    nrm = np.zeros((n, 3), F)
    # flat face: inside the face rectangle (margin), outside the opening, away from details
    cx, cy, cz, hx, hy, hz, r = sc.case
    top_l = (sc.case_top - sc.S[1]) / sc.ey[1]
    d_open = sd_rrect2(px, py, sc.open_out[0], sc.open_out[1], sc.open_out[2])
    wx = sc.S[0] + px
    wy = sc.S[1] + py * sc.ey[1]
    face = (np.isfinite(tp) & (np.abs(wx - cx) < hx - r - 4) & (py < top_l - 21) & (wy > sc.slot_y + 9)
            & (d_open > 4.0) & ((np.abs(px - sc.led[0]) > 6) | (np.abs(py - sc.led[1]) > 8)))
    mask |= face
    t[face] = tp[face]
    mat[face] = 1
    nrm[face] = sc.ez.astype(F)
    # glass: sphere hit, with the ray inside the inner opening at the face plane and at the glass
    R = sc.glass_R
    c = np.array([sc.in_c[0], sc.in_c[1], sc.glass_apex - R])
    oc = lo - c
    ld = np.stack([ldx, ldy, ldz], 1)
    b = ld @ oc
    cc = float(oc @ oc) - R * R
    disc = b * b - cc
    ok = (disc > 0) & np.isfinite(tp)
    ts = np.where(ok, -b - np.sqrt(np.maximum(disc, 0)), np.inf).astype(F)
    gx = lo[0] + ldx * ts
    gy = lo[1] + ldy * ts
    inner = sd_rrect2(gx - c[0], gy - c[1], sc.open_in[0], sc.open_in[1], sc.open_in[2])
    inner_p = sd_rrect2(px - c[0], py - c[1], sc.open_in[0], sc.open_in[1], sc.open_in[2])
    gl = ok & (inner < -2.5) & (inner_p < -2.5) & ~face
    mask |= gl
    t[gl] = ts[gl]
    mat[gl] = 2
    gz = lo[2] + ldz * ts
    nl = norm3(np.stack([gx - c[0], gy - c[1], gz - c[2]], 1)[gl])
    nrm[gl] = np.stack(sc.vec_to_world(nl[:, 0], nl[:, 1], nl[:, 2]), 1).astype(F)
    return mask, t, mat, nrm


def glass_geom(sc, ro, rd):
    """Sphere hit on the CRT face for rays rd (local frame), refraction through the faceplate
    and the raster coordinates (xc, yc in [-1, 1]) of the phosphor point seen."""
    lo = np.array(sc.to_local(*ro), float)
    ldx, ldy, ldz = sc.to_local(rd[:, 0] + sc.S[0], rd[:, 1] + sc.S[1], rd[:, 2] + sc.S[2])
    ld = np.stack([ldx, ldy, ldz], 1).astype(F)
    R = sc.glass_R
    c = np.array([sc.in_c[0], sc.in_c[1], sc.glass_apex - R])
    oc = (lo - c).astype(F)
    b = ld @ oc
    disc = np.maximum(b * b - (float(oc @ oc) - R * R), 0)
    t = -b - np.sqrt(disc)
    Pl = lo[None].astype(F) + ld * t[:, None]
    nl = (Pl - c[None].astype(F)) / R
    vl = -ld
    cosi = np.clip(np.sum(nl * vl, 1), 0, 1)
    eta = 1 / 1.52
    k = 1 - eta * eta * (1 - cosi * cosi)
    T = norm3(eta * ld + (eta * cosi - np.sqrt(np.maximum(k, 0)))[:, None] * nl)
    cos_t = np.clip(-np.sum(T * nl, 1), 0.2, 1)
    Q = Pl + T * (sc.glass_thick / cos_t)[:, None]
    xn = (Q[:, 0] - sc.in_c[0]) / sc.raster[0]
    yn = -(Q[:, 1] - sc.in_c[1]) / sc.raster[1]
    xc = xn / (1 - sc.barrel * yn * yn)        # barrel distortion of the deflection
    yc = yn / (1 - sc.barrel * 0.8 * xn * xn)
    return Pl, nl.astype(F), vl, cosi, xc.astype(F), yc.astype(F)


def raster_width_px(sc, cam):
    p0 = np.array(sc.local_to_world(sc.in_c[0] - sc.raster[0], sc.in_c[1], sc.glass_apex))
    p1 = np.array(sc.local_to_world(sc.in_c[0] + sc.raster[0], sc.in_c[1], sc.glass_apex))
    x0, _, _ = cam.project(p0[None])
    x1, _, _ = cam.project(p1[None])
    q0 = np.array(sc.local_to_world(0, -sc.raster[1], sc.glass_apex))
    q1 = np.array(sc.local_to_world(0, sc.raster[1], sc.glass_apex))
    _, y0, _ = cam.project(q0[None])
    _, y1, _ = cam.project(q1[None])
    return float(max(abs(x1 - x0)[0], abs(y1 - y0)[0] * sc.raster[0] / sc.raster[1]))


def key_legends(sc, P, Nrm):
    """Printed legend coverage (0..1) on key tops, and the key index of each point."""
    kid = sc._key_index(P[:, 0], P[:, 2])
    out = np.zeros(P.shape[0], F)
    top = Nrm[:, 1] > 0.85
    px, pz = P[:, 0], P[:, 2]
    for k in np.unique(kid[top]):
        lab = sc.key_labels[k]
        if not lab:
            continue
        kx, kz, hx, hz = sc.keys[k]
        m = np.nonzero(top & (kid == k))[0]
        lines = lab.split(" ") if " " in lab else [lab]
        if len(lab) == 1:
            dot = 0.55                       # mm per font dot: one big character
            lines = [lab]
        else:
            dot = min(0.36, (2 * hx - 2.6) / (6 * max(len(w) for w in lines)), (2 * hz - 2.0) / (10 * len(lines)))
        cwd = 8 if len(lab) == 1 else 6
        wmax = max(len(w) for w in lines) * cwd * dot
        ox = kx - wmax / 2
        oz = kz - len(lines) * 10 * dot / 2
        gx = np.floor((px[m] - ox) / dot).astype(int)
        gz = np.floor((pz[m] - oz) / dot).astype(int)
        li = gz // 10
        vals = np.zeros(m.size, F)
        for j, line in enumerate(lines):
            lx0 = (wmax - len(line) * cwd * dot) / 2 / dot
            gxx = gx - int(round(lx0))
            sel = (li == j) & (gxx >= 0) & (gxx < cwd * len(line))
            if not sel.any():
                continue
            ci = gxx[sel] // cwd
            si = np.nonzero(sel)[0]
            for q in np.unique(ci):
                gg = glyph_for(line[q])
                if cwd == 6:
                    gg = gg[:, 1:7]
                s2 = si[ci == q]
                vals[s2] = gg[gz[s2] - j * 10, gxx[s2] - q * cwd]
        out[m] = vals * 0.92
    return out, kid


def lowres_desk_shadow(sc, env, cam, xs, ys, f):
    """Soft shadow (key light) and contact occlusion on the desk, computed on a 1/f
    camera grid and bilinearly interpolated (the desk is blurred by depth of field anyway).
    Returns (N, 2): shadow, occlusion for full-res pixels xs, ys."""
    W, H = cam.W, cam.H
    w, h = W // f + 2, H // f + 2
    gy, gx = np.mgrid[0:h, 0:w]
    rd = cam.rays((gx.ravel() * f + (f - 1) / 2).astype(F), (gy.ravel() * f + (f - 1) / 2).astype(F))
    ro = cam.pos.astype(F)
    with np.errstate(divide="ignore"):
        t = np.where(rd[:, 1] < -1e-4, -ro[1] / np.minimum(rd[:, 1], -1e-4), -1)
    ok = (t > 0) & (t < 6000)
    grid = np.ones((h * w, 2), F)
    if ok.any():
        P = (ro[None] + rd[ok] * t[ok, None]).astype(F)
        L = env.lights[0].d.astype(F)
        grid[ok, 0] = soft_shadow(sc, P + np.array([0, 0.5, 0], F), L, k=6.0)
        d = np.maximum(sc.sdf(P[:, 0], P[:, 1] + 0.5, P[:, 2]), 0)
        grid[ok, 1] = 1 - 0.75 * np.exp(-d / 14.0) - 0.15 * np.exp(-d / 70.0)
    grid = gblur(grid.reshape(h, w, 2), 0.8)
    return sample(grid, np.clip((xs - (f - 1) / 2) / f, 0, w - 1), np.clip((ys - (f - 1) / 2) / f, 0, h - 1))


def depth_of_field(img, radius, fg_mask, scale=1.0):
    """Layered gather DOF. Each blur level is computed at reduced resolution and sampled only
    at the pixels that need it; background (desk, wall) is blurred with normalized
    convolution so the sharp terminal does not bleed into it."""
    H, W = radius.shape
    levels = np.array([0, 1.5, 3.5, 7, 13, 24, 42], F) * max(1.0, scale)
    r = np.clip(radius, 0, levels[-1]).reshape(-1)
    need = np.nonzero(r > 0.2)[0]
    out = img.copy()
    if need.size == 0:
        return out
    flat = out.reshape(-1, 3)
    py, px = np.divmod(need, W)
    px = px.astype(F)
    py = py.astype(F)
    rn = r[need]
    li = np.clip(np.searchsorted(levels, rn, side="right") - 1, 0, len(levels) - 2)
    tt = (rn - levels[li]) / (levels[li + 1] - levels[li])
    fg = fg_mask.reshape(-1)[need]
    acc = np.zeros((need.size, 3), F)
    bgm = (~fg_mask).astype(F)
    cache = {}
    for k in range(len(levels)):
        wk = np.where(li == k, 1 - tt, 0) + np.where(li + 1 == k, tt, 0)
        sel = np.nonzero(wk > 0)[0]
        if sel.size == 0:
            continue
        if k == 0:
            acc[sel] += flat[need[sel]] * wk[sel, None]
            continue
        s_ = float(levels[k])
        f = max(1, int(s_ / 1.5))
        if f not in cache:
            cache[f] = (img, bgm) if f == 1 else (resize(img, max(8, W // f), max(8, H // f)),
                                                   resize(bgm, max(8, W // f), max(8, H // f)))
        small, smask = cache[f]
        sig = s_ / f
        fgb = gblur(small, sig)
        nb = gblur(small * smask[..., None], sig)
        mb = gblur(smask, sig)[..., None]
        bgb = np.where(mb > 0.02, nb / np.maximum(mb, 0.02), fgb)
        hs, ws = small.shape[:2]
        sx = np.clip((px[sel] + 0.5) * ws / W - 0.5, 0, ws - 1)
        sy = np.clip((py[sel] + 0.5) * hs / H - 0.5, 0, hs - 1)
        vf = sample(fgb, sx, sy)
        vb = sample(bgb, sx, sy)
        acc[sel] += np.where(fg[sel, None], vf, vb) * wk[sel, None]
    flat[need] = acc
    return out


# ============================================================ CLI

def load_dumps(paths):
    screens = []
    for p in paths:
        text = sys.stdin.read() if p == "-" else open(p, encoding="utf-8", errors="replace").read()
        scr = parse_dump(text)
        scr.source = p
        if scr.is_blank():
            print(f"note: {p}: page={scr.page or '?'} is blank (e.g. a raw splash); rendering an empty screen",
                  file=sys.stderr)
        screens.append(scr)
    return screens


def timeline(screens, frame_ms, blink_ms, animate_blink, hold_ms=0):
    """[(screen, blink_on, duration_ms)]: each dump shown frame_ms; a lone dump with blinking
    cells (or a visible cursor) becomes a two-phase blink loop."""
    def blinks(scr):
        return bool((scr.attrs & 0x0002).any()) or bool(scr.cursor and scr.cursor[2])
    if len(screens) == 1:
        scr = screens[0]
        if animate_blink and blinks(scr):
            return [(scr, True, blink_ms), (scr, False, blink_ms)]
        return [(scr, True, max(frame_ms, 1000))]
    out, t = [], 0
    for scr in screens:
        on = (t // blink_ms) % 2 == 0 if animate_blink else True
        out.append((scr, on, frame_ms))
        t += frame_ms
    while hold_ms > 0:   # hold the last screen, still blinking
        d = min(blink_ms, hold_ms)
        out.append((screens[-1], (t // blink_ms) % 2 == 0 if animate_blink else True, d))
        t += d
        hold_ms -= d
    return out


def save_gif(frames, durations, path, colors=256):
    """Animated GIF with one shared adaptive palette (stable colours, no flicker)."""
    ims = [Image.fromarray(f) for f in frames]
    # palette from a mosaic of (up to 6) frames
    pick = ims[:: max(1, len(ims) // 6)][:6]
    w, h = ims[0].size
    sheet = Image.new("RGB", (w // 2 * len(pick), h // 2))
    for i, im in enumerate(pick):
        sheet.paste(im.resize((w // 2, h // 2)), (i * (w // 2), 0))
    pal = sheet.quantize(colors=colors, method=Image.Quantize.MEDIANCUT)
    q = [im.quantize(palette=pal, dither=Image.Dither.FLOYDSTEINBERG) for im in ims]
    q[0].save(path, save_all=True, append_images=q[1:], duration=durations, loop=0, optimize=False, disposal=1)


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Render 3615 MESHCORE screen dump(s) as a photo of a Minitel 2 (PNG or animated GIF).")
    ap.add_argument("dumps", nargs="+", help="dump file(s) ('-' = stdin). Several dumps = an animation")
    ap.add_argument("-o", "--out", help="output .png or .gif (default: <first dump>.png, or .gif if animated)")
    ap.add_argument("--size", default=None,
                    help="WxH or 4k (3840x2880), hd (1920x1440). Default 1920x1440; GIF 960x720; screen-only 1280x960")
    ap.add_argument("--angle", type=float, nargs="?", const=28.0, default=0.0,
                    help="camera yaw in degrees for a 3/4 view (bare --angle = 28)")
    ap.add_argument("--elev", type=float, default=None, help="camera elevation in degrees")
    ap.add_argument("--style", choices=sorted(STYLES), default="desk", help="lighting/background preset")
    ap.add_argument("--framing", choices=list(Camera.FRAMINGS), default="full",
                    help="full: whole terminal and keyboard; front: the bezel fills the frame; screen: close-up of the tube")
    ap.add_argument("--screen-only", action="store_true",
                    help="only the CRT face (curved raster, glow, rounded glass) on black; fast")
    ap.add_argument("--zoom", type=float, default=1.0, help="extra zoom factor")
    ap.add_argument("--aperture", type=float, default=None, help="lens aperture diameter in mm (DOF)")
    ap.add_argument("--dh-down", action="store_true",
                    help="double height extends DOWN from the written row (default: up, row above = continuation)")
    ap.add_argument("--blink", choices=["on", "off", "animate"], default=None,
                    help="blinking cells and cursor: on, off, or animate (default: animate for GIF, else on)")
    ap.add_argument("--frame-ms", type=int, default=500, help="GIF: time each dump is shown (ms)")
    ap.add_argument("--blink-ms", type=int, default=500, help="GIF: half period of the blink (ms)")
    ap.add_argument("--hold-ms", type=int, default=3000, help="GIF of several dumps: hold the last one (ms)")
    ap.add_argument("--grain", type=float, default=None, help="film grain amount (0 = off; default 1, GIF 0.5)")
    ap.add_argument("--live-grain", action="store_true", help="GIF: new grain every frame (bigger file)")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("-q", "--quiet", action="store_true")
    a = ap.parse_args(argv)

    screens = load_dumps(a.dumps)
    first = a.dumps[0]
    base = os.path.splitext(first)[0] if first != "-" else "minitel"
    gif = (a.out or "").lower().endswith(".gif") or (a.out is None and len(screens) > 1)
    out = a.out or base + (".gif" if gif else ".png")
    if a.size:
        W, H = parse_size(a.size)
    else:
        W, H = (960, 720) if gif else ((1280, 960) if a.screen_only else (1920, 1440))
    grain = a.grain if a.grain is not None else (0.5 if gif else 1.0)
    blink = a.blink or ("animate" if gif else "on")
    t0 = time.time()
    if a.screen_only:
        R = ScreenOnlyRenderer(W, H, style=a.style, dh_up=not a.dh_down, verbose=not a.quiet)
    else:
        R = PhotoRenderer(W, H, a.angle, a.elev, a.style, a.framing, a.zoom, a.aperture, not a.dh_down,
                          verbose=not a.quiet)
    R.prepare(screens[0])
    if gif:
        tl = timeline(screens, a.frame_ms, a.blink_ms, blink == "animate", a.hold_ms if len(screens) > 1 else 0)
        if blink == "off":
            tl = [(s_, False, d) for s_, _, d in tl]
        frames = [R.frame(s_, on, grain, a.seed + (i if a.live_grain else 0)) for i, (s_, on, _) in enumerate(tl)]
        save_gif(frames, [d for _, _, d in tl], out)
        desc = f"{len(frames)} frames"
    else:
        on = blink != "off"
        if len(screens) == 1:
            Image.fromarray(R.frame(screens[0], on, grain, a.seed)).save(out, compress_level=6)
        else:   # several dumps to PNG: numbered files
            stem, ext = os.path.splitext(out)
            for i, s_ in enumerate(screens):
                Image.fromarray(R.frame(s_, on, grain, a.seed)).save(f"{stem}-{i:03d}{ext}", compress_level=6)
            out = f"{stem}-000{ext} .. {stem}-{len(screens) - 1:03d}{ext}"
        desc = "still"
    sc0 = screens[0]
    print(f"{out}: {W}x{H} {desc}, {sc0.cols} col {sc0.mode or ''} page={sc0.page or '?'}, {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
