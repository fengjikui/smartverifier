import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock

import httpx
from mcp.types import CallToolResult, ImageContent, TextContent

from smartverifier_focus.agent import complete, execute_call, has_focus, image_events, redact_images, retire_overview


class AgentTests(unittest.IsolatedAsyncioTestCase):
    async def test_tool_executes_actual_model_arguments(self):
        result = CallToolResult(content=[TextContent(type="text", text="ok")])
        session = AsyncMock()
        session.call_tool.return_value = result
        args = {"image_id": "photo-id", "bbox": [0.1, 0.2, 0.6, 0.8], "rotation_degrees": -12}
        call = {"id": "call-1", "function": {"name": "focus_image", "arguments": json.dumps(args)}}
        returned = await execute_call(session, call, {"focus_image"}, "photo-id", set())
        session.call_tool.assert_awaited_once_with("focus_image", args)
        self.assertIs(returned, result)

    async def test_invalid_calls_and_other_images_do_not_execute(self):
        session = AsyncMock()
        cases = [
            {"name": "focus_image", "arguments": '{"image_id":"other-photo"}'},
            {"name": "focus_image", "arguments": "not-json"},
            {"name": "focus_image", "arguments": '{"image_id":"photo-id","rotationDegrees":-90}'},
            {"name": "delete_photo", "arguments": "{}"},
            {"name": "map_focus_region", "arguments": '{"job_id":"other-run"}'},
            {"name": "rotate_image", "arguments": '{"job_id":"other-run","rotation_degrees":90}'},
        ]
        for function in cases:
            with self.subTest(function=function):
                result = await execute_call(session, {"function": function}, {"focus_image", "rotate_image", "map_focus_region"}, "photo-id", set())
                self.assertTrue(result.isError)
        session.call_tool.assert_not_awaited()

    async def test_rotations_are_authorized_by_current_job_and_included_in_final_evidence(self):
        session = AsyncMock()
        args = {"job_id":"known-job","rotation_degrees":-90}
        call = {"function":{"name":"rotate_image","arguments":json.dumps(args)}}
        await execute_call(session, call, {"rotate_image"}, "photo-id", {"known-job"})
        session.call_tool.assert_awaited_once_with("rotate_image", args)
        events = [
            {"name":"focus_image","success":True,"result":{"operation":"focus"}},
            {"name":"rotate_image","success":True,"result":{"operation":"rotate"}},
            {"name":"rotate_image","success":False,"result":None},
        ]
        self.assertEqual(events[:2], image_events({"tool_events":events}))

    def test_text_claim_of_crop_does_not_count_as_real_focus(self):
        call = {"function": {"name": "focus_image"}}
        self.assertFalse(has_focus(call, CallToolResult(content=[TextContent(type="text", text="I enlarged it")], structuredContent={"operation":"focus"})))
        image = ImageContent(type="image", mimeType="image/png", data="AAAA")
        self.assertTrue(has_focus(call, CallToolResult(content=[image], structuredContent={"operation":"focus"})))
        self.assertFalse(has_focus(call, CallToolResult(isError=True, content=[image], structuredContent={"operation":"focus"})))

    def test_retiring_overview_preserves_crop_images_and_task(self):
        messages = [{"role":"user", "content":[{"type":"text", "text":"read floss"},{"type":"image_url","image_url":{"url":"data:overview"}}]},
                    {"role":"user", "content":[{"type":"image_url","image_url":{"url":"data:crop"}}]}]
        retire_overview(messages)
        self.assertEqual("read floss", messages[0]["content"][0]["text"])
        self.assertFalse(any(i["type"] == "image_url" for i in messages[0]["content"]))
        self.assertEqual("data:crop", messages[1]["content"][0]["image_url"]["url"])

    def test_redacting_audit_does_not_remove_real_request_pixels(self):
        original = [{"role":"user", "content":[{"type":"image_url","image_url":{"url":"data:secret-pixels"}}]}]
        redacted = redact_images(original)
        self.assertEqual("data:secret-pixels", original[0]["content"][0]["image_url"]["url"])
        self.assertNotIn("secret-pixels", json.dumps(redacted))

    async def test_truncated_response_is_saved_but_not_accepted(self):
        def handler(request):
            payload = json.loads(request.content)
            self.assertEqual("fixture-model", payload["model"])
            return httpx.Response(200, json={"choices":[{"finish_reason":"length","message":{"role":"assistant","content":"partial"}}]})
        with tempfile.TemporaryDirectory() as tmp:
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
                with self.assertRaisesRegex(RuntimeError, "partial response saved"):
                    await complete(client, "http://model.test/v1", "fixture-model", [], Path(tmp), "round")
            self.assertTrue((Path(tmp)/"round-response.json").exists())


if __name__ == "__main__":
    unittest.main()
