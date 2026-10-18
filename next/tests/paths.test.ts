import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { startServer } from '../server/index.ts';
import { MARKING_BASE, MARKING_API, markingPaths, adminPath, adminRoute, canonicalPage, apiPath, internalApiPath, publicLinkReplacer } from '../shared/paths.ts';

test('公共路径：正品详情、编辑、回收站上下文及 API 命名空间往返正确',()=>{
  for(const route of ['references','new','edit/abc','copy/abc','detail/abc','detail/abc/trash','trash','import','audit','tasks']){
    const url=new URL(adminPath(route),'http://localhost');
    assert.equal(adminRoute(url.pathname,url.search),route);
  }
  assert.equal(canonicalPage('/admin/new'),MARKING_BASE+'/admin/standards/new');
  assert.equal(canonicalPage('/tablet-preview/'),markingPaths.preview);
  assert.equal(canonicalPage('/inspections/other'),null);
  for(const route of ['/session','/task-list','/standalone','/admin/references/abc','/admin/events','/tasks/TEST/open','/rounds/abc/report.md'])assert.equal(internalApiPath(apiPath(route)),'/api'+route);
  assert.equal(apiPath('/standards?material=0007'),MARKING_API+'/standards?material=0007');
  const data=JSON.parse(JSON.stringify({image:'/api/reference-assets/old.png',url:'/assets/old.png',description:'/api/description',content:'/api/raw-model-output'},publicLinkReplacer));
  assert.equal(data.image,MARKING_API+'/reference-assets/old.png');assert.equal(data.url,MARKING_BASE+'/assets/old.png');
  assert.equal(data.description,'/api/description');assert.equal(data.content,'/api/raw-model-output');
});

test('HTTP：旧地址保留查询参数，新前缀的鉴权、管理入口、资源和历史照片正常',async t=>{
  const state=await mkdtemp(path.join(tmpdir(),'sv-paths-'));
  const {server,service,admin}=startServer({state,port:0,host:'127.0.0.1',delay:1});await once(server,'listening');
  const address=server.address();assert.ok(address&&typeof address!=='string');const base='http://127.0.0.1:'+address.port;
  t.after(async()=>{service.closing=true;admin.files.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));service.store.close();await rm(state,{recursive:true,force:true});});
  for(const [old,next]of [['/',''],['/admin/new','/admin/standards/new'],['/tablet-preview?demo=photos&view=report','/preview/tablet?demo=photos&view=report'],['/debug/model','/debug/model']]){
    const response=await fetch(base+old,{redirect:'manual'});assert.equal(response.status,308);assert.equal(response.headers.get('location'),MARKING_BASE+next);
  }
  const trash=await fetch(base+'/admin/detail/abc/trash?keep=1',{redirect:'manual'});assert.equal(trash.headers.get('location'),MARKING_BASE+'/admin/standards/abc?keep=1&from=trash');
  assert.equal((await fetch(base+markingPaths.standards)).status,200);
  assert.equal((await fetch(base+markingPaths.preview)).status,200);
  assert.equal((await fetch(base+MARKING_BASE+'/assets/tasks-scan.svg')).headers.get('content-type'),'image/svg+xml');
  assert.equal((await fetch(base+'/inspections/other')).status,404);
  assert.equal((await fetch(base+MARKING_API+'/tasks')).status,401);
  assert.equal((await fetch(base+MARKING_API+'/reference-assets/11111111-1111-1111-1111-111111111111.png')).status,401);
  const login=await fetch(base+MARKING_API+'/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie')!.split(';')[0],headers={Cookie:cookie,'Content-Type':'application/json'};
  const bootstrap=await(await fetch(base+MARKING_API+'/bootstrap',{headers})).json();assert.ok(bootstrap.tasks[0].standard.image.startsWith(MARKING_BASE+'/assets/'));
  const list=await fetch(base+MARKING_API+'/tasks',{headers});assert.equal(list.status,200);
  assert.equal((await fetch(base+MARKING_API+'/admin/standards',{headers})).status,401,'检验身份不能绕过管理鉴权');
  const denied=await fetch(base+MARKING_API+'/standards',{method:'POST',headers:{...headers,Origin:'https://other.example'},body:'{}'});assert.equal(denied.status,403);
  const legacy=await fetch(base+'/api/bootstrap',{headers,redirect:'manual'});assert.equal(legacy.status,308);assert.equal(legacy.headers.get('location'),MARKING_API+'/bootstrap');
  const oldLogin=await fetch(base+'/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(oldLogin.status,200,'旧写请求直接兼容，不重定向上传正文');
  const open=await(await fetch(base+MARKING_API+'/tasks/'+bootstrap.tasks[0].id+'/open',{method:'POST',headers,body:'{}'})).json();
  const sample=await(await fetch(base+MARKING_API+'/rounds/'+open.round.id+'/sample',{method:'POST',headers,body:JSON.stringify({revision:open.round.revision,sample:'pass'})})).json();
  assert.ok(sample.round.photos[0].url.startsWith(MARKING_API+'/files/'));
  assert.ok(service.round(open.round.id).photos[0].url.startsWith('/api/files/'),'不修改数据库中的历史/内部路径');
  assert.equal((await fetch(base+sample.round.photos[0].url,{headers})).status,200);
  const report=await fetch(base+MARKING_API+'/rounds/'+open.round.id+'/report.md',{headers});assert.equal(report.status,200);assert.match(report.headers.get('content-disposition')??'',/attachment/);assert.ok((await report.text()).includes(MARKING_API+'/files/'));
  const adminLogin=await fetch(base+MARKING_API+'/admin/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:'admin',code:'admin123'})});assert.equal(adminLogin.status,200);
  const adminCookie=adminLogin.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await fetch(base+MARKING_API+'/admin/standards',{headers:{Cookie:adminCookie}})).status,200);
  assert.equal((await fetch(base+MARKING_API+'/admin/audit-logs',{headers:{Cookie:adminCookie}})).status,200);
  assert.equal((await fetch(base+MARKING_API+'/admin/tasks',{method:'POST',headers:{Cookie:adminCookie,'Content-Type':'application/json'},body:'{}'})).status,405);
});
