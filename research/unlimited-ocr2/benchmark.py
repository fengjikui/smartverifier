"""Unlimited-OCR-2 本机独立探针：BF16 MLX，串行、有限输出、资源保护。"""
from __future__ import annotations
import argparse
from dataclasses import asdict
from datetime import datetime,timezone
import gc
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import threading
import time
import traceback

for k in ['OMP_NUM_THREADS','OPENBLAS_NUM_THREADS','MKL_NUM_THREADS']:
    os.environ[k]='2'
if hasattr(sys.stdout,'reconfigure'):sys.stdout.reconfigure(encoding='utf-8')
from score import score
ROOT=Path(__file__).resolve().parents[2]


def digest(p):
    h=hashlib.sha256()
    with Path(p).open('rb')as f:
        for block in iter(lambda:f.read(8*1024**2),b''):h.update(block)
    return h.hexdigest()


def resources():
    import psutil
    p=psutil.Process();thermal='not available'
    if sys.platform=='darwin':thermal=subprocess.run(['pmset','-g','therm'],capture_output=True,text=True,timeout=5).stdout.strip()
    return {'at':datetime.now(timezone.utc).isoformat(),'available_gib':psutil.virtual_memory().available/1024**3,
            'rss_gib':p.memory_info().rss/1024**3,'thermal':thermal,
            'load':list(os.getloadavg())if hasattr(os,'getloadavg')else None}


def main():
    p=argparse.ArgumentParser();p.add_argument('--model',required=True);p.add_argument('--out',required=True)
    p.add_argument('--phase',choices=['smoke','whole','roi','upright','plain-prompt','base-mode'],default='smoke')
    p.add_argument('--max-seconds',type=int,default=120);p.add_argument('--memory-gib',type=float,default=9)
    p.add_argument('--scenes',nargs='*');p.add_argument('--prompt');args=p.parse_args()
    import mlx.core as mx
    from mlx_vlm import load,stream_generate
    from mlx_vlm.prompt_utils import apply_chat_template
    from mlx_vlm.utils import prepare_inputs
    from PIL import Image
    model_path=Path(args.model).resolve();out=Path(args.out).resolve();out.parent.mkdir(parents=True,exist_ok=True)
    before=resources()
    if before['available_gib']<args.memory_gib+4:raise RuntimeError('可用内存不足以保留至少4GiB余量；未加载模型。')
    mx.set_cache_limit(128*1024**2);mx.set_memory_limit(int(args.memory_gib*1024**3))
    mx.set_wired_limit(min(int(args.memory_gib*1024**3),mx.device_info()['max_recommended_working_set_size']))
    evidence={'started':datetime.now(timezone.utc).isoformat(),'model_path_label':model_path.name,
        'model_source':'mlx-community/Unlimited-OCR-2-bf16','official_source':'baidu/Unlimited-OCR-2',
        'model_revision':'850d1e483f5a82a0597f0a45aac31b07ba840df2',
        'official_revision':'c14071b549f4fcab10909f3c4acc6a2edb366947',
        'runtime':'MLX native port, not official NVIDIA Transformers runtime',
        'platform':platform.platform(),'python':sys.version,'device':mx.device_info(),
        'versions':{x:importlib.metadata.version(x)for x in ['mlx','mlx-vlm','transformers','huggingface-hub','Pillow']},
        'parameters':{'temperature':0,'global_view':1024,'local_tile':640,'max_crops':16,
                      'memory_limit_gib':args.memory_gib,'cache_mib':128,'concurrency':1},
        'phase':args.phase,'score_parser_version':2,'resources':[before],'cases':[]}
    def save():out.write_text(json.dumps(evidence,ensure_ascii=False,indent=2,default=str),encoding='utf-8')
    evidence['config']=json.loads((model_path/'config.json').read_text(encoding='utf-8'))
    evidence['weights']=[{'name':f.name,'bytes':f.stat().st_size,'sha256':digest(f)}for f in sorted(model_path.glob('*.safetensors'))]
    save();at=time.perf_counter();model,processor=load(str(model_path));evidence['load_seconds']=time.perf_counter()-at
    evidence['page_layout']=processor.page_layout;evidence['max_crops']=processor.max_crops
    evidence['language_model_class']=type(model.language_model.model).__name__
    evidence['resources'].append(resources());save();print('MODEL_READY',round(evidence['load_seconds'],2),flush=True)
    manifest=json.loads((ROOT/'fixtures/inspection/ocr-exploration-v1/manifest.json').read_text(encoding='utf-8'))
    cases=[]
    if args.phase=='smoke':
        control=json.loads((Path(__file__).parent/'control.json').read_text(encoding='utf-8'))
        cases.append({'id':'text-positive-control','file':'research/unlimited-ocr2/control.png','sha256':control['sha256'],
                      'parts':[{'primary':c,'required':[c],'reference':c}for c in control['lines']], 'control':True})
        cases.append(next(s for s in manifest['scenes']if s['id']=='reference-qg'))
    elif args.phase in ['whole','plain-prompt','base-mode']:
        for s in manifest['scenes']:
            if args.scenes and s['id']not in args.scenes:continue
            cases.append(s)
    else:
        selected={'scattered-six':['C01','C03','C04','C05','C06'],'tray-thirty':['C01','C06','C24'],
                  'long-code-pair':['C01','C02'],'eighteen-two-differences':['C08','C17'],
                  'public-ne555':['C02'],'public-lm358':['C01'],'confusable-pair':['C01','C02']}
        upright={('scattered-six','C03'):180,('scattered-six','C04'):90,('long-code-pair','C02'):180}
        for s in manifest['scenes']:
            for part in s['parts']:
                if part['id'] not in selected.get(s['id'],[]):continue
                if args.phase=='upright'and(s['id'],part['id'])not in upright:continue
                cases.append({**s,'id':s['id']+'-'+part['id'],'parts':[part],'oracle_roi':part['roi'],
                              'oracle_ccw_degrees':upright.get((s['id'],part['id']),0)if args.phase=='upright'else 0})
    stop=threading.Event();abort=threading.Event()
    def monitor():
        while not stop.wait(5):
            r=resources()
            with out.with_suffix('.resources.jsonl').open('a',encoding='utf-8')as f:f.write(json.dumps(r,ensure_ascii=False)+'\n')
            if r['available_gib']<4:abort.set()
    thread=threading.Thread(target=monitor,daemon=True);thread.start()
    try:
        for case in cases:
            if resources()['available_gib']<4 or abort.is_set():raise RuntimeError('内存余量不足，停止本实验。')
            path=ROOT/case['file']
            if digest(path)!=case['sha256']:raise ValueError('Input changed: '+case['id'])
            image=Image.open(path).convert('RGB')
            if case.get('oracle_roi'):image=image.crop(case['oracle_roi'])
            if case.get('oracle_ccw_degrees'):image=image.rotate(case['oracle_ccw_degrees'],expand=True)
            row={'id':case['id'],'file':case['file'],'source_sha256':case['sha256'],'input_size':list(image.size),
                 'oracle_roi':case.get('oracle_roi'),'oracle_ccw_degrees':case.get('oracle_ccw_degrees',0),
                 'truth_assurance':case.get('truth_assurance','pixel-reviewed'),'control':case.get('control',False)}
            prompt=args.prompt or ('Multi page parsing.'if args.phase!='plain-prompt'else 'Read and transcribe all visible text in the image. Preserve exact characters. Do not guess missing text.')
            row['instruction']=prompt
            row['formatted_prompt']=apply_chat_template(processor,model.config,prompt,num_images=1)
            start=time.perf_counter();text='';first=None;last=None;state='error';inputs=None
            mx.reset_peak_memory()
            try:
                inputs=prepare_inputs(processor,images=[image],prompts=row['formatted_prompt'],
                                      image_token_index=getattr(model.config,'image_token_index',None),
                                      cropping=args.phase!='base-mode')
                row['prepared']={'keys':list(inputs),'input_ids_shape':list(inputs['input_ids'].shape),
                    'spatial_crops':inputs.get('images_spatial_crop').tolist()if inputs.get('images_spatial_crop')is not None else None}
                cap=512 if case.get('oracle_roi')else 2048;row['max_tokens']=cap
                kwargs={k:v for k,v in inputs.items()if k not in ['input_ids','pixel_values','attention_mask']}
                stream=stream_generate(model,processor,prompt=row['formatted_prompt'],input_ids=inputs['input_ids'],
                    pixel_values=inputs.get('pixel_values'),mask=inputs.get('attention_mask'),max_tokens=cap,
                    temperature=0,skip_special_tokens=False,prefill_step_size=2048,**kwargs)
                try:
                    for step in stream:
                        last=step
                        if step.text and first is None:first=time.perf_counter()-start
                        text+=step.text
                        if abort.is_set():raise RuntimeError('可用内存不足，已停止本实验生成。')
                        if time.perf_counter()-start>args.max_seconds:raise TimeoutError('实验单项达到时间上限。')
                finally:stream.close()
                state='complete'if last and last.finish_reason!='length'and last.generation_tokens<cap else 'truncated'
            except Exception as e:row.update(error=type(e).__name__+': '+str(e),traceback=traceback.format_exc())
            row.update(state=state,wall_seconds=time.perf_counter()-start,first_text_seconds=first,
                       output=text,num_page_markers=text.count('<PAGE>'),
                       statistics={k:v for k,v in asdict(last).items()if k not in ['text','logprobs','token_ids']}if last else None,
                       mlx_peak_gib=mx.get_peak_memory()/1024**3,mlx_active_gib=mx.get_active_memory()/1024**3,
                       score=score(text,case['parts'],state=='complete'))
            evidence['cases'].append(row);evidence['resources'].append(resources());save()
            print(json.dumps({k:row[k]for k in ['id','state','wall_seconds','score']},ensure_ascii=False),flush=True)
            del inputs,image;gc.collect();mx.clear_cache()
            time.sleep(3 if row['wall_seconds']>30 else 1)
            if abort.is_set():raise RuntimeError('资源保护已触发，不再开始下一项。')
    finally:stop.set();thread.join(timeout=6);evidence['resources'].append(resources());save()


if __name__=='__main__':main()
