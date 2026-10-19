"""Local opt-in inference evidence. Image bytes are snapshotted, never synthesized."""
from __future__ import annotations
import base64
import hashlib
from io import BytesIO
import json
import os
from pathlib import Path
import time
import uuid
from PIL import Image


class ItemScanner:
    """Observe complete objects in the root items array; not a contract validator."""
    def __init__(self):
        self.text = ""
        self.position = 0
        self.stack = []
        self.quoted = False
        self.escaped = False
        self.string_start = 0
        self.pending_items = False
        self.array_depth = None
        self.item_start = None

    def feed(self, fragment):
        self.text += fragment
        completed = []
        while self.position < len(self.text):
            index = self.position
            char = self.text[index]
            self.position += 1
            if self.quoted:
                if self.escaped:
                    self.escaped = False
                elif char == "\\":
                    self.escaped = True
                elif char == '"':
                    self.quoted = False
                    if self.stack == ['{']:
                        try:self.pending_items = json.loads(self.text[self.string_start:index+1]) == 'items'
                        except ValueError:self.pending_items = False
                continue
            if char == '"':
                self.quoted = True
                self.string_start = index
            elif char == ',' and self.stack == ['{']:
                self.pending_items = False
            elif char in '{[':
                if char == '[' and self.stack == ['{'] and self.pending_items:
                    self.array_depth = 2
                    self.pending_items = False
                if char == '{' and self.array_depth is not None and len(self.stack) == self.array_depth:
                    self.item_start = index
                self.stack.append(char)
            elif char in '}]' and self.stack:
                if char == '}' and self.array_depth is not None and len(self.stack) == self.array_depth+1 and self.item_start is not None:
                    try:
                        item = json.loads(self.text[self.item_start:index+1])
                        if isinstance(item, dict) and isinstance(item.get('componentId'), str):
                            completed.append(item)
                    except ValueError:
                        pass
                    self.item_start = None
                if char == ']' and len(self.stack) == self.array_depth:
                    self.array_depth = None
                self.stack.pop()
        return completed


class TraceWriter:
    def __init__(self, base, metadata, messages, trace_id=None):
        self.id = trace_id or str(uuid.uuid4())
        if str(uuid.UUID(self.id)) != self.id:
            raise ValueError('Invalid trace ID')
        self.folder = Path(base)/self.id
        self.folder.mkdir(parents=True, mode=0o700, exist_ok=False)
        self.started = time.monotonic()
        self.sequence = 0
        self.scanner = ItemScanner()
        self.first_output = None
        self.last_item = None
        self.item_count = 0
        self.stream = (self.folder/'events.ndjson').open('x', encoding='utf-8')
        os.chmod(self.folder/'events.ndjson', 0o600)
        safe_messages, images = [], []
        for message in messages:
            blocks = []
            for block in message['content']:
                if block['type'] == 'text':
                    blocks.append(block)
                elif block['type'] == 'image_url':
                    url = block['image_url']['url']
                    if not url.startswith('data:image/png;base64,'):
                        raise ValueError('Trace images must be actual PNG inputs')
                    data = base64.b64decode(url.split(',', 1)[1], validate=True)
                    filename = f'image-{len(images)}.png'
                    (self.folder/filename).write_bytes(data)
                    os.chmod(self.folder/filename, 0o600)
                    with Image.open(BytesIO(data)) as image:
                        meta = {'index':len(images), 'width':image.width, 'height':image.height,
                                'bytes':len(data), 'sha256':hashlib.sha256(data).hexdigest()}
                    images.append(meta)
                    blocks.append({'type':'image', 'imageIndex':meta['index']})
            safe_messages.append({'role':message['role'], 'content':blocks})
        self.emit('request', {**metadata, 'traceId':self.id, 'messages':safe_messages, 'images':images})

    def emit(self, kind, data=None):
        self.sequence += 1
        event = {'seq':self.sequence, 'type':kind, 'at':time.time(),
                 'elapsedMs':round((time.monotonic()-self.started)*1000, 2), **(data or {})}
        self.stream.write(json.dumps(event, ensure_ascii=False)+'\n')
        self.stream.flush()
        return event

    def observe(self, kind, data):
        event = self.emit(kind, data)
        if kind == 'fragment' and data.get('reasoningType') == 'none' and data.get('content'):
            if self.first_output is None:
                self.first_output = event['elapsedMs']
                self.emit('first_output', {'observedAtMs':self.first_output})
            for item in self.scanner.feed(data['content']):
                self.item_count += 1
                when = event['elapsedMs']
                self.emit('item_complete', {'componentId':item['componentId'], 'ordinal':self.item_count,
                          'observedAtMs':when, 'sinceOutputMs':round(when-self.first_output, 2),
                          'sincePreviousItemMs':round(when-(self.last_item if self.last_item is not None else self.first_output), 2),
                          'provisional':True, 'item':item})
                self.last_item = when

    def close(self):
        self.stream.close()
