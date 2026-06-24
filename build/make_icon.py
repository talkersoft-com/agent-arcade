#!/usr/bin/env python3
"""Agent Arcade app icon: a glossy violet orb wrapped by a glowing cyan halo ring,
on a deep cosmic squircle. Rendered at 4x then downsampled for crisp edges."""
import os
from PIL import Image, ImageDraw, ImageFilter

S = 1024
SS = 4
W = S * SS
cx = cy = W // 2

def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

# ── squircle + cosmic radial background ───────────────────────────────────────
margin = int(0.085 * W)
box = (margin, margin, W - margin, W - margin)
radius = int(0.235 * W)
mask = Image.new("L", (W, W), 0)
ImageDraw.Draw(mask).rounded_rectangle(box, radius=radius, fill=255)

C_CORE = (0x2a, 0x1e, 0x63)   # deep indigo center
C_EDGE = (0x0a, 0x09, 0x16)   # near-black edge
G = 256
small = Image.new("RGB", (G, G))
sp = small.load()
cxg = cyg = (G - 1) / 2
maxd = (cxg ** 2 + cyg ** 2) ** 0.5
for y in range(G):
    for x in range(G):
        d = ((x - cxg) ** 2 + (y - cyg) ** 2) ** 0.5 / maxd
        d = min(1.0, d ** 1.15)
        sp[x, y] = lerp(C_CORE, C_EDGE, d)
bg = small.resize((W, W), Image.BILINEAR)
img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
img.paste(bg, (0, 0), mask)

# ── halo ring (tilted, glowing) ───────────────────────────────────────────────
RX_OUT, RY_OUT = int(0.40 * W), int(0.155 * W)   # flattened ellipse → perspective
RING_W = int(0.034 * W)                           # ring thickness
RING_CORE = (0xff, 0xe0, 0xb0)   # warm gold (the brand ring color)
RING_GLOW = (0xff, 0x8c, 0x42)   # amber glow

def ring_layer():
    m = Image.new("L", (W, W), 0)
    d = ImageDraw.Draw(m)
    d.ellipse((cx - RX_OUT, cy - RY_OUT, cx + RX_OUT, cy + RY_OUT), fill=255)
    rxi, ryi = RX_OUT - RING_W, RY_OUT - RING_W
    d.ellipse((cx - rxi, cy - ryi, cx + rxi, cy + ryi), fill=0)
    layer = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    layer.paste(RING_CORE + (255,), (0, 0), m)
    return layer, m

ring, ring_mask = ring_layer()
# glow: blurred wider copy underneath
glow_m = Image.new("L", (W, W), 0)
gd = ImageDraw.Draw(glow_m)
gd.ellipse((cx - RX_OUT - RING_W, cy - RY_OUT - RING_W, cx + RX_OUT + RING_W, cy + RY_OUT + RING_W), fill=255)
rxi, ryi = RX_OUT - 2 * RING_W, RY_OUT - 2 * RING_W
gd.ellipse((cx - rxi, cy - ryi, cx + rxi, cy + ryi), fill=0)
glow = Image.new("RGBA", (W, W), (0, 0, 0, 0))
glow.paste(RING_GLOW + (190,), (0, 0), glow_m)
glow = glow.filter(ImageFilter.GaussianBlur(int(0.018 * W)))

# back half of the ring (behind the orb) = full ring; we'll redraw the front half later
img = Image.alpha_composite(img, glow)
img = Image.alpha_composite(img, ring)

# ── glossy orb ────────────────────────────────────────────────────────────────
OR = int(0.235 * W)        # orb radius
D = 2 * OR
RES = 560
orb = Image.new("RGBA", (RES, RES), (0, 0, 0, 0))
op = orb.load()
hx, hy = RES * 0.36, RES * 0.32      # highlight center (upper-left)
cc = (RES - 1) / 2
rad = RES / 2
hmax = (((RES - hx)) ** 2 + ((RES - hy)) ** 2) ** 0.5
C_HI = (0xb4, 0xa6, 0xff)   # lit
C_MID = (0x6d, 0x4f, 0xe6)
C_LO = (0x29, 0x16, 0x63)   # shadow
for y in range(RES):
    for x in range(RES):
        dx, dy = x - cc, y - cc
        if dx * dx + dy * dy > rad * rad:
            continue
        t = (((x - hx) ** 2 + (y - hy) ** 2) ** 0.5) / hmax
        t = min(1.0, t)
        col = lerp(C_HI, C_MID, min(1.0, t * 1.5)) if t < 0.66 else lerp(C_MID, C_LO, (t - 0.66) / 0.34)
        edge = (dx * dx + dy * dy) ** 0.5
        a = 255 if edge < rad - 2 else max(0, int(255 * (rad - edge) / 2))
        op[x, y] = col + (a,)
# specular highlight
spec = Image.new("RGBA", (RES, RES), (0, 0, 0, 0))
ImageDraw.Draw(spec).ellipse((RES * 0.26, RES * 0.20, RES * 0.50, RES * 0.40), fill=(255, 255, 255, 150))
spec = spec.filter(ImageFilter.GaussianBlur(int(RES * 0.03)))
orb = Image.alpha_composite(orb, spec)
orb = orb.resize((D, D), Image.LANCZOS)
# soft drop shadow under the orb
osh = Image.new("RGBA", (W, W), (0, 0, 0, 0))
ImageDraw.Draw(osh).ellipse((cx - OR, cy - OR + int(0.03 * W), cx + OR, cy + OR + int(0.03 * W)), fill=(0, 0, 0, 120))
osh = osh.filter(ImageFilter.GaussianBlur(int(0.02 * W)))
img = Image.alpha_composite(img, osh)
img.alpha_composite(orb, (cx - OR, cy - OR))

# ── front half of the ring (in front of the orb) ──────────────────────────────
front_m = Image.new("L", (W, W), 0)
ImageDraw.Draw(front_m).rectangle((0, cy, W, W), fill=255)   # lower half only
front_ring = Image.new("RGBA", (W, W), (0, 0, 0, 0))
front_ring.paste(ring, (0, 0), Image.composite(ring_mask, Image.new("L", (W, W), 0), front_m))
front_glow = Image.new("RGBA", (W, W), (0, 0, 0, 0))
front_glow.paste(glow, (0, 0), front_m)
img = Image.alpha_composite(img, front_glow)
img = Image.alpha_composite(img, front_ring)

# clip to squircle, downscale, write
clipped = Image.new("RGBA", (W, W), (0, 0, 0, 0))
clipped.paste(img, (0, 0), mask)
out = clipped.resize((S, S), Image.LANCZOS)
here = os.path.dirname(os.path.abspath(__file__))
master = os.path.join(here, "icon-1024.png")
out.save(master)
print("wrote", master)
