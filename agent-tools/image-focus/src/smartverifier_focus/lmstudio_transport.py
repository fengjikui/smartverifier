"""Optional local LM Studio SDK transport with per-request Qwen thinking disabled.

Uses the installed model's own template, never edits it or loads another model.
The SDK remains optional for ordinary OpenAI-compatible/MCP deployments.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
from pathlib import Path
from urllib.parse import urlparse
import uuid


def request_template(path: str) -> tuple[dict, str]:
    source = Path(path).expanduser().read_text(encoding="utf-8")
    if "enable_thinking" not in source or "<think>" not in source:
        raise ValueError("Use this Qwen model's own enable_thinking-aware chat_template.jinja")
    # LM Studio's Jinja runtime does not implement HTML's safe filter. Its
    # prompt renderer has no HTML autoescaping; removing this no-op preserves
    # the model's JSON tool history without editing the installed template.
    # Qwen 4B uses an unsupported `sequence` test for JSON arrays. At this
    # branch strings/mappings have already been handled, so iterable is equivalent.
    compatible = source.replace(" | safe", "").replace("args_value is sequence", "args_value is iterable")
    template = "{% set enable_thinking = false %}\n" + compatible
    return {"type": "jinja", "jinjaPromptTemplate": {"template": template}, "stopStrings": []}, hashlib.sha256(source.encode()).hexdigest()


def sdk_reply(messages: list[dict], fallback: str = "") -> dict:
    content, calls = [], []
    for message in messages:
        if message["role"] != "assistant":
            continue
        for item in message["content"]:
            if item["type"] == "text":
                content.append(item["text"])
            elif item["type"] == "toolCallRequest":
                call = item["toolCallRequest"]
                calls.append({"id": call.get("id") or uuid.uuid4().hex, "type": "function",
                              "function": {"name": call["name"], "arguments": json.dumps(call.get("arguments") or {}, ensure_ascii=False)}})
    result = {"role": "assistant", "content": "".join(content) if messages else fallback}
    if calls:
        result["tool_calls"] = calls
    return result


class LmStudioTransport:
    def __init__(self, endpoint: str, model: str, template_path: str):
        parsed = urlparse(endpoint)
        if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost"} or parsed.username or parsed.password:
            raise ValueError("This heat-bounded SDK mode only accepts local LM Studio over HTTP")
        self.host, self.identifier = parsed.netloc, model
        self.template, self.template_sha256 = request_template(template_path)
        self.images = {}

    async def __aenter__(self):
        import lmstudio as lms
        self.lms = lms
        self.client = await lms.AsyncClient(self.host).__aenter__()
        try:
            # list_loaded never loads/reloads or changes the shared model's TTL.
            self.model = next((m for m in await self.client.llm.list_loaded() if m.identifier == self.identifier), None)
            if self.model is None:
                raise RuntimeError(f"Model {self.identifier!r} must already be loaded; no automatic model loading")
            return self
        except BaseException:
            await self.client.__aexit__(None, None, None)
            raise

    async def __aexit__(self, *exc):
        await self.client.__aexit__(*exc)

    async def history(self, messages: list[dict]):
        from lmstudio._sdk_models import ToolCallRequestData, ToolCallRequest
        chat = self.lms.Chat()
        for message in messages:
            role, items = message["role"], []
            if role == "tool":
                items.append({"type": "toolCallResult", "content": message["content"], "toolCallId": message["tool_call_id"]})
            else:
                content = message.get("content") or ""
                blocks = [{"type": "text", "text": content}] if isinstance(content, str) else content
                for block in blocks:
                    if block["type"] == "text":
                        items.append({"type": "text", "text": block["text"]})
                    elif block["type"] == "image_url":
                        url = block["image_url"]["url"]
                        if not url.startswith("data:image/png;base64,"):
                            raise ValueError("Only workspace-generated PNG data images are allowed")
                        key = hashlib.sha256(url.encode()).hexdigest()
                        if key not in self.images:
                            data = base64.b64decode(url.split(",", 1)[1], validate=True)
                            self.images[key] = await self.client.files.prepare_image(data, name=key + ".png")
                        items.append(self.images[key])
                    else:
                        raise ValueError(f"Unsupported content block {block['type']}")
                for call in message.get("tool_calls", []):
                    items.append(ToolCallRequestData(tool_call_request=ToolCallRequest(
                        type="function", id=call["id"], name=call["function"]["name"],
                        arguments=json.loads(call["function"]["arguments"]))))
            chat.add_entry(role, items)
        return chat

    async def complete(self, messages: list[dict], tools: list[dict] | None, max_tokens: int, *, timeout_seconds: float = 55) -> dict:
        from lmstudio.json_api import PredictionFragmentEvent, PredictionToolCallEvent
        from lmstudio._sdk_models import LlmPredictionConfig
        from msgspec import convert
        if not 1 <= timeout_seconds <= 180:
            raise ValueError("Request timeout must be between 1 and 180 seconds")
        async with asyncio.timeout(timeout_seconds):
            chat = await self.history(messages)
            config = {"temperature": 0, "maxTokens": max_tokens, "promptTemplate": self.template,
                      "contextOverflowPolicy": "stopAtLimit",
                      "rawTools": {"type": "toolArray", "tools": tools} if tools else {"type": "none"}}
            # Passing a plain dict invokes the SDK's recursive camelCase
            # conversion, corrupting JSON Schema property names such as
            # rotation_degrees. A typed struct preserves arbitrary JSON keys.
            config = convert(config, LlmPredictionConfig)
            replies, fragments, tool_requests = [], [], []
            reasoning_tokens = 0
            stream = await self.model.respond_stream(chat, config=config, on_message=lambda m: replies.append(m.to_dict()))
            async with stream:
                # SDK 1.5.0's public fragment iterator DROPS tool events; its act()
                # uses this event iterator too. Keep this version-pinned bridge
                # until the public streaming API exposes tool requests directly.
                async for event in stream._iter_events():
                    if isinstance(event, PredictionToolCallEvent):
                        tool_requests.append(event.arg.to_dict())
                    elif isinstance(event, PredictionFragmentEvent):
                        fragment = event.arg
                        fragments.append(fragment.to_dict())
                        if fragment.reasoning_type != "none":
                            reasoning_tokens += fragment.tokens_count
                        if reasoning_tokens > 16:
                            await stream.cancel()
                            break
                result = stream.result()
            if tool_requests:
                replies.append({"role": "assistant", "content": [
                    {"type": "toolCallRequest", "toolCallRequest": call} for call in tool_requests]})
            stats = result.stats.to_dict()
            stop = stats["stopReason"]
            finish = {"eosFound": "stop", "stopStringFound": "stop", "toolCalls": "tool_calls",
                      "maxPredictedTokensReached": "length"}.get(stop, "error")
            if reasoning_tokens > 16:
                finish = "error"
            return {"choices": [{"finish_reason": finish, "message": sdk_reply(replies, result.content)}],
                    "usage": {"prompt_tokens": stats.get("promptTokensCount"),
                              "completion_tokens": stats.get("predictedTokensCount"), "reasoning_tokens": reasoning_tokens},
                    "lmstudio": {"stats": stats, "messages": replies, "fragments": fragments,
                                 "template_source_sha256": self.template_sha256, "enable_thinking": False}}
