"""照片降质、编码及大画幅对照；模拟输入不代表平板实拍。

使用已加载的临时 4B 实例；复用串行、55 秒时限、资源检查与原文留存。
JPEG 候选先解码成 PNG 交给原有 SDK 传输，只测试视觉损失，不宣称已测 JPEG 网络上传。
"""
from __future__ import annotations
import asyncio
import hashlib
import importlib.util
from io import BytesIO
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "outputs/capture-quality-20261017"
spec = importlib.util.spec_from_file_location("batch_research", ROOT / "research/vision-batching/benchmark.py")
batch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(batch)
from PIL import Image, ImageFilter


def prepare():
    OUT.mkdir(parents=True, exist_ok=True)
    source = ROOT / "outputs/model-selection-20261017/qwen4b/grid-4.png"
    board = Image.open(source).convert("RGB")
    variants = [("clear-png", board, None, "原四件紧凑白板"),
                ("jpeg-85", board, 85, "同像素JPEG，quality=85，subsampling=0"),
                ("jpeg-60", board, 60, "同像素JPEG，quality=60，subsampling=0"),
                ("blur-1.2-jpeg85", board.filter(ImageFilter.GaussianBlur(1.2)), 85, "高斯半径1.2，再JPEG85"),
                ("blur-3-jpeg85", board.filter(ImageFilter.GaussianBlur(3)), 85, "高斯半径3，再JPEG85"),
                ("resize-320-jpeg85", board.resize((320, 320), Image.Resampling.LANCZOS), 85, "先Lanczos缩至320，再JPEG85")]
    large = Image.new("RGB", (4160, 3120), "white")
    for i, xy in enumerate([(800, 600), (2800, 600), (800, 2000), (2800, 2000)]):
        large.paste(Image.open(source.parent / f"crop-{i+1}.png"), xy)
    variants.append(("large-frame-13mp", large, None, "四张相同原裁片放入4160×3120画布；原裁片像素不变，无图外编号"))
    cases, manifest = [], []
    for name, image, quality, description in variants:
        encoded = OUT / f"{name}.{'jpg' if quality else 'png'}"
        if quality:
            image.save(encoded, format="JPEG", quality=quality, subsampling=0)
            image = Image.open(encoded).convert("RGB")
        else:
            image.save(encoded, format="PNG")
        transport = OUT / f"{name}-sdk.png"
        image.save(transport, format="PNG")
        manifest.append({"id": name, "size": list(image.size), "description": description,
                         "candidate_file": str(encoded.relative_to(ROOT)), "candidate_bytes": encoded.stat().st_size,
                         "candidate_sha256": hashlib.sha256(encoded.read_bytes()).hexdigest(),
                         "sdk_input": str(transport.relative_to(ROOT)), "sdk_input_bytes": transport.stat().st_size,
                         "jpeg_redecoded_to_png_for_sdk": bool(quality)})
        cases.append({"id": name, "paths": [transport], "expected": batch.EXPECTED})
    (OUT / "manifest.json").write_text(json.dumps({"synthetic": True, "source": str(source.relative_to(ROOT)),
        "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(), "camera_capture_test": False,
        "model": "sv-quality-qwen4b", "variants": manifest}, ensure_ascii=False, indent=2), encoding="utf-8")
    return cases


async def main():
    batch.OUT = OUT
    batch.MODEL = "sv-quality-qwen4b"
    batch.TEMPLATE = Path.home() / ".lmstudio/models/mlx-community/Qwen3.5-4B-4bit/chat_template.jinja"
    for case in prepare():
        if not (OUT / f"{case['id']}.json").exists():
            await batch.run(case)
            await asyncio.sleep(3)


if __name__ == "__main__":
    asyncio.run(main())
