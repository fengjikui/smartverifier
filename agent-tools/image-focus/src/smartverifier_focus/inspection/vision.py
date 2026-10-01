"""受约束检验台的器件轮廓定位。原始字节保留，裁片从原分辨率生成。"""
from __future__ import annotations
import hashlib
from io import BytesIO
from pathlib import Path
import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageOps

cv2.setNumThreads(2)
MAX_BYTES = 64 * 1024 * 1024


def decode(data: bytes):
    if not data or len(data)>MAX_BYTES:
        raise ValueError('照片应小于 64 MB。')
    try:source=Image.open(BytesIO(data))
    except Image.DecompressionBombError as exc:raise ValueError('照片像素数过大，请降低拍摄分辨率。') from exc
    with source:
        if source.format not in ('JPEG','PNG','WEBP') or source.width*source.height>80_000_000:
            raise ValueError('请使用不超过 8000 万像素的 JPG、PNG 或 WebP。')
        extension={'JPEG':'jpg','PNG':'png','WEBP':'webp'}[source.format]
        source.load()
        image=ImageOps.exif_transpose(source).convert('RGB')
        return image, extension


def locate(image: Image.Image, *, mode='single'):
    small=image.copy()
    small.thumbnail((1600,1600))
    scale=image.width/small.width
    rgb=np.asarray(small)
    gray=cv2.cvtColor(rgb,cv2.COLOR_RGB2GRAY)
    _,mask=cv2.threshold(cv2.GaussianBlur(gray,(5,5),0),0,255,cv2.THRESH_BINARY_INV+cv2.THRESH_OTSU)
    mask=cv2.morphologyEx(mask,cv2.MORPH_CLOSE,np.ones((5,5),np.uint8))
    contours,_=cv2.findContours(mask,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
    area=small.width*small.height
    found=[]
    for c in contours:
        a=cv2.contourArea(c)
        if not area*.004<=a<=area*.80:
            continue
        (cx,cy),(w,h),angle=cv2.minAreaRect(c)
        if min(w,h)<24 or max(w,h)/max(min(w,h),1)>7 or a/max(w*h,1)<.45:
            continue
        if w<h:
            w,h=h,w
            angle+=90
        if angle>90:
            angle-=180
        # 接近正方形时长边不足以判断文字方向，采用最小旋转，避免任意转 90°。
        if w/h<1.3 and abs(angle)>45:
            angle=angle-90 if angle>0 else angle+90
            w,h=h,w
        flags=[]
        box=cv2.boxPoints(((cx,cy),(w,h),angle))
        if np.any(box[:,0]<3) or np.any(box[:,1]<3) or np.any(box[:,0]>small.width-4) or np.any(box[:,1]>small.height-4):
            flags.append('器件靠近画面边缘，可能未拍完整')
        found.append({'center':[cx*scale,cy*scale],'size':[w*scale,h*scale],'angle':float(angle),
                      'box':(box*scale).round(2).tolist(),'flags':flags})
    # 按行从上到下、同行从左到右编号；轻微倾斜不改变同一行排序。
    found.sort(key=lambda x:(round(x['center'][1]/(image.height*.18)),x['center'][0]))
    photo_flags=[]
    if not found:
        photo_flags.append('没有可靠定位到器件，请换纯色背景或重新拍照')
    if len(found)>4:
        photo_flags.append(f'定位到 {len(found)} 个目标，请每张最多拍四个器件')
    if mode=='single' and len(found)>1:
        photo_flags.append('当前为单件拍摄，照片中定位到多个目标，请核对或重新拍摄')
    return found[:4], photo_flags


def crop_component(image, region):
    center=tuple(region['center'])
    w,h=region['size']
    # 引脚可能未进入黑色塑封体轮廓，按短边保留 32% 边距。
    padding=max(12,min(w,h)*.32)
    size=(int(round(w+2*padding)),int(round(h+2*padding)))
    matrix=cv2.getRotationMatrix2D(center,region['angle'],1)
    array=np.asarray(image)
    rotated=cv2.warpAffine(array,matrix,(image.width,image.height),flags=cv2.INTER_CUBIC,borderMode=cv2.BORDER_CONSTANT,borderValue=(240,240,239))
    crop=Image.fromarray(cv2.getRectSubPix(rotated,size,center))
    flags=list(region['flags'])
    body=cv2.getRectSubPix(cv2.cvtColor(rotated,cv2.COLOR_RGB2GRAY),(max(2,int(w)),max(2,int(h))),center)
    sharpness=float(cv2.Laplacian(body,cv2.CV_64F).var())
    if sharpness<28:
        flags.append('文字区域可能模糊，请核对清晰度')
    if min(w,h)<100:
        flags.append('器件在原图中太小，建议靠近拍摄')
    return crop,flags,{'laplacian_variance':round(sharpness,2),'source_body_size':[round(w),round(h)],
                       'rotation_ccw_degrees':round(region['angle'],2),'crop_size':list(crop.size),'padding_pixels':round(padding,2)}


def process_photo(data: bytes, folder: Path, photo_id: str, label: str, mode='single',resource_check=None):
    def check():
        if resource_check:
            state=resource_check()
            if state['pressure'] or state['cpu_percent']>90:
                raise ValueError('电脑资源或热压力较高，请稍后重试保存，原照片仍在上传队列中。')
    check()
    image,ext=decode(data)
    original=f'{photo_id}-original.{ext}'
    (folder/original).write_bytes(data)
    normalized=f'{photo_id}-normalized.png'
    image.save(folder/normalized)
    preview=image.copy();preview.thumbnail((1600,1600))
    preview_name=f'{photo_id}-preview.jpg';preview.save(folder/preview_name,quality=90)
    regions,flags=locate(image,mode=mode)
    components=[]
    for i,r in enumerate(regions,1):
        check()
        crop,warnings,transform=crop_component(image,r)
        name=f'{photo_id}-C{i:02d}.png'
        crop.save(folder/name)
        components.append({'id':f'{photo_id}C{i:02d}','photo_id':photo_id,'label':f'{label}-{i:02d}',
                           'crop_file':name,'box':r['box'],'transform':transform,'quality_flags':warnings,
                           'analysis':None,'review':None,'error':None,'orientation':0})
    # 编号在图外留白处；原图和模型裁片均没有标注。
    stage=Image.new('RGB',(preview.width,preview.height+46),(241,244,242));stage.paste(preview,(0,0))
    draw=ImageDraw.Draw(stage);ratio=preview.width/image.width
    for c in components:
        pts=[(x*ratio,y*ratio) for x,y in c['box']]
        draw.line(pts+[pts[0]],fill=(33,118,85),width=3)
    draw.text((14,preview.height+16),f'{label} | '+ '  '.join(c['label'] for c in components),fill=(30,48,40))
    annotation=f'{photo_id}-annotation.jpg';stage.save(folder/annotation,quality=92)
    return {'id':photo_id,'label':label,'original_file':original,'normalized_file':normalized,'preview_file':preview_name,
            'annotation_file':annotation,'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data),'size':list(image.size),
            'flags':flags,'deleted':False,'components':components}


def model_image(path: Path):
    image=Image.open(path).convert('RGB')
    image.thumbnail((1280,1280),Image.Resampling.LANCZOS)
    stream=BytesIO();image.save(stream,format='PNG')
    return stream.getvalue()
