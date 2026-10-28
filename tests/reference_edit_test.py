from pathlib import Path
import io, tempfile, sys, unittest
from PIL import Image
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'server/admin'))
from edit_worker import edit

class ReferenceEditTest(unittest.TestCase):
 def test_crop_and_rotation_preserve_original_and_order(self):
  with tempfile.TemporaryDirectory() as folder:
   folder=Path(folder);source=folder/'original.png';im=Image.new('RGB',(100,80),'white');im.paste('red',(0,0,50,80));im.save(source);raw=source.read_bytes()
   out=edit(dict(source=str(source),folder=str(folder),filename='正品.png',angle=90,crop=dict(x=0,y=0,width=1,height=.5)))
   self.assertEqual(source.read_bytes(),raw)
   with Image.open(folder/out['id']) as image:
    self.assertEqual(image.size,(80,50));self.assertEqual(image.getpixel((40,25)),(255,0,0))
 def test_invalid_crop_and_nonfinite_rotation_rejected(self):
  with tempfile.TemporaryDirectory() as folder:
   source=Path(folder)/'a.png';Image.new('RGB',(100,80)).save(source);r=dict(source=str(source),folder=folder,filename='a.png')
   with self.assertRaisesRegex(ValueError,'超出'):edit(dict(r,angle=0,crop=dict(x=.9,y=0,width=.2,height=1)))
   with self.assertRaisesRegex(ValueError,'无效'):edit(dict(r,angle=float('nan')))
   with self.assertRaisesRegex(ValueError,'太小'):edit(dict(r,angle=0,crop=dict(x=0,y=0,width=.01,height=.01)))
if __name__=='__main__':unittest.main()
