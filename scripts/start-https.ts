/** 独立 HTTPS 入口：不重启正在使用的 HTTP 业务服务。 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { httpsConfig,startHttpsGateway } from '../server/https-gateway.ts';
import { MARKING_BASE } from '../shared/paths.ts';
const root=fileURLToPath(new URL('../',import.meta.url));
try{
  const args=process.argv.slice(2);
  if(args.length&&!(args.length===2&&args[0]==='--config'))throw new Error('用法：npm run https -- [--config 配置文件]');
  const filename=path.resolve(root,args[1]??'.env.local');
  if(existsSync(filename))process.loadEnvFile(filename);else if(args[1])throw new Error('指定的 HTTPS 配置文件不存在。');
  const config=httpsConfig(root),gateway=startHttpsGateway(config);await gateway.ready;
  const addresses=config.host==='0.0.0.0'||config.host==='::'
    ? ['127.0.0.1',...Object.values(os.networkInterfaces()).flatMap(entries=>(entries??[]).filter(e=>e.family==='IPv4'&&!e.internal).map(e=>e.address))]
    : [config.host];
  console.log('HTTPS 转发已启动，业务服务须另行保持运行；证书必须覆盖访问的域名或 IP。');
  for(const address of addresses){
    const host=address.includes(':')?'['+address+']':address;
    console.log(`HTTPS 工作台：https://${host}:${config.port}${MARKING_BASE}`);
    if(config.testCaFile)console.log(`测试 CA 下载：http://${host}:${config.bootstrapPort}/ca.cer`);
  }
  if(gateway.caFingerprint)console.log('测试 CA SHA-256 指纹：'+gateway.caFingerprint);
  for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,async()=>{await gateway.close();process.exit(0);});
}catch(error){console.error('HTTPS 入口启动失败：'+(error as Error).message);process.exitCode=1;}
