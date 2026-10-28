import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Person } from '../shared/types.ts';
const event=z.object({at:z.string().datetime(),phase:z.string().max(60),captureId:z.string().max(100).optional(),ms:z.number().nonnegative().max(1e9).optional(),width:z.number().int().nonnegative().max(50000).optional(),height:z.number().int().nonnegative().max(50000).optional(),bytes:z.number().nonnegative().max(300*1024**2).optional(),source:z.string().max(40).optional(),message:z.string().max(180).optional()}).strict();
export const clientEventsSchema=z.object({events:z.array(event).max(20)}).strict();
let writing=Promise.resolve();
export async function logClientEvents(directory:string,actor:Person,raw:unknown){const input=clientEventsSchema.parse(raw);const task=writing.then(async()=>{const folder=path.join(directory,'diagnostics'),file=path.join(folder,'camera.jsonl');await mkdir(folder,{recursive:true,mode:0o700});const size=await stat(file).then(s=>s.size).catch(()=>0);if(size>10*1024**2)await rename(file,path.join(folder,'camera.previous.jsonl'));await appendFile(file,input.events.map(e=>JSON.stringify({receivedAt:new Date().toISOString(),actorId:actor.id,...e})).join('\n')+'\n',{mode:0o600});});writing=task.catch(()=>{});await task;return {ok:true};}
