"""原图解码与可配置 VLM 传输。无自动裁剪或传统清晰度门槛。stdout 只输出 JSON。"""
from __future__ import annotations
import asyncio
import base64
import hashlib
from io import BytesIO
import json
import os
from pathlib import Path
import sys
import time
import subprocess
import shutil

os.environ["OMP_NUM_THREADS"] = "2"
os.environ["OPENBLAS_NUM_THREADS"] = "2"
os.environ["VECLIB_MAXIMUM_THREADS"] = "2"
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server/vision"))
from PIL import Image, ImageDraw, ImageOps

VERSION = "whole-photo-v1"


def load_averages():
    # Windows 不提供 os.getloadavg；不可获取时留空，不阻止正常识别。
    try:
        return os.getloadavg()
    except (AttributeError, OSError, NotImplementedError):
        return None


def lmstudio_cli():
    # 优先尊重 LM Studio CLI 的 PATH 配置，不假定用户目录或可执行文件后缀。
    command = shutil.which('lms')
    if command:
        return command
    candidate = Path.home() / '.lmstudio/bin' / ('lms.exe' if sys.platform == 'win32' else 'lms')
    if candidate.is_file():
        return str(candidate)
    raise RuntimeError('找不到 LM Studio CLI（lms），请安装 CLI 并加入 PATH 后再运行空闲检查。')


def check_resources():
    import psutil
    available = psutil.virtual_memory().available / 2**30
    if available < 8:
        raise RuntimeError("RESOURCE_PRESSURE: 可用内存不足8GiB，暂停本次处理，请稍后重试。")
    cpu=psutil.cpu_percent(interval=.15)
    if cpu>90:raise RuntimeError('RESOURCE_PRESSURE: CPU负载过高，请稍后重试。')
    thermal = "unavailable"
    if sys.platform == "darwin":
        thermal = subprocess.check_output(["pmset", "-g", "therm"], text=True, timeout=3, encoding="utf-8")
        if any("No " not in line and ("warning level" in line or "Speed_Limit" in line) for line in thermal.splitlines()):
            raise RuntimeError("RESOURCE_PRESSURE: 系统报告热或性能压力，请冷却后重试。")
    return {"availableGiB":round(available,2),"thermal":thermal.strip(),"cpuThreads":2,"cpuPercent":cpu,"load":load_averages()}


def decode(filename):
    with Image.open(filename) as source:
        if source.format not in ("JPEG", "PNG", "WEBP") or source.width * source.height > 40_000_000:
            raise ValueError("请使用不超过4000万像素的 JPG、PNG 或 WebP 照片。")
        source.load()
        return ImageOps.exif_transpose(source).convert("RGB")


def inspect_image(req):
    # 仅按 EXIF 解码得到实际尺寸；不定位、不裁剪、不转正、不判清晰度。
    image = decode(req["source"])
    return {"version": VERSION, "width": image.width, "height": image.height}


def mark_reference(pic, regions):
    """仅加检查范围边界，不覆盖框内丝印；预览与传输采用同一组多边形坐标。"""
    draw = ImageDraw.Draw(pic)
    for region in regions:
        x,y,w,h = (region[k] for k in ('x','y','width','height'))
        color = (35,117,78) if region['kind']=='focus' else (210,140,0)
        points = region.get('polygon') or [dict(x=x,y=y),dict(x=x+w,y=y),dict(x=x+w,y=y+h),dict(x=x,y=y+h)]
        pixels = [(min(pic.width-1,round(p['x']*pic.width)),min(pic.height-1,round(p['y']*pic.height))) for p in points]
        draw.line(pixels+[pixels[0]],fill=color,width=max(2,round(min(pic.size)/500)),joint='curve')
    return pic


async def recognize(req):
    # 模型地址由服务端配置；不继承桌面代理，内网直连。
    for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        os.environ.pop(key, None)
    provider=req.get('provider','lmstudio')
    if provider not in ('lmstudio','openai-compatible'):raise ValueError('VLM协议配置无效')
    if provider=='lmstudio' and req.get('requireIdle'):
        status=subprocess.check_output([lmstudio_cli(),'ps'],text=True,timeout=5, encoding="utf-8")
        row=next((line for line in status.splitlines() if line.split() and line.split()[0]==req['model']),'')
        if 'IDLE' not in row:raise RuntimeError('目标模型未空闲，未发起调试请求。')
    metrics=[]
    def block(filename, regions=None):
        pic = decode(filename)
        if regions:
            mark_reference(pic, regions)
        stream = BytesIO(); pic.save(stream,format="PNG")
        data=stream.getvalue()
        metrics.append({"inputIndex":len(metrics),"sha256":hashlib.sha256(data).hexdigest(),"sentWidth":pic.width,"sentHeight":pic.height,"encodedBytes":len(data),"effectiveWidth":None,"effectiveHeight":None})
        return {"type":"image_url","image_url":{"url":"data:image/png;base64,"+base64.b64encode(data).decode()}}
    cid = req["componentId"]
    from vlm_client.silkscreen_prompts import PAIR_PROMPT_TEMPLATE, BATCH_PROMPT, ordered_messages, pair_fixed_prompt, photo_fixed_prompt
    prompt = PAIR_PROMPT_TEMPLATE.replace("CID",cid).replace("STANDARD",req["description"]).replace("ONSITE",req["instruction"] or "无")
    if req.get('componentIds'):
        from vlm_client.silkscreen_prompts import BATCH_PROMPT
        prompt=BATCH_PROMPT+'\n本次必须返回的componentId列表：'+json.dumps(req['componentIds'],ensure_ascii=False)
    layout=req.get('inputLayout','legacy')
    reference=block(req['reference'],req.get('referenceRegions'))
    sample=block(req['sample']) if req['action']!='analyze_reference' else None
    if req['action']=='analyze_reference':
        messages=[{'role':'user','content':[{'type':'text','text':req['analysisPrompt']},reference]}]
    elif req['action']=='recognize_photo':
        messages=ordered_messages(photo_fixed_prompt(req['description']), '现场说明：'+(req['instruction'] or '无'), reference, sample, layout)
    elif req.get('componentIds'):
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
        from vlm_client.model_trace import TraceWriter
        trace=TraceWriter(req['traceDirectory'],{'model':req['model'],'source':'inspection',
            'componentIds':req.get('componentIds') or [cid], 'inputLayout':layout,'provider':provider, **req.get('traceMetadata',{})},messages,req.get('traceId'))
    start = time.monotonic()
    try:
        if provider=='lmstudio':
            from vlm_client.lmstudio_transport import LmStudioTransport
            connection=LmStudioTransport(req['endpoint'],req['model'],req['template'])
        else:
            from vlm_client.vlm_http_transport import VlmHttpTransport
            connection=VlmHttpTransport(req['endpoint'],req['model'],api_key=os.environ.get('SV_VLM_API_KEY',''),
                extra_body=req.get('extraBody'),ca_file=os.environ.get('SV_VLM_CA_FILE',''))
        async with connection as transport:
            # 关闭thinking，不修改全局模板或模型加载状态。调试可显式试验Schema，不自动降级。
            response = await transport.complete(messages,None,req.get('maxTokens',1150),
                timeout_seconds=req.get('timeoutSeconds',55),on_event=trace.observe if trace else None,
                response_format=req.get('responseSchema'))
        return {"response":response,"elapsedMs":round((time.monotonic()-start)*1000),"model":req["model"],
                "promptVersion":"silkscreen-whole-photo-v1" if req['action']=='recognize_photo' else "silkscreen-prefix-first-v1" if layout=='prefix-first' else "silkscreen-controlled-layout-v1" if req.get('componentIds') else "silkscreen-pair-v1",
                "inputLayout":layout,"provider":provider,"outputFormat":"json-schema" if req.get('responseSchema') else "prompt-json",
                "inputMetrics":metrics,"traceId":trace.id if trace else None}
    except BaseException as exc:
        if trace:trace.emit('error',{'message':str(exc),'errorType':type(exc).__name__})
        raise
    finally:
        if trace:trace.close()


if __name__ == "__main__":
    # 即使直接用解释器运行，管道也不能继承 Windows 的 GBK 或终端代码页。
    sys.stdin.reconfigure(encoding="utf-8-sig")
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8", errors="backslashreplace")
    try:
        req=json.load(sys.stdin)
        resources=check_resources()
        if req["action"] == "separate":
            raise ValueError("自动分离器未启用；当前使用原图整图识别，分离器仅保留接口。")
        result=inspect_image(req) if req["action"]=="inspect_image" else asyncio.run(recognize(req))
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
