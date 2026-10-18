/** 显式人工运行的真实模型烟测；使用独立状态，不是日常单元测试。 */
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { InspectionService, person } from '../server/service.ts';
import { LocalVisionPipeline } from '../server/vision/local-pipeline.ts';

const root=fileURLToPath(new URL('../../',import.meta.url));
const out=path.join(root,'outputs/real-vision-20261018');await mkdir(out,{recursive:true});
const state=await mkdtemp(path.join(out,'state-'));
const service=new InspectionService(state,root,1,new LocalVisionPipeline(root,state));
const records:unknown[]=[];
const override=process.argv.includes('--override');
try{
  for(const id of override?['REALVISION2']:['REALVISION1','REALVISION2','REALVISION3']){
    const thermal=execFileSync('pmset',['-g','therm'],{encoding:'utf8'});
    const resources=JSON.parse(execFileSync(path.join(root,'agent-tools/image-focus/.venv/bin/python'),['-c','import psutil,json,os; m=psutil.virtual_memory();print(json.dumps({"availableGiB":round(m.available/2**30,2),"cpuPercent":psutil.cpu_percent(interval=.2),"load":os.getloadavg()}))'],{encoding:'utf8'}));
    if(resources.availableGiB<8||resources.cpuPercent>90||thermal.split('\n').some(line=>!line.startsWith('Note: No ')&&/warning level|Speed_Limit/.test(line)))throw new Error('资源压力较高，停止本次实验');
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
