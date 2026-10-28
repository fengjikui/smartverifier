import { createHash, randomUUID } from 'node:crypto';
import { ApiError } from '../errors.ts';
import type { Registry } from './registry.ts';
import type { ReferenceAnalysis, ReferenceAnalysisResult, ReferenceAsset, ReferenceRegion } from '../../shared/admin.ts';
import { analysisIssues, analysisResultSchema } from '../../shared/reference-analysis.ts';
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
  if(!fresh){const old=this.registry.latestAnalysis(key);if(old&&old.model===this.model&&old.state!=='failed')return old;}
  const a:ReferenceAnalysis={id:randomUUID(),assetId,key,regions:structuredClone(regions),state:'queued',stage:'queued',message:'图片已保存，等待模型分析。',createdAt:new Date().toISOString(),model:this.model};this.save(a);this.queue.push(a.id);queueMicrotask(()=>void this.consume());return a;
 }
 async consume(){if(this.busy||this.closed)return;this.busy=true;try{while(this.queue.length&&!this.closed){const a=this.registry.analysis(this.queue.shift()!)!;const at=performance.now();try{a.state='queued';a.stage='queued';a.message='等待可用的模型资源…';this.save(a);if(!this.run)throw new Error('当前服务未启用真实 VLM，请启动真实识别服务后重试分析。');a.result=analysisResultSchema.parse(await this.run(this.registry.asset(a.assetId)!,a.regions,()=>{if(this.closed)return;a.state='running';a.stage='recognizing';a.message='正在定位元件、读取丝印并分析图片质量…';this.save(a);}));if(this.closed)return;a.state='completed';a.stage='ready';a.message=analysisIssues(a).length?'分析完成，有待确认项。':'分析完成，图片与丝印可用。';}catch(e){if(this.closed)return;a.state='failed';a.stage='failed';a.message=(e as Error).message;}a.elapsedMs=Math.round(performance.now()-at);a.finishedAt=new Date().toISOString();this.save(a);this.registry.applyAnalysisToImports(a);}}finally{this.busy=false;}}
 close(){this.closed=true;this.queue=[];}
}
