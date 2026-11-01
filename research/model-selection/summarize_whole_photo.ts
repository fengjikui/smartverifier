/** 离线诊断：保留失败回复，不能将结构失败或错位结果包装成成功。 */
import { readFile,readdir,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { photoReplySchema } from '../../server/vision/photo-reply.ts';

const i=process.argv.indexOf('--directory');if(i<0||!process.argv[i+1])throw new Error('Missing --directory');
const directory=path.resolve(process.argv[i+1]),summary=JSON.parse(await readFile(path.join(directory,'results.json'),'utf8'));
const rawDirectory=path.join(directory,'state/vision-records');
const records=await Promise.all((await readdir(rawDirectory)).filter(f=>f.endsWith('.json')).map(async file=>({file,data:JSON.parse(await readFile(path.join(rawDirectory,file),'utf8')).data})));
for(const row of summary.runs){
 const matches=records.filter(({data})=>data.model===row.model&&data.sourceHash===row.inputSha256);
 if(matches.length!==1)throw new Error('Expected exactly one raw record for '+row.model+'/'+row.case);
 const {file,data}=matches[0],choice=data.response?.choices?.[0];
 row.rawRecord=file;row.modelElapsedMs=data.elapsedMs;row.usage=data.response?.usage;row.inputMetrics=data.inputMetrics;row.promptVersion=data.promptVersion;row.finishReason=choice?.finish_reason;
 try{
  const parsed=JSON.parse(choice.message.content.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/,'$1'));
  row.rawReply=parsed;
  const validated=photoReplySchema.safeParse(parsed);
  row.rawReplySchemaIssues=validated.success?[]:validated.error.issues.map(issue=>({path:issue.path,message:issue.message}));
 }catch(error){row.rawReplyParseError=(error as Error).message;row.rawText=choice?.message?.content;}
 if(data.traceId){
  const events=(await readFile(path.join(directory,'traces',data.traceId,'events.ndjson'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  row.firstOutputMs=events.find(e=>e.type==='first_output')?.observedAtMs??null;
  row.itemComplete=events.filter(e=>e.type==='item_complete').map(e=>({componentId:e.componentId,observedAtMs:e.observedAtMs,provisional:true}));
  row.generationStats=events.find(e=>e.type==='generation_finished')?.stats??null;
 }
}
const j=process.argv.indexOf('--output'),output=j<0?path.join(directory,'summary.json'):path.resolve(process.argv[j+1]);
await writeFile(output,JSON.stringify(summary,null,2)+'\n');
for(const row of summary.runs)console.log(JSON.stringify({model:row.model,case:row.case,seconds:row.modelElapsedMs/1000,firstOutputMs:row.firstOutputMs,accepted:row.schemaValid,issues:row.rawReplySchemaIssues}));
