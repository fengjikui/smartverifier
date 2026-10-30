"""整图解码回归：不裁剪，不用传统图像指标判断质量。"""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from PIL import Image, ImageDraw, ImageFilter

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('worker', ROOT/'server/vision/local_worker.py')
worker=importlib.util.module_from_spec(spec);spec.loader.exec_module(worker)

class PreprocessingTest(unittest.TestCase):
    def test_lmstudio_cli_uses_path_without_assuming_macos_location(self):
        with patch.object(worker.shutil, 'which', return_value='C:/模型工具/lms.exe'), patch.object(worker.sys, 'platform', 'win32'):
            self.assertEqual(worker.lmstudio_cli(), 'C:/模型工具/lms.exe')
        with tempfile.TemporaryDirectory() as tmp, patch.object(worker.shutil, 'which', return_value=None), patch.object(worker.Path, 'home', return_value=Path(tmp)):
            with self.assertRaisesRegex(RuntimeError, 'PATH'):
                worker.lmstudio_cli()

    def test_load_unavailable_on_windows(self):
        with patch.object(worker.os, 'getloadavg', create=True, side_effect=AttributeError('unavailable')):
            self.assertIsNone(worker.load_averages())

    def test_whole_photo_dimensions_and_pixels_untouched(self):
        import hashlib
        for name in ['single','pair','dim-three','reference-crop']:
            with self.subTest(name=name),tempfile.TemporaryDirectory() as folder:
                source=ROOT/f'fixtures/inspection/green-mat-v1/{name}.png'
                before=hashlib.sha256(source.read_bytes()).hexdigest()
                result=worker.inspect_image({'source':str(source),'folder':folder})
                with Image.open(source) as image:self.assertEqual((result['width'],result['height']),image.size)
                self.assertEqual(result['version'],'whole-photo-v1')
                self.assertEqual(list(Path(folder).iterdir()),[], '不能生成裁片、白板或编号图')
                self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(),before)
                self.assertNotIn('quality',result)
        self.assertFalse(hasattr(worker,'separate'),'只保留分离器合同，不保留可调用的CV算法')

    def test_background_size_and_blur_do_not_gate_quality(self):
        with tempfile.TemporaryDirectory() as folder:
            source=Path(folder)/'input.png'
            for image in [Image.new('RGB',(16,12),'white'), Image.new('RGB',(800,600),(45,115,85)), Image.open(ROOT/'fixtures/inspection/green-mat-v1/single.png').filter(ImageFilter.GaussianBlur(30))]:
                image.save(source);result=worker.inspect_image({'source':str(source)})
                self.assertEqual((result['width'],result['height']),image.size)
                self.assertNotIn('quality',result);self.assertNotIn('coverage',result)

    def test_exif_only_and_format_safety(self):
        with tempfile.TemporaryDirectory() as folder:
            original=Image.new('RGB',(800,600),'gray');exif=original.getexif();exif[274]=6;source=Path(folder)/'exif.jpg';original.save(source,exif=exif)
            result=worker.inspect_image({'source':str(source)});self.assertEqual((result['width'],result['height']),(600,800))
            bmp=Path(folder)/'image.bmp';original.save(bmp)
            with self.assertRaisesRegex(ValueError,'JPG'):worker.inspect_image({'source':str(bmp)})

class MarkedReferenceTest(unittest.TestCase):
    def test_model_input_draws_rotated_regions_without_boxing_extra_background(self):
        from server.vision.local_worker import mark_reference
        im=Image.new('RGB',(100,100),'white')
        mark_reference(im,[dict(kind='focus',x=.2,y=.2,width=.6,height=.6,polygon=[dict(x=.5,y=.2),dict(x=.8,y=.5),dict(x=.5,y=.8),dict(x=.2,y=.5)]),dict(kind='ignore',x=.02,y=.02,width=.1,height=.1)])
        self.assertEqual(im.getpixel((50,21)),(35,117,78))
        self.assertEqual(im.getpixel((20,20)),(255,255,255))
        self.assertEqual(im.getpixel((50,50)),(255,255,255))
        self.assertEqual(im.getpixel((2,2)),(210,140,0))

if __name__=='__main__':unittest.main()
