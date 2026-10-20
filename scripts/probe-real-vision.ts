/** 显式人工运行的真实模型烟测；使用独立状态，不是日常单元测试。 */
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { pythonExecutable, pythonEnvironment } from '../server/python-runtime.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { InspectionService, person } from '../server/service.ts';
import { LocalVisionPipeline } from '../server/vision/local-pipeline.ts';

const root=fileURLToPath(new URL('../',import.meta.url));
if(existsSync(path.join(root,'.env.local')))process.loadEnvFile(path.join(root,'.env.local'));
const out=path.join(root,'outputs/real-vision-20261018');await mkdir(out,{recursive:true});
const state=await mkdtemp(path.join(out,'state-'));
const service=new InspectionService(state,root,1,new LocalVisionPipeline(root,state));
const records:unknown[]=[];
const override=process.argv.includes('--override');
try{
  for(const id of override?['REALVISION2']:['REALVISION1','REALVISION2','REALVISION3']){
    const resources=JSON.parse(execFileSync(pythonExecutable(root),['-c','from server.vision.local_worker import check_resources; import json; print(json.dumps(check_resources()))'],{cwd:root,encoding:'utf8',env:pythonEnvironment(),timeout:10000}));
    const thermal=resources.thermal;
    let view=service.open(id);view=await service.addRealTrial(view.round!.id,view.round!.revision,person);
    if(override)view=service.notes(view.round!.id,view.round!.revision,'本次允许第一行SV385作为SV358的可接受变体；其余丝印、标志和封装仍须一致。',person);
    const start=Date.now();service.analyze(view.round!.id,view.round!.revision);
    while(['queued','running'].includes(service.view(id).round!.status))await delay(250);
    view=service.view(id);
    const row={id,state,resources,thermal,elapsedMs:Date.now()-start,summary:view.summary,photos:view.round!.photos};records.push(row);
    console.log(id,JSON.stringify({elapsedMs:Date.now()-start,summary:view.summary,photos:view.round!.photos.map(p=>({status:p.status,message:p.message,components:p.components.map(c=>({label:c.label,lines:c.ai?.lines,verdict:c.ai?.verdict,confidence:c.ai?.confidence,elapsedMs:c.ai?.elapsedMs}))}))}));
    await writeFile(path.join(out,override?'onsite-integrated-probe.json':'integrated-probe.json'),JSON.stringify(records,null,2));
    await writeFile(path.join(state,'probe.json'),JSON.stringify(records,null,2));
  }
}finally{service.closing=true;service.store.close();}
