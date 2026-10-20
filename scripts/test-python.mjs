/** Offline Python regression, serially, using the project environment on each OS. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pythonTestEnvironment } from '../server/python-runtime.ts';
const root=fileURLToPath(new URL('../',import.meta.url));
const environment=pythonTestEnvironment(root),python=environment.SV_VISION_PYTHON;
for(const pattern of ['test_*.py','*_test.py']){
  const result=spawnSync(python,['-m','unittest','discover','-s','tests','-p',pattern],{
    cwd:root,stdio:'inherit',env:environment,
  });
  if(result.error){console.error('Python环境不可用：'+python+'；请先创建本机 .venv 并安装根目录 requirements.txt。');process.exit(1);}
  if(result.status!==0)process.exit(result.status??1);
}
