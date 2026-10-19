import test from 'node:test';
import assert from 'node:assert/strict';
import { alignText, finalVerdict, summarize } from '../shared/domain.ts';
import type { Round, ComponentResult } from '../shared/types.ts';
function component(verdict:'PASS'|'FAIL', confidence=.97):ComponentResult{return {id:crypto.randomUUID(),label:'P001-01',index:0,bbox:[0,0,1,1],ai:{verdict,lines:['S5'],confidence,reason:'测试',instructionVersion:1},aiHistory:[],review:null,reviewHistory:[]};}
function round(components:ComponentResult[]):Round{return {id:'r1',taskId:'t1',number:1,revision:1,status:'ready',createdAt:'2026-10-17',instruction:'',instructionVersion:1,nextPhotoSequence:2,transfer:null,standard:{id:'std',version:1,material:'m',supplier:'s',image:'/reference.png',lines:['55'],description:'可变字段以标准说明为准'},photos:[{id:'p1',sequence:1,filename:'test.png',file:'test.png',url:'/test.png',hash:'test',width:10,height:10,sample:null,status:'ready',message:'',components}]};}
test('不良数按元件而非照片计算，任一元件不合格则整体不合格',()=>{const r=round([component('PASS'),component('FAIL'),component('FAIL')]);const s=summarize(r);assert.equal(s.total,3);assert.equal(s.fail,2);assert.equal(s.verdict,'FAIL');assert.equal(s.canSubmit,true);});
test('低置信度有明确结果时不强制复核，文字不同不直接推翻模型规则判断',()=>{const r=round([component('PASS',.6)]);assert.equal(summarize(r).lowConfidence,1);assert.equal(summarize(r).canSubmit,true);assert.equal(summarize(r).verdict,'PASS');});
test('未完成、过期、需重拍和零元件均阻止部分提交',()=>{for(const state of ['pending','queued','running','quality','error'] as const){const r=round([component('PASS')]);r.photos.push({...structuredClone(r.photos[0]),id:'p2',status:state,components:[]});assert.equal(summarize(r).canSubmit,false);assert.equal(summarize(r).verdict,null);}const r=round([]);assert.equal(summarize(r).canSubmit,false);const stale=round([component('PASS')]);stale.instructionVersion=2;assert.equal(summarize(stale).canSubmit,false);});
test('人工结果优先但不改写AI原判断',()=>{const c=component('FAIL');c.review={id:'fix',verdict:'PASS',person:{id:'QA018',name:'王敏'},reason:'核对实物',at:'2026-10-17',instructionVersion:1};assert.equal(finalVerdict(c),'PASS');assert.equal(summarize(round([c])).fail,0);assert.equal(c.ai?.verdict,'FAIL');});
test('逐字对齐覆盖替换、顺序、插入、缺字和Unicode，保留原文索引',()=>{
  for(const [a,b,changed] of [['SV358','SV385',2],['SMT5X','SMTSX',1],['ABCD','ABXCD',1],['ABCD','ACD',1],['丝印5','丝印S',1],['ABC','ABC',0]] as const){const rows=alignText(a,b);assert.equal(rows.filter(x=>x.different).length,changed);assert.equal(rows.map(x=>x.expected??'').join(''),a);assert.equal(rows.map(x=>x.actual??'').join(''),b);}
  const missing=alignText('ABCD','ACD');assert.equal(missing[1].actual,null);assert.equal(missing[2].actualIndex,1);assert.throws(()=>alignText('A'.repeat(513),'A'));
});
