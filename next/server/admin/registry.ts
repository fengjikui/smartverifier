import { apiPath } from '../../shared/paths.ts';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { mockTask } from '../mes/mock.ts';
import { ApiError } from '../errors.ts';
import type { Store } from '../store.ts';
import type { Person, Standard } from '../../shared/types.ts';
import type { CatalogPage } from '../../shared/catalog.ts';
import type { ReferenceRecord, ReferenceInput, ReferenceAsset, Page, MaintenanceEvent, ImportJob } from '../../shared/admin.ts';

const text=(max:number)=>z.string().trim().max(max).transform(s=>s.normalize('NFC'));
export const referenceInput=z.object({material:text(160).pipe(z.string().min(1)),supplier:text(160).pipe(z.string().min(1)),name:text(200).default(''),description:text(8000).default(''),lines:z.array(text(300)).max(50).default([]),assetId:z.string().max(100).default(''),status:z.enum(['active','draft']).default('active')}).strict();
const stamp=()=>new Date().toISOString();
const like=(s:string)=>'%'+s.replace(/[!%_]/g,c=>'!'+c)+'%';
export class Registry {
  store:Store;
  constructor(store:Store){
    this.store=store;
    store.db.exec(`CREATE TABLE IF NOT EXISTS reference_assets(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reference_records(id TEXT PRIMARY KEY,material TEXT NOT NULL,supplier TEXT NOT NULL,name TEXT NOT NULL,status TEXT NOT NULL,deleted_at TEXT,updated_at TEXT NOT NULL,data TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS reference_pair ON reference_records(material,supplier) WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS reference_page ON reference_records(deleted_at,status,updated_at DESC,id);
      CREATE TABLE IF NOT EXISTS reference_versions(id TEXT NOT NULL,version INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(id,version));
      CREATE TABLE IF NOT EXISTS maintenance_events(id INTEGER PRIMARY KEY,entity TEXT NOT NULL,entity_id TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,before_data TEXT,after_data TEXT,at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS maintenance_entity ON maintenance_events(entity,entity_id,id DESC);
      CREATE TABLE IF NOT EXISTS reference_imports(id TEXT PRIMARY KEY,owner TEXT NOT NULL,data TEXT NOT NULL);`);
  }
  asset(id:string):ReferenceAsset|null {const r=this.store.db.prepare('SELECT data FROM reference_assets WHERE id=?').get(id);return r?JSON.parse(String(r.data)):null;}
  addAsset(asset:ReferenceAsset){this.store.db.prepare('INSERT OR IGNORE INTO reference_assets VALUES(?,?)').run(asset.id,JSON.stringify(asset));}
  get(id:string):ReferenceRecord {const r=this.store.db.prepare('SELECT data FROM reference_records WHERE id=?').get(id);if(!r)throw new ApiError(404,'这条正品标准不存在。');const record:ReferenceRecord=JSON.parse(String(r.data));record.asset=this.asset(record.assetId);return record;}
  match(material:string,supplier:string):Standard|null {const r=this.store.db.prepare("SELECT data FROM reference_records WHERE material=? AND supplier=? AND deleted_at IS NULL AND status='active'").get(material.normalize('NFC').trim(),supplier.normalize('NFC').trim());if(!r)return null;const v=JSON.parse(String(r.data));return {id:v.id,version:v.version,material:v.material,supplier:v.supplier,image:v.image,lines:v.lines,description:v.description};}
  active(id:string):Standard|null {
    const row=this.store.db.prepare("SELECT data FROM reference_records WHERE id=? AND deleted_at IS NULL AND status='active'").get(id);
    if(!row)return null;const r=JSON.parse(String(row.data));return {id:r.id,version:r.version,material:r.material,supplier:r.supplier,image:r.image,lines:r.lines,description:r.description};
  }
  catalog(material='',supplier='',page=1,size=25,offset=(page-1)*size):CatalogPage {
    const clauses=["deleted_at IS NULL","status='active'"],params:string[]=[];
    if(material.trim()){clauses.push("material LIKE ? ESCAPE '!'");params.push(like(material.trim().normalize('NFC')));}
    const materialWhere=clauses.join(' AND ');
    const suppliers=this.store.db.prepare('SELECT DISTINCT supplier FROM reference_records WHERE '+materialWhere+' ORDER BY supplier LIMIT 200').all(...params).map(r=>String(r.supplier));
    if(supplier){clauses.push('supplier=?');params.push(supplier);}
    const where=clauses.join(' AND '),total=Number(this.store.db.prepare('SELECT COUNT(*) n FROM reference_records WHERE '+where).get(...params)!.n);
    const items=this.store.db.prepare('SELECT data FROM reference_records WHERE '+where+' ORDER BY updated_at DESC,id LIMIT ? OFFSET ?').all(...params,size,offset).map(row=>{
      const r=JSON.parse(String(row.data));return {id:r.id,version:r.version,material:r.material,supplier:r.supplier,name:r.name,image:r.image,lines:r.lines,description:r.description,thumbnail:this.asset(r.assetId)?.thumbnail??r.image};
    });
    return {items,total,page,size,suppliers};
  }
  duplicate(material:string,supplier:string,except=''){const r=this.store.db.prepare('SELECT id FROM reference_records WHERE material=? AND supplier=? AND deleted_at IS NULL AND id<>?').get(material,supplier,except);return r?String(r.id):null;}
  page(q='',status='all',page=1,size=25):Page<ReferenceRecord>{
    const where=[status==='trash'?'deleted_at IS NOT NULL':'deleted_at IS NULL'],params:(string|number)[]=[];
    if(['active','draft'].includes(status)){where.push('status=?');params.push(status);}
    if(q){where.push("(material LIKE ? ESCAPE '!' OR supplier LIKE ? ESCAPE '!' OR name LIKE ? ESCAPE '!')");params.push(like(q),like(q),like(q));}
    const clause=where.join(' AND '),total=Number(this.store.db.prepare('SELECT COUNT(*) n FROM reference_records WHERE '+clause).get(...params)!.n);
    const items=this.store.db.prepare('SELECT data FROM reference_records WHERE '+clause+' ORDER BY updated_at DESC,id LIMIT ? OFFSET ?').all(...params,size,(page-1)*size).map(r=>{const v:ReferenceRecord=JSON.parse(String(r.data));v.asset=this.asset(v.assetId);return v;});
    return {items,total,page,size};
  }
  event(entity:string,id:string,action:string,actor:Person,before:unknown,after:unknown){this.store.db.prepare('INSERT INTO maintenance_events(entity,entity_id,actor,action,before_data,after_data,at) VALUES(?,?,?,?,?,?,?)').run(entity,id,JSON.stringify(actor),action,before?JSON.stringify(before):null,after?JSON.stringify(after):null,stamp());}
  events(q='',page=1,size=25,entityId?:string):Page<MaintenanceEvent>{
    const where=entityId?'entity_id=?':q?"(actor LIKE ? ESCAPE '!' OR before_data LIKE ? ESCAPE '!' OR after_data LIKE ? ESCAPE '!' OR action LIKE ? ESCAPE '!')":'1=1';
    const p=entityId?[entityId]:q?[like(q),like(q),like(q),like(q)]:[];
    const items=this.store.db.prepare('SELECT * FROM maintenance_events WHERE '+where+' ORDER BY id DESC LIMIT ? OFFSET ?').all(...p,size,(page-1)*size).map(r=>({id:Number(r.id),entity:String(r.entity),action:String(r.action),actor:JSON.parse(String(r.actor)),at:String(r.at),before:r.before_data?JSON.parse(String(r.before_data)):null,after:r.after_data?JSON.parse(String(r.after_data)):null}));
    return {items,total:Number(this.store.db.prepare('SELECT COUNT(*) n FROM maintenance_events WHERE '+where).get(...p)!.n),page,size};
  }
  persist(v:ReferenceRecord){const data=JSON.stringify({...v,asset:null});this.store.db.prepare('INSERT INTO reference_records VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET material=excluded.material,supplier=excluded.supplier,name=excluded.name,status=excluded.status,deleted_at=excluded.deleted_at,updated_at=excluded.updated_at,data=excluded.data').run(v.id,v.material,v.supplier,v.name,v.status,v.deletedAt,v.updatedAt,data);this.store.db.prepare('INSERT INTO reference_versions VALUES(?,?,?)').run(v.id,v.version,data);}
  save(raw:unknown,actor:Person,id?:string,version?:number){
    const input=referenceInput.parse(raw);let saved!:ReferenceRecord;
    this.store.transaction(()=>{saved=this.saveWithinTransaction(input,actor,id,version);});return saved;
  }
  saveWithinTransaction(input:ReferenceInput,actor:Person,id?:string,version?:number):ReferenceRecord{
    const before=id?this.get(id):null;
    if(before&&(before.deletedAt||before.version!==version))throw new ApiError(409,'标准已被其他人更新或移入回收站，请重新打开后再修改。当前输入仍保留。');
    const dup=this.duplicate(input.material,input.supplier,id);if(dup)throw new ApiError(409,'相同物料编号与供应商的标准已存在，请搜索该标准并编辑，不会覆盖原记录。');
    const asset=input.assetId?this.asset(input.assetId):null;
    if(input.assetId&&!asset)throw new ApiError(400,'正品图片不存在，请重新选择。');
    if(input.status==='active'&&!asset)throw new ApiError(400,'启用前请添加正品图片；暂时不完整可保存为草稿。');
    const at=stamp(),record:ReferenceRecord={...input,id:id??randomUUID(),version:(before?.version??0)+1,image:asset?apiPath('/reference-assets/'+asset.id):'',asset,createdAt:before?.createdAt??at,updatedAt:at,updatedBy:actor,deletedAt:null};
    this.persist(record);this.event('reference',record.id,before?'reference.update':'reference.create',actor,before,record);return record;
  }
  trash(id:string,version:number,restore:boolean,actor:Person){
    let result!:ReferenceRecord;this.store.transaction(()=>{const before=this.get(id);if(before.version!==version)throw new ApiError(409,'标准已更新，请刷新后重试。');
      if(restore&&!before.deletedAt||!restore&&before.deletedAt)throw new ApiError(409,'标准状态已变化，请刷新。');
      if(restore&&this.duplicate(before.material,before.supplier,id))throw new ApiError(409,'当前已有相同物料与供应商的标准，请先处理重复记录再恢复。');
      result={...before,version:before.version+1,deletedAt:restore?null:stamp(),updatedAt:stamp(),updatedBy:actor};this.persist(result);this.event('reference',id,restore?'reference.restore':'reference.delete',actor,before,result);
    });return result;
  }
  detail(id:string){const record=this.get(id),tasks=this.store.tasks().filter(t=>(t.origin==='local'||t.origin==='mes'||t.origin==='demo-mes')&&t.material===record.material&&t.supplier===record.supplier);if(!record.deletedAt&&record.status==='active'){const demo=mockTask(record);if(!tasks.some(task=>task.id===demo.id))tasks.unshift(demo);}return {record,events:this.events('',1,100,id).items,tasks};}
  job(id:string,owner:string):ImportJob{const r=this.store.db.prepare('SELECT data FROM reference_imports WHERE id=? AND owner=?').get(id,owner);if(!r)throw new ApiError(404,'导入记录不存在或属于其他管理员。');return JSON.parse(String(r.data));}
  saveJob(job:ImportJob,owner:string){this.store.db.prepare('INSERT INTO reference_imports VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(job.id,owner,JSON.stringify(job));}
  commitJob(id:string,actor:Person){let job=this.job(id,actor.id);if(job.status==='committed')return job;if(job.status!=='preview'||job.counts.error)throw new ApiError(409,'请先处理导入错误，重新上传并通过预检。');
    this.store.transaction(()=>{job=this.job(id,actor.id);if(job.status==='committed')return;let created=0,skipped=0;
      for(const row of job.rows){if(row.status==='skip'||this.duplicate(row.material,row.supplier)){skipped++;continue;}this.saveWithinTransaction(referenceInput.parse({material:row.material,supplier:row.supplier,name:row.name,description:row.description,lines:row.lines,assetId:row.assetId,status:'active'}),actor);created++;}
      job.status='committed';job.receipt={created,skipped};job.message=`已新增 ${created} 条，跳过 ${skipped} 条重复标准。`;this.saveJob(job,actor.id);this.event('import',job.id,'import.commit',actor,null,{filename:job.filename,...job.receipt});
    });return job;
  }
}
