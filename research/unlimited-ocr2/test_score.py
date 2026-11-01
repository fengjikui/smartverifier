import unittest
from score import code_counts,score


class ScoreTests(unittest.TestCase):
    def test_title_level_metadata_is_not_text(self):
        raw = '<PAGE><BLOCK>title<LEVEL1>[368, 535, 696, 625]<FORK>SY358'
        self.assertEqual(code_counts(raw), {'SY358': 1})

    def test_full_code_and_repetition(self):
        raw='<PAGE><BLOCK>text[1,2,999,99]<FORK>SV358 SV358 SV385'
        parts=[{'primary':'SV358','required':['SV358'],'reference':'SV358'}]*2+[
            {'primary':'SV385','required':['SV385'],'reference':'SV358'}]
        r=score(raw,parts)
        self.assertEqual(r['primary_count_matches'],3)
        self.assertEqual(r['anomaly_code_matches'],1)
        r=score('SV358 SV358 SV358',parts)
        self.assertEqual(r['primary_count_matches'],2)
        self.assertEqual(r['anomaly_code_matches'],0)

    def test_no_fuzzy_correction_or_substring_credit(self):
        self.assertNotIn('NE555',code_counts('NE555P'))
        p={'primary':'O0I1Z2','required':['O0I1Z2'],'reference':'O0I1Z2'}
        self.assertFalse(score('00I1Z2',[p])['primary_exact'])
        p={'primary':'Q65S208B','required':['Q65S208B'],'reference':'QG5S208B'}
        r=score('QG5S208B',[p]);self.assertFalse(r['primary_exact'])
        self.assertTrue(r['false_reference_transcription'])

    def test_no_text_or_incomplete_is_not_success(self):
        p={'primary':'J8','required':['J8'],'reference':'J3'}
        r=score('<PAGE><BLOCK>figure[0,0,999,999]<FORK>',[p])
        self.assertFalse(r['primary_exact'])
        r=score('J8',[p],complete=False)
        self.assertFalse(r['complete_output'])


if __name__=='__main__':unittest.main()
