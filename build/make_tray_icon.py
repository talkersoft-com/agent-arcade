#!/usr/bin/env python3
"""Menu-bar (tray) icons: the Saturn orb + glowing halo on a TRANSPARENT
background (no cosmic squircle), scaled to fill the frame. Rendered big then
downsampled to 22pt @1x and @2x PNGs under assets/.

Emits two variants:
  - tray-icon{,@2x}.png      → amber/gold halo (production — the brand)
  - tray-icon-dev{,@2x}.png  → cyan halo (the `npm run dev` build, so the dev
                                menu-bar icon is obviously distinct from prod)
"""
import os
from PIL import Image, ImageDraw, ImageFilter

W = 512
cx = cy = W // 2

def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

def render(ring_core, ring_glow, names):
    img = Image.new("RGBA", (W, W), (0, 0, 0, 0))

    # ── halo ring (flattened ellipse → Saturn) ──
    RX_OUT, RY_OUT = int(0.46 * W), int(0.185 * W)
    RING_W = int(0.060 * W)

    m = Image.new("L", (W, W), 0)
    d = ImageDraw.Draw(m)
    d.ellipse((cx - RX_OUT, cy - RY_OUT, cx + RX_OUT, cy + RY_OUT), fill=255)
    d.ellipse((cx - (RX_OUT - RING_W), cy - (RY_OUT - RING_W), cx + (RX_OUT - RING_W), cy + (RY_OUT - RING_W)), fill=0)
    ring = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    ring.paste(ring_core + (255,), (0, 0), m)
    ring_mask = m

    glow_m = Image.new("L", (W, W), 0)
    gd = ImageDraw.Draw(glow_m)
    gd.ellipse((cx - RX_OUT - RING_W, cy - RY_OUT - RING_W, cx + RX_OUT + RING_W, cy + RY_OUT + RING_W), fill=255)
    gd.ellipse((cx - (RX_OUT - 2 * RING_W), cy - (RY_OUT - 2 * RING_W), cx + (RX_OUT - 2 * RING_W), cy + (RY_OUT - 2 * RING_W)), fill=0)
    glow = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    glow.paste(ring_glow + (200,), (0, 0), glow_m)
    glow = glow.filter(ImageFilter.GaussianBlur(int(0.02 * W)))

    img = Image.alpha_composite(img, glow)
    img = Image.alpha_composite(img, ring)

    # ── glossy orb (violet in both variants) ──
    OR = int(0.27 * W)
    RES = 512
    orb = Image.new("RGBA", (RES, RES), (0, 0, 0, 0))
    op = orb.load()
    hx, hy = RES * 0.36, RES * 0.32
    cc = (RES - 1) / 2
    rad = RES / 2
    hmax = (((RES - hx)) ** 2 + ((RES - hy)) ** 2) ** 0.5
    C_HI, C_MID, C_LO = (0xb4, 0xa6, 0xff), (0x6d, 0x4f, 0xe6), (0x29, 0x16, 0x63)
    for y in range(RES):
        for x in range(RES):
            dx, dy = x - cc, y - cc
            if dx * dx + dy * dy > rad * rad:
                continue
            t = min(1.0, (((x - hx) ** 2 + (y - hy) ** 2) ** 0.5) / hmax)
            col = lerp(C_HI, C_MID, min(1.0, t * 1.5)) if t < 0.66 else lerp(C_MID, C_LO, (t - 0.66) / 0.34)
            edge = (dx * dx + dy * dy) ** 0.5
            a = 255 if edge < rad - 2 else max(0, int(255 * (rad - edge) / 2))
            op[x, y] = col + (a,)
    spec = Image.new("RGBA", (RES, RES), (0, 0, 0, 0))
    ImageDraw.Draw(spec).ellipse((RES * 0.26, RES * 0.20, RES * 0.50, RES * 0.40), fill=(255, 255, 255, 150))
    spec = spec.filter(ImageFilter.GaussianBlur(int(RES * 0.03)))
    orb = Image.alpha_composite(orb, spec).resize((2 * OR, 2 * OR), Image.LANCZOS)
    img.alpha_composite(orb, (cx - OR, cy - OR))

    # ── front half of the ring (wraps over the orb) ──
    front_m = Image.new("L", (W, W), 0)
    ImageDraw.Draw(front_m).rectangle((0, cy, W, W), fill=255)
    fr = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    fr.paste(ring, (0, 0), Image.composite(ring_mask, Image.new("L", (W, W), 0), front_m))
    fg = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    fg.paste(glow, (0, 0), front_m)
    img = Image.alpha_composite(img, fg)
    img = Image.alpha_composite(img, fr)

    here = os.path.dirname(os.path.abspath(__file__))
    assets = os.path.join(here, "..", "assets")
    os.makedirs(assets, exist_ok=True)
    for size, name in names:
        img.resize((size, size), Image.LANCZOS).save(os.path.join(assets, name))
        print("wrote", os.path.join("assets", name))

# production: amber/gold halo (the brand)
render((0xff, 0xe0, 0xb0), (0xff, 0x8c, 0x42), [(44, "tray-icon@2x.png"), (22, "tray-icon.png")])
# dev: cyan halo (obviously distinct from the gold prod icon in the menu bar)
render((0xd8, 0xf6, 0xff), (0x5f, 0xd6, 0xff), [(44, "tray-icon-dev@2x.png"), (22, "tray-icon-dev.png")])
