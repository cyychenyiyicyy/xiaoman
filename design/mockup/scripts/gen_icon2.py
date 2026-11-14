"""「小满」插画图标候选（程序绘制，Pillow 4x 超采样）。
A：麦粒三连大特写 · 出血
B：整株麦穗 · 底部出血
做法取自 ClassTool 定稿的经验：具体物体 + 满版对角渐变 + 出血，不做居中小标志。
"""
import math, os
from PIL import Image, ImageDraw

OUT = os.path.dirname(os.path.abspath(__file__)).replace("mockup", "brand")
os.makedirs(OUT, exist_ok=True)

CREAM = (251, 250, 247)
CREAM2 = (232, 220, 205)   # 暗面 / 分隔
CREAM3 = (214, 198, 178)   # 更深一层
C1 = (198, 108, 78)
C2 = (144, 64, 40)
SS = 4


def gradient(size):
    g = Image.new("RGB", (size, size))
    px = g.load()
    for y in range(size):
        for x in range(size):
            t = min(1.0, (x * 0.55 + y * 0.45) / (size - 1))
            t = t ** 0.92
            px[x, y] = tuple(int(C1[i] + (C2[i] - C1[i]) * t) for i in range(3))
    return g.convert("RGBA")


def grain(cx, cy, L, W, ang, sharp=0.72, n=64):
    """尖锐麦粒轮廓：两端收尖，中间饱满。"""
    pts = []
    for side in (-1, 1):
        rng = range(n + 1) if side < 0 else range(n, -1, -1)
        for i in rng:
            t = i / n
            hw = (W / 2) * (math.sin(math.pi * t) ** sharp)
            pts.append((side * hw, -L / 2 + t * L))
    a = math.radians(ang)
    ca, sa = math.cos(a), math.sin(a)
    return [(cx + x * ca - y * sa, cy + x * sa + y * ca) for x, y in pts]


def tapered(cx, cy, ang, L, W, curve=0.0, n=24):
    """细长渐尖的麦芒。"""
    a = math.radians(ang)
    ca, sa = math.cos(a), math.sin(a)
    left, right = [], []
    for i in range(n + 1):
        t = i / n
        off = curve * math.sin(math.pi * t) * L
        hw = (W / 2) * (1 - t) ** 1.6
        x, y = off, t * L
        left.append((cx + x * ca - y * sa - hw * sa * 0 + (-hw) * ca, cy + x * sa + y * ca + (-hw) * sa))
        right.append((cx + x * ca - y * sa + hw * ca, cy + x * sa + y * ca + hw * sa))
    return left + right[::-1]


def draw_grain(d, cx, cy, L, W, ang, fill=CREAM, sep=CREAM2, sep_off=7, sharp=0.72):
    """带一道暗面分隔的麦粒，制造体积。"""
    d.polygon(grain(cx + sep_off * 0.6, cy + sep_off, L, W, ang, sharp), fill=sep)
    d.polygon(grain(cx, cy, L, W, ang, sharp), fill=fill)


# ── A：麦粒三连 ────────────────────────────────────────
def make_A(size):
    big = size * SS
    img = gradient(big)
    d = ImageDraw.Draw(img)
    s = big / 512.0
    grains = [(96, 470, 330, 176, -40), (250, 320, 340, 182, -40), (404, 168, 330, 176, -40)]
    for cx, cy, L, W, ang in grains:
        draw_grain(d, cx * s, cy * s, L * s, W * s, ang)
    # 两根本芒
    d.polygon(tapered(430 * s, 96 * s, -58, 120 * s, 26 * s, 0.16), fill=CREAM2)
    d.polygon(tapered(468 * s, 128 * s, -18, 100 * s, 20 * s, -0.1), fill=CREAM3)
    return img.resize((size, size), Image.LANCZOS)


# ── B：整株麦穗 ────────────────────────────────────────
def make_B(size):
    big = size * SS
    img = gradient(big)
    d = ImageDraw.Draw(img)
    s = big / 512.0
    # 茎：从底部出血处向上，微微弯曲
    stem = []
    for i in range(41):
        t = i / 40
        x = 256 + 16 * math.sin(math.pi * t * 0.9)
        y = 540 - t * 430
        stem.append((x, y))
    d.line([(p[0] * s, p[1] * s) for p in stem], fill=CREAM2, width=int(30 * s), joint="curve")
    d.line([(p[0] * s - 4 * s, p[1] * s) for p in stem], fill=CREAM, width=int(20 * s), joint="curve")
    # 六粒：三对
    for y, dx, L, W, ang in [(238, 74, 150, 88, 34), (238, -74, 150, 88, -34),
                             (328, 80, 158, 92, 30), (328, -80, 158, 92, -30),
                             (418, 76, 150, 86, 26), (418, -76, 150, 86, -26)]:
        draw_grain(d, (256 + dx) * s, y * s, L * s, W * s, ang, sep_off=5)
    # 顶粒 + 芒
    draw_grain(d, 256 * s, 166 * s, 168 * s, 96 * s, 0, sep_off=5, sharp=0.62)
    d.polygon(tapered(244 * s, 92 * s, -12, 96 * s, 20 * s, 0.1), fill=CREAM2)
    d.polygon(tapered(272 * s, 92 * s, 14, 84 * s, 18 * s, -0.1), fill=CREAM3)
    return img.resize((size, size), Image.LANCZOS)


for name, fn in (("A", make_A), ("B", make_B)):
    fn(512).save(os.path.join(OUT, f"ico-{name}-512.png"))
    fn(96).save(os.path.join(OUT, f"ico-{name}-96.png"))

# 对比板
board = Image.new("RGBA", (760, 400), (21, 20, 19, 255))
board.alpha_composite(make_A(300), (40, 50))
board.alpha_composite(make_B(300), (420, 50))
board.alpha_composite(make_A(46), (140, 336))
board.alpha_composite(make_B(46), (520, 336))
board.save(os.path.join(OUT, "ico-AB.png"))
print("ok: ico-A / ico-B / ico-AB")