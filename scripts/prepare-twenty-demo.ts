/** 显式运行才创建本机演示任务；不在普通启动中预填，也不覆盖已有任务。 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../server/store.ts';
import { InspectionService, person } from '../server/service.ts';

const root=fileURLToPath(new URL('../',import.meta.url));
const directory=path.resolve(process.env.SV_STATE_DIR??path.join(root,'var/data'));
const probe=new Store(directory);
const occupied=probe.rounds().some(r=>['queued','running','submitting'].includes(r.status));probe.close();
if(occupied)throw new Error('仍有任务正在检测或保存，请完成后再准备演示任务。');
const service=new InspectionService(directory,root,10);
try {
  const standard=service.store.tasks().find(t=>!t.id.startsWith('DEMO')&&t.standard)?.standard;
  if(!standard)throw new Error('缺少本地模拟标准，请先启动一次本地试用服务。');
  for(const [id,number] of [['DEMO20PHOTOS','20张照片 · 流程样例'],['DEMO20BOARD','单图20件 · 流程样例']] as const){
    if(!service.store.task(id))service.store.saveTask({id,number,material:standard.material,supplier:standard.supplier,standard:structuredClone(standard),roundId:null,effectiveRoundId:null});
    let view=service.open(id);
    if(view.round!.photos.length){console.log(number+'已有记录，保留原样。');continue;}
    if(id==='DEMO20PHOTOS')view=await service.addTwentyPhotos(view.round!.id,view.round!.revision,'prepared-demo-v1',person);
    else view=await service.addSample(view.round!.id,view.round!.revision,'twenty',undefined,person);
    service.analyze(view.round!.id,view.round!.revision);
    const deadline=Date.now()+15000;
    while(service.view(id).round!.status!=='ready'){
      if(Date.now()>deadline)throw new Error('准备演示样例超时。');
      await delay(20);
    }
    const result=service.view(id);
    console.log(JSON.stringify({task:id,photos:result.round!.photos.length,total:result.summary!.total,fail:result.summary!.fail,synthetic:true}));
  }
} finally { service.closing=true;service.store.close(); }
