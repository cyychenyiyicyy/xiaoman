"""题组抽取（M1.3）：OCR blocks → 结构化题组 → 规范化。

三层里的第二/三层：LLM 只做语义归并（题组、共享题干、题型、分值），
后端负责把不稳定的输出收敛成可入库结构（合合那篇文章的结论）。
"""
from __future__ import annotations

import json
import re

from .llm import complete_text

SYS = """你是试卷结构化抽取器。输入是一页（或多页）试卷的 OCR 结果，每行形如：
【页 1｜类型｜x1,y1,x2,y2】文本

你的任务：把它组织成题组结构，只输出 JSON（不要解释、不要代码块）：

{
  "paper_title": "试卷标题（看不出就空串）",
  "groups": [
    {
      "group_id": "G1",
      "section": "大题标题，如「二、阅读理解」（没有就空串）",
      "shared_stem": "题组共享的题干/材料（没有就空串）",
      "shared_pages": [1],
      "questions": [
        {
          "number": "1",
          "type": "choice|blank|short|reading|essay",
          "score": null,
          "stem": "小题题干",
          "options": ["A. ...", "B. ..."],
          "source_page": 1,
          "bbox": [x1,y1,x2,y2],
          "continues_previous": false
        }
      ]
    }
  ],
  "warnings": []
}

硬规则：
- 共享材料/大题干放 shared_stem，**小题不许把共享题干重复抄一遍**；
- 选项只放在所属小题的 options 里；
- 公式保持原样（如 $\\frac{1}{2}mv^2$），不要改写成文字；
- 「如图所示」这类引用原样保留；
- 看不清、跨页断裂的内容写进 warnings，不要猜；
- 题号只保留出现在题干开头的那个（「1.」「(2)」「①」都算）。"""


def _fmt_blocks(blocks: dict) -> str:
    lines = []
    for page in blocks.get("pages") or []:
        pno = page.get("page_no") or 1
        for b in page.get("blocks") or []:
            text = (b.get("text") or "").strip()
            if not text:
                continue
            kind = b.get("kind") or b.get("type") or "text"
            bbox = b.get("bbox") or []
            box = ",".join(str(int(v)) for v in bbox[:4]) if len(bbox) >= 4 else ""
            lines.append(f"【页 {pno}｜{kind}｜{box}】{text}")
    return "\n".join(lines)


def _rule_based(blocks: dict) -> dict:
    """没有可用模型时的兜底：按题号/选项的规则切。"""
    lines: list[tuple[int, str, list]] = []
    for page in blocks.get("pages") or []:
        for b in page.get("blocks") or []:
            if b.get("text"):
                lines.append((page.get("page_no") or 1, b["text"].strip(), b.get("bbox") or []))

    groups, current = [], None
    for page_no, text, bbox in lines:
        is_option = bool(re.match(r"^[A-D][.．、]", text))
        is_question = bool(re.match(r"^\d{1,2}[.．、)]", text)) and not is_option
        if is_question and not is_option:
            if current:
                groups.append(current)
            number = re.match(r"^(\d{1,2})", text).group(1)
            current = {
                "group_id": f"G{len(groups) + 1}",
                "section": "",
                "shared_stem": "",
                "shared_pages": [page_no],
                "questions": [
                    {
                        "number": number,
                        "type": "choice" if "（" in text or "(" in text else "short",
                        "score": None,
                        "stem": text,
                        "options": [],
                        "source_page": page_no,
                        "bbox": bbox,
                    }
                ],
            }
        elif is_option and current:
            current["questions"][-1]["options"].append(text)
        elif current:
            q = current["questions"][-1]
            q["stem"] = f"{q['stem']}\n{text}".strip()

    if current:
        groups.append(current)
    return {"paper_title": "", "groups": groups, "warnings": ["规则抽取（未用模型）"] if groups else ["没识别出题目"]}


def _parse_json(raw: str) -> dict:
    t = (raw or "").strip()
    if t.startswith("```"):
        t = re.sub(r"^```[a-zA-Z]*\n?", "", t)
        t = re.sub(r"\n?```$", "", t)
    start, end = t.find("{"), t.rfind("}")
    if start < 0 or end <= start:
        return {}
    try:
        return json.loads(t[start : end + 1])
    except json.JSONDecodeError:
        return {}


def normalize(data: dict) -> tuple[dict, list[str]]:
    """字段清洗、组号重排、共享题干去重。"""
    warnings = list(data.get("warnings") or [])
    groups = []
    for g in data.get("groups") or []:
        if not isinstance(g, dict):
            continue
        questions = []
        for q in g.get("questions") or []:
            if not isinstance(q, dict):
                continue
            stem = str(q.get("stem") or "").strip()
            if not stem:
                continue
            shared = str(g.get("shared_stem") or "").strip()
            if shared and stem.startswith(shared):
                # 模型偶尔把共享题干抄进小题，去掉
                stem = stem[len(shared) :].strip(" \n:：")
            score = q.get("score")
            try:
                score = float(score) if score not in (None, "", "null") else None
            except (TypeError, ValueError):
                score = None
            options = [str(o).strip() for o in (q.get("options") or []) if str(o).strip()]
            questions.append(
                {
                    "number": str(q.get("number") or "").strip() or str(len(questions) + 1),
                    "type": str(q.get("type") or ("choice" if options else "short")),
                    "score": score,
                    "stem": stem,
                    "options": options,
                    "source_page": int(q.get("source_page") or 1),
                    "bbox": q.get("bbox") if isinstance(q.get("bbox"), list) else [],
                    "continues_previous": bool(q.get("continues_previous")),
                }
            )
        if not questions:
            continue
        groups.append(
            {
                "group_id": f"G{len(groups) + 1}",
                "section": str(g.get("section") or "").strip(),
                "shared_stem": str(g.get("shared_stem") or "").strip(),
                "shared_pages": g.get("shared_pages") or [1],
                "questions": questions,
            }
        )
    if not groups:
        warnings.append("没有可用的题目")
    return {"paper_title": str(data.get("paper_title") or "").strip(), "groups": groups, "warnings": warnings}, warnings


async def extract(blocks: dict, provider=None, model=None) -> dict:
    """优先 LLM；没有模型就退回规则。"""
    if provider is not None and model is not None:
        body = _fmt_blocks(blocks)
        if body.strip():
            try:
                raw = await complete_text(provider, model, SYS, body[:24000], max_tokens=3000)
                parsed = _parse_json(raw)
                if parsed.get("groups"):
                    data, _ = normalize(parsed)
                    data["source"] = "llm"
                    return data
                data, warnings = normalize(parsed)
                data["source"] = "llm"
                data["warnings"] = warnings + ["模型没抽出题组"]
                return data
            except Exception as exc:  # noqa: BLE001
                fallback = _rule_based(blocks)
                fallback["warnings"].append(f"模型抽取失败：{str(exc)[:120]}")
                fallback["source"] = "rule"
                return fallback

    data = _rule_based(blocks)
    data["source"] = "rule"
    return data


def confidence_of(groups: dict) -> float:
    """粗略置信度：题目数、有没有选项/共享题干、来源。"""
    gs = groups.get("groups") or []
    q = sum(len(g.get("questions") or []) for g in gs)
    if not gs:
        return 0.0
    score = 0.55 + min(0.25, 0.05 * q)
    if groups.get("source") == "llm":
        score += 0.1
    if any(g.get("shared_stem") for g in gs):
        score += 0.05
    if any(qq.get("options") for g in gs for qq in g.get("questions") or []):
        score += 0.03
    return round(min(0.98, score), 3)