import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server/vision"))
import base64
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

from vlm_client.lmstudio_transport import LmStudioTransport, request_template, sdk_reply


class LmStudioTransportTests(unittest.IsolatedAsyncioTestCase):
    async def test_live_events_and_schema_are_passed_without_mutating_schema_keys(self):
        from lmstudio.json_api import PredictionFragmentEvent
        from lmstudio._sdk_models import LlmPredictionFragment
        events=[]
        class Stream:
            async def __aenter__(self):return self
            async def __aexit__(self,*exc):pass
            async def _iter_events(self):
                yield PredictionFragmentEvent(LlmPredictionFragment(content='{"items":[]}',tokens_count=7,contains_drafted=False,reasoning_type='none'))
            def result(self):return SimpleNamespace(content='{"items":[]}',stats=SimpleNamespace(to_dict=lambda:{'stopReason':'eosFound','predictedTokensCount':7}))
        transport=object.__new__(LmStudioTransport);transport.history=AsyncMock(return_value='chat');transport.model=AsyncMock()
        async def respond(*args,**kwargs):
            kwargs['on_prompt_processing_progress'](.5);kwargs['on_first_token']();return Stream()
        transport.model.respond_stream.side_effect=respond
        transport.template,transport.template_sha256={'type':'jinja','jinjaPromptTemplate':{'template':'fixture'},'stopStrings':[]},'fixture'
        schema={'type':'object','properties':{'rotation_degrees':{'type':'number'}}}
        await transport.complete([],None,100,on_event=lambda kind,data:events.append((kind,data)),response_format=schema)
        self.assertEqual(schema,transport.model.respond_stream.call_args.kwargs['response_format'])
        self.assertEqual(['image_prepare_started','images_prepared','prediction_started','prefill_progress','first_token','fragment','generation_finished'],[kind for kind,_ in events])
        self.assertEqual(0,events[-1][1]['reasoningTokens'])

    async def test_experiment_timeout_is_bounded_without_changing_the_default(self):
        transport=object.__new__(LmStudioTransport)
        for seconds in (0,181,float('inf')):
            with self.assertRaisesRegex(ValueError,'between 1 and 180'):
                await transport.complete([],None,100,timeout_seconds=seconds)

    async def test_sdk_tool_events_reach_agent_even_without_text_fragments(self):
        from lmstudio.json_api import PredictionToolCallEvent
        from lmstudio._sdk_models import ToolCallRequest
        event = PredictionToolCallEvent(ToolCallRequest(type="function", id="from-model", name="focus_image", arguments={"bbox": [0.1, 0.2, 0.8, 0.9]}))
        class Stream:
            async def __aenter__(self): return self
            async def __aexit__(self, *exc): pass
            async def _iter_events(self): yield event
            def result(self):
                return SimpleNamespace(content="", stats=SimpleNamespace(to_dict=lambda: {"stopReason": "eosFound", "predictedTokensCount": 100}))
        transport = object.__new__(LmStudioTransport)
        transport.history = AsyncMock(return_value="chat")
        transport.model = AsyncMock()
        transport.model.respond_stream.return_value = Stream()
        transport.template, transport.template_sha256 = {"type": "jinja", "jinjaPromptTemplate": {"template": "fixture"}, "stopStrings": []}, "fixture"
        result = await transport.complete([], [{"type": "function", "function": {"name": "focus_image", "parameters": {"type": "object", "properties": {"rotation_degrees": {"type": "number"}}}}}], 350)
        call = result["choices"][0]["message"]["tool_calls"][0]
        self.assertEqual("from-model", call["id"])
        self.assertEqual("focus_image", call["function"]["name"])
        self.assertIn("0.9", call["function"]["arguments"])
        transport.model.respond_stream.assert_awaited_once()
        config = transport.model.respond_stream.call_args.kwargs["config"].to_dict()
        self.assertIn("rotation_degrees", config["rawTools"]["tools"][0]["function"]["parameters"]["properties"])

    def test_template_override_does_not_write_model_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "chat_template.jinja"
            text = "{% if enable_thinking %}<think>{% endif %}"
            path.write_text(text)
            template, checksum = request_template(str(path))
            self.assertEqual(text, path.read_text())
            self.assertTrue(template["jinjaPromptTemplate"]["template"].startswith("{% set enable_thinking = false %}"))
            self.assertEqual(64, len(checksum))
            with self.assertRaisesRegex(ValueError, "local LM Studio"):
                LmStudioTransport("https://external.example/v1", "model", str(path))

    def test_real_tool_request_keeps_name_arguments_and_call_id(self):
        reply = sdk_reply([{"role": "assistant", "content": [{"type": "toolCallRequest", "toolCallRequest": {
            "type": "function", "id": "call-1", "name": "rotate_image", "arguments": {"job_id": "abc", "rotation_degrees": -90}}}]}])
        self.assertEqual("call-1", reply["tool_calls"][0]["id"])
        self.assertEqual("rotate_image", reply["tool_calls"][0]["function"]["name"])
        self.assertIn('-90', reply["tool_calls"][0]["function"]["arguments"])

    def test_qwen4b_array_test_is_adapted_without_changing_installed_template(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "chat_template.jinja"
            source = "{% if enable_thinking %}<think>{% endif %}{% if args_value is sequence %}{{ args_value | safe }}{% endif %}"
            path.write_text(source)
            template, _ = request_template(str(path))
            self.assertIn("args_value is iterable", template["jinjaPromptTemplate"]["template"])
            self.assertNotIn(" | safe", template["jinjaPromptTemplate"]["template"])
            self.assertEqual(source, path.read_text())

    async def test_history_preserves_tool_result_and_actual_image_bytes(self):
        import lmstudio
        transport = object.__new__(LmStudioTransport)
        transport.lms, transport.images, transport.client = lmstudio, {}, AsyncMock()
        handle = {"type": "file", "name": "crop.png", "identifier": "image-handle", "sizeBytes": 6, "fileType": "image"}
        transport.client.files.prepare_image.return_value = handle
        image_url = "data:image/png;base64," + base64.b64encode(b"pixels").decode()
        chat = await transport.history([
            {"role": "user", "content": "Inspect this"},
            {"role": "assistant", "tool_calls": [{"id": "call-1", "function": {"name": "focus_image", "arguments": '{"bbox":[0,0,1,1],"rotation_degrees":-90}'}}]},
            {"role": "tool", "tool_call_id": "call-1", "content": "actual crop metadata"},
            {"role": "user", "content": [{"type": "text", "text": "model_view"}, {"type": "image_url", "image_url": {"url": image_url}}]},
        ])
        data = chat._get_history_for_prediction()
        self.assertEqual("call-1", data["messages"][2]["content"][0]["toolCallId"])
        request = data["messages"][1]["content"][-1]["toolCallRequest"]
        self.assertEqual(-90, request["arguments"]["rotation_degrees"])
        self.assertEqual("image-handle", data["messages"][3]["content"][1]["identifier"])
        self.assertEqual(b"pixels", transport.client.files.prepare_image.call_args.args[0])


if __name__ == "__main__":
    unittest.main()
