"""本地千问图片布局对照；仅用公开合成样例，串行、有时限、不改模型设置。

运行：.venv/bin/python research/vision-batching/benchmark.py
支持 --cases 指定逗号分隔案例；已保存的案例默认跳过，避免重复推理。
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import time

os.environ.setdefault("OMP_NUM_THREADS", "2")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "2")
# SDK 自建 httpx 客户端会读取全局代理；仅此研究进程使用本机回环地址。
for proxy_key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
    os.environ.pop(proxy_key, None)
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server/vision"))
from PIL import Image, ImageDraw, ImageFont
import httpx
import psutil
from vlm_client.lmstudio_transport import LmStudioTransport

OUT = ROOT / "outputs/vision-batching-20261017"
TEMPLATE = Path.home() / ".lmstudio/models/lmstudio-community/Qwen3.8-27B-MLX-4bit/chat_template.jinja"
MODEL = "hr-qwen"
EXPECTED = [["SV358", "A26", "0147"], ["SV358", "A26", "0147"],
            ["SV385", "A26", "0147"], ["SV358", "A26", "0147"]]


def resources():
    thermal = subprocess.check_output(["pmset", "-g", "therm"], text=True, stderr=subprocess.STDOUT)
    mem = psutil.virtual_memory()
    snapshot = {"time": time.time(), "load": os.getloadavg(), "available_gib": round(mem.available / 2**30, 2),
                "cpu_percent": psutil.cpu_percent(interval=.3), "thermal": thermal.strip()}
    with (OUT / "resources.jsonl").open("a") as f:
        f.write(json.dumps(snapshot, ensure_ascii=False) + "\n")
    if mem.available < 8 * 2**30 or snapshot["cpu_percent"] > 90:
        raise RuntimeError("内存或 CPU 压力较高，停止本次测试")
    if any("No " not in line and ("warning level" in line or "Speed_Limit" in line) for line in thermal.splitlines()):
        raise RuntimeError("发现系统热/性能告警，停止本次测试")
    return snapshot


def prepare():
    OUT.mkdir(parents=True, exist_ok=True)
    image = Image.open(ROOT / "fixtures/inspection/four-components.png").convert("RGB")
    # 人工固定选区：只比较输入布局，不把定位算法误差混进 OCR 实验。
    boxes = [(230, 60, 660, 490), (900, 75, 1330, 505), (250, 515, 680, 945), (880, 520, 1310, 950)]
    crops = [image.crop(box) for box in boxes]
    paths = []
    for i, crop in enumerate(crops):
        path = OUT / f"crop-{i+1}.png"
        crop.save(path)
        paths.append(path)
    font = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", 25)

    def grid(count, *, wide=False):
        cols = count if wide else (2 if count == 4 else 4)
        rows = math.ceil(count / cols)
        board = Image.new("RGB", (cols * 480, rows * 480), "white")
        draw = ImageDraw.Draw(board)
        for i in range(count):
            x, y = i % cols * 480, i // cols * 480
            draw.text((x + 14, y + 6), f"#{i+1:02}", fill="black", font=font)
            board.paste(crops[i % 4], (x + 25, y + 42))
        path = OUT / f"grid-{count}{'-wide' if wide else ''}.png"
        board.save(path)
        return path

    grids = {n: grid(n) for n in (4, 8, 16)}
    wide = grid(16, wide=True)
    small = Image.open(grids[4]); small = small.resize((512, 512), Image.Resampling.LANCZOS)
    small.save(OUT / "grid-4-512.png")
    # 大图探针只改变像素尺寸，不宣称增加细节；只要求一个字，限制输出开销。
    large = Image.open(grids[4]).resize((3072, 3072), Image.Resampling.LANCZOS)
    large.save(OUT / "grid-4-3072.png")
    manifest = {"source": "fixtures/inspection/four-components.png", "synthetic": True,
                "source_sha256": hashlib.sha256((ROOT / "fixtures/inspection/four-components.png").read_bytes()).hexdigest(),
                "crop_boxes_xyxy": boxes, "rotation": "保留相同原始角度，隔离布局变量", "interpolation": "拼图不缩放裁片；512压力图和3072探针用Lanczos",
                "ground_truth": EXPECTED, "repeated_images_for_8_16": True}
    (OUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    cases = [{"id": f"single-{i+1}", "paths": [path], "expected": [EXPECTED[i]]} for i, path in enumerate(paths)]
    cases += [
        {"id": "original-four", "paths": [ROOT / "fixtures/inspection/four-components.png"], "expected": EXPECTED},
        {"id": "separate-four", "paths": paths, "expected": EXPECTED},
        *[{"id": f"grid-{n}", "paths": [grids[n]], "expected": EXPECTED * (n // 4)} for n in (4, 8, 16)],
        {"id": "grid-4-512", "paths": [OUT / "grid-4-512.png"], "expected": EXPECTED},
        {"id": "probe-960", "paths": [grids[4]], "expected": None},
        {"id": "probe-3072", "paths": [OUT / "grid-4-3072.png"], "expected": None},
        {"id": "rest-probe-960", "paths": [grids[4]], "expected": None, "rest": True},
        {"id": "rest-probe-3072", "paths": [OUT / "grid-4-3072.png"], "expected": None, "rest": True},
        {"id": "reference-and-grid-four", "paths": [ROOT / "fixtures/inspection/reference.png", grids[4]],
         "expected": EXPECTED, "comparison": True},
        {"id": "grid-16-wide", "paths": [wide], "expected": EXPECTED * 4},
    ]
    return cases


def score(text, expected):
    clean = text.strip()
    if clean.startswith("```"):
        clean = clean.split("\n", 1)[1].rsplit("```", 1)[0]
    try:
        data = json.loads(clean)
    except ValueError as exc:
        return {"json_valid": False, "schema_valid": False, "error": str(exc)}
    try:
        if not isinstance(data, dict) or not isinstance(data.get("items"), list):
            raise TypeError("期望带 items 数组的 JSON 对象")
        items = data["items"]
        if not all(isinstance(x, dict) and isinstance(x.get("lines"), list) for x in items):
            raise TypeError("元件记录应为带 lines 数组的对象")
        ids = [x["id"] for x in items]
        valid_ids = ids == list(range(1, len(expected) + 1))
        exact = sum(x.get("lines") == truth for x, truth in zip(items, expected)) if valid_ids else 0
        bad = [x["id"] for x in items if x.get("lines", [""])[0] == "SV385"]
        expected_bad = [i + 1 for i, x in enumerate(expected) if x[0] == "SV385"]
        return {"json_valid": True, "schema_valid": True, "ids_exact": valid_ids, "count": len(items), "exact_components": exact,
                "total": len(expected), "all_exact": valid_ids and exact == len(expected),
                "text_difference_ids_exact": valid_ids and bad == expected_bad, "items": items}
    except (ValueError, KeyError, TypeError, IndexError) as exc:
        return {"json_valid": True, "schema_valid": False, "error": str(exc)}


async def run(case):
    resources()
    async with httpx.AsyncClient(trust_env=False, timeout=5) as client:
        loaded = (await client.get("http://127.0.0.1:1234/api/v1/models")).json()
    instances = [i for m in loaded["models"] for i in m.get("loaded_instances", []) if i["id"] == MODEL]
    if not instances:
        raise RuntimeError(f"{MODEL} 未加载，本测试不会自动加载或切换模型")
    blocks = []
    for i, path in enumerate(case["paths"]):
        if case.get("comparison"):
            blocks.append({"type": "text", "text": "正品参考图：" if i == 0 else "待检元件拼图："})
        elif len(case["paths"]) > 1:
            blocks.append({"type": "text", "text": f"下图是元件 {i+1}。"})
        blocks.append({"type": "image_url", "image_url": {"url": "data:image/png;base64," + base64.b64encode(path.read_bytes()).decode()}})
    if case.get("comparison"):
        prompt = ('第一张是正品参考照片，第二张是4个待检元件的编号拼图。请抄录每个待检元件的全部三行丝印，并逐个与参考图比对，'
                  '只有文字完全一致才PASS，存在明确文字差异为FAIL，看不清为UNCERTAIN。不要把参考文字抄成待检文字。'
                  '只输出JSON：{"items":[{"id":1,"lines":["第一行","第二行","第三行"],"verdict":"PASS或FAIL或UNCERTAIN"}]}。'
                  '按拼图外的#编号，不把编号当成丝印。忽略拍摄角度和光照差异，本轮只测试文字比对。')
    elif case["expected"] is None:
        prompt = "只回答一个汉字：好。不要解释。"
    else:
        count = len(case["expected"])
        prompt = (f"请逐个抄录图片中的{count}个电子元件表面可见的全部丝印文字。只输出JSON："
                  '{"items":[{"id":1,"lines":["第一行","第二行","第三行"]}]}。'
                  "多张独立图片按传入顺序编号；拼图按图外#编号；无编号原图按先上后下、同行左到右编号。"
                  "保持字母大小写、字符和顺序，不根据其他元件推测，不把图外编号当丝印。看不清写?，不要补字、不要解释。")
    blocks.append({"type": "text", "text": prompt})
    started = time.monotonic()
    result = {"id": case["id"], "input_images": [{"path": str(p.relative_to(ROOT)), "size": list(Image.open(p).size),
                    "sha256": hashlib.sha256(p.read_bytes()).hexdigest()} for p in case["paths"]], "prompt": prompt,
              "model": MODEL, "temperature": 0, "enable_thinking": False, "expected": case["expected"]}
    print("START", case["id"], flush=True)
    try:
        if case.get("rest"):
            # 仅测预处理，不评判回答；一个输出 token，避免 REST 默认思考产生额外负载。
            async with httpx.AsyncClient(trust_env=False, timeout=55) as client:
                response = await client.post("http://127.0.0.1:1234/v1/chat/completions", json={
                    "model": MODEL, "messages": [{"role": "user", "content": blocks}],
                    "max_tokens": 1, "temperature": 0, "stream": False})
                response.raise_for_status()
                reply = response.json()
            result["enable_thinking"] = "REST 默认，未声明成功关闭；仅测预处理"
        else:
            async with LmStudioTransport("http://127.0.0.1:1234/v1", MODEL, str(TEMPLATE)) as transport:
                reply = await transport.complete([{"role": "user", "content": blocks}], None,
                                                  max_tokens=850 if case["expected"] and len(case["expected"]) > 8 else 500)
        result["response"] = reply
        result["finish_reason"] = reply["choices"][0]["finish_reason"]
        result["text"] = reply["choices"][0]["message"]["content"]
        if case["expected"]:
            result["score"] = score(result["text"], case["expected"])
            if case.get("comparison") and result["score"].get("schema_valid"):
                result["score"]["verdicts_exact"] = [x.get("verdict") for x in result["score"]["items"]] == ["PASS", "PASS", "FAIL", "PASS"]
    except Exception as exc:
        result["error"] = f"{type(exc).__name__}: {exc}"
    result["elapsed_seconds"] = round(time.monotonic() - started, 3)
    result["resources_after"] = resources()
    (OUT / f"{case['id']}.json").write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print("DONE", case["id"], result["elapsed_seconds"], result.get("score", {}), result.get("error", ""), flush=True)
    if "error" in result:
        raise RuntimeError("本轮请求失败；保留原始结果并停止，避免盲目重试")


async def main():
    global OUT, TEMPLATE, MODEL
    parser = argparse.ArgumentParser()
    parser.add_argument("--cases", default="")
    parser.add_argument("--retry-errors", action="store_true", help="显式重试已诊断的错误，旧记录另存")
    parser.add_argument("--model", default=MODEL)
    parser.add_argument("--template", type=Path)
    parser.add_argument("--output-dir", type=Path)
    args = parser.parse_args()
    if args.model != MODEL and (not args.template or not args.output_dir):
        parser.error("对比其他模型时必须显式提供 --template 和独立 --output-dir")
    MODEL = args.model
    if args.template:
        TEMPLATE = args.template.expanduser().resolve()
    if args.output_dir:
        OUT = args.output_dir.resolve()
    cases = prepare()
    selected = set(args.cases.split(",")) if args.cases else {c["id"] for c in cases}
    for case in cases:
        saved = OUT / f"{case['id']}.json"
        if saved.exists() and json.loads(saved.read_text()).get("model") != MODEL:
            raise RuntimeError("已有结果属于不同模型，请使用独立输出目录")
        if args.retry_errors and case["id"] in selected and saved.exists() and "error" in json.loads(saved.read_text()):
            saved.rename(OUT / f"{case['id']}.error-{time.time_ns()}.json")
        if case["id"] in selected and not (OUT / f"{case['id']}.json").exists():
            await run(case)
            await asyncio.sleep(3)


if __name__ == "__main__":
    asyncio.run(main())
