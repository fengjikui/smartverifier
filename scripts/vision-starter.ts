import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { exportStarter } from '../server/vision/starter.ts';
const root=fileURLToPath(new URL('../',import.meta.url));
try{
 const {values}=parseArgs({options:{separate:{type:'boolean',default:false},backend:{type:'string',default:'vlm'},reference:{type:'string',default:'clear'},out:{type:'string'}}});
 const {output,run}=await exportStarter(root,{separate:values.separate,backend:values.backend,reference:values.reference},values.out?path.resolve(values.out):undefined);
 console.log('仅模拟：未调用模型，不写业务数据库或MES。');console.log('前置分割：'+(run.options.separate?'模拟启用':'关闭')+'；识别后端：'+run.route.selected+'（模拟）');console.log(run.route.reasons.join(' '));console.log('图片、输入输出JSON已保存：'+output);
}catch(e){console.error('接入示例失败：'+(e as Error).message);process.exitCode=1;}
