import test from 'node:test';
import assert from 'node:assert/strict';
import { vlmConfig } from '../server/vision/vlm-config.ts';

test('VLM配置使用新名称，旧变量兼容；公司HTTP地址不依赖本机模板',()=>{
  const config=vlmConfig({}, {SV_VLM_PROVIDER:'openai-compatible',SV_VLM_ENDPOINT:'https://vlm.internal.example/api/v1/chat/completions/',SV_VLM_MODEL:'company-vlm',SV_VLM_API_KEY:'fixture-secret',SV_LM_ENDPOINT:'http://127.0.0.1:1234/v1',SV_LM_MODEL:'old'});
  assert.equal(config.endpoint,'https://vlm.internal.example/api/v1');assert.equal(config.model,'company-vlm');assert.equal(config.apiKey,'fixture-secret');
  assert.equal(vlmConfig({}, {SV_LM_MODEL:'old-model'}).model,'old-model');assert.equal(vlmConfig({},{}).provider,'lmstudio');
  assert.equal(vlmConfig({model:'explicit'}, {SV_VLM_MODEL:'env'}).model,'explicit');
});

test('错误地址、超时和覆盖核心参数在启动前明确拒绝',()=>{
  for(const endpoint of ['file:///etc/hosts','https://user:password@host/v1','https://host/v1?token=secret','https://host/v1#key'])assert.throws(()=>vlmConfig({provider:'openai-compatible',endpoint,model:'vlm'},{}));
  assert.throws(()=>vlmConfig({endpoint:'http://10.0.0.9:8000/v1'},{}),/SV_VLM_PROVIDER/);
  assert.throws(()=>vlmConfig({provider:'openai-compatible'},{}));
  for(const timeoutSeconds of [0,181,NaN])assert.throws(()=>vlmConfig({timeoutSeconds},{}));
  for(const extra of ['[]','invalid','{"messages":[]}','{"response_format":{}}'])assert.throws(()=>vlmConfig({}, {SV_VLM_EXTRA_BODY:extra}));
  assert.deepEqual(vlmConfig({}, {SV_VLM_EXTRA_BODY:'{"chat_template_kwargs":{"enable_thinking":false}}'}).extraBody,{chat_template_kwargs:{enable_thinking:false}});
});
