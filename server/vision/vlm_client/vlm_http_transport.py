"""服务端配置的 VLM Chat Completions 流式适配；不依赖本机模型权重或模板。"""
from __future__ import annotations
import asyncio
import json
import ssl
import time
from urllib.parse import urlsplit
import httpx


class VlmHttpError(RuntimeError):pass


class VlmHttpTransport:
    def __init__(self,endpoint,model,*,api_key='',extra_body=None,ca_file='',http_transport=None):
        url=urlsplit(endpoint)
        if url.scheme not in ('http','https') or not url.hostname or url.username or url.password or url.query or url.fragment:
            raise ValueError('VLM地址无效')
        self.url=endpoint.rstrip('/')
        if not self.url.endswith('/chat/completions'):self.url+='/chat/completions'
        self.model=model;self.extra=extra_body if extra_body is not None else {}
        reserved={'model','messages','stream','stream_options','response_format','max_tokens','max_completion_tokens','temperature','tools','tool_choice'}
        if not isinstance(self.extra,dict) or reserved.intersection(self.extra):raise ValueError('VLM额外参数不能覆盖核心请求')
        headers={'Authorization':'Bearer '+api_key} if api_key else {}
        self.client=httpx.AsyncClient(headers=headers,trust_env=False,follow_redirects=False,
            verify=ssl.create_default_context(cafile=ca_file) if ca_file else True,transport=http_transport)

    async def __aenter__(self):await self.client.__aenter__();return self
    async def __aexit__(self,*args):await self.client.__aexit__(*args)

    async def complete(self,messages,tools,max_tokens,*,timeout_seconds=55,on_event=None,response_format=None):
        if not 1<=timeout_seconds<=180:raise ValueError('VLM超时必须在1到180秒之间')
        if tools:raise ValueError('此VLM检验适配器不执行工具调用')
        started=time.monotonic();first=None;parts=[];reasoning=[];usage={};finish=None;count=0;size=0
        def emit(kind,data=None):
            if on_event:on_event(kind,{'transportElapsedMs':round((time.monotonic()-started)*1000,2),**(data or {})})
        payload={**self.extra,'model':self.model,'messages':messages,'temperature':0,'max_tokens':max_tokens,'stream':True,'stream_options':{'include_usage':True}}
        if response_format:payload['response_format']={'type':'json_schema','json_schema':{'name':'silkscreen_inspection','strict':True,'schema':response_format}}
        emit('images_prepared')  # PNG已由调用方编码，HTTP传输未进行任何重采样。
        emit('prediction_started',{'provider':'openai-compatible','maxTokens':max_tokens,'temperature':0,
            'responseFormat':'json-schema' if response_format else 'prompt-json','schema':response_format,
            'enableThinking':self.extra.get('chat_template_kwargs',{}).get('enable_thinking') if isinstance(self.extra.get('chat_template_kwargs',{}),dict) else None})
        try:
            async with asyncio.timeout(timeout_seconds):
                async with self.client.stream('POST',self.url,json=payload,timeout=timeout_seconds) as response:
                    if response.status_code!=200:
                        # 不复制上游错误正文，避免服务回显凭证或内部信息进入浏览器/调试记录。
                        raise VlmHttpError(f'VLM服务返回HTTP {response.status_code}，请检查协议、模型名、权限及Schema支持；未自动降级。')
                    if 'text/event-stream' not in response.headers.get('content-type',''):raise VlmHttpError('VLM服务未返回约定的SSE流式响应。')
                    data=[]
                    async def consume(lines):
                        nonlocal first,finish,usage,count,size
                        if not lines:return
                        raw='\n'.join(lines)
                        if raw=='[DONE]':return True
                        size+=len(raw)
                        if size>5*1024*1024:raise VlmHttpError('VLM响应超过长度限制。')
                        try:chunk=json.loads(raw)
                        except (ValueError,TypeError):raise VlmHttpError('VLM流式响应不是有效JSON。') from None
                        if not isinstance(chunk,dict):raise VlmHttpError('VLM流式事件须为JSON对象。')
                        if chunk.get('error'):raise VlmHttpError('VLM服务在生成过程中返回错误。')
                        if chunk.get('usage'):usage=chunk['usage']
                        for choice in chunk.get('choices',[]):
                            if choice.get('index',0)!=0:raise VlmHttpError('VLM服务返回了非预期的多个候选结果。')
                            delta=choice.get('delta') or {}
                            if delta.get('tool_calls'):raise VlmHttpError('VLM意外返回工具调用，本件未产生判定。')
                            for field,channel in [('reasoning_content','reasoning'),('reasoning','reasoning'),('content','none')]:
                                text=delta.get(field)
                                if not text:continue
                                if not isinstance(text,str):raise VlmHttpError('VLM流片段内容类型无效。')
                                if first is None:first=time.monotonic()-started;emit('first_token')
                                (parts if channel=='none' else reasoning).append(text);count+=1
                                emit('fragment',{'content':text,'reasoningType':channel,'tokensCount':None})
                            if choice.get('finish_reason') is not None:finish=choice['finish_reason']
                    async for line in response.aiter_lines():
                        if not line:
                            if await consume(data):data=[];break
                            data=[]
                        elif line.startswith('data:'):data.append(line[5:].lstrip(' '))
                    await consume(data)
        except httpx.TimeoutException:raise TimeoutError('VLM请求超时') from None
        except httpx.HTTPError:raise VlmHttpError('无法连接VLM服务，请检查地址、网络及HTTPS证书。') from None
        if finish is None:raise VlmHttpError('VLM流提前结束，缺少完成标识，本件未产生判定。')
        elapsed=time.monotonic()-started
        completion=usage.get('completion_tokens');details=usage.get('completion_tokens_details') or {};reasoning_tokens=details.get('reasoning_tokens')
        stats={'timingSource':'client-http','timeToFirstTokenSec':first,'predictedTokensCount':completion,
            'tokensPerSecond':completion/(elapsed-first) if completion is not None and first is not None and elapsed>first else None,
            'tokensPerSecondScope':'输出token数/首片段至结束墙钟，可能包含推理token；非服务端纯解码统计','stopReason':finish,'fragmentCount':count}
        output=''.join(parts);emit('generation_finished',{'finishReason':finish,'stats':stats,'reasoningTokens':reasoning_tokens,'output':output})
        return {'choices':[{'finish_reason':finish,'message':{'role':'assistant','content':output}}],
            'usage':{**usage,'reasoning_tokens':reasoning_tokens},'vlm':{'provider':'openai-compatible','stats':stats,'observedReasoning':''.join(reasoning)}}
