"""整理本轮有限实验的公开研究记录；剔除重复逐 token 片段和运行状态。

完整 SDK 原始记录仍在 outputs 中；保留模型原文 choices、usage、统计和哈希。
"""
import copy
import json
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'outputs/ocr-localization-20261101'
DEST = Path(__file__).parent / 'results-2026-11-01'


def slim(value):
    value = copy.deepcopy(value)
    if isinstance(value, list):
        return [slim(v) for v in value]
    if not isinstance(value, dict):
        return value
    for key, data in value.items():
        value[key] = slim(data)
    if 'lmstudio' in value and isinstance(value['lmstudio'], dict):
        sdk = value['lmstudio']
        fragments = sdk.pop('fragments', [])
        sdk.pop('messages', None)  # choices 已保留完全相同的模型原文。
        sdk['stream_fragment_count'] = len(fragments)
    return value


def save(name, data):
    (DEST/name).write_text(json.dumps(slim(data),ensure_ascii=False,indent=2),encoding='utf-8')


def main():
    DEST.mkdir(exist_ok=True)
    for name in ['final-v6-small.json','final-v5-mobile.json','final-v6-tiny.json',
                 'rapid-v6-up512.json','rapid-v5-up512.json','sam2-tiny.json']:
        shutil.copyfile(SOURCE/name,DEST/name)
    for folder,name in [('vlm-extended','vlm-image-only-extended.json'),
                        ('vlm-confirmed','vlm-confirmed-extended.json'),
                        ('vlm-oracle-roi','vlm-oracle-roi.json')]:
        save(name,json.loads((SOURCE/folder/'result.json').read_text(encoding='utf-8')))
    rows=[]
    for row in json.loads((SOURCE/'vlm-demo-api.json').read_text(encoding='utf-8')):
        rows.append(dict(material=row['material'],elapsedMs=row['elapsedMs'],summary=row['view']['summary'],
                         photos=[dict(status=p['status'],message=p['message'],components=p['components'])
                                 for p in row['view']['round']['photos']],raw=row['raw']))
    save('vlm-normal-api-before.json',rows)


if __name__=='__main__':
    main()
