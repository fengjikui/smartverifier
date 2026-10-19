import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';

export type VlmProvider='lmstudio'|'openai-compatible';
export type VlmOptions={model?:string;endpoint?:string;template?:string;provider?:VlmProvider;apiKey?:string;timeoutSeconds?:number;extraBody?:Record<string,unknown>;caFile?:string};
const reserved=new Set(['model','messages','stream','stream_options','response_format','max_tokens','max_completion_tokens','temperature','tools','tool_choice']);

/** 只读取服务端配置；不允许浏览器指定推理地址或认证信息。旧变量仅用于兼容。 */
export function vlmConfig(options:VlmOptions={},env:NodeJS.ProcessEnv=process.env){
  const provider=z.enum(['lmstudio','openai-compatible']).parse(options.provider??env.SV_VLM_PROVIDER??'lmstudio');
  const address=options.endpoint??env.SV_VLM_ENDPOINT??env.SV_LM_ENDPOINT??'http://127.0.0.1:1234/v1';
  let url:URL;try{url=new URL(address);}catch{throw new Error('VLM地址无效，请配置SV_VLM_ENDPOINT。');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error('VLM地址须为HTTP或HTTPS，不能包含账号、密码、查询参数或片段。');
  url.pathname=url.pathname.replace(/\/chat\/completions\/?$/,'').replace(/\/+$/,'');
  if(provider==='lmstudio'&&(url.protocol!=='http:'||!['127.0.0.1','localhost'].includes(url.hostname)))throw new Error('LM Studio SDK仅用于本机；公司VLM服务请设置SV_VLM_PROVIDER=openai-compatible。');
  const model=z.string().trim().min(1).parse(options.model??env.SV_VLM_MODEL??env.SV_LM_MODEL??(provider==='lmstudio'?'hr-qwen':''));
  const timeoutSeconds=z.coerce.number().int().min(5).max(180).parse(options.timeoutSeconds??env.SV_VLM_TIMEOUT_SECONDS??55);
  let extraBody:Record<string,unknown>;
  try{extraBody=options.extraBody??JSON.parse(env.SV_VLM_EXTRA_BODY??'{}');}catch{throw new Error('SV_VLM_EXTRA_BODY须为JSON对象。');}
  if(!extraBody||typeof extraBody!=='object'||Array.isArray(extraBody)||Object.keys(extraBody).some(k=>reserved.has(k)))throw new Error('VLM额外参数须为对象，不能覆盖图片、模型、Schema或流式等核心请求参数。');
  return {provider,endpoint:url.toString().replace(/\/$/,''),model,timeoutSeconds,extraBody,
    apiKey:options.apiKey??env.SV_VLM_API_KEY??'',caFile:options.caFile??env.SV_VLM_CA_FILE??'',
    template:options.template??env.SV_VLM_TEMPLATE??env.SV_LM_TEMPLATE??path.join(os.homedir(),'.lmstudio/models/lmstudio-community/Qwen3.8-27B-MLX-4bit/chat_template.jinja')};
}
