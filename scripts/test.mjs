/** 显式枚举用例，Windows cmd/PowerShell 不需要替我们展开 shell 通配符。 */
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pythonTestEnvironment } from '../server/python-runtime.ts';
const root=fileURLToPath(new URL('../',import.meta.url));
const files=readdirSync(path.join(root,'tests')).filter(name=>name.endsWith('.test.ts')).sort().map(name=>path.join(root,'tests',name));
const result=spawnSync(process.execPath,['--test','--test-concurrency=1',...files],{cwd:root,stdio:'inherit',env:pythonTestEnvironment(root)});
if(result.error)console.error('测试进程启动失败：'+result.error.message);
process.exitCode=result.status??1;
