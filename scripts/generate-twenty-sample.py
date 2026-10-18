"""拼接既有虚构样片，构造20件UI样例；不调用模型，不作为准确率测试。"""
from pathlib import Path
import hashlib
import json
from PIL import Image, ImageOps

root = Path(__file__).resolve().parents[1]
folder = root / "fixtures" / "inspection"
columns, rows, cell_width, cell_height = 5, 4, 512, 400
failures = {2, 7, 13, 18}
board = Image.new("RGB", (columns * cell_width, rows * cell_height), (216, 214, 214))
sources = {}
for name in ("reference.png", "mismatch.png"):
    with Image.open(folder / name) as source:
        sources[name] = ImageOps.contain(source.convert("RGB"), (cell_width - 24, cell_height - 40), Image.Resampling.LANCZOS)
entries = []
for index in range(20):
    name = "mismatch.png" if index in failures else "reference.png"
    tile = sources[name]
    left = (index % columns) * cell_width
    top = (index // columns) * cell_height
    board.paste(tile, (left + (cell_width - tile.width) // 2, top + (cell_height - tile.height) // 2))
    entries.append({"index": index, "source": name, "expected": "FAIL" if index in failures else "PASS", "bbox": [index % 5 / 5, index // 5 / 4, .2, .25]})
output = folder / "twenty-components.png"
board.save(output, optimize=True)
manifest = {"synthetic": True, "purpose": "仅验证20件的界面、编号、进度和预设结果，不证明批量识别可行", "width": board.width, "height": board.height, "sha256": hashlib.sha256(output.read_bytes()).hexdigest(), "sources": {name: hashlib.sha256((folder / name).read_bytes()).hexdigest() for name in sources}, "components": entries}
(folder / "twenty-components.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"file": str(output), "width": board.width, "height": board.height, "components": 20, "failures": 4}, ensure_ascii=False))
