import { analysisKey } from './analysis.ts';
import { importRowReady } from '../../shared/reference-analysis.ts';
import { ApiError } from '../errors.ts';
import type { Registry } from './registry.ts';
import type { ImportJob, ImportRow } from '../../shared/admin.ts';
import type { Person } from '../../shared/types.ts';
import { referenceInput } from './registry.ts';

export const importKey=(row:ImportRow)=>JSON.stringify([row.material,row.modelNumber??'']);
export function refreshImport(job:ImportJob){
  const pending=job.rows.filter(r=>!r.savedId);
  job.counts={ready:pending.filter(r=>importRowReady(r)&&r.decision==='include').length,skip:pending.filter(r=>r.status!=='error'&&(!importRowReady(r)||r.decision!=='include')).length,error:pending.filter(r=>r.status==='error').length};
  job.message=pending.length?`${job.counts.ready} 条可保存，${pending.length-job.counts.ready} 条暂存待处理。`:'本批条目已全部保存。';
  return job;
}
export function prepareImport(registry:Registry,job:ImportJob){
  const groups=new Map<string,ImportRow[]>();
  for(const r of job.rows){if(r.savedId)continue;delete r.duplicateId;delete r.duplicateVersion;delete r.batchGroup;if(r.status!=='error'){r.status='ready';r.message='';}r.material=r.material.normalize('NFC');r.modelNumber=(r.modelNumber??'').normalize('NFC');r.supplier=r.supplier.normalize('NFC');if(r.status==='error'){r.decision='defer';continue;}const analysis=registry.latestAnalysis(analysisKey(r.assetId??'',r.regions??[]));if(analysis){r.analysis=analysis;r.analysisId=analysis.id;}const key=importKey(r);groups.set(key,[...(groups.get(key)??[]),r]);const duplicate=registry.duplicate(r.material,r.modelNumber);if(duplicate){r.duplicateId=duplicate;r.duplicateVersion=registry.get(duplicate).version;r.needsRemark=!!registry.get(duplicate).regions?.length&&registry.get(duplicate).assetId!==r.assetId&&!r.regions?.length&&!r.reviewReason;r.status='skip';r.message='已有相同物料编号与型号。默认暂存，确认后可覆盖全部资料。';}r.decision=duplicate?'defer':'include';}
  for(const [key,rows]of groups)if(rows.length>1)for(const r of rows){r.batchGroup=key;r.status='skip';r.decision='defer';r.message=`同批有 ${rows.length} 张候选，请比较后只采用一张。`;}
  job.status='preview';job.version=1;return refreshImport(job);
}
export function decideImport(registry:Registry,id:string,actor:Person,version:number,rows:number[],decision:'include'|'defer'){
  let result!:ImportJob;registry.store.transaction(()=>{
    const job=registry.job(id,actor.id);if(job.status!=='preview'||(job.version??1)!==version)throw new ApiError(409,'这批预览已更新，请刷新后继续。');
    const targets=rows.map(n=>job.rows.find(r=>r.row===n));if(!targets.length||targets.some(r=>!r||r.savedId||r.status==='error'))throw new ApiError(400,'请选择尚未保存且预检通过的条目。');
    const keys=new Set<string>();for(const r of targets as ImportRow[]){if(decision==='include'&&keys.has(importKey(r)))throw new ApiError(409,'同批重复每组只能采用一张，请打开“比较并选择”。');keys.add(importKey(r));}
    for(const r of targets as ImportRow[]){if(decision==='include'&&r.batchGroup)for(const other of job.rows)if(other.batchGroup===r.batchGroup&&!other.savedId)other.decision='defer';r.decision=decision;}
    job.version=(job.version??1)+1;refreshImport(job);registry.saveJob(job,actor.id);result=job;
  });return result;
}
export function commitImport(registry:Registry,id:string,actor:Person,version?:number){
  let result!:ImportJob;registry.store.transaction(()=>{
    const job=registry.job(id,actor.id);if(job.status==='committed'){result=job;return;}
    if(job.status!=='preview'||version!==undefined&&(job.version??1)!==version)throw new ApiError(409,'预览尚未完成或已更新，请刷新后继续。');
    const selected=job.rows.filter(r=>!r.savedId&&r.decision==='include'&&importRowReady(r)),keys=new Set<string>();
    for(const r of selected){if(keys.has(importKey(r)))throw new ApiError(409,'同批重复每组只能保存一张。');keys.add(importKey(r));}
    let created=0,updated=0;
    for(const r of selected){
      const duplicate=registry.duplicate(r.material,r.modelNumber??'');
      if(duplicate&&(duplicate!==r.duplicateId||registry.get(duplicate).version!==r.duplicateVersion)){r.decision='defer';r.duplicateId=duplicate;r.duplicateVersion=registry.get(duplicate).version;r.needsRemark=!!registry.get(duplicate).regions?.length&&registry.get(duplicate).assetId!==r.assetId&&!r.regions?.length&&!r.reviewReason;r.status='skip';r.message='预览后已有标准发生变化，请重新检查并确认是否覆盖。';continue;}
      if(r.duplicateId&&!duplicate){r.decision='defer';r.message='原标准已被删除或更改匹配键，请重新上传确认。';continue;}
      const input=referenceInput.parse({material:r.material,modelNumber:r.modelNumber,supplier:r.supplier,name:r.name,description:r.description,lines:r.lines,assetId:r.assetId,status:'active',regions:r.regions??[],analysisId:r.analysisId,reviewReason:r.reviewReason??''});
      const record=registry.saveWithinTransaction(input,actor,duplicate??undefined,duplicate?r.duplicateVersion:undefined);r.savedId=record.id;r.message=duplicate?'已覆盖，旧版本保留。':'已保存';if(r.batchGroup)for(const other of job.rows)if(!other.savedId&&other!==r&&other.batchGroup===r.batchGroup){other.duplicateId=record.id;other.duplicateVersion=record.version;other.decision='defer';other.message='本组已采用另一张；如改用这张，需确认覆盖刚保存的资料。';}duplicate?updated++:created++;
    }
    job.receipt={created:(job.receipt?.created??0)+created,updated:(job.receipt?.updated??0)+updated,skipped:job.rows.filter(r=>!r.savedId).length};
    job.status=job.rows.every(r=>r.savedId)?'committed':'preview';job.version=(job.version??1)+1;refreshImport(job);
    job.message=`本次新增 ${created} 条，覆盖 ${updated} 条；${job.receipt.skipped} 条已保留在待处理批次。`;
    registry.saveJob(job,actor.id);registry.event('import',id,'import.commit',actor,null,{filename:job.filename,created,updated,deferred:job.receipt.skipped});result=job;
  });return result;
}
