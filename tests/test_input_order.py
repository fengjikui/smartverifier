import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server/vision"))
import unittest
from vlm_client.silkscreen_prompts import BATCH_PROMPT,ordered_messages,pair_fixed_prompt,PAIR_PROMPT_TEMPLATE


class InputOrderTests(unittest.TestCase):
    def test_dynamic_data_cannot_change_the_fixed_prefix_or_image_bytes(self):
        reference={'type':'image_url','image_url':{'url':'same reference bytes'}}
        sample1={'type':'image_url','image_url':{'url':'new photo one'}}
        sample2={'type':'image_url','image_url':{'url':'new photo two'}}
        one=ordered_messages(BATCH_PROMPT,'IDs one',reference,sample1,'prefix-first')
        two=ordered_messages(BATCH_PROMPT,'IDs two',reference,sample2,'prefix-first')
        self.assertEqual(one[:3],two[:3])
        self.assertEqual(['system','user','assistant','user'],[m['role'] for m in one])
        self.assertIs(reference,one[1]['content'][1]);self.assertIs(sample1,one[-1]['content'][1])
        self.assertNotIn('IDs one',str(one[:3]));self.assertIn('IDs one',str(one[-1]))
        old=ordered_messages(BATCH_PROMPT,'IDs one',reference,sample1,'legacy')
        self.assertEqual(BATCH_PROMPT+'IDs one',old[0]['content'][0]['text'])
        with self.assertRaises(ValueError):ordered_messages('fixed','ids',reference,sample1,'unknown')

    def test_pair_rule_keeps_standard_and_onsite_priority_without_dynamic_values(self):
        fixed=pair_fixed_prompt('允许批次号变化，核对型号')
        self.assertIn('允许批次号变化，核对型号',fixed)
        self.assertIn('以现场说明为准',fixed)
        self.assertNotIn('ONSITE',fixed);self.assertNotIn('STANDARD',fixed);self.assertNotIn('CID',fixed)
        self.assertIn('componentId',fixed);self.assertIn('instructionConflicts',fixed)
        # 保留旧模板作为可以复现的对照，不在生成时改写历史提示词。
        self.assertIn('ONSITE',PAIR_PROMPT_TEMPLATE)

if __name__=='__main__':unittest.main()
