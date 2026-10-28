import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { InspectionService,person } from '../server/service.ts';
import { AdminFiles } from '../server/admin/files.ts';
import { ReferenceAnalyses } from '../server/admin/analysis.ts';
import { fakeReferenceAnalysis } from './reference-fixture.ts';
import { storedRar } from './rar-fixture.ts';

test('实际 RAR5 解包、中文嵌套文件名预检、自动分析、保存和不安全路径拒绝',async t=>{
 const root=path.resolve('.'),dir=await mkdtemp(path.join(tmpdir(),'sv-rar-中文 空格-')),service=new InspectionService(dir,root),analyses=new ReferenceAnalyses(service.registry,()=>fakeReferenceAnalysis(),'TEST-ONLY'),files=new AdminFiles(service.registry,root,dir,analyses);t.after(async()=>{files.close();service.store.close();await rm(dir,{recursive:true,force:true});});
 const image=await readFile('fixtures/inspection/green-mat-v1/reference-crop.png');
 async function unpack(name:string,reportedSize?:number){const started=await files.start([new File([storedRar([{name,data:image,reportedSize}])],'标准.rar')],person);for(let i=0;i<200;i++){const j=service.registry.job(started.id,person.id);if(j.status!=='validating'&&!j.rows.some(r=>r.analysis?.state==='queued'||r.analysis?.state==='running'))return j;await delay(10);}throw Error('RAR预检超时');}
 let job=await unpack('资料/更深目录/000123 SV358 供应商甲.png');assert.equal(job.status,'preview',job.message);assert.equal(job.rows[0].material,'000123');assert.equal(job.rows[0].modelNumber,'SV358');assert.equal(job.rows[0].supplier,'供应商甲');assert.equal(job.counts.ready,1);assert.equal(service.registry.commitJob(job.id,person,job.version).receipt!.created,1);
 job=await unpack('../escape.png');assert.equal(job.status,'failed');assert.match(job.message,/不安全/);
 job=await unpack('000124 SV358.png',101*1024**2);assert.equal(job.status,'failed');assert.match(job.message,/过大/);
});
