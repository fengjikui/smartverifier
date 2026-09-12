from __future__ import annotations

import hashlib
import io
import json
import math
import re
import shutil
import tempfile
import uuid
import warnings
from pathlib import Path

from PIL import Image, ImageCms, ImageFilter, ImageOps, UnidentifiedImageError

MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_SOURCE_PIXELS = 80_000_000
MAX_CROP_PIXELS = 16_000_000
ID_PATTERN = re.compile(r"^[0-9a-f]{32}$")


class FocusError(ValueError):
    """Invalid input; safe to return to an agent so it can correct the call."""


def number(value, name: str, low: float, high: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise FocusError(f"{name} must be a finite number in [{low}, {high}]")
    if not math.isfinite(value) or not low <= value <= high:
        raise FocusError(f"{name} must be a finite number in [{low}, {high}]")
    return float(value)


def integer(value, name: str, low: int, high: int) -> int:
    number(value, name, low, high)
    if not isinstance(value, int):
        raise FocusError(f"{name} must be an integer")
    return value


def bounded_size(size: tuple[int, int], scale: float, max_side: int) -> tuple[int, int]:
    factor = min(scale, max_side / max(size))
    return tuple(max(1, math.floor(d * factor)) for d in size)


def resized(image: Image.Image, size: tuple[int, int], method="lanczos") -> Image.Image:
    if size == image.size:
        return image.copy()
    filter_ = Image.Resampling.LANCZOS if method == "lanczos" else Image.Resampling.BICUBIC
    return image.resize(size, filter_)


def png(image: Image.Image, path: Path) -> None:
    # Do not leak GPS/EXIF, or accidentally apply the original ICC profile twice.
    clean = image.copy()
    clean.info.clear()
    clean.save(path, "PNG")


def json_write(path: Path, obj: dict) -> None:
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")


class ImageWorkspace:
    """Trusted host imports images; agents can only access opaque registered IDs.

    Each workspace is one trust boundary. Use a separate directory per tenant/job.
    All source coordinates refer to the EXIF-oriented, sRGB working image.
    """

    def __init__(self, root: str | Path):
        self.root = Path(root).expanduser().resolve()
        self.sources = self.root / "sources"
        self.artifacts = self.root / "artifacts"
        self.sources.mkdir(parents=True, exist_ok=True)
        self.artifacts.mkdir(parents=True, exist_ok=True)

    def import_image(self, path: str | Path) -> dict:
        """Host-side API only. Never expose arbitrary filesystem import to the model."""
        path = Path(path)
        if not path.is_file() or path.stat().st_size > MAX_FILE_BYTES:
            raise FocusError("Image must be a local file no larger than 64 MiB")
        with path.open("rb") as handle:
            data = handle.read(MAX_FILE_BYTES + 1)
        if len(data) > MAX_FILE_BYTES:
            raise FocusError("Image exceeds 64 MiB")
        notes = []
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("error", Image.DecompressionBombWarning)
                with Image.open(io.BytesIO(data)) as opened:
                    if opened.format not in {"JPEG", "PNG", "WEBP"}:
                        raise FocusError("Supported formats: JPEG, PNG, WebP (convert HEIC before import)")
                    if getattr(opened, "n_frames", 1) != 1:
                        raise FocusError("Animated/multi-frame images are not supported")
                    if opened.width * opened.height > MAX_SOURCE_PIXELS:
                        raise FocusError("Image exceeds 80 megapixels; split it before import")
                    stored_size = list(opened.size)
                    orientation = opened.getexif().get(274, 1)
                    original_format = opened.format
                    opened.load()
                    working = ImageOps.exif_transpose(opened)
                    alpha = working.convert("RGBA").getchannel("A") if "A" in working.getbands() or "transparency" in working.info else None
                    profile = working.info.get("icc_profile")
                    if profile:
                        try:
                            # Preserve CMYK/L modes for profiles of those colour spaces.
                            colour = working if working.mode in {"RGB", "CMYK", "L", "LAB"} else working.convert("RGB")
                            working = ImageCms.profileToProfile(colour, ImageCms.ImageCmsProfile(io.BytesIO(profile)), ImageCms.createProfile("sRGB"), outputMode="RGB")
                            notes.append("Embedded ICC profile converted to sRGB; original file retained")
                        except (ImageCms.PyCMSError, OSError, ValueError) as exc:
                            raise FocusError("Cannot interpret embedded colour profile; export an sRGB copy first") from exc
                    else:
                        if working.mode not in {"RGB", "RGBA", "L", "LA", "P", "1"}:
                            raise FocusError("Unsupported colour mode without ICC profile; export an 8-bit sRGB copy")
                        working = working.convert("RGB")
                        notes.append("No ICC profile: RGB interpreted as sRGB")
                    if alpha is not None:
                        background = Image.new("RGB", working.size, "white")
                        background.paste(working, mask=alpha)
                        working = background
                        notes.append("Transparency composited onto white")
                    if orientation != 1:
                        notes.append("EXIF orientation applied; coordinates use the upright working image")
        except (UnidentifiedImageError, OSError, SyntaxError, Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
            raise FocusError("Image cannot be decoded safely; provide a valid JPEG, PNG or WebP") from exc

        image_id = uuid.uuid4().hex
        staging = Path(tempfile.mkdtemp(prefix=".import-", dir=self.sources))
        try:
            (staging / "original.bin").write_bytes(data)
            png(working, staging / "source.png")
            meta = {
                "image_id": image_id, "width": working.width, "height": working.height,
                "stored_size_before_exif": stored_size, "original_format": original_format,
                "original_sha256": hashlib.sha256(data).hexdigest(),
                "source_png_sha256": hashlib.sha256((staging / "source.png").read_bytes()).hexdigest(),
                "coordinate_system": "upright source image; x right, y down; pixel edges; bbox [left, top, right, bottom]",
                "notes": notes,
            }
            json_write(staging / "metadata.json", meta)
            staging.rename(self.sources / image_id)
        finally:
            if staging.exists():
                shutil.rmtree(staging)
        return meta

    def _source(self, image_id: str) -> tuple[dict, Image.Image]:
        if not isinstance(image_id, str) or not ID_PATTERN.fullmatch(image_id):
            raise FocusError("Use a registered image_id; file paths and URLs are not accepted")
        directory = self.sources / image_id
        try:
            # Reject a redirected directory, including symlinks into another job.
            if directory.resolve().parent != self.sources.resolve() or directory.is_symlink():
                raise FocusError("Invalid source directory")
            source = directory / "source.png"
            metadata = directory / "metadata.json"
            if source.is_symlink() or metadata.is_symlink():
                raise FocusError("Invalid source entry")
            meta = json.loads(metadata.read_text(encoding="utf-8"))
            with Image.open(source) as im:
                return meta, im.copy()
        except (FileNotFoundError, UnidentifiedImageError, json.JSONDecodeError) as exc:
            raise FocusError("Unknown or invalid image_id; import the photo first") from exc

    def _save_result(self, metadata: dict, images: dict[str, Image.Image], model_keys: list[str]) -> dict:
        job_id = uuid.uuid4().hex
        staging = Path(tempfile.mkdtemp(prefix=".job-", dir=self.artifacts))
        try:
            outputs = {}
            for role, image in images.items():
                filename = f"{role}.png"
                png(image, staging / filename)
                outputs[role] = {
                    "path": f"artifacts/{job_id}/{filename}", "width": image.width, "height": image.height,
                    "mime_type": "image/png", "sha256": hashlib.sha256((staging / filename).read_bytes()).hexdigest(),
                }
            result = {"job_id": job_id, **metadata, "images": outputs, "model_image_roles": model_keys}
            json_write(staging / "result.json", result)
            staging.rename(self.artifacts / job_id)
            return result
        finally:
            if staging.exists():
                shutil.rmtree(staging)

    def inspect_image(self, image_id: str, max_side: int = 1280) -> dict:
        integer(max_side, "max_side", 256, 2048)
        meta, source = self._source(image_id)
        overview = resized(source, bounded_size(source.size, 1, max_side))
        return self._save_result({
            "operation": "overview", "source": meta,
            "overview_pixel_to_source_scale": [source.width / overview.width, source.height / overview.height],
            "instructions": "Locate on this overview using normalized [0,1] source coordinates. Use focus_image for details; overview is downsampled, not inspection evidence.",
        }, {"overview": overview}, ["overview"])

    @staticmethod
    def _box(bbox: list[float], size: tuple[int, int], coordinate_space: str, margin: float) -> tuple[int, int, int, int]:
        if coordinate_space not in {"normalized", "pixels"}:
            raise FocusError("coordinate_space must be normalized or pixels")
        if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
            raise FocusError("bbox must be [left, top, right, bottom]")
        width, height = size
        limits = [1, 1, 1, 1] if coordinate_space == "normalized" else [width, height, width, height]
        values = [number(v, f"bbox[{i}]", 0, limits[i]) for i, v in enumerate(bbox)]
        if coordinate_space == "normalized":
            values = [v * (width if i % 2 == 0 else height) for i, v in enumerate(values)]
        left, top, right, bottom = values
        if right <= left or bottom <= top:
            raise FocusError("bbox must have positive width and height")
        dx, dy = (right - left) * margin, (bottom - top) * margin
        # Only requested context is clipped; invalid caller coordinates are rejected.
        return (max(0, math.floor(left - dx)), max(0, math.floor(top - dy)), min(width, math.ceil(right + dx)), min(height, math.ceil(bottom + dy)))

    def focus_image(self, image_id: str, bbox: list[float], coordinate_space: str = "normalized",
                    rotation_degrees: float = 0, scale: float = 3, max_side: int = 1280,
                    margin: float = 0.08, resampling: str = "lanczos", sharpen: bool = False) -> dict:
        rotation_degrees = number(rotation_degrees, "rotation_degrees", -180, 180)
        scale = number(scale, "scale", 1, 6)
        margin = number(margin, "margin", 0, 0.5)
        integer(max_side, "max_side", 256, 2048)
        if resampling not in {"lanczos", "bicubic"} or not isinstance(sharpen, bool):
            raise FocusError("resampling must be lanczos/bicubic; sharpen must be a boolean")
        meta, source = self._source(image_id)
        box = self._box(bbox, source.size, coordinate_space, margin)
        return self._render_focus(meta, source, box, rotation_degrees, scale, max_side, resampling, sharpen,
                                  {"operation":"focus", "requested_bbox":list(bbox), "coordinate_space":coordinate_space})

    def _render_focus(self, meta: dict, source: Image.Image, box: tuple[int, int, int, int],
                      rotation_degrees: float, scale: float, max_side: int, resampling: str,
                      sharpen: bool, operation: dict) -> dict:
        if (box[2] - box[0]) * (box[3] - box[1]) > MAX_CROP_PIXELS:
            raise FocusError("Crop exceeds 16 megapixels; use a smaller bbox or tile_image first")
        raw = source.crop(box)
        # Pillow's 90-degree paths use exact pixel transposition. Other angles interpolate.
        upright = raw.rotate(-rotation_degrees, resample=Image.Resampling.BICUBIC, expand=True, fillcolor=(255, 255, 255))
        model_view = resized(upright, bounded_size(upright.size, scale, max_side), resampling)
        images = {"raw_crop": raw, "model_view": model_view}
        # A small evidence image keeps the second model input bounded. Full pixels remain on disk.
        evidence = resized(raw, bounded_size(raw.size, 1, 1024))
        images["evidence_view"] = evidence
        roles = ["evidence_view", "model_view"]
        if sharpen:
            images["sharpened_view"] = model_view.filter(ImageFilter.UnsharpMask(radius=1, percent=60, threshold=3))
            roles.append("sharpened_view")
        c, s = round(math.cos(math.radians(rotation_degrees)), 15), round(math.sin(math.radians(rotation_degrees)), 15)
        sx, sy = upright.width / model_view.width, upright.height / model_view.height
        # Pixel-edge affine mapping, including expanded white rotation padding.
        inverse = [[c * sx, s * sy, box[0] + raw.width / 2 - c * upright.width / 2 - s * upright.height / 2],
                   [-s * sx, c * sy, box[1] + raw.height / 2 + s * upright.width / 2 - c * upright.height / 2]]
        notes = ["Interpolation does not recover missing detail. Do not infer authenticity or unreadable characters from this tool alone."]
        if min(raw.size) < 64:
            notes.append("Very few source pixels in this region; consider a closer photo. Enlargement adds no measured detail.")
        if max(upright.size) * scale > max_side:
            notes.append("Requested enlargement capped by max_side; inspect effective_scale_xy (it can be less than 1).")
        if rotation_degrees % 90:
            notes.append("Arbitrary-angle rotation uses bicubic interpolation; white corners are padding, not the component.")
        if sharpen:
            notes.append("sharpened_view is auxiliary and can introduce halos; compare against evidence_view and model_view.")
        return self._save_result({
            **operation, "source": meta,
            "source_bbox_pixels": list(box), "source_bbox_normalized": [v / (source.width if i % 2 == 0 else source.height) for i, v in enumerate(box)],
            "rotation_degrees_clockwise": rotation_degrees, "rotation_expanded_size": list(upright.size),
            "requested_scale": scale, "effective_scale_xy": [model_view.width / upright.width, model_view.height / upright.height],
            "resampling": resampling, "max_side": max_side, "sharpen": sharpen, "generative_restoration": False,
            "model_pixel_to_source_affine": inverse,
            "evidence_downsampled": evidence.size != raw.size,
            "instructions": "Images are labelled by role. raw_crop is pixel-exact relative to the upright sRGB source. model_view is rotated/resized. All future bboxes refer to the source; use map_focus_region for a box located in this model_view.",
            "warnings": notes,
        }, images, roles)

    def rotate_image(self, job_id: str, rotation_degrees: float, angle_mode: str = "relative",
                     max_side: int | None = None) -> dict:
        """Rotate a previous crop/view by regenerating from the exact original ROI.

        Relative angles act on the previous model_view. Absolute angles replace
        its total rotation relative to the upright source. No new margin is added.
        """
        delta = number(rotation_degrees, "rotation_degrees", -360, 360)
        if angle_mode not in {"relative", "absolute"}:
            raise FocusError("angle_mode must be relative or absolute")
        if max_side is not None:
            integer(max_side, "max_side", 256, 2048)
        previous = self._focus_result(job_id)
        old_angle = previous["rotation_degrees_clockwise"]
        angle = (old_angle + delta if angle_mode == "relative" else delta) % 360
        if angle > 180:
            angle -= 360
        if max_side is None:
            old_view = previous["images"]["model_view"]
            max_side = previous.get("max_side", max(256, old_view["width"], old_view["height"]))
        meta, source = self._source(previous["source"]["image_id"])
        box = tuple(previous["source_bbox_pixels"])
        return self._render_focus(meta, source, box, angle, previous["requested_scale"], max_side,
                                  previous["resampling"], previous.get("sharpen", "sharpened_view" in previous["images"]),
                                  {"operation":"rotate", "parent_job_id":job_id,
                                   "requested_bbox":list(box), "coordinate_space":"pixels",
                                   "angle_mode":angle_mode, "requested_rotation_degrees":delta,
                                   "previous_rotation_degrees_clockwise":old_angle,
                                   "rotation_note":"Relative is applied to the parent model_view; absolute is relative to the upright source. Rotation is regenerated from source pixels, with the same crop and no additional margin. Use this result's new job_id for the next rotate/map operation."})

    def tile_image(self, image_id: str, columns: int = 4, rows: int = 3, start: int = 0,
                   count: int = 4, overlap: float = 0.15, max_side: int = 1024) -> dict:
        integer(columns, "columns", 1, 20)
        integer(rows, "rows", 1, 20)
        integer(start, "start", 0, rows * columns - 1)
        integer(count, "count", 1, 6)
        number(overlap, "overlap", 0, 0.5)
        integer(max_side, "max_side", 256, 1280)
        meta, source = self._source(image_id)
        images, tiles = {}, []
        for index in range(start, min(start + count, rows * columns)):
            row, col = divmod(index, columns)
            bbox = [col / columns, row / rows, (col + 1) / columns, (row + 1) / rows]
            box = self._box(bbox, source.size, "normalized", overlap / 2)
            crop = source.crop(box)
            role = f"tile_{index:03d}"
            images[role] = resized(crop, bounded_size(crop.size, 1, max_side))
            tiles.append({"index": index, "row": row, "column": col, "image_role": role,
                          "source_bbox_pixels": list(box), "source_bbox_normalized": [v / (source.width if i % 2 == 0 else source.height) for i, v in enumerate(box)]})
        return self._save_result({
            "operation": "tiles", "source": meta, "tiles": tiles, "total_tiles": rows * columns,
            "next_start": start + count if start + count < rows * columns else None,
            "instructions": "Overlapping search tiles, not detected components. A component may appear twice or cross boundaries. For a tile-local normalized bbox [l,t,r,b], map x=L+x*(R-L), y=T+y*(B-T) using that tile's source_bbox_normalized, then focus_image on the source. Review all pages for full coverage.",
        }, images, list(images))

    def _focus_result(self, job_id: str) -> dict:
        if not isinstance(job_id, str) or not ID_PATTERN.fullmatch(job_id):
            raise FocusError("Invalid job_id")
        directory = self.artifacts / job_id
        path = directory / "result.json"
        if directory.is_symlink() or path.is_symlink():
            raise FocusError("Invalid result entry")
        try:
            result = json.loads(path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError) as exc:
            raise FocusError("Unknown job_id") from exc
        if result["operation"] not in {"focus", "rotate"}:
            raise FocusError("job_id must identify a focus_image or rotate_image result")
        return result

    def map_focus_region(self, job_id: str, bbox: list[float]) -> dict:
        """Map a normalized model_view box back to an enclosing SOURCE box, without resampling."""
        result = self._focus_result(job_id)
        view = result["images"]["model_view"]
        box = self._box(bbox, (view["width"], view["height"]), "normalized", 0)
        a, b, tx = result["model_pixel_to_source_affine"][0]
        c, d, ty = result["model_pixel_to_source_affine"][1]
        points = [(a*x+b*y+tx, c*x+d*y+ty) for x, y in [(box[0],box[1]),(box[2],box[1]),(box[2],box[3]),(box[0],box[3])]]
        # Clip the mapped polygon, not just its envelope: a white padded corner
        # can have an envelope touching the source while containing no real pixels.
        polygon = points
        left, top, right, bottom = result["source_bbox_pixels"]
        for axis, bound, keep_greater in [(0,left,True),(0,right,False),(1,top,True),(1,bottom,False)]:
            clipped = []
            if not polygon:
                break
            prev = polygon[-1]
            prev_in = prev[axis] >= bound if keep_greater else prev[axis] <= bound
            for cur in polygon:
                cur_in = cur[axis] >= bound if keep_greater else cur[axis] <= bound
                if cur_in != prev_in:
                    t = (bound - prev[axis]) / (cur[axis] - prev[axis])
                    clipped.append(tuple(prev[j] + t * (cur[j] - prev[j]) for j in (0, 1)))
                if cur_in:
                    clipped.append(cur)
                prev, prev_in = cur, cur_in
            polygon = clipped
        if len(polygon) < 3:
            raise FocusError("Selected region is rotation padding; select a region on the component")
        twice_area = abs(sum(p[0]*q[1] - q[0]*p[1] for p, q in zip(polygon, polygon[1:] + polygon[:1])))
        if twice_area < 1e-6:
            raise FocusError("Selected region has no source pixels")
        xs, ys = zip(*polygon)
        mapped = [max(left, min(xs)), max(top, min(ys)), min(right, max(xs)), min(bottom, max(ys))]
        if mapped[2] - mapped[0] < 1e-6 or mapped[3] - mapped[1] < 1e-6:
            raise FocusError("Selected region has no source pixels")
        width, height = result["source"]["width"], result["source"]["height"]
        return {"image_id": result["source"]["image_id"], "bbox": [v / (width if i % 2 == 0 else height) for i, v in enumerate(mapped)],
                "coordinate_space": "normalized", "rotation_degrees": result["rotation_degrees_clockwise"],
                "note": "Enclosing axis-aligned source box; may include extra context after rotation. Call focus_image with margin=0 to reuse these bounds. Always resample from source."}
