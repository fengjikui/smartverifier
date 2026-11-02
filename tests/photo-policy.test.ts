import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { photoPolicy, parseCaptureTime, admitPhotoTime } from '../server/photo-policy.ts';
import { startServer } from '../server/index.ts';
import { InspectionService, person } from '../server/service.ts';
import { datedPhotoFrom } from './photo-fixture.ts';
import { photoHash } from '../web/src/photo-selection.ts';

const root=path.resolve('.'),now=Date.UTC(2026,10,2,6,0,0),policy={albumMaxAgeMinutes:10,timezoneOffset:'+08:00'};
const jpeg=await readFile(path.join(root,'fixtures/inspection/ocr-exploration-v1/public/lm358n.jpg'));
const datedPhoto=(date:string,offset='+08:00')=>datedPhotoFrom(jpeg,date,offset);

test('拍摄时间：EXIF 原始时间、时区、精确边界、缺失／损坏／未来与关闭配置',async()=>{
  assert.deepEqual(photoPolicy({}),policy);assert.equal(photoPolicy({SV_ALBUM_MAX_AGE_MINUTES:'0'}).albumMaxAgeMinutes,0);
  for(const value of ['-1','NaN','1.2','10081',''])assert.throws(()=>photoPolicy({SV_ALBUM_MAX_AGE_MINUTES:value}));
  assert.throws(()=>photoPolicy({SV_PHOTO_TIMEZONE_OFFSET:'+25:00'}));
  assert.equal(parseCaptureTime('2026:11:02 14:00:00',undefined,'+08:00'),now);
  assert.equal(parseCaptureTime('2026:11:02 06:00:00','+00:00','+08:00'),now);
  assert.equal(parseCaptureTime('2026:02:30 14:00:00',undefined,'+08:00'),null);
  const recent=datedPhoto('2026:11:02 13:50:00');
  assert.equal(await admitPhotoTime(recent,'album',policy,now),'2026-11-02T05:50:00.000Z');
  await assert.rejects(admitPhotoTime(recent,'album',policy,now+1),{code:'PHOTO_TOO_OLD'});
  await assert.rejects(admitPhotoTime(datedPhoto('2026:11:02 14:03:00'),'album',policy,now),{code:'PHOTO_TIME_FUTURE'});
  await assert.rejects(admitPhotoTime(jpeg,'album',policy,now),{code:'PHOTO_TIME_MISSING'});
  await assert.rejects(admitPhotoTime(Buffer.from('bad'),'album',policy,now),{code:'PHOTO_TIME_MISSING'});
  assert.equal(await admitPhotoTime(jpeg,'album',{...policy,albumMaxAgeMinutes:0},now),undefined);
  assert.equal(await admitPhotoTime(jpeg,'camera',policy,now),undefined);
  assert.equal((await photoHash(new File([recent],'a.jpg')))?.length,64);
});

test('照片去重：不同文件名、不同入口、替换、删除、重试及本轮范围',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'sv-photo-admit-')),service=new InspectionService(directory,root,1,undefined,{...policy,albumMaxAgeMinutes:0});
  t.after(async()=>{service.closing=true;service.store.close();await rm(directory,{recursive:true,force:true});});
  let view=service.open('IQCF26090500016');const input={bytes:datedPhoto('2026:11:02 14:00:00'),width:800,height:600,filename:'one.jpg',clientId:'one',source:'album' as const};
  view=await service.addPhoto(view.round!.id,view.round!.revision,input,person);const first=view.round!.photos[0],revision=view.round!.revision;
  const same=await service.addPhoto(view.round!.id,revision-1,input,person);assert.equal(same.round!.photos.length,1);
  await assert.rejects(service.addPhoto(view.round!.id,revision,{...input,filename:'renamed.jpg',clientId:'two',source:'camera'},person),{code:'PHOTO_DUPLICATE'});
  assert.equal(service.view(view.task.id).round!.revision,revision);assert.equal((await readdir(path.join(directory,'files'))).length,1);
  view=await service.addPhoto(view.round!.id,revision,{...input,clientId:'replace',replaceId:first.id},person);assert.equal(view.round!.photos.length,1);assert.equal(view.round!.photos[0].sequence,first.sequence);
  const fresh=datedPhoto('2026:11:02 14:00:01');view=await service.addPhoto(view.round!.id,view.round!.revision,{...input,bytes:fresh,clientId:'fresh'},person);
  await assert.rejects(service.addPhoto(view.round!.id,view.round!.revision,{...input,bytes:fresh,clientId:'badreplace',replaceId:view.round!.photos[0].id},person),{code:'PHOTO_DUPLICATE'});
  view=service.remove(view.round!.id,view.round!.revision,view.round!.photos[0].id,person);
  view=await service.addPhoto(view.round!.id,view.round!.revision,{...input,clientId:'readd'},person);assert.equal(view.round!.photos.length,2);
  const other=service.open('IQCF26090500017');assert.equal((await service.addPhoto(other.round!.id,other.round!.revision,{...input,clientId:'different-task'},person)).round!.photos.length,1);
  const target=service.view(other.task.id),before=(await readdir(path.join(directory,'files'))).length;
  const concurrent=await Promise.allSettled(['parallel-a','parallel-b'].map(clientId=>service.addPhoto(target.round!.id,target.round!.revision,{...input,bytes:fresh,clientId},person)));
  assert.equal(concurrent.filter(r=>r.status==='fulfilled').length,1);assert.equal(service.view(other.task.id).round!.photos.length,2);
  assert.equal((await readdir(path.join(directory,'files'))).length,before+1,'并发冲突不能留下重复照片或孤立原图');
});

test('HTTP：相册时间服务端校验、拒绝不写库、相机无EXIF及原图保存',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'sv-photo-http-')),{server,service,admin}=startServer({state:directory,port:0,host:'127.0.0.1',delay:1});
  await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');const base='http://127.0.0.1:'+address.port+'/api/v1/inspections/marking';
  t.after(async()=>{service.closing=true;admin.files.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));service.store.close();await rm(directory,{recursive:true,force:true});});
  const session=await fetch(base+'/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}),cookie=session.headers.get('set-cookie')!.split(';')[0];assert.equal((await session.json()).photoPolicy.albumMaxAgeMinutes,10);
  const view=await (await fetch(base+'/tasks/IQCF26090500016/open',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:'{}'})).json();
  async function upload(bytes:Buffer,source:string,key:string,revision:number){const form=new FormData();form.set('photo',new File([new Uint8Array(bytes)],'same.jpg'));form.set('source',source);form.set('width','800');form.set('height','600');form.set('revision',String(revision));form.set('clientId',key);const r=await fetch(base+'/rounds/'+view.round.id+'/photos',{method:'POST',headers:{Cookie:cookie},body:form});return {status:r.status,data:await r.json()};}
  assert.equal((await upload(jpeg,'album','missing',view.round.revision)).data.code,'PHOTO_TIME_MISSING');
  assert.equal((await upload(datedPhoto('2020:01:01 00:00:00'),'album','old',view.round.revision)).data.code,'PHOTO_TOO_OLD');
  assert.equal(service.view(view.task.id).round!.photos.length,0);
  const camera=await upload(jpeg,'camera','camera',view.round.revision);assert.equal(camera.status,200);assert.equal(camera.data.round.photos[0].source,'camera');
  const duplicate=await upload(jpeg,'camera','duplicate',camera.data.round.revision);assert.equal(duplicate.data.code,'PHOTO_DUPLICATE');
  const stamp=new Date().toISOString().slice(0,19).replace(/-/g,':').replace('T',' '),recent=await upload(datedPhoto(stamp,'+00:00'),'album','recent',camera.data.round.revision);assert.equal(recent.status,200);assert.ok(recent.data.round.photos[1].capturedAt);
  const image=await fetch('http://127.0.0.1:'+address.port+recent.data.round.photos[1].url,{headers:{Cookie:cookie}});assert.deepEqual(Buffer.from(await image.arrayBuffer()),datedPhoto(stamp,'+00:00'));
});
