"""汉字字标图标候选：把「满」做成满版裁切的字标。
C1 巨字右下裁切（出血）
C2 完整居中 + 暗面错位（浅浮雕感）
C3 「小满」两字竖排，底行裁切
"""
import os
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.dirname(os.path.abspath(__file__)).replace("mockup", "brand")
os.makedirs(OUT, exist_ok=True)

CREAM = (251, 250, 247)
CREAM2 = (236, 226, 212)
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
            t = min(1.0, (x * 0.55 + y * 0.45) / (size - 1)) ** 0.92
            px[x, y] = tuple(int(C1[i] + (C2[i] - C1[i]) * t) for i in range(3))
    return g.convert("RGBA")


def text_layer(size, ch, font_path, factor, dx, dy, fill):
    """返回一个只含该字的透明图层（字号 = size*factor）。"""
    big = size * SS
    lay = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    f = ImageFont.truetype(font_path, int(big * factor))
    d = ImageDraw.Draw(lay)
    bbox = d.textbbox((0, 0), ch, font=f)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    d.text((big / 2 - w / 2 - bbox[0] + dx * big, big / 2 - h / 2 - bbox[1] + dy * big),
           ch, font=f, fill=fill)
    return lay.resize((size, size), Image.LANCZOS)


def make(ch, font, factor, dx, dy, shadow=True, bg_grad=True, size=512):
    img = gradient(size) if bg_grad else Image.new("RGBA", (size, size), (176, 86, 58, 255))
    if shadow:
        img.alpha_composite(text_layer(size, ch, font, factor, dx + 0.012, dy + 0.012, CREAM2))
    img.alpha_composite(text_layer(size, ch, font, factor, dx, dy, CREAM))
    return img


# C1：巨字，右下裁切
c1 = lambda s: make("满", BOLD, 1.55, 0.10, 0.13, size=s)
# C2：完整居中
c2 = lambda s: make("满", BOLD, 0.86, 0, 0.01, size=s)
# C3：小满竖排，下字出血
def c3(size):
    img = gradient(size)
    img.alpha_composite(text_layer(size, "小", BOLD, 0.52, 0, -0.20, CREAM2))
    img.alpha_composite(text_layer(size, "小", BOLD, 0.52, -0.004, -0.204, CREAM))
    img.alpha_composite(text_layer(size, "满", BOLD, 0.52, 0, 0.30, CREAM2))
    img.alpha_composite(text_layer(size, "满", BOLD, 0.52, -0.004, 0.296, CREAM))
    return img


for name, fn in (("C1", c1), ("C2", c2), ("C3", c3)):
    fn(512).save(os.path.join(OUT, f"ico-{name}-512.png"))
    fn(96).save(os.path.join(OUT, f"ico-{name}-96.png"))

board = Image.new("RGBA", (1100, 380), (21, 20, 19, 255))
x = 40
for fn in (c1, c2, c3):
    board.alpha_composite(fn(280), (x, 40))
    x += 320
x = 100
for fn in (c1, c2, c3):
    board.alpha_composite(fn(48), (x, 330))
    x += 320
board.save(os.path.join(OUT, "ico-C.png"))
print("ok: ico-C1/C2/C3 + ico-C")