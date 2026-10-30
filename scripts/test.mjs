/** 显式枚举用例，Windows cmd/PowerShell 不需要替我们展开 shell 通配符。 */
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pythonTestEnvironment } from '../server/python-runtime.ts';
const root=fileURLToPath(new URL('../',import.meta.url));
const suites={
  unit:['domain','vision-contracts','vlm-config','whiteboard-scoring'],
  admin:['admin','admin-access','admin-users','reference-workflow','reference-analysis','reference-transform','rar-import'],
  camera:['camera','client-events'],
  workflow:['service','standalone','twenty-samples','paths','vlm-http','real-vision','photo-inspection'],
  deployment:['python-runtime','https','windows-update'],
};
const selected=process.argv[2];if(selected&&!suites[selected]){console.error('测试分组不存在：'+selected);process.exit(1);}
const files=readdirSync(path.join(root,'tests')).filter(name=>name.endsWith('.test.ts')&&(!selected||suites[selected].some(base=>name===base+'.test.ts'))).sort().map(name=>path.join(root,'tests',name));
const env=pythonTestEnvironment(root);for(const key of Object.keys(env))if(key.startsWith('SV_')&&key!=='SV_VISION_PYTHON')delete env[key];env.SV_RECOGNIZER='mock';
const result=spawnSync(process.execPath,['--test','--test-concurrency=1',...files],{cwd:root,stdio:'inherit',env});
if(result.error)console.error('测试进程启动失败：'+result.error.message);
process.exitCode=result.status??1;
