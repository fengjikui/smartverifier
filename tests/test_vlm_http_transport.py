import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server/vision"))
import json
import unittest
import httpx
from vlm_client.vlm_http_transport import VlmHttpTransport,VlmHttpError


def sse(chunks):return ''.join('data: '+(json.dumps(c,ensure_ascii=False) if isinstance(c,dict) else c)+'\n\n' for c in chunks)


class VlmHttpTests(unittest.IsolatedAsyncioTestCase):
    async def test_usage_missing_stays_unknown_and_reasoning_is_separate(self):
        events=[]
        def handler(req):return httpx.Response(200,headers={'Content-Type':'text/event-stream'},content=sse([
            {'choices':[{'delta':{'reasoning_content':'内部推理'},'finish_reason':None}]},
            {'choices':[{'delta':{'content':'{"items":[]}'},'finish_reason':'stop'}]},'[DONE]']))
        async with VlmHttpTransport('http://vlm.internal/v1','model',http_transport=httpx.MockTransport(handler)) as t:
            result=await t.complete([],None,100,on_event=lambda k,v:events.append((k,v)))
        self.assertEqual('{"items":[]}',result['choices'][0]['message']['content'])
        self.assertEqual('内部推理',result['vlm']['observedReasoning'])
        self.assertIsNone(result['vlm']['stats']['tokensPerSecond']);self.assertIsNone(result['usage']['reasoning_tokens'])
        self.assertEqual(['reasoning','none'],[v['reasoningType'] for k,v in events if k=='fragment'])

    async def test_invalid_or_truncated_stream_never_becomes_a_complete_answer(self):
        for headers,body in [({'Content-Type':'application/json'},'{"choices":[]}'),({'Content-Type':'text/event-stream'},sse([{'choices':[{'delta':{'content':'{"items":'},'finish_reason':None}]}])),({'Content-Type':'text/event-stream'},sse(['not-json'])),({'Content-Type':'text/event-stream'},sse([{'error':{'message':'private upstream detail'}}]))]:
            with self.subTest(body=body):
                async with VlmHttpTransport('http://vlm.internal/v1','model',http_transport=httpx.MockTransport(lambda r:httpx.Response(200,headers=headers,content=body))) as t:
                    with self.assertRaises(VlmHttpError):await t.complete([],None,100)

    async def test_redirect_and_server_error_never_echo_private_body_or_retry(self):
        calls=[]
        for status in [302,401,429,500]:
            def handler(req):calls.append(req);return httpx.Response(status,headers={'Location':'http://elsewhere.internal'},content='a-private-secret')
            async with VlmHttpTransport('http://vlm.internal/v1','model',api_key='a-private-secret',http_transport=httpx.MockTransport(handler)) as t:
                with self.assertRaises(VlmHttpError) as caught:await t.complete([],None,100)
                self.assertNotIn('a-private-secret',str(caught.exception))
        self.assertEqual(4,len(calls))

if __name__=='__main__':unittest.main()
