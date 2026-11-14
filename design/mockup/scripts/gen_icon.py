"""「小满」定稿图标：平涂版 + 对角渐变版，全套位图导出。
环 r148 w36，缺口 -70° 半宽 30，种子 r26 落在内径 r88。
"""
import math, os
from PIL import Image, ImageDraw

OUT = os.path.dirname(os.path.abspath(__file__)).replace("mockup", "brand")
os.makedirs(OUT, exist_ok=True)
CREAM = (251, 250, 247)
C1 = (198, 108, 78)   # 渐变亮端
C2 = (150, 68, 44)    # 渐变暗端
FLAT = (176, 86, 58)  # #B0563A 平涂
SS = 4


def mark_mask(size, scale=1.0):
    """返回白标 + 透明底的遮罩图。"""
    big = size * SS
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx = cy = big / 2
    s = big / 512.0
    r, w = 148.0 * scale * s, 36.0 * scale * s
    dr, drad = 26.0 * scale * s, 88.0 * scale * s
    br = r + w / 2
    d.arc([cx - br, cy - br, cx + br, cy + br], start=-40, end=290, fill=(255, 255, 255, 255),
          width=int(round(w)))
    a = math.radians(-70)
    px, py = cx + drad * math.cos(a), cy + drad * math.sin(a)
    d.ellipse([px - dr, py - dr, px + dr, py + dr], fill=(255, 255, 255, 255))
    return img.resize((size, size), Image.LANCZOS)


def gradient(size):
    """对角线性渐变（亮端左上 → 暗端右下）。"""
    g = Image.new("RGB", (size, size))
    px = g.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2.0 * (size - 1))
            px[x, y] = tuple(int(C1[i] + (C2[i] - C1[i]) * t) for i in range(3))
    return g.convert("RGBA")


def compose(size, bg, mark_color=None, scale=1.0, grad=False):
    if grad:
        base = gradient(size)
    elif bg is None:
        base = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    else:
        base = Image.new("RGBA", (size, size), bg + (255,))
    m = mark_mask(size, scale)
    if mark_color:                       # 换标记颜色
        tint = Image.new("RGBA", (size, size), mark_color + (255,))
        tint.putalpha(m.split()[3])
        m = tint
    base.alpha_composite(m)
    return base


# ── 平涂版 ─────────────────────────────────────────────
for sz in (512, 192, 96, 48, 32, 24):
    compose(sz, FLAT, CREAM).save(os.path.join(OUT, f"icon-{sz}.png"))

# ── 渐变版 ─────────────────────────────────────────────
for sz in (512, 192, 96, 48):
    compose(sz, None, CREAM, grad=True).save(os.path.join(OUT, f"icon-grad-{sz}.png"))

# ── Android 自适应图层（透明底，0.88 缩放落进安全圆）─────────
compose(432, None, CREAM, scale=0.88).save(os.path.join(OUT, "ic_launcher_foreground-432.png"))
compose(432, None, (255, 255, 255), scale=0.88).save(os.path.join(OUT, "ic_launcher_monochrome-432.png"))
# 渐变背景层（108dp → 432px，无标记）
gradient(432).save(os.path.join(OUT, "ic_launcher_background-432.png"))

# ── 反色（米底陶标）────────────────────────────────────
compose(512, CREAM, FLAT).save(os.path.join(OUT, "icon-inverse-512.png"))

# ── 尺寸阶梯 ───────────────────────────────────────────
strip = Image.new("RGBA", (820, 300), (21, 20, 19, 255))
x = 30
for sz in (180, 96, 64, 48, 32, 24):
    strip.alpha_composite(compose(sz, FLAT, CREAM), (x, (300 - sz) // 2))
    x += sz + 30
strip.save(os.path.join(OUT, "preview-sizes.png"))

# ── 平涂 vs 渐变 ───────────────────────────────────────
cmp = Image.new("RGBA", (900, 400), (21, 20, 19, 255))
cmp.alpha_composite(compose(300, FLAT, CREAM), (40, 30))
cmp.alpha_composite(compose(300, None, CREAM, grad=True), (390, 30))
cmp.alpha_composite(compose(46, FLAT, CREAM), (110, 340))
cmp.alpha_composite(compose(46, None, CREAM, grad=True), (460, 340))
cmp.alpha_composite(compose(46, CREAM, FLAT), (810 - 60, 340))
cmp.save(os.path.join(OUT, "flat-vs-grad.png"))
print("ok: flat + grad + adaptive + inverse + preview")