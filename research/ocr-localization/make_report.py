"""从保存结果生成离线可查看的样片与对照表；不调用模型。"""
import html
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


def main():
    manifest = json.loads((ROOT / 'fixtures/inspection/ocr-exploration-v1/manifest.json').read_text(encoding='utf-8'))
    results = [json.loads((HERE / 'results-2026-11-01' / f'final-{m}.json').read_text(encoding='utf-8'))
               for m in ['v6-tiny', 'v6-small', 'v5-mobile']]
    sam = json.loads((HERE / 'results-2026-11-01/sam2-tiny.json').read_text(encoding='utf-8'))
    chunks = ['''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>鉴微 · OCR 与定位实验</title><style>
body{font:15px/1.65 system-ui,sans-serif;margin:0;background:#f4f5f4;color:#252b29}main{max-width:1150px;margin:40px auto;padding:0 24px}h1{font-size:30px;margin-bottom:8px}h2{font-size:22px;margin-top:0}p{max-width:90ch}.muted{color:#65716c}.notice{background:#fff2de;border-left:4px solid #ab710f;padding:16px 20px;border-radius:8px}section{margin:24px 0;background:white;border:1px solid #dfe5e0;border-radius:12px;padding:22px}img,svg{display:block;max-width:100%;max-height:650px;margin:auto;border-radius:6px}table{border-collapse:collapse;width:100%;margin:16px 0}td,th{text-align:left;border-bottom:1px solid #e5e9e6;padding:8px 12px}th{color:#65716c;font-size:13px}code{font:14px ui-monospace,monospace}.bad{color:#b42318}.good{color:#177245}.scroll{overflow-x:auto}summary{cursor:pointer;color:#4d6559;padding:10px 0}a{color:#177245}.codes{display:flex;flex-wrap:wrap;gap:6px}.codes span{font:12px ui-monospace,monospace;background:#eef2ef;padding:5px 8px;border-radius:4px}</style>
<main><div class="muted">2026-11-01 · 本机研究 · 正常检验仍使用 VLM</div><h1>小模型读字，定位与方向分开验证</h1>
<p>9 张图片，63 次元件出现。60 次可按像素核验主码；另 3 次形近字按录入人员声明单列观察。合成图和公开实拍用于探索，不能代表公司现场准确率。</p>
<p class="notice"><b>需要保留的反例：</b>18 件样片中的 C08、C17 有预设字符差异。原有 VLM 配置延长到 180 秒后仍将两件判为合格；三套 OCR 开启方向分类后在这一张图上都读对了 18 件主码。不能把任一模型的高分当作正确答案。</p>
<p><a href="../../docs/research/轻量OCR与定位方向探索-2026-11-01.md">研究说明与来源</a> · <a href="../../fixtures/inspection/ocr-exploration-v1/public/ATTRIBUTION.md">公开图片署名与许可</a></p>''']
    for scene in manifest['scenes']:
        chunks.append(f'<section id="{html.escape(scene["id"])}"><h2>{html.escape(scene["id"])}</h2>')
        if scene.get('truth_assurance'):
            chunks.append('<p class="notice">形近字单列探索：O/0、I/1 的像素本身难以明确区分。期望文字由录入人员声明，不作为独立 OCR 正确率证明。</p>')
        chunks.append(f'<img src="../../{scene["file"]}" alt="{scene["id"]}"><div class="codes">')
        for part in scene['parts']:
            cls='bad' if part['primary']!=part['reference'] else ''
            chunks.append(f'<span class="{cls}">{part["id"]} {part["primary"]}</span>')
        chunks.append('</div><div class="scroll"><table><tr><th>模型</th><th>整图主码，方向关→开</th><th>开启方向耗时</th><th>人工 ROI＋四方向主码</th><th>ROI 全部调用耗时</th></tr>')
        for result in results:
            row=next(s for s in result['scenes'] if s['id']==scene['id'])
            counts=[sum(p['primary_exact'] for p in r['parts']) for r in row['whole']]
            roi=sum(p['primary_exact'] for p in row['oracle_roi'])
            chunks.append(f'<tr><td>{result["model"]}</td><td>{counts[0]} → {counts[1]} / {len(scene["parts"])}</td><td>{row["whole"][1]["wall_seconds"]:.3f} 秒</td><td>{roi} / {len(scene["parts"])}</td><td>{sum(p["wall_seconds"]for p in row["oracle_roi"]):.3f} 秒</td></tr>')
            chunks.append(f'<tr><td colspan="5"><details><summary>{result["model"]} · 实际整图 OCR 原文和分数</summary><code>{html.escape(" | ".join(l["text"]+" ("+str(round(l["score"],4))+")" for l in row["whole"][1]["lines"]))}</code></details></td></tr>')
        chunks.append('</table></div><p class="muted">耗时为单次已加载 CPU 推理，2 线程；不同模式处理次数不同。人工框只用于评估归属及方向实验，不是自动定位结果。</p>')
        if scene['id']=='eighteen-two-differences':
            chunks.append('<p class="notice"><b>VLM 对照：</b>整图未提供人工文字时 94.18 秒，提供后 91.58 秒，两次均将 18 件判合格，漏掉 C08/C17。按人工位置分别裁出后，两件都被正确判为不合格（22.27 / 21.85 秒）。以下只放大原像素，不重绘文字。</p><div style="display:flex;gap:20px;flex-wrap:wrap">')
            for part in scene['parts']:
                if part['id'] not in ['C08','C17']:
                    continue
                x,y,x2,y2=part['roi'];w,h=scene['size']
                chunks.append(f'<div style="flex:1;min-width:200px"><svg viewBox="{x} {y} {x2-x} {y2-y}" style="max-height:280px"><image href="../../{scene["file"]}" width="{w}" height="{h}"/></svg><p class="bad">{part["id"]} · {part["primary"]} · 逐件 VLM：FAIL</p></div>')
            chunks.append('</div>')
        mask=next((s for s in sam['scenes'] if s['id']==scene['id']),None)
        if mask:
            w,h=scene['size']
            chunks.append(f'<details><summary>SAM 2.1 Tiny 自动网格：{len(mask["automatic_masks"])} 个候选，{mask["automatic_seconds_including_encoding"]:.2f} 秒，查看多余框和漏件</summary><svg viewBox="0 0 {w} {h}"><image href="../../{scene["file"]}" width="{w}" height="{h}"/>')
            for i,m in enumerate(mask['automatic_masks']):
                x,y,mw,mh=m['bbox']
                chunks.append(f'<rect x="{x}" y="{y}" width="{mw}" height="{mh}" stroke="#ffb000" stroke-width="3" fill="none"/><text x="{x+2}" y="{y+18}" fill="#a10c0c" font-size="18">{i+1}</text>')
            chunks.append('</svg><p>8×8 点网格，不按元件类别过滤；框可能属于背景、托盘或引脚。这不是逐元件真值。</p></details>')
        chunks.append('</section>')
    chunks.append('<p class="muted">结果来自保存 JSON，生成此页不调用模型。没有修改或重绘原始丝印。正品录入中的人工文本不能成为给样品自动纠错的字典。</p></main></html>')
    (HERE/'report.html').write_text('\n'.join(chunks),encoding='utf-8')


if __name__=='__main__':
    main()
