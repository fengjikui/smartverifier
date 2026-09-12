"""Build a synthetic crowded-photo fixture and run the real image tool offline.

This illustrates the pixel pipeline, not factory photos or detection accuracy.
"""

import argparse
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps

from smartverifier_focus import ImageWorkspace


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    reference = Path(__file__).resolve().parents[3] / "public/images/reference.png"
    with Image.open(reference) as im:
        chip = im.convert("RGB").resize((530, 424), Image.Resampling.LANCZOS)
    chip = chip.rotate(-7, Image.Resampling.BICUBIC, expand=True, fillcolor=(231, 233, 232))
    tray = Image.new("RGB", (4032, 3024), (215, 220, 218))
    selected = None
    for row in range(5):
        for col in range(6):
            x, y = 80 + 650*col, 100 + 560*row
            tray.paste(chip, (x, y))
            if (row, col) == (2, 3):
                selected = [x, y, x+chip.width, y+chip.height]
    photo = output / "synthetic-tray.jpg"
    tray.save(photo, quality=92)
    workspace = ImageWorkspace(output / "workspace")
    meta = workspace.import_image(photo)
    overview = workspace.inspect_image(meta["image_id"], 1280)
    result = workspace.focus_image(meta["image_id"], selected, "pixels", rotation_degrees=-7, scale=3, max_side=1280, margin=0)
    tiles = workspace.tile_image(meta["image_id"], columns=6, rows=5, count=4)
    for role, name in [("raw_crop", "raw-crop.png"), ("model_view", "focused.png")]:
        (output / name).write_bytes((workspace.root / result["images"][role]["path"]).read_bytes())
    (output / "overview.png").write_bytes((workspace.root / overview["images"]["overview"]["path"]).read_bytes())
    (output / "result.json").write_text(json.dumps({"overview": overview, "focus": result, "tiles": tiles}, ensure_ascii=False, indent=2), encoding="utf-8")

    # Compare the same ROI from a globally reduced image versus original pixels.
    # Both use the SAME interpolation; this isolates why crop-before-resize matters.
    with Image.open(photo) as captured:
        reduced = captured.convert("RGB").resize((1008, 756), Image.Resampling.LANCZOS)
    reduced_box = [round(v/4) for v in selected]
    thumbnail_crop = reduced.crop(reduced_box).rotate(7, Image.Resampling.BICUBIC, expand=True, fillcolor="white")
    with Image.open(output / "focused.png") as im:
        focused = im.copy()
    panel_size = (600, 490)
    report = Image.new("RGB", (1304, 716), "#edf2f0")
    draw = ImageDraw.Draw(report)
    font = ImageFont.load_default(size=22)
    small = ImageFont.load_default(size=17)
    draw.text((40, 26), "SAME PHOTO. DIFFERENT PIXEL INPUT.", font=font, fill="#173d32")
    draw.text((40, 64), "Synthetic 4032 x 3024 tray / 30 repeated items / not a detection benchmark", font=small, fill="#51645c")
    for x, title, im in [(40, "A  Crop AFTER reducing full image", thumbnail_crop), (664, "B  Crop ORIGINAL pixels, then enlarge", focused)]:
        draw.text((x, 114), title, font=small, fill="#173d32")
        fitted = ImageOps.contain(im, panel_size, Image.Resampling.LANCZOS)
        draw.rectangle((x, 154, x+600, 644), fill="white")
        report.paste(fitted, (x+(600-fitted.width)//2, 154+(490-fitted.height)//2))
    draw.text((40, 658), "Both: non-generative interpolation. B retains available source detail; no new detail is recovered.", font=small, fill="#51645c")
    report.save(output / "comparison.png")
    print(json.dumps({"output": str(output), "image_id": meta["image_id"], "source_bbox_pixels": selected,
                      "actual_scale": result["effective_scale_xy"], "comparison": str(output / "comparison.png")}, indent=2))


if __name__ == "__main__":
    main()
