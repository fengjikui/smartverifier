import type { Registry } from '../server/admin/registry.ts';
import { analysisKey } from '../server/admin/analysis.ts';
import type { ReferenceAnalysisResult, ReferenceRegion } from '../shared/admin.ts';
export const fakeReferenceAnalysis=():ReferenceAnalysisResult=>({confidence:.95,quality:'clear',qualityReason:'测试替身，仅验证状态机，不代表真实识别',lines:['SV358','A26','0147'],ambiguities:[],description:'',component:{x:0,y:0,width:1,height:1,angle:0},regionReadings:[]});
export function seedAnalysis(registry:Registry,assetId:string,regions:ReferenceRegion[]=[]){const id=crypto.randomUUID(),data={id,key:analysisKey(assetId,regions),assetId,regions,state:'completed',stage:'ready',message:'TEST ONLY',createdAt:new Date().toISOString(),model:'TEST-ONLY',result:{...fakeReferenceAnalysis(),regionReadings:regions.map(r=>({id:r.id,text:null,readable:true}))}};registry.store.db.prepare('INSERT INTO reference_analyses VALUES(?,?,?,?)').run(id,assetId,data.key,JSON.stringify(data));return id;}
