import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBatchReply } from '../server/vision/local-pipeline.ts';
import { compareCalls, scoreCall } from '../research/whiteboard-batching/summarize.ts';

const truth=[{componentId:'C01',source:'a',expectedLines:['SV358'],expectedVerdict:'PASS' as const,referenceDependent:false,image:{file:'1.png',sha256:'a',width:100,height:100}},
  {componentId:'C02',source:'b',expectedLines:['SV385'],expectedVerdict:'FAIL' as const,referenceDependent:false,image:{file:'2.png',sha256:'b',width:100,height:100}}];
const item=(id:string,lines:string[],verdict:'PASS'|'FAIL')=>({componentId:id,status:'decided',verdict,lines,confidence:.9,reason:'已比较',features:[],differences:[]});
function call(items:unknown[],mode='board4',ids=['C01','C02']){return {sequence:1,repeat:1,mode,componentIds:ids,callWallMs:5000,response:{choices:[{finish_reason:'stop',message:{content:JSON.stringify({items,instructionConflicts:[]})}}]}};}

test('白板结果按ID匹配；文字准确与判定准确分别评分，错序位置由字符串计算',()=>{
  const input=call([item('C02',['SV385'],'FAIL'),item('C01',['SV358'],'PASS')]);
  assert.deepEqual(parseBatchReply(input.response.choices[0].message.content,['C01','C02']).items.map(i=>i.componentId),['C01','C02']);
  const scored=scoreCall(input,truth);assert.equal(scored.protocolValid,true);assert.equal(scored.counts.textExact,2);assert.equal(scored.counts.verdictCorrect,2);
  const wrong=scoreCall(call([item('C01',['SV358'],'PASS'),item('C02',['SV358'],'PASS')]),truth);
  assert.equal(wrong.counts.falsePass,1);assert.equal(wrong.counts.characterErrors,2);assert.equal(wrong.counts.textExact,1);
});
test('漏项、重号、未知编号和截断均使整批失效，诊断不按位置修复或伪造元件',()=>{
  const missing=scoreCall(call([item('C01',['SV358'],'PASS')]),truth);assert.equal(missing.protocolValid,false);assert.equal(missing.counts.missing,1);assert.equal(missing.counts.textExact,1);
  const duplicate=scoreCall(call([item('C01',['SV358'],'PASS'),item('C01',['SV358'],'PASS')]),truth);assert.equal(duplicate.protocolValid,false);assert.equal(duplicate.counts.textExact,0);
  const unknown=scoreCall(call([item('C01',['SV358'],'PASS'),item('C2',['SV385'],'FAIL')]),truth);assert.equal(unknown.protocolValid,false);assert.deepEqual(unknown.unknownIds,['C2']);assert.equal(unknown.counts.missing,1);
  const truncated=call([item('C01',['SV358'],'PASS')]);truncated.response.choices[0].message.content='{"items":[';truncated.response.choices[0].finish_reason='length';assert.equal(scoreCall(truncated,truth).counts.textExact,0);
  const malformed=scoreCall(call([null,'invalid']),truth);assert.equal(malformed.protocolValid,false);assert.equal(malformed.counts.missing,2);
  assert.throws(()=>parseBatchReply('{"items":[]}',[]));
});
test('性能比较只汇总同轮同一组元件；缺少逐件对照时不生成漂亮的加速数字',()=>{
  const records=[scoreCall({...call([item('C01',['SV358'],'PASS')],'single',['C01']),callWallMs:3000},truth),scoreCall({...call([item('C02',['SV385'],'FAIL')],'single',['C02']),callWallMs:5000},truth),scoreCall(call([item('C01',['SV358'],'PASS'),item('C02',['SV385'],'FAIL')]),truth)];
  const comparison=compareCalls(records,{four:['C01','C02']})[0];assert.equal(comparison.speedup,1.6);assert.equal(comparison.timeReductionPercent,37.5);assert.equal(comparison.batchTextExact,2);
  assert.throws(()=>compareCalls(records.slice(1),{four:['C01','C02']}),/缺少/);
});
