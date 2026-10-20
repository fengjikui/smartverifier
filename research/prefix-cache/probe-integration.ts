/** 显式真实推理：独立状态，验证正常识别、实际Schema和现场说明优先级。 */
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pythonEnvironment } from '../../server/python-runtime.ts';
import { InspectionService, person } from '../../server/service.ts';
import { LocalVisionPipeline } from '../../server/vision/local-pipeline.ts';
const root=fileURLToPath(new URL('../../',import.meta.url));
const out=path.join(root,'outputs/prefix-cache-20261018/integration');await mkdir(out,{recursive:true});
const state=await mkdtemp(path.join(out,'state-')),traces=path.join(state,'vision-traces');
const pipeline=new LocalVisionPipeline(root,state,{traceDirectory:traces});
const service=new InspectionService(state,root,1,pipeline),samples:unknown[]=[];
const code='import importlib.util,json; s=importlib.util.spec_from_file_location("v","server/vision/local_worker.py");v=importlib.util.module_from_spec(s);s.loader.exec_module(v); print(json.dumps(v.check_resources()))';
function resources(){const sample=JSON.parse(execFileSync(pipeline.python,['-c',code],{cwd:root,encoding:'utf8',env:pythonEnvironment(),timeout:5000}));samples.push(sample);return sample;}
let pressure='';resources();
const timer=setInterval(()=>{try{resources();}catch(error){pressure=String(error);service.closing=true;pipeline.close();}},3000);
try{
  const status=execFileSync(pipeline.python,['-c','from server.vision.local_worker import lmstudio_cli; import subprocess; print(subprocess.check_output([lmstudio_cli(),"ps"],text=True,encoding="utf-8",timeout=5))'],{cwd:root,encoding:'utf8',env:pythonEnvironment(),timeout:10000});
  assert.match(status.split('\n').find(s=>s.split(/\s+/)[0]===pipeline.model)??'',/IDLE/);
  let view=service.open('REALVISION2');view=await service.addRealTrial(view.round!.id,view.round!.revision,person);
  service.analyze(view.round!.id,view.round!.revision);while(service.worker)await delay(100);
  if(pressure)throw new Error(pressure);view=service.view('REALVISION2');
  assert.equal(view.summary!.total,2);assert.equal(view.summary!.completed,2);assert.equal(view.summary!.fail,1);assert.equal(view.summary!.canSubmit,true);
  const photo=view.round!.photos[0],failed=photo.components.find(c=>c.ai?.verdict==='FAIL')!;
  assert.deepEqual(failed.ai!.lines,['SV385','A26','0147']);
  const round={...view.round!,instruction:'本次允许第一行SV385作为SV358的可接受变体；其余丝印、标志和封装仍须一致。',instructionVersion:2};
  const override=await pipeline.recognize(round,photo,failed);
  assert.equal(override!.verdict,'PASS');assert.deepEqual(override!.lines,['SV385','A26','0147']);
  assert.ok(override!.instructionConflicts?.length||override!.instructionWarnings?.length);
  const receipt={experiment:'EXP-008',syntheticOnly:true,submittedToMes:false,profile:{inputLayout:pipeline.inputLayout,schema:pipeline.structured},summary:view.summary,
    baseline:photo.components.map(c=>({id:c.id,label:c.label,ai:c.ai})),onsiteInstruction:round.instruction,override,resources:samples,
    rawRecognition:await Promise.all([...photo.components.map(c=>c.ai!.rawRecord!),override!.rawRecord!].map(async name=>JSON.parse(await readFile(path.join(state,'vision-records',name),'utf8'))))};
  await writeFile(path.join(out,'result.json'),JSON.stringify(receipt,null,2)+'\n');
  // 公开报告仅包含生成样片的判定和配置；流片段及本机路径留在独立实验目录。
  await writeFile(path.join(root,'research/prefix-cache/integration-results.json'),JSON.stringify({...receipt,rawRecognition:receipt.rawRecognition.map(r=>({...r,data:{...r.data,response:{...r.data.response,lmstudio:{stats:r.data.response.lmstudio.stats,template_source_sha256:r.data.response.lmstudio.template_source_sha256,enable_thinking:r.data.response.lmstudio.enable_thinking}}}}))},null,2)+'\n');
  console.log(JSON.stringify({state,profile:receipt.profile,summary:receipt.summary,baseline:receipt.baseline.map(c=>({label:c.label,verdict:c.ai?.verdict})),override:override!.verdict,conflicts:override!.instructionConflicts,warnings:override!.instructionWarnings}));
}finally{clearInterval(timer);service.closing=true;pipeline.close();while(service.worker)await delay(50);service.store.close();}
