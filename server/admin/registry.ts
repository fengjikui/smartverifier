import { apiPath } from '../../shared/paths.ts';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { commitImport, decideImport, refreshImport } from './imports.ts';
import { analysisKey } from './analysis.ts';
import { analysisIssues, regionInstructions } from '../../shared/reference-analysis.ts';
import { ApiError } from '../errors.ts';
import { regionGeometryValid, regionsOverlap } from '../../shared/reference-geometry.ts';
import type { Store } from '../store.ts';
import type { Person, Standard } from '../../shared/types.ts';
import type { CatalogPage } from '../../shared/catalog.ts';
import type { ReferenceRecord, ReferenceInput, ReferenceAsset, Page, MaintenanceEvent, ImportJob, ReferenceAnalysis, ReferenceRegion } from '../../shared/admin.ts';

const text=(max:number)=>z.string().trim().max(max).transform(s=>s.normalize('NFC'));
export const regionSchema=z.object({id:z.string().max(100),kind:z.enum(['ignore','focus']),x:z.number().min(0).max(1),y:z.number().min(0).max(1),width:z.number().positive().max(1),height:z.number().positive().max(1),label:text(300),polygon:z.array(z.object({x:z.number().min(0).max(1),y:z.number().min(0).max(1)}).strict()).length(4).optional()}).strict().refine(regionGeometryValid,'区域须为图片范围内的有效矩形或旋转矩形');
export const referenceInput=z.object({material:text(160).default(''),supplier:text(160).default(''),modelNumber:text(200).default(''),name:text(200).default(''),description:text(8000).default(''),lines:z.array(text(300)).max(50).default([]),assetId:z.string().max(100).default(''),status:z.enum(['active','draft']).default('active'),regions:z.array(regionSchema).max(30).default([]),analysisId:z.string().max(100).optional(),reviewReason:text(1000).default('')}).strict().superRefine((v,ctx)=>{
  if(v.status==='active'){if(!v.material)ctx.addIssue({code:z.ZodIssueCode.custom,message:'请填写物料编号',path:['material']});if(!v.modelNumber)ctx.addIssue({code:z.ZodIssueCode.custom,message:'请填写型号',path:['modelNumber']});}
  if(v.status==='draft'&&!v.material&&!v.modelNumber&&!v.assetId&&!v.name&&!v.description&&!v.lines.length)ctx.addIssue({code:z.ZodIssueCode.custom,message:'草稿至少添加图片或一项资料'});
  if(new Set(v.regions.map(r=>r.id)).size!==v.regions.length)ctx.addIssue({code:z.ZodIssueCode.custom,message:'区域编号不能重复',path:['regions']});
  for(let i=0;i<v.regions.length;i++)for(let j=0;j<i;j++){const a=v.regions[i],b=v.regions[j];if(a.kind!==b.kind&&regionsOverlap(a,b))ctx.addIssue({code:z.ZodIssueCode.custom,message:'忽略区域与重点区域不能重叠',path:['regions']});}
});
const stamp=()=>new Date().toISOString();
const like=(s:string)=>'%'+s.replace(/[!%_]/g,c=>'!'+c)+'%';
export class Registry {
  store:Store;
  constructor(store:Store){
    this.store=store;
    store.db.exec(`CREATE TABLE IF NOT EXISTS reference_assets(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reference_records(id TEXT PRIMARY KEY,material TEXT NOT NULL,supplier TEXT NOT NULL,name TEXT NOT NULL,status TEXT NOT NULL,deleted_at TEXT,updated_at TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS reference_page ON reference_records(deleted_at,status,updated_at DESC,id);
      CREATE TABLE IF NOT EXISTS reference_versions(id TEXT NOT NULL,version INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(id,version));
      CREATE TABLE IF NOT EXISTS maintenance_events(id INTEGER PRIMARY KEY,entity TEXT NOT NULL,entity_id TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,before_data TEXT,after_data TEXT,at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS maintenance_entity ON maintenance_events(entity,entity_id,id DESC);
      CREATE TABLE IF NOT EXISTS reference_imports(id TEXT PRIMARY KEY,owner TEXT NOT NULL,data TEXT NOT NULL);`);
    store.db.exec('CREATE TABLE IF NOT EXISTS reference_analyses(id TEXT PRIMARY KEY,asset_id TEXT NOT NULL,key TEXT NOT NULL,data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS reference_analysis_key ON reference_analyses(key);');
    // 保留旧资产、版本与检测记录；缺型号或新键冲突的旧标准停用，交由管理员确认。
    if(!store.db.prepare('PRAGMA table_info(reference_records)').all().some(c=>c.name==='model_number'))store.transaction(()=>{
      store.db.exec("ALTER TABLE reference_records ADD COLUMN model_number TEXT NOT NULL DEFAULT ''; DROP INDEX IF EXISTS reference_pair;");
      const records=store.db.prepare('SELECT data FROM reference_records').all().map(r=>JSON.parse(String(r.data)) as ReferenceRecord),groups=new Map<string,number>();
      for(const r of records)if(!r.deletedAt){const key=JSON.stringify([r.material,(r.modelNumber??'').trim()]);groups.set(key,(groups.get(key)??0)+1);}
      for(const r of records){r.modelNumber=(r.modelNumber??'').trim();const conflict=!r.modelNumber||(groups.get(JSON.stringify([r.material,r.modelNumber]))??0)>1;if(conflict&&!r.deletedAt){r.status='draft';this.event('reference',r.id,'reference.key-migration',{id:'SYSTEM',name:'系统迁移'},null,{material:r.material,modelNumber:r.modelNumber,reason:'新匹配键不完整或重复，保留资料并停用待确认'});}store.db.prepare('UPDATE reference_records SET model_number=?,status=?,data=? WHERE id=?').run(r.modelNumber,r.status,JSON.stringify(r),r.id);}
    });
    store.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS reference_material_model ON reference_records(material,model_number) WHERE deleted_at IS NULL AND status='active';");
    store.db.exec('CREATE INDEX IF NOT EXISTS reference_lookup ON reference_records(material,model_number) WHERE deleted_at IS NULL;');
  }
  asset(id:string):ReferenceAsset|null {const r=this.store.db.prepare('SELECT data FROM reference_assets WHERE id=?').get(id);return r?JSON.parse(String(r.data)):null;}
  addAsset(asset:ReferenceAsset){this.store.db.prepare('INSERT OR IGNORE INTO reference_assets VALUES(?,?)').run(asset.id,JSON.stringify(asset));}
  get(id:string):ReferenceRecord {const r=this.store.db.prepare('SELECT data FROM reference_records WHERE id=?').get(id);if(!r)throw new ApiError(404,'这条正品标准不存在。');const record:ReferenceRecord=JSON.parse(String(r.data));record.asset=this.asset(record.assetId);record.analysis=record.analysisId?this.analysis(record.analysisId)??undefined:undefined;return record;}
  analysis(id:string):ReferenceAnalysis|null{const row=this.store.db.prepare('SELECT data FROM reference_analyses WHERE id=?').get(id);return row?JSON.parse(String(row.data)):null;}
  latestAnalysis(key:string):ReferenceAnalysis|null{const row=this.store.db.prepare('SELECT data FROM reference_analyses WHERE key=? ORDER BY rowid DESC LIMIT 1').get(key);return row?JSON.parse(String(row.data)):null;}
  usableAnalysis(assetId:string,regions:ReferenceRegion[]=[],id?:string){const a=id?this.analysis(id):this.latestAnalysis(analysisKey(assetId,regions));if(!a||a.key!==analysisKey(assetId,regions)||a.state!=='completed'||!a.result)throw new ApiError(409,'当前图片与区域的模型分析尚未完成，不能启用；可先保存草稿。');return a;}
  applyAnalysisToImports(a:ReferenceAnalysis){for(const stored of this.store.db.prepare('SELECT owner,data FROM reference_imports').all()){const job:ImportJob=JSON.parse(String(stored.data));let changed=false;for(const row of job.rows)if(!row.savedId&&row.analysisId===a.id){row.analysis=a;if(a.result&&!row.manualContent){row.lines=a.result.lines;row.description=a.result.description;}changed=true;}if(changed){job.version=(job.version??1)+1;refreshImport(job);this.saveJob(job,String(stored.owner));}}}
  match(material:string,modelNumber:string):Standard|null {const r=this.store.db.prepare("SELECT id FROM reference_records WHERE material=? AND model_number=? AND deleted_at IS NULL AND status='active'").get(material.normalize('NFC').trim(),modelNumber.normalize('NFC').trim());return r?this.active(String(r.id)):null;}
  active(id:string):Standard|null {
    const row=this.store.db.prepare("SELECT data FROM reference_records WHERE id=? AND deleted_at IS NULL AND status='active'").get(id);
    if(!row)return null;const r=JSON.parse(String(row.data));return {id:r.id,version:r.version,material:r.material,supplier:r.supplier,modelNumber:r.modelNumber??'',image:r.image,lines:r.lines,description:r.description,regionDescription:r.regionDescription??'',regions:r.regions??[]};
  }
  catalog(material='',supplier='',page=1,size=25,offset=(page-1)*size):CatalogPage {
    const clauses=["deleted_at IS NULL","status='active'"],params:string[]=[];
    if(material.trim()){clauses.push("(material LIKE ? ESCAPE '!' OR model_number LIKE ? ESCAPE '!')");const keyword=like(material.trim().normalize('NFC'));params.push(keyword,keyword);}
    const materialWhere=clauses.join(' AND ');
    const suppliers=this.store.db.prepare('SELECT DISTINCT supplier FROM reference_records WHERE '+materialWhere+' ORDER BY supplier LIMIT 200').all(...params).map(r=>String(r.supplier)).filter(Boolean);
    if(supplier){clauses.push('supplier=?');params.push(supplier);}
    const where=clauses.join(' AND '),total=Number(this.store.db.prepare('SELECT COUNT(*) n FROM reference_records WHERE '+where).get(...params)!.n);
    const items=this.store.db.prepare('SELECT data FROM reference_records WHERE '+where+' ORDER BY updated_at DESC,id LIMIT ? OFFSET ?').all(...params,size,offset).map(row=>{
      const r=JSON.parse(String(row.data));return {id:r.id,version:r.version,material:r.material,supplier:r.supplier,modelNumber:r.modelNumber??'',name:r.name,image:r.image,lines:r.lines,description:r.description,regions:r.regions??[],regionDescription:r.regionDescription??'',thumbnail:this.asset(r.assetId)?.thumbnail??r.image};
    });
    return {items,total,page,size,suppliers};
  }
  duplicate(material:string,modelNumber:string,except=''){const r=this.store.db.prepare('SELECT id FROM reference_records WHERE material=? AND model_number=? AND deleted_at IS NULL AND id<>?').get(material,modelNumber,except);return r?String(r.id):null;}
  page(q='',status='all',page=1,size=25,ids?:{values:string[];exclude:boolean}):Page<ReferenceRecord>{
    const where=[status==='trash'?'deleted_at IS NOT NULL':'deleted_at IS NULL'],params:(string|number)[]=[];
    const result="(SELECT data FROM reference_analyses WHERE id=json_extract(reference_records.data,'$.analysisId'))";
    if(status==='quality')where.push("json_extract("+result+",'$.result.quality') IN ('poor','uncertain')");
    if(status==='ambiguity')where.push("json_array_length(json_extract("+result+",'$.result.ambiguities'))>0");
    if(status==='override')where.push("json_extract(data,'$.manualApproval.kind')='override'");
    if(status==='pending')where.push("status='draft'");
    if(['active','draft'].includes(status)){where.push('status=?');params.push(status);}
    if(q){where.push("(material LIKE ? ESCAPE '!' OR supplier LIKE ? ESCAPE '!' OR name LIKE ? ESCAPE '!' OR json_extract(data,'$.modelNumber') LIKE ? ESCAPE '!')");params.push(like(q),like(q),like(q),like(q));}
    if(ids){if(ids.values.length){where.push('id '+(ids.exclude?'NOT IN':'IN')+' ('+ids.values.map(()=>'?').join(',')+')');params.push(...ids.values);}else if(!ids.exclude)where.push('0=1');}
    const clause=where.join(' AND '),total=Number(this.store.db.prepare('SELECT COUNT(*) n FROM reference_records WHERE '+clause).get(...params)!.n);
    const items=this.store.db.prepare('SELECT data FROM reference_records WHERE '+clause+' ORDER BY updated_at DESC,id LIMIT ? OFFSET ?').all(...params,size,(page-1)*size).map(r=>{const v:ReferenceRecord=JSON.parse(String(r.data));v.asset=this.asset(v.assetId);v.analysis=v.analysisId?this.analysis(v.analysisId)??undefined:undefined;return v;});
    return {items,total,page,size};
  }
  event(entity:string,id:string,action:string,actor:Person,before:unknown,after:unknown){this.store.db.prepare('INSERT INTO maintenance_events(entity,entity_id,actor,action,before_data,after_data,at) VALUES(?,?,?,?,?,?,?)').run(entity,id,JSON.stringify(actor),action,before?JSON.stringify(before):null,after?JSON.stringify(after):null,stamp());}
  events(q='',page=1,size=25,entityId?:string):Page<MaintenanceEvent>{
    const where=entityId?'entity_id=?':q?"(actor LIKE ? ESCAPE '!' OR before_data LIKE ? ESCAPE '!' OR after_data LIKE ? ESCAPE '!' OR action LIKE ? ESCAPE '!')":'1=1';
    const p=entityId?[entityId]:q?[like(q),like(q),like(q),like(q)]:[];
    const items=this.store.db.prepare('SELECT * FROM maintenance_events WHERE '+where+' ORDER BY id DESC LIMIT ? OFFSET ?').all(...p,size,(page-1)*size).map(r=>({id:Number(r.id),entity:String(r.entity),action:String(r.action),actor:JSON.parse(String(r.actor)),at:String(r.at),before:r.before_data?JSON.parse(String(r.before_data)):null,after:r.after_data?JSON.parse(String(r.after_data)):null}));
    return {items,total:Number(this.store.db.prepare('SELECT COUNT(*) n FROM maintenance_events WHERE '+where).get(...p)!.n),page,size};
  }
  persist(v:ReferenceRecord){const data=JSON.stringify({...v,asset:null});this.store.db.prepare('INSERT INTO reference_records(id,material,supplier,name,status,deleted_at,updated_at,data,model_number) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET material=excluded.material,supplier=excluded.supplier,model_number=excluded.model_number,name=excluded.name,status=excluded.status,deleted_at=excluded.deleted_at,updated_at=excluded.updated_at,data=excluded.data').run(v.id,v.material,v.supplier,v.name,v.status,v.deletedAt,v.updatedAt,data,v.modelNumber??'');this.store.db.prepare('INSERT INTO reference_versions VALUES(?,?,?)').run(v.id,v.version,data);}
  save(raw:unknown,actor:Person,id?:string,version?:number){
    const input=referenceInput.parse(raw);let saved!:ReferenceRecord;
    this.store.transaction(()=>{saved=this.saveWithinTransaction(input,actor,id,version);});return saved;
  }
  saveWithinTransaction(input:ReferenceInput,actor:Person,id?:string,version?:number):ReferenceRecord{
    const before=id?this.get(id):null;
    if(before&&(before.deletedAt||before.version!==version))throw new ApiError(409,'标准已被其他人更新或移入回收站，请重新打开后再修改。当前输入仍保留。');
    const dup=input.material&&input.modelNumber?this.duplicate(input.material,input.modelNumber,id):null;if(dup)throw new ApiError(409,'相同物料编号与型号的标准已存在，请搜索该标准并编辑，不会覆盖原记录。');
    const asset=input.assetId?this.asset(input.assetId):null;
    if(input.assetId&&!asset)throw new ApiError(400,'正品图片不存在，请重新选择。');
    if(input.status==='active'&&!asset)throw new ApiError(400,'启用前请添加正品图片；暂时不完整可保存为草稿。');
    const needsRemark=!!before&&!!(before.needsRemark||before.assetId!==input.assetId&&before.regions?.length)&&!input.regions?.length&&!input.reviewReason;
    const analysis=input.status==='active'?this.usableAnalysis(input.assetId,input.regions,input.analysisId):(input.analysisId?this.analysis(input.analysisId):null);
    const issues=analysis?analysisIssues(analysis):[];
    if(input.status==='active'&&(issues.length||needsRemark)&&!input.reviewReason)throw new ApiError(409,needsRemark?'图片已更换，旧区域需重新标记或确认不再需要。':'请确认分析中的问题并填写人工核对原因；图片质量差时须明确强制采用。');
    const at=stamp(),record:ReferenceRecord={...input,id:id??randomUUID(),version:(before?.version??0)+1,image:asset?apiPath('/reference-assets/'+asset.id):'',asset,regionDescription:regionInstructions(input.regions??[],analysis??undefined),analysisId:analysis?.id??input.analysisId,analysis:analysis??undefined,needsRemark,createdAt:before?.createdAt??at,updatedAt:at,updatedBy:actor,deletedAt:null,...(input.reviewReason&&input.status==='active'&&analysis?.state==='completed'?{manualApproval:{kind:analysis?.result?.quality!=='clear'?'override' as const:'confirmed' as const,reason:input.reviewReason,actor,at}}:{})};
    this.persist(record);this.event('reference',record.id,before?'reference.update':'reference.create',actor,before,record);return record;
  }
  trash(id:string,version:number,restore:boolean,actor:Person){
    let result!:ReferenceRecord;this.store.transaction(()=>{const before=this.get(id);if(before.version!==version)throw new ApiError(409,'标准已更新，请刷新后重试。');
      if(restore&&!before.deletedAt||!restore&&before.deletedAt)throw new ApiError(409,'标准状态已变化，请刷新。');
      if(restore&&this.duplicate(before.material,before.modelNumber??'',id))throw new ApiError(409,'当前已有相同物料与型号的标准，请先处理重复记录再恢复。');
      result={...before,version:before.version+1,deletedAt:restore?null:stamp(),updatedAt:stamp(),updatedBy:actor};this.persist(result);this.event('reference',id,restore?'reference.restore':'reference.delete',actor,before,result);
    });return result;
  }
  detail(id:string){return {record:this.get(id),events:this.events('',1,100,id).items};}
  job(id:string,owner:string):ImportJob{const r=this.store.db.prepare('SELECT data FROM reference_imports WHERE id=? AND owner=?').get(id,owner);if(!r)throw new ApiError(404,'导入记录不存在或属于其他管理员。');return JSON.parse(String(r.data));}
  saveJob(job:ImportJob,owner:string){this.store.db.prepare('INSERT INTO reference_imports VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(job.id,owner,JSON.stringify(job));}
  jobs(owner:string){return this.store.db.prepare("SELECT data FROM reference_imports WHERE owner=? ORDER BY rowid DESC LIMIT 100").all(owner).map(r=>JSON.parse(String(r.data)) as ImportJob).filter(j=>j.status==='preview');}
  decideJob(id:string,actor:Person,version:number,rows:number[],decision:'include'|'defer'){return decideImport(this,id,actor,version,rows,decision);}
  commitJob(id:string,actor:Person,version?:number){return commitImport(this,id,actor,version);}
}
