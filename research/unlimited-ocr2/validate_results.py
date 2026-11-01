"""仅标准库：从原文重评分，核对真值、图片哈希和结果快照。"""
from __future__ import annotations
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
from score import score
from snapshot import RUNS
from summarize import summarize

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent


def main():
    manifest = json.loads((ROOT/'fixtures/inspection/ocr-exploration-v1/manifest.json').read_text(encoding='utf-8'))
    scenes = {s['id']: s for s in manifest['scenes']}
    control = json.loads((HERE/'control.json').read_text(encoding='utf-8'))
    files = [HERE/'results-2026-11-02'/(name+'.json') for name in RUNS]
    checked = 0
    weights = None
    for path in files:
        data = json.loads(path.read_text(encoding='utf-8'))
        assert data['model_revision'] == '850d1e483f5a82a0597f0a45aac31b07ba840df2'
        assert data['language_model_class'] == 'DeepseekV2DashModel'
        assert data['page_layout'] is True and data['max_crops'] == 16
        if weights is None:
            weights = data['weights']
        assert data['weights'] == weights
        for row in data['cases']:
            if row['control']:
                parts = [{'primary':c, 'required':[c], 'reference':c} for c in control['lines']]
                truth = control
                width, height = truth['size']
            elif row['oracle_roi']:
                sid, pid = row['id'].rsplit('-', 1)
                truth = scenes[sid]
                parts = [p for p in truth['parts'] if p['id'] == pid]
                assert len(parts) == 1 and parts[0]['roi'] == row['oracle_roi']
                x, y, x1, y1 = row['oracle_roi']
                width, height = x1-x, y1-y
                if row['oracle_ccw_degrees'] % 180:
                    width, height = height, width
            else:
                truth = scenes[row['id']]
                parts = truth['parts']
                width, height = truth['size']
            assert row['source_sha256'] == truth['sha256']
            assert hashlib.sha256((ROOT/row['file']).read_bytes()).hexdigest() == truth['sha256']
            assert row['input_size'] == [width, height]
            assert row['score'] == score(row['output'], parts, row['state'] == 'complete'), row['id']
            assert row['truth_assurance'] == truth.get('truth_assurance', 'pixel-reviewed')
            checked += 1
    saved = json.loads((HERE/'results-2026-11-02/summary.json').read_text(encoding='utf-8'))
    assert saved == summarize(files)

    class Links(HTMLParser):
        def handle_starttag(self, tag, attrs):
            for key, value in attrs:
                if key == 'href' and value and not value.startswith(('#', 'http:', 'https:')):
                    assert (HERE/value.split('#')[0]).resolve().exists(), value
    Links().feed((HERE/'report.html').read_text(encoding='utf-8'))
    print(f'已核验 {checked} 次原文、输入尺寸／哈希、逐项重评分、7 组汇总和静态页文件链接。')


if __name__ == '__main__':
    main()
