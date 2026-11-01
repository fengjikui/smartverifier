"""独立 CPU OCR 实验；不接生产服务，不按正品答案选择方向。

用法见本目录 README。manual_rois 仅是人工评估/方向实验边界，不能算自动定位。
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import time

for name in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ[name] = "2"
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parents[2]


def canonical(text):
    # 本轮只评估字母数字代码；空白和标点忽略，不合并 0/O、1/I、5/S 等。
    return re.sub(r"[^A-Z0-9]", "", text.upper())


def assess(lines, part):
    values = [canonical(line["text"]) for line in lines]
    expected = [canonical(v) for v in part["required"]]
    target = canonical(part["primary"])
    reference = canonical(part.get("reference", part["primary"]))
    # 只认独立完整文字行，不用编辑距离把错误字符吸附到标准答案。
    return {"primary_exact": target in values,
            "all_required_exact": all(v in values for v in expected),
            "false_reference_match": target != reference and reference in values,
            "high_conf_unmatched_lines": [l for l in lines if l["score"] >= .95
                                      and canonical(l["text"]) not in expected]}


def resource():
    import psutil
    p = psutil.Process()
    result = {"process_rss_bytes": p.memory_info().rss,
              "available_bytes": psutil.virtual_memory().available,
              "load_average": list(os.getloadavg()) if hasattr(os, "getloadavg") else None}
    if sys.platform == "darwin":
        result["thermal_status"] = subprocess.run(
            ["pmset", "-g", "therm"], capture_output=True, text=True, timeout=5).stdout.strip()
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", default="fixtures/inspection/ocr-exploration-v1/manifest.json")
    parser.add_argument("--model", choices=["v6-tiny", "v6-small", "v5-mobile"], required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--scenes", nargs="*")
    parser.add_argument("--skip-roi", action="store_true")
    parser.add_argument("--roi-min-side", type=int, default=0,
                        help="ROI 短边不足此值时等比例双三次放大；0 表示不放大")
    args = parser.parse_args()
    import cv2
    import numpy as np
    from rapidocr import RapidOCR
    from rapidocr.utils.typings import ModelType, OCRVersion
    cv2.setNumThreads(2)
    manifest = json.loads((ROOT / args.manifest).read_text(encoding="utf-8"))
    model_dir = ROOT / "outputs/ocr-localization-20261101/models"
    params = {"Global.model_root_dir": str(model_dir), "Global.log_level": "warning",
              "EngineConfig.onnxruntime.intra_op_num_threads": 2,
              "EngineConfig.onnxruntime.inter_op_num_threads": 1,
              "Det.limit_side_len": 1536, "Det.limit_type": "max"}
    if args.model == "v5-mobile":
        for stage in ("Det", "Rec"):
            params[f"{stage}.ocr_version"] = OCRVersion.PPOCRV5
            params[f"{stage}.model_type"] = ModelType.MOBILE
    if args.model == "v6-tiny":
        for stage in ("Det", "Rec"):
            params[f"{stage}.model_type"] = ModelType.TINY
    engine = RapidOCR(params=params)

    def call(image, cls=True):
        started = time.perf_counter()
        r = engine(image, use_cls=cls)
        elapsed = time.perf_counter() - started
        lines = [{"text": t, "score": float(s), "box": b.tolist()}
                 for b, t, s in zip(r.boxes if r.boxes is not None else [],
                                    r.txts or [], r.scores or [])]
        return {"wall_seconds": elapsed, "stage_seconds": r.elapse_list, "lines": lines}

    # 单独记录首次调用（含模型下载/懒加载），后面均为已加载推理。
    t = time.perf_counter()
    # 空白图不会触发识别器懒加载，必须用真实文字预热完整链路。
    warm_scene = next(s for s in manifest["scenes"] if not args.scenes or s["id"] in args.scenes)
    warm = call(cv2.imread(str(ROOT / warm_scene["file"])))
    result = {"model": args.model, "platform": platform.platform(), "python": sys.version,
              "versions": {p: importlib.metadata.version(p) for p in ("rapidocr", "onnxruntime", "numpy")},
              "parameters": {k: str(v) for k, v in params.items()}, "cold_load_seconds": time.perf_counter()-t,
              "roi_min_side": args.roi_min_side,
              "warmup": warm, "resources": [resource()], "scenes": []}
    out = ROOT / args.out
    out.parent.mkdir(parents=True, exist_ok=True)

    def save():
        result["models"] = [{"file": p.name, "bytes": p.stat().st_size,
                             "sha256": hashlib.sha256(p.read_bytes()).hexdigest()}
                            for p in sorted(model_dir.glob("*.onnx"))]
        out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

    for scene in manifest["scenes"]:
        if args.scenes and scene["id"] not in args.scenes:
            continue
        path = ROOT / scene["file"]
        image = cv2.imread(str(path))
        if image is None:
            raise ValueError(f"Cannot decode {path}")
        actual_hash = hashlib.sha256(path.read_bytes()).hexdigest()
        if actual_hash != scene["sha256"]:
            raise ValueError(f"Input changed: {scene['id']}")
        sample = {"id": scene["id"], "file": scene["file"], "sha256": actual_hash,
                  "shape": list(image.shape), "whole": [], "oracle_roi": []}
        for enabled in (False, True):
            run = call(image, enabled)
            run["orientation_classifier"] = enabled
            run["parts"] = []
            for part in scene["parts"]:
                x1, y1, x2, y2 = part["roi"]
                assigned = [l for l in run["lines"]
                            if x1 <= np.mean(l["box"], axis=0)[0] <= x2
                            and y1 <= np.mean(l["box"], axis=0)[1] <= y2]
                run["parts"].append({"id": part["id"], **assess(assigned, part), "lines": assigned})
            sample["whole"].append(run)
        if not args.skip_roi:
            for part in scene["parts"]:
                x1, y1, x2, y2 = part["roi"]
                crop = image[y1:y2, x1:x2]
                if args.roi_min_side > min(crop.shape[:2]):
                    scale = args.roi_min_side / min(crop.shape[:2])
                    crop = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
                candidates = []
                for turns in range(4):
                    r = call(np.ascontiguousarray(np.rot90(crop, turns)), True)
                    r["ccw_degrees"] = turns * 90
                    # 仅按 OCR 自身的字符加权分数选方向；不看真值或正品。
                    denom = sum(len(canonical(l["text"])) for l in r["lines"])
                    r["selection_score"] = sum(l["score"] * len(canonical(l["text"]))
                                               for l in r["lines"]) / max(denom, 1)
                    candidates.append(r)
                chosen = max(candidates, key=lambda c: c["selection_score"])
                sample["oracle_roi"].append({"id": part["id"], "candidates": candidates,
                    "selected_ccw_degrees": chosen["ccw_degrees"], **assess(chosen["lines"], part),
                    "wall_seconds": sum(c["wall_seconds"] for c in candidates)})
        result["scenes"].append(sample)
        result["resources"].append(resource())
        save()
        print(json.dumps({"model": args.model, "scene": scene["id"],
                          "whole_seconds": [r["wall_seconds"] for r in sample["whole"]]}, ensure_ascii=False), flush=True)
        if result["resources"][-1]["available_bytes"] < 6 * 1024**3:
            raise RuntimeError("可用内存不足，实验已保存并暂停")
    save()


if __name__ == "__main__":
    main()
