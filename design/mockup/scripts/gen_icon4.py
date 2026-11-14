"""汉字字标图标 · 四选一对比板。
1 「满」满版（微软雅黑 Bold，几乎顶边）
2 「满」满版（黑体，笔画更硬）
3 「小满」竖排满版（雅黑 Bold）
4 「满」居中留白（雅黑 Bold）
"""
import os
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.dirname(os.path.abspath(__file__)).replace("mockup", "brand")
os.makedirs(OUT, exist_ok=True)
CREAM = (251, 250, 247)
CREAM2 = (222, 208, 190)
C1 = (198, 108, 78)
C2 = (144, 64, 40)
SS = 4
BOLD = "C:/Windows/Fonts/msyhbd.ttc"
HEI = "C:/Windows/Fonts/simhei.ttf"


def gradient(size):
    g = Image.new("RGB", (size, size))
    px = g.load()
    for y in range(size):
        for x in range(size):
            t = min(1.0, (x * 0.55 + y * 0.45) / (size - 1)) ** 0.9
            px[x, y] = tuple(int(C1[i] + (C2[i] - C1[i]) * t) for i in range(3))
    return g.convert("RGBA")


def layer(size, ch, font_path, factor, dx=0.0, dy=0.0, fill=CREAM):
    big = size * SS
    lay = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    f = ImageFont.truetype(font_path, int(big * factor))
    d = ImageDraw.Draw(lay)
    b = d.textbbox((0, 0), ch, font=f)
    w, h = b[2] - b[0], b[3] - b[1]
    d.text((big / 2 - w / 2 - b[0] + dx * big, big / 2 - h / 2 - b[1] + dy * big), ch, font=f, fill=fill)
    return lay.resize((size, size), Image.LANCZOS)


def build(size, items, shadow=0.011):
    img = gradient(size)
    for ch, font, factor, dx, dy in items:
        img.alpha_composite(layer(size, ch, font, factor, dx + shadow, dy + shadow, CREAM2))
    for ch, font, factor, dx, dy in items:
        img.alpha_composite(layer(size, ch, font, factor, dx, dy))
    return img


V = [
    ("1", lambda s: build(s, [("满", BOLD, 1.34, 0, 0.04)])),
    ("2", lambda s: build(s, [("满", HEI, 1.30, 0, 0.03)])),
    ("3", lambda s: build(s, [("小", BOLD, 0.70, 0, -0.285), ("满", BOLD, 0.70, 0, 0.285)])),
    ("4", lambda s: build(s, [("满", BOLD, 0.86, 0, 0.01)])),
]

for tag, fn in V:
    fn(512).save(os.path.join(OUT, f"logo-{tag}.png"))
    fn(96).save(os.path.join(OUT, f"logo-{tag}-96.png"))

board = Image.new("RGBA", (1320, 780), (21, 20, 19, 255))
x = 40
for tag, fn in V:
    board.alpha_composite(fn(280), (x, 40))
    board.alpha_composite(fn(48), (x + 20, 350))
    board.alpha_composite(fn(32), (x + 90, 358))
    x += 318
board.save(os.path.join(OUT, "logo-pick.png"))
print("ok: logo-1..4 / logo-pick")