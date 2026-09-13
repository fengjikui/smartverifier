import asyncio
import base64
import io
import tempfile
import unittest
import uuid
from pathlib import Path

import httpx
from PIL import Image
from pydantic import ValidationError

from smartverifier_focus.viewport import Viewport, render_viewport
from smartverifier_focus.web import Store, create_app


def png(image):
    stream = io.BytesIO()
    image.save(stream, format="PNG")
    return stream.getvalue()


class ViewportTests(unittest.TestCase):
    def test_free_ratios_render_expected_sizes_and_keep_original_geometry(self):
        source = Image.new("RGB", (800, 400), "red")
        source.paste("blue", (400, 0, 800, 400))
        for ratio, expected in [(2.5, (1280, 512)), (.4, (512, 1280)), (8, (1280, 160)), (.125, (160, 1280))]:
            with self.subTest(ratio=ratio):
                output, meta = render_viewport(source, Viewport(mode="crop", aspect="free", aspect_ratio=ratio))
                self.assertEqual(expected, output.size)
                self.assertEqual(ratio, meta["settings"]["aspect_ratio"])
                self.assertEqual("free", meta["settings"]["aspect"])
                self.assertEqual((255, 0, 0), output.getpixel((output.width // 4, output.height // 2)))
                self.assertEqual((0, 0, 255), output.getpixel((output.width * 3 // 4, output.height // 2)))
        for ratio in [None, 0, -.5, 100, float("inf"), float("nan")]:
            with self.assertRaises(ValidationError):
                Viewport(mode="crop", aspect="free", aspect_ratio=ratio)

    def test_crop_excludes_other_half_of_original(self):
        source = Image.new("RGB", (800, 400), "red")
        source.paste("blue", (400, 0, 800, 400))
        crop, meta = render_viewport(source, Viewport(mode="crop", pan_x=.5), 400)
        self.assertEqual((400, 400), crop.size)
        self.assertEqual([(160000, (255, 0, 0))], crop.getcolors())
        self.assertEqual(1, meta["source_coverage"])

    def test_positive_rotation_is_clockwise_with_no_pixel_loss_at_90(self):
        source = Image.new("RGB", (4, 4), "red")
        source.paste("blue", (0, 2, 4, 4))
        crop, _ = render_viewport(source, Viewport(mode="crop", rotation=90), 4)
        self.assertEqual(source.transpose(Image.Transpose.ROTATE_270).tobytes(), crop.tobytes())

    def test_arbitrary_rotation_leaves_white_corners_and_rejects_empty_view(self):
        source = Image.new("RGB", (100, 100), "black")
        crop, meta = render_viewport(source, Viewport(mode="crop", rotation=45), 100)
        self.assertEqual((255, 255, 255), crop.getpixel((0, 0)))
        self.assertGreater(meta["source_coverage"], .8)
        with self.assertRaisesRegex(ValueError, "取景框"):
            render_viewport(source, Viewport(mode="crop", pan_x=12))
        with self.assertRaises(ValidationError):
            Viewport(rotation=float("nan"))

    def test_full_image_preserves_all_pixels_without_upscaling_small_input(self):
        source = Image.new("RGB", (400, 200), "green")
        result, _ = render_viewport(source, Viewport())
        self.assertEqual(source.size, result.size)
        self.assertEqual(source.tobytes(), result.tobytes())


class WebTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.received, self.gate = [], None
        async def models():
            await asyncio.sleep(0)  # Exercise the request retry race around SDK enumeration.
            return [{"id": "test-vlm", "name": "Test", "size": "4B", "available": True, "template": "test-only"}]
        async def predictor(messages, model):
            self.received.append(messages)
            if self.gate:
                await self.gate.wait()
            return {"choices": [{"finish_reason": "stop", "message": {"content": "这张图是红色。"}}]}
        self.app = create_app(Path(self.temp.name), predictor=predictor, models_provider=models)
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test", trust_env=False)
        await self.client.post("/api/connect", json={"key": self.app.state.store.key})

    async def asyncTearDown(self):
        tasks = list(self.app.state.tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await self.client.aclose()
        self.temp.cleanup()

    async def upload_view(self, crop=True, viewport=None):
        source = Image.new("RGB", (800, 400), "red")
        source.paste("blue", (400, 0, 800, 400))
        response = await self.client.post("/api/images", files={"file": ("sample.png", png(source), "image/png")})
        self.assertEqual(200, response.status_code, response.text)
        photo = response.json()
        response = await self.client.post("/api/views", json={"image_id": photo["id"], "viewport": viewport or {"mode": "crop" if crop else "whole", "pan_x": .5 if crop else 0}})
        self.assertEqual(200, response.status_code, response.text)
        return photo, response.json()

    async def submit(self, **kwargs):
        return await self.client.post("/api/chat", json={"model": "test-vlm", "text": "什么颜色？", "request_id": uuid.uuid4().hex, **kwargs})

    async def finish(self, ident):
        async with asyncio.timeout(3):
            while True:
                job = (await self.client.get(f"/api/jobs/{ident}")).json()
                if job["status"] in {"completed", "failed", "cancelled"}:
                    return job
                await asyncio.sleep(.01)

    async def test_exact_preview_pixels_only_are_sent_and_followup_retains_text(self):
        _, view = await self.upload_view(viewport={"mode": "crop", "aspect": "free", "aspect_ratio": 2.5, "zoom": 2, "pan_x": .5})
        response = await self.submit(view_id=view["id"])
        self.assertEqual(200, response.status_code, response.text)
        first = response.json()
        self.assertEqual("completed", (await self.finish(first["job_id"]))["status"])
        raw = (await self.client.get(view["url"])).content
        image_blocks = [block for message in self.received[0] if isinstance(message["content"], list) for block in message["content"] if block["type"] == "image_url"]
        self.assertEqual(1, len(image_blocks))
        self.assertEqual(raw, base64.b64decode(image_blocks[0]["image_url"]["url"].split(",")[1]))
        output = Image.open(io.BytesIO(raw))
        self.assertEqual((1280, 512), output.size)
        self.assertEqual((255, 0, 0), output.getpixel((640, 256)))
        self.assertEqual((255, 0, 0), output.getpixel((1270, 256)))
        self.assertEqual(2.5, view["settings"]["aspect_ratio"])
        # Change to whole image: previous crop is text history only, new pixels attached once.
        _, whole = await self.upload_view(crop=False)
        second = (await self.submit(chat_id=first["chat_id"], view_id=whole["id"], text="和刚才相比呢？")).json()
        await self.finish(second["job_id"])
        self.assertEqual(["system", "user", "assistant", "user"], [m["role"] for m in self.received[1]])
        self.assertEqual("这张图是红色。", self.received[1][2]["content"])
        self.assertEqual(1, sum(isinstance(m["content"], list) for m in self.received[1]))
        chat = (await self.client.get(f"/api/chats/{first['chat_id']}")).json()
        self.assertEqual(4, len(chat["messages"]))
        self.assertEqual(whole["id"], chat["view"]["id"])
        photo_id = chat["image"]["id"]
        self.assertEqual(422, (await self.client.post("/api/views", json={"image_id": photo_id, "viewport": {"mode": "crop", "aspect": "free"}})).status_code)

    async def test_unpaired_and_other_device_cannot_read_private_photos_or_chats(self):
        photo, view = await self.upload_view()
        job = (await self.submit(view_id=view["id"])).json()
        await self.finish(job["job_id"])
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test", trust_env=False) as other:
            self.assertEqual(401, (await other.get(view["url"])).status_code)
            self.assertEqual(401, (await other.post("/api/connect", json={"key": "wrong"})).status_code)
            await other.post("/api/connect", json={"key": self.app.state.store.key})
            for url in [view["url"], photo["preview_url"], f"/api/chats/{job['chat_id']}", f"/api/jobs/{job['job_id']}"]:
                self.assertEqual(404, (await other.get(url)).status_code)
            self.assertEqual([], (await other.get("/api/chats")).json()["chats"])
        self.assertEqual(403, (await self.client.post("/api/connect", json={"key": self.app.state.store.key}, headers={"origin": "http://other"})).status_code)

    async def test_parallel_retries_create_only_one_job(self):
        self.gate = asyncio.Event()
        ident = uuid.uuid4().hex
        first, second = await asyncio.gather(self.submit(request_id=ident), self.submit(request_id=ident))
        self.assertEqual(first.json(), second.json())
        self.assertEqual(1, len(self.app.state.store.data["jobs"]))
        self.gate.set()
        await self.finish(first.json()["job_id"])

    async def test_serial_queue_cancel_and_busy_chat_protection(self):
        self.gate = asyncio.Event()
        first = (await self.submit()).json()
        second = (await self.submit()).json()
        self.assertEqual(1, len(self.received))
        self.assertEqual("queued", (await self.client.get(f"/api/jobs/{second['job_id']}")).json()["status"])
        self.assertEqual(409, (await self.submit(chat_id=first["chat_id"])).status_code)
        cancelled = await self.client.post(f"/api/jobs/{second['job_id']}/cancel")
        self.assertEqual("cancelled", cancelled.json()["status"])
        cancelled = await self.client.post(f"/api/jobs/{first['job_id']}/cancel")
        self.assertEqual("cancelled", cancelled.json()["status"])
        self.assertEqual("cancelled", (await self.client.get(f"/api/chats/{first['chat_id']}")).json()["messages"][0]["status"])

    async def test_invalid_upload_and_unknown_model_return_actionable_errors(self):
        response = await self.client.post("/api/images", files={"file": ("bad.jpg", b"not an image", "image/jpeg")})
        self.assertEqual(400, response.status_code)
        self.assertEqual(409, (await self.submit(model="not-loaded")).status_code)

    async def test_restart_marks_interrupted_jobs_and_preserves_history(self):
        self.gate = asyncio.Event()
        job = (await self.submit()).json()
        restarted = Store(Path(self.temp.name))
        self.assertEqual("failed", restarted.data["jobs"][job["job_id"]]["status"])
        self.assertIsNone(restarted.data["chats"][job["chat_id"]]["active_job"])
        self.assertEqual("failed", restarted.data["chats"][job["chat_id"]]["messages"][0]["status"])


if __name__ == "__main__":
    unittest.main()
