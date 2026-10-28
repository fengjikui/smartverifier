/** 独立进程内使用 WASM 读 RAR；仅写数字文件名，绝不按压缩包路径写磁盘。 */
import { createExtractorFromData } from 'node-unrar-js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pythonExecutable, pythonEnvironment } from '../python-runtime.ts';
const chunks:Buffer[]=[];for await(const chunk of process.stdin)chunks.push(chunk);const req=JSON.parse(Buffer.concat(chunks).toString('utf8'));
function resources(){const r=spawnSync(pythonExecutable(req.root),['-c',"import sys;sys.path.insert(0,'server/admin');from asset_worker import resource_check;resource_check()"],{cwd:req.root,env:pythonEnvironment(),encoding:'utf8',timeout:5000});if(r.status!==0)throw new Error('资源或热压力检查未通过，暂停 RAR 解包，请稍后重试。');}
try{
 resources();const bytes=await readFile(req.source),extractor=await createExtractorFromData({data:Uint8Array.from(bytes).buffer}),list=extractor.getFileList();
 if(list.arcHeader.flags.volume||list.arcHeader.flags.headerEncrypted)throw new Error('暂不支持分卷或加密 RAR，请提供普通图片压缩包。');
 const headers=[];let total=0;const names=new Set<string>();
 for(const h of list.fileHeaders){const name=h.name.replaceAll('\\','/').normalize('NFC');if(headers.length>=5000)throw new Error('压缩包条目超过 5000 个。');if(name.startsWith('/')||name.includes(':')||name.split('/').includes('..')||/[\x00-\x1f]/.test(name)||h.flags.encrypted)throw new Error('RAR 包含不安全路径或加密文件。');if(names.has(name))throw new Error('RAR 包含重复文件路径。');names.add(name);total+=h.unpSize;if(!Number.isSafeInteger(h.unpSize)||h.unpSize<0||total>500*1024**2||h.unpSize>100*1024**2)throw new Error('RAR 解压后数据过大，请分批导入。');headers.push(h);}
 await mkdir(req.folder,{recursive:true,mode:0o700});const files=[];let extracted=0;
 for(const entry of extractor.extract({files:h=>!h.flags.directory&&!h.name.startsWith('__MACOSX/')&&!path.posix.basename(h.name).startsWith('.')}).files){if(entry.fileHeader.flags.directory)continue;const data=entry.extraction;if(!data||data.byteLength!==entry.fileHeader.unpSize)throw new Error('RAR 文件内容或大小不完整。');extracted+=data.byteLength;if(extracted>500*1024**2)throw new Error('RAR 解压体积超过限制。');const name=entry.fileHeader.name.replaceAll('\\','/').normalize('NFC');if(!/\.(png|jpe?g|webp|json|xlsx)$/i.test(name))continue;const target=path.join(req.folder,String(files.length));await writeFile(target,data,{mode:0o600});files.push({name,path:target});if(files.length%20===0)resources();}
 if(!files.length)throw new Error('RAR 中没有可导入的图片或清单。');resources();process.stdout.write(JSON.stringify({files}));
}catch(e){process.stdout.write(JSON.stringify({error:e instanceof Error?e.message:'RAR 解包失败。'}));process.exitCode=1;}
