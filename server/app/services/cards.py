"""知识卡片 / 记忆闪卡的独立模板。

卡片是 1080×1440 的 PNG（Edge 截图），闪卡是自包含 HTML（点一下翻面）。
两者都复用 artifacts.py 的 Markdown 子集。
"""
from __future__ import annotations

import html
import json
from datetime import datetime

from .artifacts import render_markdown

CARD_TEMPLATE = """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title} · 知识卡片</title>
<link rel="stylesheet" href="/vendor/katex/katex.min.css">
<style>
  :root{{--paper:#FBFAF7;--ink:#1A1917;--ink2:#5F5A52;--ink3:#A09B90;--clay:#B0563A;--claybg:#F8EDE8;--line:#E8E4DA;
    --sans:"Instrument Sans","Segoe UI","Microsoft YaHei","PingFang SC",sans-serif}}
  *{{box-sizing:border-box}}
  html,body{{margin:0;width:1080px;height:1440px;overflow:hidden}}
  body{{background:var(--paper);color:var(--ink);font-family:var(--sans);padding:76px 84px 64px;
    display:flex;flex-direction:column;-webkit-font-smoothing:antialiased}}
  .brand{{font-size:22px;letter-spacing:.14em;color:var(--clay);font-weight:600}}
  .subj{{margin-left:auto;font-size:22px;color:var(--ink3);letter-spacing:.06em}}
  .top{{display:flex;align-items:center}}
  h1{{font-size:64px;line-height:1.18;letter-spacing:-.03em;margin:56px 0 18px;font-weight:600}}
  .rule{{height:3px;width:96px;background:var(--clay);border-radius:2px;margin:0 0 34px}}
  article{{font-size:27px;line-height:1.82;color:var(--ink2);flex:1;overflow:hidden}}
  article h2{{font-size:34px;line-height:1.35;color:var(--ink);margin:26px 0 12px;font-weight:600}}
  article h3{{font-size:29px;margin:18px 0 8px;color:var(--ink);font-weight:600}}
  article p{{margin:0 0 14px}}
  article strong{{color:var(--clay);font-weight:600}}
  article ul,article ol{{margin:0 0 14px;padding-left:30px}}
  article li{{margin:6px 0}}
  article blockquote{{margin:18px 0;padding:16px 22px;background:var(--claybg);border-radius:0 12px 12px 0;
    border-left:4px solid var(--clay);color:var(--ink);font-size:25px}}
  article code{{font-family:ui-monospace,Consolas,monospace;font-size:.9em;background:var(--claybg);
    padding:1px 6px;border-radius:5px}}
  article pre{{background:#1D1C19;color:#EFEBE3;padding:18px;border-radius:12px;font-size:20px;overflow:hidden}}
  .formula{{font-size:30px}}
  .foot{{display:flex;align-items:center;justify-content:space-between;border-top:1px solid var(--line);
    padding-top:22px;font-size:20px;color:var(--ink3);margin-top:20px}}
  .foot b{{color:var(--clay);font-weight:600}}
</style>
</head>
<body>
  <div class="top"><span class="brand">小满 · 知识卡片</span><span class="subj">{subject}</span></div>
  <h1>{title}</h1>
  <div class="rule"></div>
  <article>
{body}
  </article>
  <div class="foot"><span>一张卡片只讲一件事</span><span><b>小满</b> · {date}</span></div>
  <script defer src="/vendor/katex/katex.min.js"></script>
  <script defer src="/vendor/katex/auto-render.min.js"></script>
  <script>
    document.addEventListener("DOMContentLoaded", function () {{
      if (window.renderMathInElement) {{
        renderMathInElement(document.body, {{
          delimiters: [{{left:"$$",right:"$$",display:true}},{{left:"$",right:"$",display:false}}],
          throwOnError:false, strict:false
        }});
      }}
      function fit() {{
        var a = document.querySelector("article");
        if (!a) return;
        var fs = 27;
        a.style.fontSize = fs + "px";
        while (a.scrollHeight > a.clientHeight + 1 && fs > 17) {{
          fs -= 1;
          a.style.fontSize = fs + "px";
        }}
      }}
      setTimeout(fit, 250);
      setTimeout(fit, 900);
    }});
  </script>
</body>
</html>
"""


def build_card_document(title: str, markdown: str, subject: str = "") -> str:
    now = datetime.now()
    md = (markdown or "").lstrip("\n")
    if md.startswith("# "):
        first, _, rest = md.partition("\n")
        if first.lstrip("# ").strip()[:16] == (title or "").strip()[:16]:
            md = rest.lstrip("\n")
    return CARD_TEMPLATE.format(
        title=html.escape(title or "知识卡片", quote=False),
        subject=html.escape(subject or "", quote=False),
        date=f"{now.month} 月 {now.day} 日",
        body=render_markdown(md),
    )


FLASHCARD_TEMPLATE = """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title} · 记忆闪卡</title>
<link rel="stylesheet" href="/vendor/katex/katex.min.css">
<style>
  :root{{--paper:#FBFAF7;--card:#FFFFFF;--ink:#1A1917;--ink2:#5F5A52;--ink3:#A09B90;--clay:#B0563A;
    --claybg:#F8EDE8;--line:#E8E4DA;--sans:"Instrument Sans","Segoe UI","Microsoft YaHei","PingFang SC",sans-serif}}
  *{{box-sizing:border-box}}
  body{{margin:0;background:var(--paper);color:var(--ink);font-family:var(--sans);padding:48px 32px 64px}}
  .wrap{{max-width:980px;margin:0 auto}}
  header{{display:flex;align-items:flex-end;gap:16px;border-bottom:1px solid var(--line);padding-bottom:20px;margin-bottom:28px}}
  h1{{font-size:34px;line-height:1.3;letter-spacing:-.02em;margin:0;font-weight:600}}
  .sub{{font-size:13px;color:var(--ink3);margin-left:auto}}
  .hint{{font-size:13px;color:var(--ink3);margin:0 0 20px}}
  .grid{{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}}
  .fc{{perspective:1200px;background:none;border:0;padding:0;cursor:pointer;font-family:inherit;text-align:left;
    min-height:220px;-webkit-tap-highlight-color:transparent}}
  .fci{{position:relative;width:100%;height:100%;min-height:220px;transition:transform .5s cubic-bezier(.2,.7,.2,1);
    transform-style:preserve-3d}}
  .fc.flip .fci{{transform:rotateY(180deg)}}
  .face{{position:absolute;inset:0;backface-visibility:hidden;border:1px solid var(--line);border-radius:16px;
    background:var(--card);padding:22px;display:flex;flex-direction:column;gap:10px}}
  .face.back{{transform:rotateY(180deg);background:var(--claybg);border-color:#EAD5CB}}
  .k{{font-size:11px;letter-spacing:.1em;color:var(--clay);font-weight:600}}
  .t{{font-size:19px;line-height:1.6;color:var(--ink);overflow-wrap:anywhere}}
  .back .t{{font-size:16px;color:var(--ink2)}}
  .idx{{margin-top:auto;font-size:11px;color:var(--ink3)}}
  .rate{{display:flex;gap:8px;margin-top:auto;padding-top:12px}}
  .rate button{{font-family:inherit;font-size:12px;height:30px;padding:0 12px;border-radius:999px;cursor:pointer;
    border:1px solid var(--line);background:var(--card);color:var(--ink2)}}
  .rate button.ok{{border-color:var(--clay);color:var(--clay);background:var(--claybg)}}
  .rated{{font-size:11px;color:var(--ink3);margin-top:auto;padding-top:12px}}
  @media (max-width:720px){{.grid{{grid-template-columns:1fr}} body{{padding:28px 18px 48px}} h1{{font-size:24px}}}}
</style>
</head>
<body>
<div class="wrap">
  <header><h1>{title}</h1><span class="sub">{date} · {count} 张</span></header>
  <p class="hint">点卡片翻面；先自己想，再对答案。</p>
  <div class="grid" id="grid"></div>
</div>
<script>
  const cards = {cards_json};
  const grid = document.getElementById("grid");
  cards.forEach(function (c, i) {{
    const b = document.createElement("button");
    b.type = "button"; b.className = "fc";
    b.setAttribute("aria-label", "第 " + (i + 1) + " 张，点击翻面");
    b.innerHTML = '<div class="fci">' +
      '<div class="face"><span class="k">正面</span><span class="t"></span><span class="idx">' + (i + 1) + ' / ' + cards.length + '</span></div>' +
      '<div class="face back"><span class="k">背面</span><span class="t"></span>' +
      '<div class="rate"><button type="button" data-k="1">记住了</button><button type="button" data-k="0">没记住</button></div></div>' +
      '</div>';
    const ts = b.querySelectorAll(".t");
    ts[0].textContent = c.front || "";
    ts[1].textContent = c.back || "";
    b.addEventListener("click", function () {{ b.classList.toggle("flip"); }});
    b.querySelectorAll(".rate button").forEach(function (btn) {{
      btn.addEventListener("click", function (ev) {{
        ev.stopPropagation();
        if (btn.disabled) return;
        b.querySelectorAll(".rate button").forEach(function (x) {{ x.disabled = true; }});
        var known = btn.getAttribute("data-k") === "1";
        fetch("/api/v1/artifacts/__AID__/card-review", {{
          method: "POST",
          headers: {{ "content-type": "application/json" }},
          body: JSON.stringify({{ index: i, known: known }})
        }}).then(function (r) {{ return r.json(); }}).then(function (res) {{
          var box = b.querySelector(".rate");
          if (box) box.outerHTML = '<div class="rated">' + (res && res.ok ? "已记录，下次再见" : "记录失败") + "</div>";
        }}).catch(function () {{
          var box = b.querySelector(".rate");
          if (box) box.outerHTML = '<div class="rated">记录失败，稍后再试</div>';
        }});
      }});
    }});
    grid.appendChild(b);
  }});
</script>
<script defer src="/vendor/katex/katex.min.js"></script>
<script defer src="/vendor/katex/auto-render.min.js"></script>
<script>
  document.addEventListener("DOMContentLoaded", function () {{
    if (window.renderMathInElement) {{
      renderMathInElement(document.body, {{
        delimiters: [{{left:"$$",right:"$$",display:true}},{{left:"$",right:"$",display:false}}],
        throwOnError:false, strict:false
      }});
    }}
  }});
</script>
</body>
</html>
"""


def build_flashcards_document(title: str, cards: list[dict], subject: str = "") -> str:
    now = datetime.now()
    clean = [
        {"front": str(c.get("front") or "")[:600], "back": str(c.get("back") or "")[:1200]}
        for c in (cards or [])
        if isinstance(c, dict) and (c.get("front") or c.get("back"))
    ][:20]
    data = json.dumps(clean, ensure_ascii=False).replace("</", "<\\/")
    return FLASHCARD_TEMPLATE.format(
        title=html.escape(title or "记忆闪卡", quote=False),
        date=f"{now.month} 月 {now.day} 日",
        count=len(clean),
        cards_json=data,
    )
