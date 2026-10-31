"""生成固定人工选框的模拟产物，不进行CV检测，不访问业务数据。仅重建样例时需要Pillow。"""
from pathlib import Path
from PIL import Image
import hashlib,json
root=Path(__file__).resolve().parents[2]; folder=Path(__file__).resolve().parent
source=root/'fixtures/inspection/green-mat-v1/pair.png'
def save(name,data):
 (folder/name).write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
def asset(name,file):
 data=file.read_bytes()
 with Image.open(file) as im:w,h=im.size
 return dict(assetId=name,sha256=hashlib.sha256(data).hexdigest(),mime='image/png',width=w,height=h,bytes=len(data))
original=asset('starter-original',source); photo=dict(photoId='starter-photo',photoVersion=1,original=original,upright=original,originalToUpright=[1,0,0,0,1,0,0,0,1]);save('input.json',photo)
reference=asset('starter-reference',root/'fixtures/inspection/green-mat-v1/reference-crop.png')
save('basis.json',dict(referenceImage=reference,standardDescription='',onsiteInstruction='',promptVersion='starter-mock-v1',precedence='onsite_over_standard'))
assets={'starter-original':'../../fixtures/inspection/green-mat-v1/pair.png','starter-reference':'../../fixtures/inspection/green-mat-v1/reference-crop.png'}; components=[]; ocr=[]
with Image.open(source) as im:
 for i,(x,y,w,h) in enumerate([(140,220,460,550),(930,230,510,560)],1):
  cid=f'starter-c{i}';name=f'crop-{i}.png';im.crop((x,y,x+w,y+h)).save(folder/name);a=asset(cid,folder/name);assets[cid]=name
  components.append(dict(componentId=cid,photoId=photo['photoId'],photoVersion=1,sourceSha256=original['sha256'],quadPx=[[x,y],[x+w,y],[x+w,y+h],[x,y+h]],modelView=a,viewToUprightOriginal=[1,0,x,0,1,y,0,0,1],rotationClockwiseDegrees=0,quality=dict(state='undetermined',reasons=[]),routeHint='unclassified'))
  lines=['SV358' if i==1 else 'SV385','A26','0147']
  ocr.append(dict(requestId=f'starter-ocr-{i}',componentId=cid,photoId=photo['photoId'],photoVersion=1,sourceSha256=original['sha256'],inputSha256=a['sha256'],state='completed',lines=[dict(text=t,quadPx=[[0,j*h/3],[w,j*h/3],[w,(j+1)*h/3],[0,(j+1)*h/3]],score=None) for j,t in enumerate(lines)],engine='mock-ocr',modelVersion='fixture-v1',preprocessingVersion='manual-crops-v1',scoreMeaning='模拟读文无模型评分；文字框为示例行带，不是实测定位',elapsedMs=0,warnings=['固定样例返回，不是OCR预测；文字行框为接口占位示例'],error=None))
save('assets.json',assets)
save('separation.mock.json',dict(protocol='sv.vision.v1',photoId=photo['photoId'],photoVersion=1,sourceSha256=original['sha256'],separatorId='mock-manual-fixture',separatorVersion='v1',preprocessingVersion='manual-crops-v1',status='completed',coverage='complete',components=components,issues=[]))
save('ocr.mock.json',ocr)
save('reference-analysis.mock.json',dict(quality='clear',confidence=.95,ambiguities=[]))
print('已生成固定选框裁片和JSON；模拟数据不代表分割或OCR准确率。')
