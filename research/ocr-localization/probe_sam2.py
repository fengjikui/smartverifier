"""SAM 2.1 Tiny CPU 可行性探针：人工框提示与自动点网格明确分开。"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

os.environ["OMP_NUM_THREADS"] = "2"
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).parent))
from benchmark import resource


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--sam-repo", required=True)
    p.add_argument("--weights", required=True)
    p.add_argument("--out", required=True)
    args = p.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    repo = Path(args.sam_repo).resolve()
    sys.path.insert(0, str(repo))
    import numpy as np
    import torch
    from PIL import Image
    from sam2.build_sam import build_sam2
    from sam2.sam2_image_predictor import SAM2ImagePredictor
    from sam2.automatic_mask_generator import SAM2AutomaticMaskGenerator
    torch.set_num_threads(2)
    torch.set_num_interop_threads(1)
    before = resource()
    at = time.perf_counter()
    model = build_sam2("configs/sam2.1/sam2.1_hiera_t.yaml", args.weights, device="cpu")
    model.eval()
    data = {"torch": torch.__version__, "device": "cpu", "threads": 2,
            "source_commit": subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"], text=True).strip(),
            "weights_sha256": hashlib.sha256(Path(args.weights).read_bytes()).hexdigest(),
            "weights_bytes": Path(args.weights).stat().st_size,
            "load_seconds": time.perf_counter()-at, "resources": [before, resource()], "scenes": []}
    predictor = SAM2ImagePredictor(model)
    generator = SAM2AutomaticMaskGenerator(model, points_per_side=8, points_per_batch=8,
                                          pred_iou_thresh=.8, stability_score_thresh=.9,
                                          crop_n_layers=0, min_mask_region_area=0)
    manifest = json.loads((ROOT / "fixtures/inspection/ocr-exploration-v1/manifest.json").read_text(encoding="utf-8"))
    out = ROOT / args.out
    for scene in manifest["scenes"]:
        if scene["id"] not in ["scattered-six", "tray-thirty"]:
            continue
        im = np.array(Image.open(ROOT / scene["file"]).convert("RGB"))
        row = {"id": scene["id"], "file": scene["file"], "input_sha256": scene["sha256"]}
        with torch.inference_mode():
            at = time.perf_counter()
            predictor.set_image(im)
            row["encode_seconds"] = time.perf_counter()-at
            at = time.perf_counter()
            masks, scores, _ = predictor.predict(box=np.array([part["roi"] for part in scene["parts"]]), multimask_output=False)
            row["oracle_box_decode_seconds"] = time.perf_counter()-at
            row["oracle_box_scores"] = scores.tolist()
            row["oracle_box_mask_pixels"] = [int(np.sum(m)) for m in masks]
            at = time.perf_counter()
            masks = generator.generate(im)
            row["automatic_seconds_including_encoding"] = time.perf_counter()-at
            row["automatic_parameters"] = {"points_per_side": 8, "points_per_batch": 8, "pred_iou_thresh": .8,
                                           "stability_score_thresh": .9, "crop_n_layers": 0}
            row["automatic_masks"] = [{k: m[k] for k in ("bbox", "area", "predicted_iou", "stability_score", "point_coords")} for m in masks]
            # 可视化只绘制原图上的候选框；不是人工真值，不用于 OCR 改字。
            from PIL import ImageDraw
            vis = Image.fromarray(im)
            draw = ImageDraw.Draw(vis)
            for i, m in enumerate(masks):
                x, y, w, h = m["bbox"]
                draw.rectangle((x, y, x+w, y+h), outline="orange", width=2)
                draw.text((x, y), str(i+1), fill="red")
            preview = out.parent / (scene["id"] + "-sam2-automatic.png")
            vis.save(preview)
            row["preview"] = str(preview.relative_to(ROOT))
        data["scenes"].append(row)
        data["resources"].append(resource())
        out.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({k: v for k, v in row.items() if k.endswith("seconds") or k == "id"}), flush=True)


if __name__ == "__main__":
    main()
