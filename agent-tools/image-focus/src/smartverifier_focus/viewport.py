"""Render a phone viewport from original pixels using one inverse affine map."""
import math
from typing import Literal

from PIL import Image
from pydantic import BaseModel, ConfigDict, Field, model_validator


class Viewport(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    mode: Literal["whole", "crop"] = "whole"
    aspect: Literal["1:1", "4:3", "3:4", "free"] = "1:1"
    aspect_ratio: float | None = Field(None, ge=0.125, le=8)
    zoom: float = Field(1, ge=1, le=12)
    rotation: float = Field(0, ge=-360, le=360)
    pan_x: float = Field(0, ge=-12, le=12)
    pan_y: float = Field(0, ge=-12, le=12)

    @model_validator(mode="after")
    def require_free_ratio(self):
        if self.aspect == "free" and self.aspect_ratio is None:
            raise ValueError("自由比例需要指定宽高比。")
        return self


def render_viewport(source: Image.Image, view: Viewport, max_side: int = 1280) -> tuple[Image.Image, dict]:
    if view.mode == "whole":
        result = source.copy()
        result.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
        return result, {"mode": "whole", "width": result.width, "height": result.height,
                        "source_size": list(source.size), "settings": view.model_dump(exclude_none=True)}
    rw, rh = (view.aspect_ratio, 1) if view.aspect == "free" else map(int, view.aspect.split(":"))
    width, height = round(max_side * rw / max(rw, rh)), round(max_side * rh / max(rw, rh))
    scale = max(width / source.width, height / source.height) * view.zoom
    angle = math.radians(view.rotation)
    c, s = math.cos(angle) / scale, math.sin(angle) / scale
    cx, cy = width * (0.5 + view.pan_x), height * (0.5 + view.pan_y)
    matrix = (c, s, source.width / 2 - c * cx - s * cy,
              -s, c, source.height / 2 + s * cx - c * cy)
    # Reject an empty viewport instead of spending an inference on white pixels.
    mask = Image.new("L", source.size, 255).transform((width, height), Image.Transform.AFFINE, matrix, Image.Resampling.NEAREST, fillcolor=0)
    coverage = sum(mask.histogram()[1:]) / (width * height)
    if coverage < 0.01:
        raise ValueError("取景框里没有足够的图片内容，请把图片拖回框内。")
    result = source.transform((width, height), Image.Transform.AFFINE, matrix, Image.Resampling.BICUBIC, fillcolor=(255, 255, 255))
    return result, {"mode": "crop", "width": width, "height": height, "source_size": list(source.size),
                    "settings": view.model_dump(exclude_none=True), "output_to_source_affine": list(matrix),
                    "source_coverage": round(coverage, 4), "effective_scale": scale,
                    "note": "Only these rendered pixels are sent to the model. White corners are padding; no generative enhancement."}
