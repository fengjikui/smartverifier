"""只收集公开模型元数据和配置，不下载权重、不运行推理。Windows/macOS 均使用 UTF-8。"""
from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


MODELS = [
    "Qwen/Qwen3.8-27B", "Qwen/Qwen3.5-0.8B", "Qwen/Qwen3.5-2B", "Qwen/Qwen3.5-4B", "Qwen/Qwen3.5-9B",
    "Qwen/Qwen3-VL-2B-Instruct", "openbmb/MiniCPM-V-4.7-1B",
    "OpenGVLab/InternVL3_5-2B", "google/gemma-4-E2B-it",
    "HuggingFaceTB/SmolVLM2-2.2B-Instruct", "apple/FastVLM-0.5B",
    "microsoft/Phi-4-multimodal-instruct", "PaddlePaddle/PaddleOCR-VL-1.6",
    "openbmb/MiniCPM-OCR-1.0", "openbmb/MiniCPM-OCR-Jev", "zai-org/GLM-OCR",
    "xiaomi-research/Xiaomi-OCR-0", "baidu/Unlimited-OCR",
]
CONFIG_FIELDS = [
    "model_type", "architectures", "hidden_size", "num_hidden_layers", "depth",
    "patch_size", "image_size", "image_seq_length", "num_image_tokens",
    "downsample_mode", "max_slice_nums", "vocab_size", "torch_dtype", "dtype",
]


def fetch(url: str) -> bytes:
    with urlopen(Request(url, headers={"User-Agent": "Jianwei-model-survey/1.0"}), timeout=25) as response:
        data = response.read(4 * 1024 * 1024 + 1)
        if len(data) > 4 * 1024 * 1024:
            raise ValueError("Metadata exceeds 4 MiB limit")
        return data


def collect(model: str) -> dict:
    api_url = "https://huggingface.co/api/models/" + model
    result = {"model": model, "source": "https://huggingface.co/" + model, "api_url": api_url}
    try:
        raw = fetch(api_url)
        metadata = json.loads(raw)
        result.update({
            "revision": metadata.get("sha"), "last_modified": metadata.get("lastModified"),
            "license": (metadata.get("cardData") or {}).get("license"),
            "pipeline_tag": metadata.get("pipeline_tag"), "gated": metadata.get("gated"),
            "safetensors": metadata.get("safetensors"),
            "metadata_sha256": hashlib.sha256(raw).hexdigest(),
        })
        revision = metadata.get("sha") or "main"
        config_url = f"https://huggingface.co/{model}/resolve/{revision}/config.json"
        result["config_url"] = config_url
        try:
            config_raw = fetch(config_url)
            config = json.loads(config_raw)
            summary = {k: config[k] for k in CONFIG_FIELDS if k in config}
            for key in ["text_config", "llm_config", "vision_config", "slice_config"]:
                value = config.get(key)
                if isinstance(value, dict):
                    summary[key] = {k: value[k] for k in CONFIG_FIELDS if k in value}
            result["config"] = summary
            result["config_sha256"] = hashlib.sha256(config_raw).hexdigest()
        except (HTTPError, URLError, TimeoutError, ValueError) as error:
            result["config_error"] = str(error)
    except (HTTPError, URLError, TimeoutError, ValueError) as error:
        result["metadata_error"] = str(error)
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--model", action="append", help="Can be repeated; defaults to the documented shortlist")
    args = parser.parse_args()
    models = []
    for model in args.model or MODELS:
        entry = collect(model)
        models.append(entry)
        print(model + ": " + ("ERROR" if entry.get("metadata_error") else "OK"), flush=True)
    payload = {"collected_at": datetime.now(timezone.utc).isoformat(),
               "scope": "Public metadata only; not a benchmark or runtime memory measurement", "models": models}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
