/** Offline Python regression, serially, using the project environment on each OS. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const python=process.env.SV_VISION_PYTHON??path.join(root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
for(const pattern of ['test_*.py','*_test.py']){
  const result=spawnSync(python,['-m','unittest','discover','-s','tests','-p',pattern],{
    cwd:root,stdio:'inherit',env:{...process.env,OMP_NUM_THREADS:'2',OPENBLAS_NUM_THREADS:'2'},
  });
  if(result.error){console.error('Python环境不可用，请先安装根目录 requirements.txt。');process.exit(1);}
  if(result.status!==0)process.exit(result.status??1);
}
