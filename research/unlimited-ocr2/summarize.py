"""汇总独立研究结果；不按真值修正模型原文。"""
from __future__ import annotations
import argparse
import json
from pathlib import Path
from statistics import median


def summarize(files):
    result = {}
    for path in files:
        data = json.loads(path.read_text(encoding='utf-8'))
        rows = data['cases']
        verified = [r for r in rows if not r['control'] and
                    r['truth_assurance'] != 'manual-declared-confusable']
        completed = [r for r in rows if r['state'] == 'complete']
        is_roi = all(r['oracle_roi'] for r in verified) if verified else False
        result[path.stem] = {
            'file': path.name,
            'cases': len(rows),
            'completed_cases': len(completed),
            'pixel_verified_appearances': sum(r['score']['primary_count_total'] for r in verified),
            'complete_primary_count_matches': sum(r['score']['primary_count_matches'] for r in verified if r['state'] == 'complete'),
            'anomaly_codes_total': sum(r['score']['anomaly_code_total'] for r in verified),
            'complete_anomaly_code_matches': sum(r['score']['anomaly_code_matches'] for r in verified if r['state'] == 'complete'),
            'roi_all_required_exact': sum(bool(r['score'].get('all_required_exact')) for r in verified if r['state'] == 'complete') if is_roi else None,
            'metric': '人工 ROI 完整主码' if is_roi else '整图全文完整主码计数，不证明元件归属',
            'completed_wall_seconds_median': median(r['wall_seconds'] for r in completed) if completed else None,
            'mlx_peak_gib_max': max((r['mlx_peak_gib'] for r in rows), default=None),
            'cases_detail': [{k: r.get(k) for k in ['id', 'state', 'wall_seconds', 'first_text_seconds', 'score', 'error']} for r in rows],
        }
    return result


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('files', nargs='+', type=Path)
    p.add_argument('--out', required=True, type=Path)
    args = p.parse_args()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(summarize(args.files), ensure_ascii=False, indent=2), encoding='utf-8')
