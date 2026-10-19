import { appendFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { TraceEvent, TraceSummary } from '../../shared/model-trace.ts';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const envelope=z.object({seq:z.number().int().positive(),type:z.string(),elapsedMs:z.number().finite().nonnegative(),at:z.number().finite()}).passthrough();
export class TraceStore{
  directory:string;cache=new Map<string,{size:number;mtime:number;events:TraceEvent[]}>();
  constructor(directory:string){this.directory=directory;}
  folder(id:string){if(!uuid.test(id))throw new Error('调试记录编号无效');return path.join(this.directory,id);}
  async read(id:string){
    const file=path.join(this.folder(id),'events.ndjson'),info=await stat(file);
    if(info.size>16*1024*1024)throw new Error('调试记录超过读取上限');
    const cached=this.cache.get(id);if(cached?.size===info.size&&cached.mtime===info.mtimeMs)return cached.events;
    const lines=(await readFile(file,'utf8')).split('\n');lines.pop(); // 最后一行尚未flush时，留给下次增量读取。
    const events=lines.filter(Boolean).map(line=>envelope.parse(JSON.parse(line)) as TraceEvent);
    this.cache.set(id,{size:info.size,mtime:info.mtimeMs,events});if(this.cache.size>200)this.cache.delete(this.cache.keys().next().value!);
    return events;
  }
  async finish(id:string,valid:boolean,message:string){
    let events;try{events=await this.read(id);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
    if(events.some(e=>e.type==='validation'))return;
    const first=events[0];if(!first)return;
    const event={seq:events.at(-1)!.seq+1,type:'validation',elapsedMs:Math.max(events.at(-1)!.elapsedMs,Date.now()-first.at*1000+first.elapsedMs),at:Date.now()/1000,valid,message};
    await appendFile(path.join(this.folder(id),'events.ndjson'),JSON.stringify(event)+'\n',{mode:0o600});
  }
  async failure(id:string,message:string,metadata:Record<string,unknown>={}){
    await mkdir(this.folder(id),{recursive:true,mode:0o700});
    let events:TraceEvent[]=[];try{events=await this.read(id);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(events.some(e=>e.type==='error'))return;
    const now=Date.now()/1000;
    if(!events.length){const first={seq:1,type:'request',at:now,elapsedMs:0,...metadata};await writeFile(path.join(this.folder(id),'events.ndjson'),JSON.stringify(first)+'\n',{mode:0o600});events=[first];}
    await appendFile(path.join(this.folder(id),'events.ndjson'),JSON.stringify({seq:events.at(-1)!.seq+1,type:'error',elapsedMs:Math.max(events.at(-1)!.elapsedMs,(now-events[0].at)*1000),at:now,message})+'\n');
  }
  async list():Promise<TraceSummary[]>{
    let entries;try{entries=await readdir(this.directory,{withFileTypes:true});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
    const found=[];
    for(const entry of entries.filter(e=>e.isDirectory()&&uuid.test(e.name))){
      try{const events=await this.read(entry.name),first=events[0];if(!first)continue;
        const generation=events.find(e=>e.type==='generation_finished'),validation=events.find(e=>e.type==='validation'),failed=events.find(e=>e.type==='error'),config=events.find(e=>e.type==='prediction_started');
        found.push({id:entry.name,at:first.at,model:first.model??'',label:first.label??first.taskId??'元件比对',source:first.source??'inspection',componentIds:first.componentIds??[],status:failed?'error':validation?(validation.valid?'valid':'invalid'):Date.now()/1000-(events.at(-1)?.at??0)>180?'interrupted':'running',format:config?.responseFormat??'prompt-json',historical:!!first.historical,elapsedMs:generation?.elapsedMs??events.at(-1)!.elapsedMs,outputTokens:generation?.stats?.predictedTokensCount??null,tokensPerSecond:generation?.stats?.tokensPerSecond??null,completedItems:events.filter(e=>e.type==='item_complete').length} satisfies TraceSummary);
      }catch{/* 单条损坏记录不妨碍其他调试记录读取。 */}
    }
    return found.sort((a,b)=>b.at-a.at).slice(0,100);
  }
}
