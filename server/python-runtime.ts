import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

/** 直接调用解释器，不依赖 shell 的 activate/Activate.ps1，也不回退到系统 Python。 */
export function pythonExecutable(root:string,configured=process.env.SV_VISION_PYTHON,platform:NodeJS.Platform=process.platform):string {
  const paths=platform==='win32'?path.win32:path.posix;
  const value=configured?.trim();
  return paths.resolve(root,value||paths.join('.venv',platform==='win32'?'Scripts':'bin',platform==='win32'?'python.exe':'python'));
}

/** Node 与 Python 的管道协议及落盘文本统一为 UTF-8，覆盖 Windows 的 GBK 默认值。 */
export function pythonEnvironment(overrides:NodeJS.ProcessEnv={},parent:NodeJS.ProcessEnv=process.env):NodeJS.ProcessEnv {
  return {...parent,...overrides,PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8',OMP_NUM_THREADS:'2',OPENBLAS_NUM_THREADS:'2',VECLIB_MAXIMUM_THREADS:'2'};
}

/** 测试只读取解释器配置，避免把本机业务数据、账号或真实模型配置带入测试。 */
export function pythonTestEnvironment(root:string):NodeJS.ProcessEnv {
  const filename=path.join(root,'.env.local');
  const configured=process.env.SV_VISION_PYTHON??(existsSync(filename)?parseEnv(readFileSync(filename,'utf8')).SV_VISION_PYTHON:undefined);
  return pythonEnvironment({SV_VISION_PYTHON:pythonExecutable(root,configured)});
}
