import { createHash, randomUUID } from 'node:crypto';
import { ApiError } from '../errors.ts';
import type { Registry } from './registry.ts';
import type { ReferenceAnalysis, ReferenceAnalysisResult, ReferenceAsset, ReferenceRegion } from '../../shared/admin.ts';
import { analysisIssues, analysisResultSchema } from '../../shared/reference-analysis.ts';
import { regionPoints, transformRegions } from '../../shared/reference-geometry.ts';
import type { ReferenceTransform } from '../../shared/admin.ts';
export const analysisKey=(assetId:string,regions:ReferenceRegion[]=[])=>createHash('sha256').update(JSON.stringify([assetId,regions])).digest('hex');
export type ReferenceAnalyzer=(asset:ReferenceAsset,regions:ReferenceRegion[],onStarted?:()=>void)=>Promise<ReferenceAnalysisResult>|ReferenceAnalysisResult;
/** 单进程串行任务；实际 VLM 调用另外与检验共用模型槽位。 */
export class ReferenceAnalyses {
 registry:Registry;run?:ReferenceAnalyzer;model:string;queue:string[]=[];busy=false;closed=false;
 constructor(registry:Registry,run?:ReferenceAnalyzer,model='未配置'){this.registry=registry;this.run=run;this.model=model;
  for(const row of registry.store.db.prepare('SELECT data FROM reference_analyses').all()){const a:ReferenceAnalysis=JSON.parse(String(row.data));if(a.state==='queued'||a.state==='running'){a.state='failed';a.stage='failed';a.message='服务重启，本次分析尚未完成，请重试。';this.save(a);this.registry.applyAnalysisToImports(a);}}
 }
 save(a:ReferenceAnalysis){this.registry.store.db.prepare('INSERT INTO reference_analyses(id,asset_id,key,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(a.id,a.assetId,a.key,JSON.stringify(a));}
 start(assetId:string,regions:ReferenceRegion[]=[],fresh=false){const asset=this.registry.asset(assetId);if(!asset)throw new ApiError(404,'正品图片不存在。');const key=analysisKey(assetId,regions);
  if(!fresh){
   const signature=(v:ReferenceRegion[])=>JSON.stringify(v.map(r=>[r.id,r.kind,r.label,regionPoints(r).map(p=>[Math.round(p.x*1e6),Math.round(p.y*1e6)])]));
   const old=this.registry.latestAnalysis(key)??this.registry.store.db.prepare('SELECT data FROM reference_analyses WHERE asset_id=? ORDER BY rowid DESC LIMIT 40').all(assetId).map(r=>JSON.parse(String(r.data)) as ReferenceAnalysis).find(a=>signature(a.regions)===signature(regions));
   if(old&&(old.transform||old.model===this.model&&old.state!=='failed')){
    if(old.key===key)return old;
    if(old.state==='queued'||old.state==='running')return this.transformed(assetId,assetId,old.regions,regions,{angle:0,sourceWidth:asset.width,sourceHeight:asset.height,rotatedWidth:asset.width,rotatedHeight:asset.height,left:0,top:0,width:asset.width,height:asset.height});
    const alias={...old,id:randomUUID(),key,regions:structuredClone(regions)};this.save(alias);return alias;
   }
  }
  const a:ReferenceAnalysis={id:randomUUID(),assetId,key,regions:structuredClone(regions),state:'queued',stage:'queued',message:'图片已保存，等待模型分析。',createdAt:new Date().toISOString(),model:this.model};this.save(a);this.queue.push(a.id);queueMicrotask(()=>void this.consume());return a;
 }
 transformed(sourceId:string,assetId:string,sourceRegions:ReferenceRegion[],regions:ReferenceRegion[],transform:ReferenceTransform){
  const parent=this.registry.latestAnalysis(analysisKey(sourceId,sourceRegions));
  const a:ReferenceAnalysis={id:randomUUID(),assetId,key:analysisKey(assetId,regions),regions:structuredClone(regions),state:parent?'queued':'failed',stage:parent?'transformed':'transform-failed',message:parent?'裁剪 / 旋转已应用，沿用原图片分析。':'裁剪已应用，尚无可沿用的原图片分析；可手动点击重新分析。',createdAt:new Date().toISOString(),model:parent?.model??this.model,...(parent?{inheritedFrom:parent.id}:{}),transform};
  this.save(a);if(parent){this.queue.push(a.id);queueMicrotask(()=>void this.consume());}return a;
 }
 async consume(){
  if(this.busy||this.closed)return;this.busy=true;
  try{while(this.queue.length&&!this.closed){
   const a=this.registry.analysis(this.queue.shift()!)!,at=performance.now();
   try{
    if(a.inheritedFrom){
     const source=this.registry.analysis(a.inheritedFrom);
     if(source?.state!=='completed'||!source.result||!a.transform)throw new Error('原图片分析尚未完成或失败；裁剪未触发新分析，可手动点击重新分析。');
     a.result=structuredClone(source.result);a.inheritedIssues=analysisIssues(source);
     const component=a.result.component;
     if(component){try{const [mapped]=transformRegions([{...component,id:'component',kind:'focus',label:''}],a.transform);a.result.component={x:mapped.x,y:mapped.y,width:mapped.width,height:mapped.height,angle:((component.angle-a.transform.angle+540)%360)-180};}catch{a.result.component=null;}}
    }else{
     a.state='queued';a.stage='queued';a.message='等待可用的模型资源…';this.save(a);
     if(!this.run)throw new Error('当前服务未启用真实 VLM，请启动真实识别服务后重试分析。');
     a.result=analysisResultSchema.parse(await this.run(this.registry.asset(a.assetId)!,a.regions,()=>{if(this.closed)return;a.state='running';a.stage='recognizing';a.message='正在读取丝印并分析图片质量…';this.save(a);}));
    }
    if(this.closed)return;a.state='completed';a.stage='ready';a.message=a.inheritedFrom?'已沿用原图片分析，裁剪 / 旋转未重新调用模型。':analysisIssues(a).length?'分析完成，有待确认项。':'分析完成，图片与丝印可用。';
   }catch(e){if(this.closed)return;a.state='failed';a.stage=a.inheritedFrom?'transform-failed':'failed';a.message=(e as Error).message;}
   a.elapsedMs=Math.round(performance.now()-at);a.finishedAt=new Date().toISOString();this.save(a);this.registry.applyAnalysisToImports(a);
  }}finally{this.busy=false;}
 }
 close(){this.closed=true;this.queue=[];}
}
