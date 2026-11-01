"""保留本轮原文与资源记录，并生成无需模型的静态对照页。"""
from __future__ import annotations
import argparse
import hashlib
import html
import json
from pathlib import Path
import shutil
from summarize import summarize

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
RUNS = ['smoke', 'whole', 'roi', 'upright', 'plain-prompt', 'free-ocr', 'grounding-ocr']


def esc(value):
    return html.escape(str(value), quote=True)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--source', type=Path, default=ROOT/'outputs/unlimited-ocr2-20261102')
    args = p.parse_args()
    target = HERE/'results-2026-11-02'
    target.mkdir(exist_ok=True)
    files = []
    for name in RUNS:
        src = args.source/(name+'.json')
        shutil.copy2(src, target/src.name)
        files.append(target/src.name)
        resources = src.with_suffix('.resources.jsonl')
        if resources.exists():
            shutil.copy2(resources, target/resources.name)
    summary = summarize(files)
    (target/'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
    manifest = json.loads((ROOT/'fixtures/inspection/ocr-exploration-v1/manifest.json').read_text(encoding='utf-8'))
    scenes = {s['id']: s for s in manifest['scenes']}
    blocks = []
    for path in files:
        data = json.loads(path.read_text(encoding='utf-8'))
        blocks.append(f'<section id="{esc(path.stem)}"><h2>{esc(path.stem)}</h2><a href="results-2026-11-02/{esc(path.name)}">完整 JSON</a>')
        for row in data['cases']:
            source = ROOT/row['file']
            assert hashlib.sha256(source.read_bytes()).hexdigest() == row['source_sha256']
            if row['control']:
                from_dimensions = [1200, 800]
                expected = '排字阳性对照，不计入元件准确度'
            else:
                sid = row['id'].rsplit('-', 1)[0] if row['oracle_roi'] else row['id']
                from_dimensions = scenes[sid]['size']
                expected = json.dumps(row['score']['expected_primary_counts'], ensure_ascii=False)
            width, height = from_dimensions
            roi = row['oracle_roi'] or [0, 0, width, height]
            x, y, x1, y1 = roi
            w, h = x1-x, y1-y
            cx, cy = (x+x1)/2, (y+y1)/2
            angle = row['oracle_ccw_degrees']
            view = [cx-h/2, cy-w/2, h, w] if angle % 180 else [x, y, w, h]
            viewbox = ' '.join(str(v) for v in view)
            href = '../../'+row['file']
            transform = f'rotate({-angle} {cx} {cy})'
            clip_id = esc('clip-'+path.stem+'-'+row['id'])
            caption = '人工已知 ROI' if row['oracle_roi'] else '整图'
            if angle:
                caption += f' · 逆时针转正 {angle}°'
            matched, total = row['score']['primary_count_matches'], row['score']['primary_count_total']
            blocks.append(f'''<details id="{esc(path.stem+'-'+row['id'])}"><summary>{esc(row['id'])}
                <span>{matched}/{total} 主码 · {row['wall_seconds']:.3f}s · {esc(row['state'])}</span></summary>
                <div class="pair"><figure><svg viewBox="{viewbox}" role="img" aria-label="模型输入区域">
                <defs><clipPath id="{clip_id}"><rect x="{view[0]}" y="{view[1]}" width="{view[2]}" height="{view[3]}"/></clipPath></defs>
                <g clip-path="url(#{clip_id})"><image href="{esc(href)}" width="{width}" height="{height}" transform="{transform}"/></g></svg>
                <figcaption>{esc(caption)} · <a href="{esc(href)}" target="_blank" rel="noopener">原图</a></figcaption></figure>
                <div><p>预期主码及次数：<code>{esc(expected)}</code></p><p>输入提示词：<code>{esc(row['instruction'])}</code></p>
                <p>人工声明歧义：{'是，单列观察' if row['truth_assurance']=='manual-declared-confusable' else '否'}</p>
                <pre>{esc(row['output'])}</pre></div></div></details>''')
        blocks.append('</section>')
    document = '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Unlimited OCR 2 丝印实验对照</title><style>
    *{box-sizing:border-box}body{margin:0;background:#f7f7f8;color:#25252a;font:15px/1.7 system-ui,sans-serif}
    main{max-width:1140px;margin:auto;padding:36px 28px}h1{font-size:28px;margin:0 0 12px}h2{margin-top:30px}
    a{color:#a51c30}nav{display:flex;flex-wrap:wrap;gap:18px}details{background:white;border:1px solid #dedee4;border-radius:10px;margin:12px 0;overflow:hidden}
    summary{cursor:pointer;padding:14px 18px;font-weight:600}summary span{float:right;font-weight:400;color:#666}
    .pair{display:grid;grid-template-columns:260px minmax(0,1fr);gap:24px;padding:4px 18px 20px}figure{margin:0}svg{width:100%;height:210px;background:#eeeff1}
    figcaption{font-size:13px;color:#666}pre{padding:14px;background:#f6f6f8;border-radius:6px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:360px;overflow:auto}
    code{overflow-wrap:anywhere}p{margin:8px 0}.notice{padding:16px 20px;background:#fff2df;border-radius:10px;margin:24px 0}
    @media(max-width:700px){main{padding:24px 16px}.pair{grid-template-columns:1fr}summary span{float:none;display:block}}
    </style><main><h1>Unlimited OCR 2 丝印实验对照</h1>
    <p>2026-11-02 · BF16 · Apple M2 Ultra · MLX 社区移植 · 独立研究，不接入正常检验</p>
    <div class="notice">DEFAULT_METRICS
    complete 只表示生成正常结束，不表示识别成功。整图计数不证明元件归属；人工 ROI 不证明自动分割可用。样片为合成及公开照片，不是公司现场验收。</div>
    <p><a href="../../docs/research/Unlimited-OCR-2丝印独立实测-2026-11-02.md">中文报告</a> · <a href="README.md">复现步骤</a> · <a href="results-2026-11-02/summary.json">汇总数据</a></p>
    <nav>'''
    metric = lambda n: f"{summary[n]['complete_primary_count_matches']}/{summary[n]['pixel_verified_appearances']}"
    document = document.replace('DEFAULT_METRICS', f"默认整图主码计数匹配 {metric('whole')}；人工单件 ROI 为 {metric('roi')}。详细结论见中文报告。")
    document += ''.join(f'<a href="#{esc(n)}">{esc(n)}</a>' for n in RUNS)
    document += '</nav>'+''.join(blocks)+'</main></html>'
    (HERE/'report.html').write_text(document, encoding='utf-8')
    print('snapshotted', len(files), 'runs;', sum(v['cases'] for v in summary.values()), 'calls')


if __name__ == '__main__':
    main()
