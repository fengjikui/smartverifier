"""验证白板不缩放、遮挡或串换裁片；不调用模型。"""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from PIL import Image

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('whiteboard',ROOT/'next/research/whiteboard-batching/benchmark.py')
benchmark=importlib.util.module_from_spec(spec);spec.loader.exec_module(benchmark)

class CompositionTest(unittest.TestCase):
    def test_every_crop_is_pixel_identical_and_label_outside(self):
        with tempfile.TemporaryDirectory() as directory:
            folder=Path(directory);components=[]
            for i in range(6):
                filename=folder/f'c{i}.png';Image.new('RGB',(40+i*4,45+i*3),(i*30,20,50)).save(filename)
                components.append({'componentId':f'C{i+1:02d}','image':benchmark.info(filename,folder)})
            for count in (4,6):
                chosen=[c['componentId'] for c in components[:count]]
                result=benchmark.compose(folder,components,chosen,f'sheet{count}.png')
                self.assertEqual(result['scale'],1)
                with Image.open(folder/result['file']) as image:
                    for p,c in zip(result['placements'],components):
                        with Image.open(folder/c['image']['file']) as source:
                            self.assertEqual(image.crop((p['x'],p['y'],p['x']+p['width'],p['y']+p['height'])).tobytes(),source.tobytes())
                        self.assertGreaterEqual(p['y'],48)

if __name__=='__main__':unittest.main()
