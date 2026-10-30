/** 显式调用配置的真实 VLM；全程使用独立状态目录，不接触业务正品和账号。 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp,readFile,mkdir,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../server/index.ts';
import type { ReferenceAnalysis,ReferenceAsset,ReferenceRecord } from '../shared/admin.ts';
import type { TaskView } from '../shared/types.ts';
const root=process.cwd();if(existsSync('.env.local'))process.loadEnvFile('.env.local');
// 仅隔离试验服务使用本机试用身份；不读取公司的管理员账号配置。
delete process.env.SV_ADMIN_USERS_FILE;process.env.SV_ADMIN_LOCAL_ONLY='true';
const state=await mkdtemp(path.join(tmpdir(),'jianwei-real-reference-')),{server,service,admin}=startServer({state,host:'127.0.0.1',port:0,real:true,debug:true});await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');const base='http://127.0.0.1:'+address.port+'/api/v1/inspections/marking';
let cookie='';const evidence:Record<string,unknown>={at:new Date().toISOString(),model:service.vision?.model,source:'真实VLM，虚构样例照片，不代表现场准确率'};
async function call<T>(route:string,data?:unknown,status=200){const r=await fetch(base+route,{method:data===undefined?'GET':'POST',headers:{Cookie:cookie,...(data instanceof FormData||data===undefined?{}:{'Content-Type':'application/json'})},body:data===undefined?undefined:data instanceof FormData?data:JSON.stringify(data)});const value=await r.json();assert.equal(r.status,status,JSON.stringify(value));return value as T;}
async function analysis(id:string){for(let i=0;i<1200;i++){const a=await call<ReferenceAnalysis>('/admin/analyses/'+id);if(a.state==='failed')throw Error(a.message);if(a.state==='completed')return a;await delay(200);}throw Error('真实分析等待超时');}
try{
 const login=await fetch(base+'/admin/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:'admin',code:'admin123'})});cookie=login.headers.get('set-cookie')!.split(';')[0];
 const form=new FormData();form.set('image',new File([await readFile('fixtures/inspection/green-mat-v1/reference-crop.png')],'000123 SV358.png'));console.log('正在真实分析正品样例…');const asset=await call<ReferenceAsset>('/admin/assets',form,201),a=await analysis(asset.analysisId!);evidence.reference=a;assert.deepEqual(a.result!.lines,['SV358','A26','0147']);
 const standard=await call<ReferenceRecord>('/admin/standards',{material:'000123',modelNumber:'SV358',supplier:'',assetId:asset.id,analysisId:a.id,status:'active',lines:a.result!.lines},201);assert.equal(standard.status,'active');
 const inspector=await fetch(base+'/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});cookie=inspector.headers.get('set-cookie')!.split(';')[0]+'; '+cookie;
 let view=await call<TaskView>('/checks',{standardId:standard.id,version:1,clientId:crypto.randomUUID()},201);const photo=new FormData();photo.set('photo',new File([await readFile('fixtures/inspection/green-mat-v1/single.png')],'模拟拍摄-single.png'));photo.set('width','1536');photo.set('height','1024');photo.set('revision',String(view.round!.revision));photo.set('clientId',crypto.randomUUID());
 view=await call<TaskView>('/rounds/'+view.round!.id+'/photos',photo);await call('/rounds/'+view.round!.id+'/analyze',{revision:view.round!.revision},202);console.log('正在直接识别整张待检原图…');
 for(let i=0;i<1200;i++){view=await call<TaskView>('/tasks/'+view.task.id);if(!['queued','running'].includes(view.round!.status))break;await delay(200);}
 assert.equal(view.round!.status,'ready');assert.equal(view.summary!.verdict,'PASS');assert.equal(view.summary!.total,1);assert.equal(view.round!.photos[0].preparation?.mode,'original');assert.ok(view.round!.photos[0].components.every(c=>!c.crop));evidence.inspection={summary:view.summary,components:view.round!.photos[0].components};view=await call<TaskView>('/rounds/'+view.round!.id+'/complete',{revision:view.round!.revision});assert.equal(view.round!.status,'completed');
 console.log('正在真实分析忽略区与重点区…');const regions=[{id:'focus',kind:'focus',x:.2,y:.2,width:.6,height:.3,label:'型号和第二行丝印'},{id:'ignore',kind:'ignore',x:.3,y:.55,width:.45,height:.18,label:'可变编号'}];const marked=await call<ReferenceAnalysis>('/admin/analyses',{assetId:asset.id,regions},202);evidence.regions=await analysis(marked.id);
 const folder=path.join(root,'var/reference-probes');await mkdir(folder,{recursive:true});const report=path.join(folder,Date.now()+'.json');await writeFile(report,JSON.stringify(evidence,null,2));console.log('真实正品分析、原图单件识别、完成保存通过。区域原始结果请查：'+report);
}finally{admin.files.close();service.closing=true;service.vision?.close?.();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));service.store.close();await rm(state,{recursive:true,force:true});}
