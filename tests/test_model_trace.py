import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server/vision"))
import base64
from io import BytesIO
import json
from pathlib import Path
import tempfile
import unittest
from PIL import Image
from vlm_client.model_trace import ItemScanner, TraceWriter


class TraceTests(unittest.TestCase):
    def test_items_are_observed_at_object_end_with_escaped_and_nested_text(self):
        text=json.dumps({'note':'items','other':[{'componentId':'not-an-item'}],
             'items':[{'componentId':'C02','reason':'文字包含 } ] 与 " 引号','nested':{'key':['x']}},
                      {'componentId':'C01','lines':['中文']}], 'instructionConflicts':[]},ensure_ascii=False)
        scanner=ItemScanner();observed=[]
        for index,char in enumerate(text):
            for item in scanner.feed(char):observed.append((index,item))
        self.assertEqual(['C02','C01'],[item['componentId'] for _,item in observed])
        self.assertLess(observed[0][0],text.index('C01'))
        self.assertLess(observed[1][0],len(text)-1)

    def test_snapshot_is_exact_and_reasoning_does_not_complete_items(self):
        buffer=BytesIO();Image.new('RGB',(9,7),(100,120,130)).save(buffer,format='PNG');data=buffer.getvalue()
        messages=[{'role':'user','content':[{'type':'text','text':'实际中文提示'},
                  {'type':'image_url','image_url':{'url':'data:image/png;base64,'+base64.b64encode(data).decode()}}]}]
        with tempfile.TemporaryDirectory() as tmp:
            trace=TraceWriter(tmp,{'model':'fixture','componentIds':['C01']},messages)
            trace.observe('fragment',{'content':'{"items":[{"componentId":"fake"}]}','reasoningType':'reasoning'})
            trace.observe('fragment',{'content':'{"items":[{"componentId":"C01","lines":["S5"]}]}','reasoningType':'none'})
            trace.close()
            events=[json.loads(line) for line in (trace.folder/'events.ndjson').read_text().splitlines()]
            self.assertEqual(data,(trace.folder/'image-0.png').read_bytes())
            self.assertEqual(9,events[0]['images'][0]['width'])
            items=[e for e in events if e['type']=='item_complete'];self.assertEqual(['C01'],[e['componentId'] for e in items])
            self.assertTrue(items[0]['provisional']);self.assertGreaterEqual(items[0]['sinceOutputMs'],0)
            self.assertEqual([1,2,3,4,5],[e['seq'] for e in events])

if __name__=='__main__':unittest.main()
