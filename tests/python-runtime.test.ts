import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pythonExecutable, pythonEnvironment, pythonTestEnvironment } from '../server/python-runtime.ts';
import { LocalVisionPipeline } from '../server/vision/local-pipeline.ts';
import { AdminFiles } from '../server/admin/files.ts';
import { InspectionService } from '../server/service.ts';

const root=fileURLToPath(new URL('../',import.meta.url));

test('Python解释器按系统选择，支持中文空格、绝对路径及相对仓库路径，不需要激活',()=>{
  assert.equal(pythonExecutable('C:\\检验 系统','', 'win32'),'C:\\检验 系统\\.venv\\Scripts\\python.exe');
  assert.equal(pythonExecutable('C:\\检验 系统','./工具 环境/python.exe','win32'),'C:\\检验 系统\\工具 环境\\python.exe');
  assert.equal(pythonExecutable('C:\\检验 系统','D:\\Python 环境\\python.exe','win32'),'D:\\Python 环境\\python.exe');
  assert.equal(pythonExecutable('/检验 系统','', 'darwin'),'/检验 系统/.venv/bin/python');
  assert.equal(pythonExecutable('/检验 系统','./工具/python','linux'),'/检验 系统/工具/python');
  assert.equal(pythonExecutable('/检验 系统','   ','linux'),'/检验 系统/.venv/bin/python');
});

test('Python子进程固定UTF-8和保守线程数，保留必要配置且不修改父进程环境',()=>{
  const parent={PYTHONUTF8:'0',PYTHONIOENCODING:'gbk',OMP_NUM_THREADS:'64',PATH:'fixture',SV_VLM_API_KEY:'fixture-only'};
  const environment=pythonEnvironment({SV_VLM_MODEL:'test'},parent);
  assert.equal(environment.PYTHONUTF8,'1');assert.equal(environment.PYTHONIOENCODING,'utf-8');
  assert.equal(environment.OMP_NUM_THREADS,'2');assert.equal(environment.OPENBLAS_NUM_THREADS,'2');
  assert.equal(environment.SV_VLM_API_KEY,parent.SV_VLM_API_KEY);assert.equal(environment.PATH,'fixture');
  assert.equal(environment.SV_VLM_MODEL,'test');assert.equal(parent.PYTHONIOENCODING,'gbk');
});

test('测试入口读取本机解释器配置，同时不载入业务目录、管理员与真实模型配置',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'sv-python-config-')),previous=process.env.SV_VISION_PYTHON;
  t.after(async()=>{if(previous===undefined)delete process.env.SV_VISION_PYTHON;else process.env.SV_VISION_PYTHON=previous;await rm(directory,{recursive:true,force:true});});
  delete process.env.SV_VISION_PYTHON;
  await writeFile(path.join(directory,'.env.local'),'SV_VISION_PYTHON="./自定义 环境/python"\nSV_STATE_DIR=不应加载\nSV_VLM_API_KEY=不应加载\n');
  const environment=pythonTestEnvironment(directory);
  assert.equal(environment.SV_VISION_PYTHON,path.resolve(directory,'自定义 环境/python'));
  assert.equal(environment.SV_STATE_DIR,process.env.SV_STATE_DIR);assert.equal(environment.SV_VLM_API_KEY,process.env.SV_VLM_API_KEY);
  process.env.SV_VISION_PYTHON=pythonExecutable(root);
  assert.equal(pythonTestEnvironment(directory).SV_VISION_PYTHON,pythonExecutable(root));
});

test('三个实际工作器在GBK管道下正确收发UTF-8，支持中文空格路径与GBK无法表示的字符',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'鉴微 中文目录 🧪 '));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const source=path.join(directory,'正品 照片🧪.png');
  await copyFile(path.join(root,'fixtures/inspection/green-mat-v1/single.png'),source);
  const python=pythonExecutable(root);
  function worker(script:string,input:unknown){
    const result=spawnSync(python,[path.join(root,script)],{cwd:root,encoding:'utf8',timeout:20000,
      input:'\uFEFF'+JSON.stringify(input),env:{...pythonEnvironment(),PYTHONUTF8:'0',PYTHONIOENCODING:'gbk'}});
    assert.equal(result.status,0,result.error?.message??result.stderr+result.stdout);
    assert.ok(!result.stdout.includes('\uFFFD'),'不能出现编码替代字符');
    return JSON.parse(result.stdout);
  }
  const asset=worker('server/admin/asset_worker.py',{source,filename:'正品 照片🧪.png',folder:path.join(directory,'正品 图片')});
  assert.equal(asset.filename,'正品 照片🧪.png');assert.ok(asset.width>0);
  const prepared=worker('server/vision/local_worker.py',{action:'separate',source,folder:path.join(directory,'裁剪 结果🧪'),label:'P001'});
  assert.equal(prepared.components.length,1);assert.equal(prepared.coverage,'complete');
  const manifest=path.join(directory,'标准 清单🧪.json');
  await writeFile(manifest,JSON.stringify({schemaVersion:'1.0',records:[{materialCode:'0001',modelNumber:'M1',supplierName:'测试供应商🧪',imagePath:'缺失🧪.png'}]}));
  const imported=worker('server/admin/import_worker.py',{files:[{name:'标准.json',path:manifest}],folder:path.join(directory,'导入 图片')});
  assert.equal(imported.rows[0].supplier,'测试供应商🧪');
  assert.equal(imported.rows[0].message,'图片缺失或文件名重复：缺失🧪.png');
});

test('Node按完整UTF-8字符解码分块输出，识别和正品导入两条管道均无乱码',async t=>{
  const workspace=await mkdtemp(path.join(tmpdir(),'sv-stream-中文 ')),directory=path.join(workspace,'state');
  const service=new InspectionService(directory,root,1);
  const python=pythonExecutable(root),pipeline=new LocalVisionPipeline(workspace,directory,{python});
  const files=new AdminFiles(service.registry,workspace,directory),previous=process.env.SV_VISION_PYTHON;
  process.env.SV_VISION_PYTHON=python;
  t.after(async()=>{if(previous===undefined)delete process.env.SV_VISION_PYTHON;else process.env.SV_VISION_PYTHON=previous;pipeline.close();files.close();service.store.close();await rm(workspace,{recursive:true,force:true});});
  const script='import sys, os, time, json\njson.load(sys.stdin)\ndata=json.dumps({"text":"中文丝印🧪"},ensure_ascii=False).encode("utf-8")\nfor byte in data:\n os.write(1,bytes([byte])); time.sleep(.003)\n';
  for(const folder of ['vision','admin'])await mkdir(path.join(workspace,'server',folder),{recursive:true});
  await writeFile(path.join(workspace,'server/vision/local_worker.py'),script);
  await writeFile(path.join(workspace,'server/admin/chunks.py'),script);
  assert.deepEqual(await pipeline.worker({action:'fixture'},10000),{text:'中文丝印🧪'});
  assert.deepEqual(await files.worker('chunks.py',{},10000),{text:'中文丝印🧪'});
});
