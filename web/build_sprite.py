#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 web/sprite.svg（SVG symbol 雪碧图）。

输入：design/mockup/icons/*.svg（Lucide 原始图标，stroke-width=2）
输出：web/sprite.svg，每个图标一个 <symbol id="i-xxx" viewBox="0 0 24 24">，
      描边强制 1.7（全局唯一样式来自 web/theme.css 的 --stroke）。

约束：
- 路径全部相对本文件（Path(__file__).parent），不写死绝对路径；
- 校验不过则 sys.exit(1)（构建脚本必须能失败）。

补充图标：icons/ 目录里没有、但 v6 设计稿的 provider 管理界面要用的 6 个
Lucide 图标（key / plug / refresh-cw / chevron-left / message-square /
alert-circle）。路径取自 Lucide v1.73 官方几何，仅补几何、不改设计。
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

WEB_DIR = Path(__file__).parent
ICON_DIR = WEB_DIR.parent / "design" / "mockup" / "icons"
OUT_FILE = WEB_DIR / "sprite.svg"

STROKE = "1.7"
ROOT_ATTRS = (
    'fill="none" stroke="currentColor" stroke-width="' + STROKE + '"'
    ' stroke-linecap="round" stroke-linejoin="round"'
)

# stroke-width="2" 的兜底：Lucide 源文件里所有子元素都用父级描边，
# 这里把可能出现的属性一并清掉，保证最终只有 symbol 根上的 1.7。
CHILD_ATTR_STRIP = re.compile(r'\s+(?:stroke-width|stroke-linecap|stroke-linejoin|stroke|fill)="[^"]*"')

# icons/ 目录缺的 6 个（Lucide v1.73）
SUPPLEMENT = {
    "key": (
        'm15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4',
        'm21 2-9.6 9.6',
        '<circle cx="7.5" cy="15.5" r="5.5"/>',
    ),
    "plug": (
        'M12 22v-5',
        'M9 8V2',
        'M15 8V2',
        'M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z',
    ),
    "refresh-cw": (
        'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8',
        'M21 3v5h-5',
        'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16',
        'M8 16H3v5',
    ),
    "chevron-left": ('m15 18-6-6 6-6',),
    "message-square": (
        'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
    ),
    "alert-circle": (
        '<circle cx="12" cy="12" r="10"/>',
        'M12 8v4',
        'M12 16h.01',
    ),
    "external-link": (
        'M15 3h6v6',
        'M10 14 21 3',
        'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6',
    ),
    "minus": ('M5 12h14',),
    # 知识地图（P5）
    "map": (
        'M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z',
        'M15 5.764v15',
        'M9 3.236v15',
    ),
    "scan": (
        'M3 7V5a2 2 0 0 1 2-2h2',
        'M17 3h2a2 2 0 0 1 2 2v2',
        'M21 17v2a2 2 0 0 1-2 2h-2',
        'M7 21H5a2 2 0 0 1-2-2v-2',
    ),
}


def read_icon(path: Path) -> tuple[str, str]:
    """返回 (viewBox, symbol 内部标记)。"""
    text = path.read_text(encoding="utf-8")
    text = re.sub(r"<!--.*?-->", "", text, flags=re.S)
    m = re.search(r"<svg\b[^>]*>", text)
    if not m:
        raise ValueError("no <svg> root")
    root = m.group(0)
    vb = re.search(r'viewBox="([^"]+)"', root)
    if not vb:
        raise ValueError("no viewBox")
    body = text[m.end():]
    body = body.split("</svg>")[0]
    body = re.sub(r"\s+", " ", body).strip()
    # 子元素上的描边/填充属性全部交给 symbol 根与 theme.css 的 .ic 控制，
    # 只保留 geometry（palette 的实心小圆点用 fill 内联在 circle 上，另行保留）。
    keep_fill = []
    if 'fill="currentColor"' in body:
        keep_fill = re.findall(r'fill="currentColor"', body)
        body = body.replace('fill="currentColor"', "\x00FILL\x00")
    body = CHILD_ATTR_STRIP.sub("", body)
    body = body.replace("\x00FILL\x00", 'fill="currentColor"')
    if keep_fill and 'fill="currentColor"' not in body:
        raise ValueError("currentColor fill lost")
    return vb.group(1), body


def supplement_body(name: str) -> tuple[str, str]:
    parts = SUPPLEMENT[name]
    out = []
    for p in parts:
        if p.startswith("<"):
            out.append(p)
        else:
            out.append('<path d="%s"/>' % p)
    return "0 0 24 24", "".join(out)


def main() -> int:
    failures: list[str] = []

    if not ICON_DIR.is_dir():
        print("FAIL: icon dir missing: %s" % ICON_DIR)
        return 1

    files = sorted(ICON_DIR.glob("*.svg"))
    if not files:
        print("FAIL: no icons in %s" % ICON_DIR)
        return 1

    symbols: list[tuple[str, str, str]] = []  # (id, viewBox, body)
    seen: set[str] = set()

    for f in files:
        sid = "i-" + f.stem
        if sid in seen:
            failures.append("duplicate id %s" % sid)
            continue
        seen.add(sid)
        try:
            vb, body = read_icon(f)
        except ValueError as exc:
            failures.append("%s: %s" % (f.name, exc))
            continue
        if not body:
            failures.append("%s: empty body" % f.name)
            continue
        if re.search(r"stroke-width", body):
            failures.append("%s: child stroke-width survived" % f.name)
        symbols.append((sid, vb, body))

    for name in SUPPLEMENT:
        sid = "i-" + name
        if sid in seen:
            continue  # icons/ 以后补上同名文件时自动让位
        seen.add(sid)
        vb, body = supplement_body(name)
        symbols.append((sid, vb, body))

    if len(symbols) < 33:
        failures.append("symbol count %d < 33" % len(symbols))

    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!-- 由 web/build_sprite.py 生成，勿手改。源：design/mockup/icons/*.svg -->',
        '<!-- Lucide · ISC · 描边统一 1.7（源文件为 2） -->',
        '<svg xmlns="http://www.w3.org/2000/svg" style="display:none" aria-hidden="true">',
    ]
    for sid, vb, body in symbols:
        lines.append(
            '<symbol id="%s" viewBox="%s" %s>%s</symbol>' % (sid, vb, ROOT_ATTRS, body)
        )
    lines.append("</svg>")
    lines.append("")
    svg = "\n".join(lines)

    # 生成后回读校验
    if re.search(r'stroke-width="(?!1\.7")', svg):
        failures.append('non-1.7 stroke-width remains')
    if svg.count("<symbol") != len(symbols):
        failures.append("symbol tag count mismatch")
    if 'stroke-width="1.7"' not in svg:
        failures.append("no 1.7 stroke-width")
    for chunk in re.finditer(r"<symbol\b[^>]*>", svg):
        if 'stroke-width="1.7"' not in chunk.group(0):
            failures.append("symbol without 1.7: %s" % chunk.group(0)[:60])

    OUT_FILE.write_text(svg, encoding="utf-8")

    print("icons/*.svg   : %d" % len(files))
    print("supplements   : %d" % len([n for n in SUPPLEMENT if "i-" + n not in {"i-" + f.stem for f in files}]))
    print("symbols       : %d" % len(symbols))
    print("bytes         : %d" % len(svg.encode("utf-8")))
    print("out           : %s" % OUT_FILE.name)

    if failures:
        print("\nFAIL:")
        for f in failures:
            print("  - %s" % f)
        return 1
    print("OK: all symbols use stroke-width 1.7")
    return 0


if __name__ == "__main__":
    sys.exit(main())