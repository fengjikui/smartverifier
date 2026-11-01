/** 显式运行：通过当前本机 API 添加两份合成演示标准及待检照片。不会覆盖现有标准。
 * 只接受本机试用身份；不保存密码/Cookie。真实管理员配置下请从页面正常录入。
 */
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { apiPath } from '../../shared/paths.ts';
const base='http://127.0.0.1:5190',root=process.cwd();let cookie='';
async function request(route:string,method='GET',body?:unknown){
 const form=body instanceof FormData;
 const r=await fetch(base+apiPath(route),{method,headers:{...(cookie?{Cookie:cookie}:{}),...(!form&&body?{'Content-Type':'application/json'}:{})},...(body?{body:form?body:JSON.stringify(body)}:{})});
 const set=r.headers.get('set-cookie');if(set)cookie=[...cookie.split('; ').filter(s=>s&&!s.startsWith(set.split('=')[0]+'=')),set.split(';')[0]].join('; ');
 const value=await r.json();if(!r.ok)throw new Error(r.status+' '+JSON.stringify(value));return value;
}
const config=await request('/admin/config');if(config.accessMode!=='trial')throw new Error('只允许本机试用身份自动添加演示数据，请从页面录入。');
const demoPassword=process.env.SV_DEMO_ADMIN_PASSWORD;if(!demoPassword)throw new Error('请临时设置 SV_DEMO_ADMIN_PASSWORD 为已有本机试用密码；脚本不保存凭证。');
await request('/admin/session','POST',{id:process.env.SV_DEMO_ADMIN_ID??'admin',code:demoPassword});
const cases=[
 {material:'DEMO-20261101-QG',modelNumber:'QG5S208B',reference:'reference-qg.png',sample:'eighteen-two-differences.png',lines:['QG5S208B']},
 {material:'DEMO-20261101-LOOKALIKE',modelNumber:'O0I1Z2',reference:'reference-confusables.png',sample:'confusable-pair.png',lines:['O0I1Z2','6G8B5S']},
];
const result=[];
for(const c of cases){
 const existing=await request('/admin/standards?q='+encodeURIComponent(c.material));
 let record=existing.items.find((r:any)=>r.material===c.material&&r.modelNumber===c.modelNumber);
 if(!record){
  const f=new FormData();f.set('image',new File([await readFile(path.join(root,'fixtures/inspection/ocr-exploration-v1',c.reference))],c.reference,{type:'image/png'}));
  const asset=await request('/admin/assets','POST',f);
  const until=Date.now()+240000;let analysis;
  while(Date.now()<until){analysis=await request('/admin/analyses/'+asset.analysisId);if(['completed','failed'].includes(analysis.state))break;await new Promise(r=>setTimeout(r,2000));}
  if(analysis?.state!=='completed')throw new Error('正品分析未完成：'+analysis?.message);
  record=await request('/admin/standards','POST',{material:c.material,modelNumber:c.modelNumber,supplier:'合成演示资料',name:'研究样例（非生产正品）',assetId:asset.id,analysisId:analysis.id,status:'active',lines:c.lines,description:'研究用合成样片。固定丝印须逐字符、逐位置一致。允许拍摄角度和光照差异；不允许将样品形近字自动改写成正品字符。无法辨明时明确说明，不猜补。',reviewReason:'合成演示资料，按设计及维护人员声明确认标准字符；形近字歧义保留在分析记录中，不作为真实业务准确率证据。'});
  console.log('已添加标准',c.material,record.id);
 }
 await request('/session','POST',{});
 const view=await request('/checks','POST',{standardId:record.id,version:record.version,clientId:'research-20261101-'+c.material});
 let updated=view;
 if(!view.round.photos.length){const f=new FormData();f.set('photo',new File([await readFile(path.join(root,'fixtures/inspection/ocr-exploration-v1',c.sample))],c.sample,{type:'image/png'}));f.set('width','1536');f.set('height','1024');f.set('clientId',randomUUID());f.set('revision',String(view.round.revision));updated=await request('/rounds/'+view.round.id+'/photos','POST',f);}
 result.push({material:c.material,standardId:record.id,taskId:view.task.id,view:updated});
}
await mkdir('outputs/ocr-localization-20261101',{recursive:true});
await writeFile('outputs/ocr-localization-20261101/demo-seed.json',JSON.stringify(result,null,2));
console.log(JSON.stringify(result.map(r=>({material:r.material,url:base+'/inspections/marking?task='+r.taskId})),null,2));
