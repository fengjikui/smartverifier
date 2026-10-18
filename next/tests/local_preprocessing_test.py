"""CPU几何测试，不调用模型；使用生成样本及明确标注的几何反例。"""
import importlib.util
from pathlib import Path
import tempfile
import unittest
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('worker', ROOT/'next/server/vision/local_worker.py')
worker=importlib.util.module_from_spec(spec);spec.loader.exec_module(worker)

class PreprocessingTest(unittest.TestCase):
    def test_six_generated_components(self):
        for name,count in [('single',1),('pair',2),('dim-three',3)]:
            with self.subTest(name=name),tempfile.TemporaryDirectory() as folder:
                r=worker.separate({'source':str(ROOT/f'fixtures/inspection/green-mat-v1/{name}.png'),'folder':folder,'label':'P001'})
                self.assertEqual(len(r['components']),count);self.assertEqual(r['coverage'],'complete')
                self.assertLessEqual(r['width'],4160);self.assertLessEqual(r['height'],3120)
                for c in r['components']:
                    self.assertEqual(c['quality']['state'],'usable');self.assertLessEqual(abs(c['rotationClockwiseDegrees']),45)
                    # 裁片中心反投影必须等于定位四角的中心。
                    a=c['modelView'];mapped=np.array(c['viewToUprightOriginal']).reshape(3,3)@np.array([(a['width']-1)/2,(a['height']-1)/2,1])
                    np.testing.assert_allclose(mapped[:2],np.array(c['quadPx']).mean(axis=0),atol=.01)
    def test_negative_and_exif(self):
        with tempfile.TemporaryDirectory() as folder:
            folder=Path(folder);image=Image.new('RGB',(800,600),(45,115,85));source=folder/'input.png';image.save(source)
            req={'source':str(source),'folder':str(folder),'label':'P001'}
            self.assertEqual(worker.separate(req)['coverage'],'uncertain')
            ImageDraw.Draw(image).rectangle((250,200,550,400),fill=(20,20,20));image.save(source)
            r=worker.separate(req);self.assertTrue(r['components'][0]['quality']['reasons'],'无纹理黑矩形不能通过质量门')
            real=Image.open(ROOT/'fixtures/inspection/green-mat-v1/single.png').filter(ImageFilter.GaussianBlur(14));real.save(source)
            r=worker.separate(req);self.assertTrue(r['components'][0]['quality']['reasons'],'严重模糊需重拍')
            original=Image.open(ROOT/'fixtures/inspection/green-mat-v1/single.png');exif=original.getexif();exif[274]=6;source=folder/'exif.jpg';original.save(source,exif=exif)
            r=worker.separate({**req,'source':str(source)});self.assertEqual((r['width'],r['height']),(1024,1536));self.assertEqual(r['originalToUpright'],[0,-1,1023,1,0,0,0,0,1])

if __name__=='__main__':unittest.main()
