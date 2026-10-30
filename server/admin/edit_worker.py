"""从不可变原图生成编辑副本；仅裁剪和旋转，不做生成式修复或上采样。"""
import io, json, math, sys
from pathlib import Path
from PIL import Image, ImageOps
from asset_worker import asset, resource_check


def edit(r):
    resource_check()
    angle = r['angle']
    if not isinstance(angle, (int, float)) or not math.isfinite(angle) or abs(angle) > 180:
        raise ValueError('旋转角度无效。')
    with Image.open(r['source']) as source:
        im = ImageOps.exif_transpose(source).convert('RGB')
        source_width, source_height = im.size
        if angle:
            # 先检查旋转后尺寸，防止放大画布导致内存暴涨。
            radians = math.radians(angle)
            w = math.ceil(abs(im.width*math.cos(radians))+abs(im.height*math.sin(radians)))+2
            h = math.ceil(abs(im.height*math.cos(radians))+abs(im.width*math.sin(radians)))+2
            if w*h > 40_000_000:
                raise ValueError('旋转后画布超过 4000 万像素，请先缩小原图。')
            im = im.rotate(-angle, resample=Image.Resampling.BICUBIC, expand=True, fillcolor='white')
        rotated_width, rotated_height = im.size
        left = top = 0
        crop = r.get('crop')
        if crop:
            if any(not isinstance(crop.get(k), (int,float)) or not math.isfinite(crop[k]) for k in ('x','y','width','height')):
                raise ValueError('裁剪范围无效。')
            x,y,w,h = (crop[k] for k in ('x','y','width','height'))
            if min(x,y)<0 or min(w,h)<=0 or x+w>1.000001 or y+h>1.000001:
                raise ValueError('裁剪范围超出图片。')
            bounds = (round(x*im.width),round(y*im.height),round((x+w)*im.width),round((y+h)*im.height))
            if bounds[2]-bounds[0]<16 or bounds[3]-bounds[1]<16:
                raise ValueError('裁剪区域太小，请保留整个元件。')
            im = im.crop(bounds)
            left, top = bounds[:2]
        transform = dict(angle=angle,sourceWidth=source_width,sourceHeight=source_height,rotatedWidth=rotated_width,rotatedHeight=rotated_height,left=left,top=top,width=im.width,height=im.height)
        out=io.BytesIO();im.save(out,'PNG')
    return dict(asset(out.getvalue(),Path(r['filename']).stem+'-编辑.png',r['folder']),transform=transform)

if __name__=='__main__':
    sys.stdin.reconfigure(encoding='utf-8-sig');sys.stdout.reconfigure(encoding='utf-8');sys.stderr.reconfigure(encoding='utf-8',errors='backslashreplace')
    try:print(json.dumps(edit(json.load(sys.stdin)),ensure_ascii=False))
    except Exception as e:print(json.dumps({'error':str(e)},ensure_ascii=False));sys.exit(1)
