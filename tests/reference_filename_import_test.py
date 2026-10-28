"""Actual ZIP preflight: names, fields, images, duplicates and failure isolation."""
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile
import io
from PIL import Image

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'server/admin'))
import import_worker as worker

class FilenameImportTest(unittest.TestCase):
    def pack(self,names):
        self.folder=tempfile.TemporaryDirectory();self.addCleanup(self.folder.cleanup)
        folder=Path(self.folder.name);image=io.BytesIO();Image.new('RGB',(80,60),(20,30,40)).save(image,'PNG')
        filename=folder/'images.zip'
        with zipfile.ZipFile(filename,'w') as z:
            for name in names:z.writestr(name,image.getvalue())
        return worker.main({'files':[{'name':'图片.zip','path':str(filename)}],'folder':str(folder/'assets')})
    def test_folder_spaces_model_and_empty_description(self):
        result=self.pack(['图片/000123  STM32-F407   华信电子.png','图片/MAT-02\u3000SV358.PNG'])
        rows=result['rows'];self.assertEqual([r['status'] for r in rows],['ready','ready'])
        self.assertEqual((rows[0]['material'],rows[0]['supplier'],rows[0]['modelNumber']),('000123','华信电子','STM32-F407'))
        self.assertEqual(rows[1]['supplier'],'');self.assertEqual(rows[1]['modelNumber'],'SV358');self.assertEqual(rows[0]['description'],'');self.assertEqual(len(result['assets']),1)
    def test_bad_filename_is_visible_without_guessing_or_partial_standard_writes(self):
        result=self.pack(['只有一个名字.png','001 供应商 型号 多余.png','002 供应商 型号.png'])
        self.assertEqual([r['status'] for r in result['rows']],['error','ready','error'])
        self.assertEqual(result['rows'][0]['imagePath'],'001 供应商 型号 多余.png')
        self.assertTrue(all('三段' in r['message'] for r in result['rows'] if r['status']=='error'))
    def test_same_batch_candidates_are_preserved_for_explicit_selection(self):
        result=self.pack(['第一组/001 型号A 供应商.png','另一组/001 型号A.png','001 型号B.png'])
        self.assertEqual([r['status'] for r in result['rows']],['ready','ready','ready'])
        self.assertEqual(len(result['rows']),3)
    def test_path_traversal_still_rejected(self):
        with self.assertRaisesRegex(ValueError,'不安全'):self.pack(['../001 供应商 型号.png'])
    def test_template_zip_is_usable(self):
        with tempfile.TemporaryDirectory() as folder:
            result=worker.main({'files':[{'name':'示例.zip','path':str(ROOT/'templates/reference-import-v1/图片命名示例.zip')}],'folder':folder})
            self.assertEqual(len(result['rows']),2);self.assertTrue(all(r['status']=='ready' for r in result['rows']))

if __name__=='__main__':unittest.main()
