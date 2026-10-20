/** 跨平台 Python 入口：npm run python -- <解释器参数或脚本路径>。 */
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pythonExecutable, pythonEnvironment } from '../server/python-runtime.ts';

const root=fileURLToPath(new URL('../',import.meta.url));
if(existsSync(path.join(root,'.env.local')))process.loadEnvFile(path.join(root,'.env.local'));
const python=pythonExecutable(root);
const child=spawn(python,process.argv.slice(2),{cwd:root,stdio:'inherit',env:pythonEnvironment()});
child.on('error',error=>{
  console.error('Python 启动失败：'+python+'；请在目标电脑创建 .venv 并安装 requirements.txt。'+error.message);
  process.exitCode=1;
});
child.on('exit',code=>{process.exitCode=code??1;});
