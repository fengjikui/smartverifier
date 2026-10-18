"""绿色检验台CPU分离器与可配置VLM传输。stdout只输出JSON。"""
from __future__ import annotations
import asyncio
import base64
import hashlib
from io import BytesIO
import json
import math
import os
from pathlib import Path
import sys
import time
import uuid
import subprocess

os.environ["OMP_NUM_THREADS"] = "2"
os.environ["OPENBLAS_NUM_THREADS"] = "2"
os.environ["VECLIB_MAXIMUM_THREADS"] = "2"
ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "agent-tools/image-focus/src"))
from PIL import Image, ImageDraw, ImageFont, ImageOps

VERSION = "green-contours-v1"


def load_averages():
    # Windows 不提供 os.getloadavg；不可获取时留空，不阻止正常识别。
    try:
        return os.getloadavg()
    except (AttributeError, OSError, NotImplementedError):
        return None


def check_resources():
    import psutil
    available = psutil.virtual_memory().available / 2**30
    if available < 8:
        raise RuntimeError("RESOURCE_PRESSURE: 可用内存不足8GiB，暂停本次处理，请稍后重试。")
    cpu=psutil.cpu_percent(interval=.15)
    if cpu>90:raise RuntimeError('RESOURCE_PRESSURE: CPU负载过高，请稍后重试。')
    thermal = "unavailable"
    if sys.platform == "darwin":
        thermal = subprocess.check_output(["pmset", "-g", "therm"], text=True, timeout=3)
        if any("No " not in line and ("warning level" in line or "Speed_Limit" in line) for line in thermal.splitlines()):
            raise RuntimeError("RESOURCE_PRESSURE: 系统报告热或性能压力，请冷却后重试。")
    return {"availableGiB":round(available,2),"thermal":thermal.strip(),"cpuThreads":2,"cpuPercent":cpu,"load":load_averages()}


def decode(filename):
    with Image.open(filename) as source:
        if source.format not in ("JPEG", "PNG", "WEBP") or source.width * source.height > 40_000_000:
            raise ValueError("请使用不超过4000万像素的 JPG、PNG 或 WebP 照片。")
        source.load()
        return ImageOps.exif_transpose(source).convert("RGB")


def asset(image, folder):
    name = str(uuid.uuid4()) + ".png"
    stream = BytesIO(); image.save(stream, format="PNG")
    data = stream.getvalue(); (folder / name).write_bytes(data)
    os.chmod(folder / name, 0o600)
    return {"assetId": name, "sha256": hashlib.sha256(data).hexdigest(), "mime": "image/png",
            "width": image.width, "height": image.height, "bytes": len(data)}


def separate(req):
    import cv2
    import numpy as np
    cv2.setNumThreads(2)
    started = time.monotonic()
    folder = Path(req["folder"]); folder.mkdir(parents=True, exist_ok=True)
    with Image.open(req["source"]) as original:
        ow, oh = original.size; orientation = original.getexif().get(274, 1)
        transforms = {1:[1,0,0,0,1,0,0,0,1],2:[-1,0,ow-1,0,1,0,0,0,1],3:[-1,0,ow-1,0,-1,oh-1,0,0,1],4:[1,0,0,0,-1,oh-1,0,0,1],5:[0,1,0,1,0,0,0,0,1],6:[0,-1,oh-1,1,0,0,0,0,1],7:[0,-1,oh-1,-1,0,ow-1,0,0,1],8:[0,1,0,-1,0,ow-1,0,0,1]}
        original_to_upright = transforms.get(orientation, transforms[1])
    image = decode(req["source"])
    upright = asset(image, folder)
    small = image.copy(); small.thumbnail((1600, 1600))
    sx, sy = image.width / small.width, image.height / small.height
    rgb = np.asarray(small); hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    # 该配置明确限定绿色防静电垫。不是通用语义分割；换台面要换配置/检测器。
    green = cv2.inRange(hsv, np.array([30, 35, 20]), np.array([100, 255, 255]))
    green_ratio = float((green > 0).mean())
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    foreground = ((green == 0) & (gray < 160)).astype("uint8") * 255
    mask = cv2.morphologyEx(foreground, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    area = small.width * small.height; candidates = []; rejected = 0
    for contour in contours:
        a = cv2.contourArea(contour)
        if a < area * .0015:
            continue
        (cx, cy), (w, h), angle = cv2.minAreaRect(contour)
        if a > area * .55 or min(w, h) < 24 or max(w, h) / max(1, min(w, h)) > 4 or a / max(1, w * h) < .45:
            rejected += 1; continue
        # 小角度转正。仅几何校正，不声称解决文字180°方向和透视畸变。
        if angle > 45:
            angle -= 90; w, h = h, w
        elif angle < -45:
            angle += 90; w, h = h, w
        candidates.append({"cx": cx*sx, "cy": cy*sy, "w": w*sx, "h": h*sy, "angle": angle})
    candidates.sort(key=lambda c: (round(c["cy"]/(image.height*.18)), c["cx"]))
    issues = []
    if green_ratio < .25:
        issues.append("当前定位器要求绿色防静电垫背景，请调整拍摄背景。")
    if rejected:
        issues.append("画面存在无法可靠分离的目标或粘连区域，请分开摆放后重拍。")
    if not candidates:
        issues.append("没有可靠定位到元件，请靠近并确保元件完整入镜。")
    if len(candidates) > 6:
        issues.append("当前验证配置每张最多6件，请减少数量后重拍。")
    components = []
    array = np.asarray(image)
    for i, region in enumerate(candidates[:6]):
        cx, cy, w, h, angle = (region[k] for k in ("cx", "cy", "w", "h", "angle"))
        pad = max(12, min(w, h) * .13)
        cw, ch = max(2, round(w + 2*pad)), max(2, round(h + 2*pad))
        matrix = cv2.getRotationMatrix2D((cx, cy), angle, 1)
        # 直接从全分辨率原图采样，不先把整张缩小；只做传统插值，不生成新文字。
        matrix[0, 2] += (cw-1)/2 - cx; matrix[1, 2] += (ch-1)/2 - cy
        crop = cv2.warpAffine(array, matrix, (cw, ch), flags=cv2.INTER_CUBIC,
                             borderMode=cv2.BORDER_CONSTANT, borderValue=(255, 255, 255))
        inverse = cv2.invertAffineTransform(matrix)
        quad = cv2.boxPoints(((cx, cy), (w, h), angle))
        warnings = []
        if quad[:,0].min() < 3 or quad[:,1].min() < 3 or quad[:,0].max() > image.width-4 or quad[:,1].max() > image.height-4:
            warnings.append("元件靠近边缘，可能未拍完整，请重新拍照。")
        if min(w, h) < 90:
            warnings.append("元件在原图中太小，请靠近拍照。")
        body = cv2.getRectSubPix(cv2.cvtColor(crop, cv2.COLOR_RGB2GRAY), (max(2, round(w*.8)), max(2, round(h*.8))), ((cw-1)/2,(ch-1)/2))
        sharpness = float(cv2.Laplacian(body, cv2.CV_64F).var())
        # 防止把空矩形/笔帽作为元件。检查塑封体内有无可见标记纹理。
        # 只是一道保守拒绝门，不等于已证明目标一定是电子元件。
        detail = float(body.std())
        if sharpness < 12 or detail < 3:
            warnings.append("目标细节不足，无法可靠读取丝印，请重新拍照。")
        view = asset(Image.fromarray(crop), folder)
        points = np.clip(quad, [0, 0], [image.width, image.height]).round(3).tolist()
        x0, y0 = np.min(quad, axis=0); x1, y1 = np.max(quad, axis=0)
        components.append({"componentId": str(uuid.uuid4()), "quadPx": points, "modelView": view,
            "viewToUprightOriginal": [*inverse[0].tolist(), *inverse[1].tolist(), 0, 0, 1],
            "rotationClockwiseDegrees": -float(angle), "quality": {"state": "needs_recapture" if warnings else "usable", "reasons": warnings},
            "routeHint": "unclassified", "bbox": [max(0,float(x0)/image.width),max(0,float(y0)/image.height), min(image.width,float(x1))/image.width-max(0,float(x0)/image.width),min(image.height,float(y1))/image.height-max(0,float(y0)/image.height)],
            "metrics": {"laplacianVariance": round(sharpness,2), "bodyStd": round(detail,2)},
            "label": req["label"] + "-" + str(i+1).zfill(2)})
    # 白板保留每块裁片像素；不强行统一缩小，不贴字到丝印上。
    cols = min(3, max(1, len(components))); rows = math.ceil(len(components)/cols)
    cellw = max((c["modelView"]["width"] for c in components), default=320)+32
    cellh = max((c["modelView"]["height"] for c in components), default=160)+66
    if cols*cellw*max(1,rows)*cellh > 32_000_000:
        raise ValueError("裁片白板过大，请减少同一张照片里的元件数量后重拍。")
    sheet = Image.new("RGB", (cols*cellw, max(1,rows)*cellh), "white")
    draw = ImageDraw.Draw(sheet); font = ImageFont.load_default(size=28)
    for i, c in enumerate(components):
        pic = Image.open(folder/c["modelView"]["assetId"])
        x = i%cols*cellw+(cellw-pic.width)//2; y = i//cols*cellh+46
        sheet.paste(pic,(x,y)); draw.text((i%cols*cellw+16,i//cols*cellh+12),c["label"],font=font,fill=(90,30,35))
    preview = image.copy(); preview.thumbnail((1536, 1536)); ratio = preview.width/image.width
    gutter = 110; annotated = Image.new("RGB",(preview.width+2*gutter,preview.height),(249,249,249)); annotated.paste(preview,(gutter,0))
    draw = ImageDraw.Draw(annotated)
    annotation_font=ImageFont.load_default(size=44)
    for left in (True, False):
        group = [c for c in components if (sum(p[0] for p in c["quadPx"])/4 < image.width/2) == left]
        group.sort(key=lambda c: sum(p[1] for p in c["quadPx"])/4)
        last = -30
        for i,c in enumerate(group):
            pts = [(x*ratio+gutter,y*ratio) for x,y in c["quadPx"]]
            y = max(last+68,min(preview.height-34-(len(group)-i-1)*68,sum(p[1] for p in pts)/4)); last=y
            x = 10 if left else gutter+preview.width+12
            anchor = (min if left else max)(pts,key=lambda p:p[0]); elbow=gutter-9 if left else gutter+preview.width+9
            draw.line(pts+[pts[0]],fill=(196,25,38),width=3)
            draw.line([(x+86 if left else x,y),(elbow,y),anchor],fill=(196,25,38),width=2)
            draw.rounded_rectangle((x,y-29,x+86,y+29),radius=7,fill=(196,25,38)); draw.text((x+15,y-24),c["label"].rsplit('-',1)[-1],font=annotation_font,fill="white")
    return {"version":VERSION,"width":image.width,"height":image.height,"originalWidth":ow,"originalHeight":oh,"originalToUpright":original_to_upright,"upright":upright,
        "annotated":asset(annotated,folder),"sheet":asset(sheet,folder),"components":components,
        "issues":issues,"coverage":"uncertain" if issues else "complete", "greenRatio":round(green_ratio,3),
        "elapsedMs":round((time.monotonic()-started)*1000),"opencv":cv2.__version__}


async def recognize(req):
    # 模型地址由服务端配置；不继承桌面代理，内网直连。
    for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        os.environ.pop(key, None)
    provider=req.get('provider','lmstudio')
    if provider not in ('lmstudio','openai-compatible'):raise ValueError('VLM协议配置无效')
    if provider=='lmstudio' and req.get('requireIdle'):
        status=subprocess.check_output([str(Path.home()/'.lmstudio/bin/lms'),'ps'],text=True,timeout=5)
        row=next((line for line in status.splitlines() if line.split() and line.split()[0]==req['model']),'')
        if 'IDLE' not in row:raise RuntimeError('目标模型未空闲，未发起调试请求。')
    metrics=[]
    def block(filename):
        pic = decode(filename); stream = BytesIO(); pic.save(stream,format="PNG")
        data=stream.getvalue()
        metrics.append({"inputIndex":len(metrics),"sha256":hashlib.sha256(data).hexdigest(),"sentWidth":pic.width,"sentHeight":pic.height,"encodedBytes":len(data),"effectiveWidth":None,"effectiveHeight":None})
        return {"type":"image_url","image_url":{"url":"data:image/png;base64,"+base64.b64encode(data).decode()}}
    cid = req["componentId"]
    from smartverifier_focus.silkscreen_prompts import PAIR_PROMPT_TEMPLATE, BATCH_PROMPT, ordered_messages, pair_fixed_prompt
    prompt = PAIR_PROMPT_TEMPLATE.replace("CID",cid).replace("STANDARD",req["description"]).replace("ONSITE",req["instruction"] or "无")
    if req.get('componentIds'):
        from smartverifier_focus.silkscreen_prompts import BATCH_PROMPT
        prompt=BATCH_PROMPT+'\n本次必须返回的componentId列表：'+json.dumps(req['componentIds'],ensure_ascii=False)
    layout=req.get('inputLayout','legacy')
    reference,sample=block(req['reference']),block(req['sample'])
    if req.get('componentIds'):
        fixed=BATCH_PROMPT
        scope='\n本次必须返回的componentId列表：'+json.dumps(req['componentIds'],ensure_ascii=False)
        messages=ordered_messages(fixed,scope,reference,sample,layout)
    elif layout=='prefix-first':
        fixed=pair_fixed_prompt(req['description'])
        scope='\n本次必须返回的componentId列表：'+json.dumps([cid],ensure_ascii=False)+'\n现场说明：'+(req['instruction'] or '无')
        messages=ordered_messages(fixed,scope,reference,sample,layout)
    elif layout=='legacy':
        messages=[{"role":"user","content":[{"type":"text","text":prompt},reference,sample]}]
    else:raise ValueError('不支持的输入顺序')
    trace=None
    if req.get('traceDirectory'):
        from smartverifier_focus.model_trace import TraceWriter
        trace=TraceWriter(req['traceDirectory'],{'model':req['model'],'source':'inspection',
            'componentIds':req.get('componentIds') or [cid], 'inputLayout':layout,'provider':provider, **req.get('traceMetadata',{})},messages,req.get('traceId'))
    start = time.monotonic()
    try:
        if provider=='lmstudio':
            from smartverifier_focus.lmstudio_transport import LmStudioTransport
            connection=LmStudioTransport(req['endpoint'],req['model'],req['template'])
        else:
            from smartverifier_focus.vlm_http_transport import VlmHttpTransport
            connection=VlmHttpTransport(req['endpoint'],req['model'],api_key=os.environ.get('SV_VLM_API_KEY',''),
                extra_body=req.get('extraBody'),ca_file=os.environ.get('SV_VLM_CA_FILE',''))
        async with connection as transport:
            # 关闭thinking，不修改全局模板或模型加载状态。调试可显式试验Schema，不自动降级。
            response = await transport.complete(messages,None,req.get('maxTokens',1150),
                timeout_seconds=req.get('timeoutSeconds',55),on_event=trace.observe if trace else None,
                response_format=req.get('responseSchema'))
        return {"response":response,"elapsedMs":round((time.monotonic()-start)*1000),"model":req["model"],
                "promptVersion":"silkscreen-prefix-first-v1" if layout=='prefix-first' else "silkscreen-controlled-layout-v1" if req.get('componentIds') else "silkscreen-pair-v1",
                "inputLayout":layout,"provider":provider,"outputFormat":"json-schema" if req.get('responseSchema') else "prompt-json",
                "inputMetrics":metrics,"traceId":trace.id if trace else None}
    except BaseException as exc:
        if trace:trace.emit('error',{'message':str(exc),'errorType':type(exc).__name__})
        raise
    finally:
        if trace:trace.close()


if __name__ == "__main__":
    try:
        req=json.load(sys.stdin)
        resources=check_resources()
        result=separate(req) if req["action"]=="separate" else asyncio.run(recognize(req))
        result["resourcesBefore"]=resources
        try:
            result["resourcesAfter"]=check_resources()
        except RuntimeError as pressure:
            # 已完成结果仍返回并落盘；下一件在开始前暂停，不能丢掉完成证据。
            result["resourcesAfter"]={"warning":str(pressure)}
        if sys.platform in ("darwin","linux"):
            import resource
            result["workerPeakRssMiB"]=round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/(2**20 if sys.platform=="darwin" else 1024),2)
        print(json.dumps(result,ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({"error":str(exc),"type":type(exc).__name__},ensure_ascii=False)); sys.exit(1)
