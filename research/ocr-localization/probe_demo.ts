/** 通过正常 API 检测 create_demo.ts 添加的合成样片；保留失败，不修改服务超时配置。 */
import {readFile,writeFile} from 'node:fs/promises';
import {apiPath} from '../../shared/paths.ts';
const folder='outputs/ocr-localization-20261101';
const seed=JSON.parse(await readFile(folder+'/demo-seed.json','utf8'));
const base='http://127.0.0.1:5190';let cookie='';
async function request(route:string,body?:unknown){
 const r=await fetch(base+apiPath(route),{method:body?'POST':'GET',headers:{...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
 const c=r.headers.get('set-cookie');if(c)cookie=c.split(';')[0];const d=await r.json();if(!r.ok)throw new Error(r.status+JSON.stringify(d));return d;
}
await request('/session',{});const results=[];
for(const c of seed){
 let view=await request('/tasks/'+c.taskId);const before=view.round,started=performance.now();
 if(before.photos.some((p:any)=>['pending','error'].includes(p.status)))await request('/rounds/'+before.id+'/analyze',{revision:before.revision});
 const until=Date.now()+240000;
 do {await new Promise(r=>setTimeout(r,2000));view=await request('/tasks/'+c.taskId);if(!['queued','running'].includes(view.round.status))break;}while(Date.now()<until);
 const raw=[];
 for(const p of view.round.photos)for(const component of p.components){
  if(component.ai?.rawRecord){const record=JSON.parse(await readFile('var/data/vision-records/'+component.ai.rawRecord,'utf8'));raw.push({componentId:component.id,data:record.data});break;}
 }
 results.push({material:c.material,elapsedMs:Math.round(performance.now()-started),view,raw});
 await writeFile(folder+'/vlm-demo-api.json',JSON.stringify(results,null,2));
 console.log(JSON.stringify({material:c.material,elapsedMs:Math.round(performance.now()-started),summary:view.summary,photos:view.round.photos.map((p:any)=>({status:p.status,message:p.message,components:p.components.length}))}));
}
