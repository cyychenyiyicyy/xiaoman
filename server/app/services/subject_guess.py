"""从拍题结果的主题文字里猜学科（只用于自动填，不是硬分类）。"""
from __future__ import annotations

import re

SUBJECTS = ["语文", "数学", "英语", "物理", "化学", "生物", "政治", "历史", "地理"]

# 只放高辨识度的词，避免「阅读」「分析」这种通用词。
WORDS = {
    "语文": ["文言文", "古诗", "诗句", "作文", "修辞", "字音", "字形", "病句", "文言", "默写", "现代文阅读"],
    "数学": ["函数", "方程", "不等式", "三角函数", "数列", "导数", "几何", "向量", "概率", "集合", "复数", "极值", "单调性"],
    "物理": ["加速度", "速度", "摩擦力", "重力", "电场", "磁场", "电路", "电流", "电压", "电阻", "动量", "机械能", "电磁感应", "光的折射"],
    "化学": ["化学式", "化学方程式", "离子", "溶液", "元素", "氧化", "还原", "摩尔", "有机物", "官能团", "pH", "浓度"],
    "生物": ["细胞", "遗传", "DNA", "蛋白质", "酶", "生态系统", "光合作用", "呼吸作用", "基因", "染色体", "种群"],
    "政治": ["哲学", "唯物", "辩证", "经济生活", "政治生活", "文化生活", "法治", "社会主义", "人民代表大会", "宏观调控"],
    "历史": ["朝代", "革命", "战争", "条约", "世纪", "王朝", "改革开放", "辛亥革命", "抗日战争", "新文化运动"],
    "地理": ["地图", "气候", "地形", "人口", "城市化", "洋流", "板块", "等高线", "季风", "经纬度", "农业区位"],
}

_WORD_RE = re.compile(r"[A-Za-z]{2,}")
_NUM_RE = re.compile(r"\d")


def _texts_of(groups: list[dict]) -> list[str]:
    out: list[str] = []
    for g in groups or []:
        if g.get("shared_stem"):
            out.append(str(g["shared_stem"]))
        for q in g.get("questions") or []:
            out.append(str(q.get("stem") or ""))
            out.extend(str(x) for x in (q.get("options") or []))
    return out


def guess_subject(groups: list[dict], current: str = "") -> str:
    text = "\n".join(_texts_of(groups))
    if not text.strip():
        return ""
    words = len(_WORD_RE.findall(text))
    chinese = len(re.findall(r"[\u4e00-\u9fff]", text))
    # 英语题：大量英文单词、中文很少；听力/阅读常见。
    if words >= 6 and words >= chinese / 4:
        return "英语"

    scores = {s: 0 for s in SUBJECTS}
    for s, words in WORDS.items():
        scores[s] = sum(1 for w in words if w in text)
    best = max(SUBJECTS, key=lambda s: scores[s])
    if scores[best] >= 2:
        return best
    if current and current in SUBJECTS:
        return current
    return ""


def guess_from_stems(stems: list[str], current: str = "") -> str:
    groups = [{"questions": [{"stem": s} for s in stems if s]}]
    return guess_subject(groups, current)
