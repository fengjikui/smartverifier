"""只读取受控临时目录；原图不压缩替换，另生成列表缩略图。"""
import sys, json, os, hashlib, uuid, warnings
from pathlib import Path
from PIL import Image, ImageOps
Image.MAX_IMAGE_PIXELS = 40_000_000
warnings.simplefilter('error', Image.DecompressionBombWarning)

def resource_check():
    import psutil, subprocess
    if psutil.virtual_memory().available < 3 * 1024**3 or psutil.cpu_percent(interval=.1) > 90:
        raise ValueError('电脑资源紧张，暂停图片预检，请稍后重试。')
    if sys.platform == 'darwin':
        result = subprocess.run(['pmset', '-g', 'therm'], capture_output=True, text=True, timeout=3).stdout
        if any(int(v.strip().split('=')[-1]) < 90 for v in result.splitlines() if 'CPU_Speed_Limit' in v):
            raise ValueError('电脑热压力较高，暂停预检，请稍后重试。')

def asset(data, filename, folder):
    if not data or len(data) > 20 * 1024**2: raise ValueError('单张图片须为 20MB 以内的 JPG、PNG 或 WebP。')
    import io
    with Image.open(io.BytesIO(data)) as im:
        if im.format not in ('JPEG','PNG','WEBP') or getattr(im, 'n_frames',1) != 1: raise ValueError('仅支持静态 JPG、PNG 或 WebP。')
        if im.width * im.height > 40_000_000: raise ValueError('图片不能超过 4000 万像素。')
        im.verify()
    with Image.open(io.BytesIO(data)) as im:
        im.load(); image=ImageOps.exif_transpose(im).convert('RGB'); w,h=image.size
        ext={'JPEG':'.jpg','PNG':'.png','WEBP':'.webp'}[im.format]
        sha=hashlib.sha256(data).hexdigest()
        # 相同原始字节共用不可变资产，避免导入反复写大图。
        key=str(uuid.UUID(sha[:32])); name=key+ext; thumb=key+'-thumb.jpg'
        folder=Path(folder);folder.mkdir(parents=True,exist_ok=True)
        if not (folder/name).exists(): (folder/name).write_bytes(data);os.chmod(folder/name,0o600)
        if not (folder/thumb).exists():
            image.thumbnail((192,192),Image.Resampling.LANCZOS);image.save(folder/thumb,quality=85);os.chmod(folder/thumb,0o600)
    return dict(id=name,filename=Path(filename).name[:160],width=w,height=h,bytes=len(data),sha256=sha,thumbnail='/api/reference-assets/'+thumb)

if __name__ == '__main__':
    try:
        r=json.load(sys.stdin);resource_check();result=asset(Path(r['source']).read_bytes(),r['filename'],r['folder']);print(json.dumps(result,ensure_ascii=False))
    except Exception as e:
        print(json.dumps({'error':str(e)},ensure_ascii=False));sys.exit(1)
