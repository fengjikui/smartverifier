import base64
import hashlib
import io
import json
import math
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

from smartverifier_focus import FocusError, ImageWorkspace


class FocusTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.workspace = ImageWorkspace(self.root / "workspace")
        self.photo = Image.new("RGB", (320, 240), (20, 20, 20))
        draw = ImageDraw.Draw(self.photo)
        draw.rectangle((20, 30, 80, 100), fill=(230, 10, 20))
        draw.rectangle((200, 140, 250, 210), fill=(10, 220, 30))
        draw.text((90, 95), "NOVA VGT6", fill=(240, 240, 240))
        self.path = self.root / "photo.png"
        self.photo.save(self.path)
        self.meta = self.workspace.import_image(self.path)
        self.id = self.meta["image_id"]

    def tearDown(self):
        self.tmp.cleanup()

    def image(self, result, role):
        with Image.open(self.workspace.root / result["images"][role]["path"]) as im:
            return im.copy()

    def test_raw_crop_is_exact_and_original_is_unchanged(self):
        before = self.path.read_bytes()
        result = self.workspace.focus_image(self.id, [17, 22, 287, 225], "pixels", margin=0)
        expected = self.photo.crop((17, 22, 287, 225))
        self.assertIsNone(ImageChops.difference(expected, self.image(result, "raw_crop")).getbbox())
        self.assertEqual(before, self.path.read_bytes())
        self.assertEqual(before, (self.workspace.sources / self.id / "original.bin").read_bytes())
        self.assertEqual(hashlib.sha256(before).hexdigest(), result["source"]["original_sha256"])

    def test_overview_box_uses_source_resolution(self):
        overview = self.workspace.inspect_image(self.id, 256)
        self.assertEqual([1.25, 1.25], overview["overview_pixel_to_source_scale"])
        result = self.workspace.focus_image(self.id, [0.25, 0.25, 0.75, 0.75], margin=0, scale=2)
        self.assertEqual([80, 60, 240, 180], result["source_bbox_pixels"])
        self.assertEqual((320, 240), self.image(result, "model_view").size)

    def test_exif_orientation_and_metadata_removal(self):
        exif = Image.Exif()
        exif[274] = 6
        exif[270] = "private fixture annotation"
        phone = self.root / "phone.jpg"
        self.photo.save(phone, exif=exif)
        meta = self.workspace.import_image(phone)
        self.assertEqual((240, 320), (meta["width"], meta["height"]))
        result = self.workspace.focus_image(meta["image_id"], [0, 0, 1, 1], margin=0, scale=1)
        im = self.image(result, "raw_crop")
        self.assertEqual({}, dict(im.getexif()))
        # The original top-left red rectangle moves to the upright top-right.
        red = im.getpixel((189, 40))
        self.assertGreater(red[0], 200)
        self.assertLess(red[1], 30)

    def test_quarter_turn_is_exact_and_clockwise(self):
        result = self.workspace.focus_image(self.id, [0, 0, 1, 1], rotation_degrees=90, margin=0, scale=1)
        expected = self.photo.transpose(Image.Transpose.ROTATE_270)
        self.assertIsNone(ImageChops.difference(expected, self.image(result, "model_view")).getbbox())
        self.assertEqual([240, 320], result["rotation_expanded_size"])

    def test_standalone_rotation_keeps_roi_and_quarter_turn_pixels(self):
        first = self.workspace.focus_image(self.id, [0.1, 0.1, 0.8, 0.9], margin=0.08, scale=1)
        result = self.workspace.rotate_image(first["job_id"], 90)
        self.assertEqual("rotate", result["operation"])
        self.assertEqual(first["job_id"], result["parent_job_id"])
        self.assertEqual(first["source_bbox_pixels"], result["source_bbox_pixels"])
        expected = self.image(first, "raw_crop").transpose(Image.Transpose.ROTATE_270)
        self.assertIsNone(ImageChops.difference(expected, self.image(result, "model_view")).getbbox())
        self.assertEqual(first["images"]["raw_crop"]["sha256"], result["images"]["raw_crop"]["sha256"])

    def test_relative_absolute_and_full_circle_do_not_accumulate_interpolation(self):
        original = self.workspace.focus_image(self.id, [0, 0, 1, 1], rotation_degrees=12, margin=0, scale=1)
        relative = self.workspace.rotate_image(original["job_id"], -7)
        self.assertEqual(5, relative["rotation_degrees_clockwise"])
        direct = self.workspace.focus_image(self.id, [0,0,1,1], rotation_degrees=5, margin=0, scale=1)
        self.assertEqual(self.image(direct,"model_view").tobytes(), self.image(relative,"model_view").tobytes())
        restored = self.workspace.rotate_image(relative["job_id"], 0, "absolute")
        self.assertEqual(self.photo.tobytes(), self.image(restored,"model_view").tobytes())
        for _ in range(4):
            restored = self.workspace.rotate_image(restored["job_id"], 90)
        self.assertEqual(0, restored["rotation_degrees_clockwise"])
        self.assertEqual(self.photo.tobytes(), self.image(restored,"model_view").tobytes())

    def test_mapping_after_standalone_rotation_matches_direct_rotation(self):
        first = self.workspace.focus_image(self.id, [0,0,1,1], rotation_degrees=12, margin=0)
        rotated = self.workspace.rotate_image(first["job_id"], 20)
        direct = self.workspace.focus_image(self.id, [0,0,1,1], rotation_degrees=32, margin=0)
        mapped = self.workspace.map_focus_region(rotated["job_id"], [0.3,0.3,0.7,0.6])
        expected = self.workspace.map_focus_region(direct["job_id"], [0.3,0.3,0.7,0.6])
        self.assertEqual(expected, mapped)

    def test_rotation_limits_invalid_jobs_and_legacy_crop_results(self):
        first = self.workspace.focus_image(self.id, [0,0,1,1], max_side=256, scale=3)
        for args in [{"rotation_degrees":float("nan")}, {"rotation_degrees":True}, {"rotation_degrees":361},
                     {"rotation_degrees":10,"angle_mode":"guess"}, {"rotation_degrees":10,"max_side":4096}]:
            with self.subTest(args=args), self.assertRaises(FocusError):
                self.workspace.rotate_image(first["job_id"], **args)
        for bad in [self.id, "../source.png", "f"*32]:
            with self.subTest(bad=bad), self.assertRaises(FocusError):
                self.workspace.rotate_image(bad, 90)
        overview = self.workspace.inspect_image(self.id)
        with self.assertRaises(FocusError):
            self.workspace.rotate_image(overview["job_id"], 90)
        path = self.workspace.artifacts/first["job_id"]/"result.json"
        legacy = json.loads(path.read_text())
        legacy.pop("max_side")
        legacy.pop("sharpen")
        path.write_text(json.dumps(legacy))
        result = self.workspace.rotate_image(first["job_id"], 45)
        self.assertEqual(256, result["max_side"])
        self.assertLessEqual(max(self.image(result,"model_view").size), 256)

    def test_nonright_rotation_mapping_matches_coloured_landmarks(self):
        for angle in [17, -35, 90, -90, 180]:
            with self.subTest(angle=angle):
                result = self.workspace.focus_image(self.id, [0, 0, 1, 1], margin=0, rotation_degrees=angle, scale=2)
                view = self.image(result, "model_view")
                a, b, tx = result["model_pixel_to_source_affine"][0]
                c, d, ty = result["model_pixel_to_source_affine"][1]
                det = a*d-b*c
                source_x, source_y = 45.5, 60.5
                x = (d*(source_x-tx)-b*(source_y-ty))/det
                y = (-c*(source_x-tx)+a*(source_y-ty))/det
                colour = view.getpixel((int(x), int(y)))
                self.assertGreater(colour[0], 200)
                self.assertLess(colour[1], 30)
                mapped = self.workspace.map_focus_region(result["job_id"], [(x-2)/view.width, (y-2)/view.height, (x+2)/view.width, (y+2)/view.height])
                box = mapped["bbox"]
                self.assertLessEqual(box[0]*320, source_x)
                self.assertGreaterEqual(box[2]*320, source_x)
                self.assertLessEqual(box[1]*240, source_y)
                self.assertGreaterEqual(box[3]*240, source_y)

    def test_rotation_padding_is_not_source_content(self):
        result = self.workspace.focus_image(self.id, [0, 0, 1, 1], margin=0, rotation_degrees=45)
        with self.assertRaisesRegex(FocusError, "padding"):
            self.workspace.map_focus_region(result["job_id"], [0, 0, 0.03, 0.03])

    def test_nested_focus_returns_original_pixels(self):
        first = self.workspace.focus_image(self.id, [0.1, 0.1, 0.9, 0.9], margin=0, rotation_degrees=-28)
        args = self.workspace.map_focus_region(first["job_id"], [0.4, 0.4, 0.6, 0.6])
        args.pop("note")
        nested = self.workspace.focus_image(**args, margin=0)
        expected = self.photo.crop(nested["source_bbox_pixels"])
        self.assertIsNone(ImageChops.difference(expected, self.image(nested, "raw_crop")).getbbox())

    def test_output_cap_and_context_clipping_are_explicit(self):
        result = self.workspace.focus_image(self.id, [0, 0, 0.9, 0.9], margin=0.5, scale=6, max_side=256)
        self.assertEqual([0, 0, 320, 240], result["source_bbox_pixels"])
        self.assertLessEqual(max(self.image(result, "model_view").size), 256)
        self.assertLess(result["effective_scale_xy"][0], 1)
        self.assertTrue(any("capped" in w for w in result["warnings"]))

    def test_unsafe_or_ambiguous_arguments_are_rejected(self):
        for box in [[0, 0, 800, 800], [0, 0, 0, 0.5], [-0.1, 0, 1, 1], [0, 0, math.nan, 1], [0, 0, math.inf, 1], [False, 0, 1, 1]]:
            with self.subTest(box=box), self.assertRaises(FocusError):
                self.workspace.focus_image(self.id, box)
        for args in [{"scale": 100}, {"scale": True}, {"rotation_degrees": math.nan}, {"max_side": 4096}, {"max_side": 1024.5}, {"sharpen": "yes"}, {"coordinate_space": "1000"}]:
            with self.subTest(args=args), self.assertRaises(FocusError):
                self.workspace.focus_image(self.id, [0, 0, 1, 1], **args)
        for bad_id in ["../../photo.png", "https://example.test/a.png", "f"*32]:
            with self.subTest(bad_id=bad_id), self.assertRaises(FocusError):
                self.workspace.inspect_image(bad_id)

    def test_tile_pagination_covers_full_source_and_overlaps(self):
        all_tiles, start = [], 0
        while start is not None:
            result = self.workspace.tile_image(self.id, columns=3, rows=2, start=start, count=2)
            self.assertLessEqual(len(result["model_image_roles"]), 2)
            all_tiles.extend(result["tiles"])
            start = result["next_start"]
        coverage = Image.new("L", self.photo.size)
        draw = ImageDraw.Draw(coverage)
        for tile in all_tiles:
            l, t, r, b = tile["source_bbox_pixels"]
            draw.rectangle((l, t, r-1, b-1), fill=255)
        self.assertEqual((255, 255), coverage.getextrema())
        self.assertGreater(all_tiles[0]["source_bbox_pixels"][2], all_tiles[1]["source_bbox_pixels"][0])
        self.assertEqual(list(range(6)), [t["index"] for t in all_tiles])

    def test_optional_sharpening_keeps_baseline_and_raw(self):
        result = self.workspace.focus_image(self.id, [0.1, 0.1, 0.9, 0.9], sharpen=True)
        self.assertEqual(["evidence_view", "model_view", "sharpened_view"], result["model_image_roles"])
        self.assertFalse(result["generative_restoration"])
        self.assertIn("raw_crop", result["images"])

    def test_bad_files_and_animation_are_rejected(self):
        broken = self.root / "broken.png"
        broken.write_bytes(b"not an image")
        with self.assertRaises(FocusError):
            self.workspace.import_image(broken)
        animated = self.root / "animated.png"
        self.photo.save(animated, save_all=True, append_images=[Image.new("RGB", self.photo.size, "blue")])
        with self.assertRaises(FocusError):
            self.workspace.import_image(animated)

    def test_symlink_source_is_rejected(self):
        path = self.workspace.sources / self.id / "source.png"
        path.unlink()
        path.symlink_to(self.path)
        with self.assertRaises(FocusError):
            self.workspace.inspect_image(self.id)

    def test_resource_limits_fail_before_creating_artifacts(self):
        with patch("smartverifier_focus.core.MAX_CROP_PIXELS", 1000), self.assertRaises(FocusError):
            self.workspace.focus_image(self.id, [0, 0, 1, 1])
        self.assertEqual([], list(self.workspace.artifacts.iterdir()))
        with patch("smartverifier_focus.core.MAX_SOURCE_PIXELS", 1000), self.assertRaises(FocusError):
            self.workspace.import_image(self.path)
        with patch("smartverifier_focus.core.MAX_FILE_BYTES", 1), self.assertRaises(FocusError):
            self.workspace.import_image(self.path)


class AdapterTests(unittest.TestCase):
    def test_image_bytes_are_in_next_model_message(self):
        from mcp.types import CallToolResult, ImageContent, TextContent
        from smartverifier_focus.chat_adapter import tool_observation_messages

        buf = io.BytesIO()
        Image.new("RGB", (2, 2), "red").save(buf, "PNG")
        encoded = base64.b64encode(buf.getvalue()).decode("ascii")
        result = CallToolResult(content=[TextContent(type="text", text="Image role: model_view"), ImageContent(type="image", mimeType="image/png", data=encoded)])
        messages = tool_observation_messages("crop-call", result)
        self.assertEqual("tool", messages[0]["role"])
        self.assertEqual("crop-call", messages[0]["tool_call_id"])
        self.assertEqual("user", messages[1]["role"])
        image_url = messages[1]["content"][-1]["image_url"]["url"]
        self.assertEqual("data:image/png;base64,"+encoded, image_url)

    def test_error_does_not_create_fake_image_observation(self):
        from mcp.types import CallToolResult, TextContent
        from smartverifier_focus.chat_adapter import tool_observation_messages

        result = CallToolResult(isError=True, content=[TextContent(type="text", text="invalid bbox")])
        self.assertEqual(1, len(tool_observation_messages("bad-call", result)))


class MCPTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_stdio_roundtrip_returns_images_and_recoverable_errors(self):
        import sys
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "source.png"
            Image.new("RGB", (300, 200), (13, 91, 42)).save(path)
            workspace = ImageWorkspace(Path(tmp) / "work")
            image_id = workspace.import_image(path)["image_id"]
            params = StdioServerParameters(command=sys.executable, args=["-m", "smartverifier_focus.server", "--workspace", str(workspace.root)])
            async with stdio_client(params) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    tools = (await session.list_tools()).tools
                    self.assertEqual({"inspect_image", "focus_image", "rotate_image", "tile_image", "map_focus_region"}, {t.name for t in tools})
                    overview = await session.call_tool("inspect_image", {"image_id": image_id})
                    self.assertFalse(overview.isError)
                    result = await session.call_tool("focus_image", {"image_id": image_id, "bbox": [0.1, 0.2, 0.7, 0.8]})
                    self.assertFalse(result.isError)
                    images = [i for i in result.content if i.type == "image"]
                    self.assertEqual(2, len(images))
                    for block in images:
                        with Image.open(io.BytesIO(base64.b64decode(block.data))) as decoded:
                            self.assertEqual("PNG", decoded.format)
                            self.assertLessEqual(max(decoded.size), 1280)
                    self.assertEqual("focus", result.structuredContent["operation"])
                    rotated = await session.call_tool("rotate_image", {"job_id":result.structuredContent["job_id"],"rotation_degrees":90})
                    self.assertFalse(rotated.isError)
                    self.assertEqual("rotate", rotated.structuredContent["operation"])
                    self.assertEqual(2,len([b for b in rotated.content if b.type=="image"]))
                    mapped = await session.call_tool("map_focus_region", {"job_id":rotated.structuredContent["job_id"],"bbox":[0.2,0.2,0.8,0.8]})
                    self.assertFalse(mapped.isError)
                    bad = await session.call_tool("focus_image", {"image_id": image_id, "bbox": [0, 0, 900, 900]})
                    self.assertTrue(bad.isError)
                    strict = await session.call_tool("focus_image", {"image_id": image_id, "bbox": [False, 0, 1, 1]})
                    self.assertTrue(strict.isError)
                    recovered = await session.call_tool("tile_image", {"image_id": image_id, "count": 1})
                    self.assertFalse(recovered.isError)


if __name__ == "__main__":
    unittest.main()
