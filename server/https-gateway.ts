/** 可选的 HTTPS 入口；业务仍由本机 HTTP 服务处理，不接触业务数据库。 */
import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import path from 'node:path';

export interface HttpsConfig {
  host:string; port:number; upstreamPort:number; certFile:string; keyFile:string;
  testCaFile?:string; bootstrapPort:number;
}
function port(value:string|undefined,fallback:number){
  const n=Number(value??fallback);
  if(!Number.isInteger(n)||n<1||n>65535)throw new Error('HTTPS 和业务端口须为 1–65535。');
  return n;
}
export function httpsConfig(root:string,env:NodeJS.ProcessEnv=process.env):HttpsConfig {
  if(!env.SV_HTTPS_CERT_FILE?.trim()||!env.SV_HTTPS_KEY_FILE?.trim())throw new Error('请配置 SV_HTTPS_CERT_FILE（服务器完整证书链）和 SV_HTTPS_KEY_FILE（服务器私钥）。');
  const config={host:env.SV_HTTPS_HOST?.trim()||'0.0.0.0',port:port(env.SV_HTTPS_PORT,5443),upstreamPort:port(env.SV_PORT,5190),
    certFile:path.resolve(root,env.SV_HTTPS_CERT_FILE),keyFile:path.resolve(root,env.SV_HTTPS_KEY_FILE),
    testCaFile:env.SV_HTTPS_TEST_CA_FILE?.trim()?path.resolve(root,env.SV_HTTPS_TEST_CA_FILE):undefined,
    bootstrapPort:port(env.SV_HTTPS_BOOTSTRAP_PORT,5442)};
  if(config.port===config.upstreamPort||(config.testCaFile&&[config.port,config.upstreamPort].includes(config.bootstrapPort)))throw new Error('HTTPS、业务及测试证书下载端口不能相同。');
  return config;
}
const hopHeaders=new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade']);
function endToEnd(headers:http.IncomingHttpHeaders){
  const nominated=new Set(String(headers.connection??'').toLowerCase().split(',').map(s=>s.trim()));
  return Object.fromEntries(Object.entries(headers).filter(([key])=>!hopHeaders.has(key)&&!nominated.has(key)));
}
export function startHttpsGateway(config:HttpsConfig){
  // Node 检查证书与私钥是否匹配；错误时启动即失败，不回退到 HTTP。
  const cert=readFileSync(config.certFile),key=readFileSync(config.keyFile),leaf=new X509Certificate(cert);
  if(Date.now()<Date.parse(leaf.validFrom)||Date.now()>=Date.parse(leaf.validTo))throw new Error('HTTPS 服务器证书尚未生效或已过期，请更换。');
  let publicCa:X509Certificate|undefined;
  if(config.testCaFile){
    const bytes=readFileSync(config.testCaFile);
    if(bytes.toString().includes('PRIVATE KEY'))throw new Error('测试证书下载只接受公开 CA 证书，不能包含私钥。');
    publicCa=new X509Certificate(bytes);
    if(!publicCa.ca)throw new Error('测试证书下载必须配置 CA 证书，不能使用服务器证书。');
  }
  const server=https.createServer({cert,key,minVersion:'TLSv1.2'},(req,res)=>{
    const headers=endToEnd(req.headers);
    for(const name of Object.keys(headers))if(name==='forwarded'||name.startsWith('x-forwarded-'))delete headers[name];
    // 保留原 Host，使浏览器 Origin/Cookie 与后端同源判断一致；覆盖客户端伪造的代理信息。
    headers.host=req.headers.host;
    headers['x-forwarded-for']=req.socket.remoteAddress??'';
    headers['x-forwarded-proto']='https';
    const upstream=http.request({hostname:'127.0.0.1',port:config.upstreamPort,method:req.method,path:req.url,headers},response=>{
      const outgoing=endToEnd(response.headers);
      const cookies=response.headers['set-cookie'];
      if(cookies)outgoing['set-cookie']=cookies.map(cookie=>/;\s*secure(?:;|$)/i.test(cookie)?cookie:cookie+'; Secure');
      res.writeHead(response.statusCode??502,outgoing);response.on('error',()=>res.destroy());response.pipe(res);
    });
    upstream.setTimeout(200000,()=>upstream.destroy(new Error('upstream timeout')));
    upstream.on('error',()=>{
      if(res.destroyed)return;
      if(res.headersSent){res.destroy();return;}
      res.writeHead(502,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
      res.end(JSON.stringify({message:'无法连接本机业务服务，请确认业务服务已启动。'}));
    });
    req.on('aborted',()=>upstream.destroy());
    req.on('error',()=>upstream.destroy());
    res.on('error',()=>upstream.destroy());
    res.on('close',()=>{if(!res.writableFinished)upstream.destroy();});
    req.pipe(upstream);
  });
  server.requestTimeout=240000;server.headersTimeout=15000;
  // 仅测试模式启用下载口；固定路由只返回已解析的公开 CA，不提供任意文件读取。
  const bootstrap=publicCa?http.createServer((req,res)=>{
    const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
    if(!['GET','HEAD'].includes(req.method??'')){res.writeHead(405,headers);res.end();return;}
    if(req.url==='/ca.cer'){
      res.writeHead(200,{...headers,'Content-Type':'application/x-x509-ca-cert','Content-Disposition':'attachment; filename="jianwei-local-test-ca.cer"','Content-Length':publicCa!.raw.length});
      res.end(req.method==='HEAD'?undefined:publicCa!.raw);return;
    }
    if(req.url!=='/'){res.writeHead(404,headers);res.end();return;}
    res.writeHead(200,{...headers,'Content-Type':'text/plain; charset=utf-8'});
    res.end(req.method==='HEAD'?undefined:`鉴微本机联调证书（仅用于测试）\n\n下载本地址的 /ca.cer 文件，在平板设置中搜索“证书”，安装为 CA 证书。\nSHA-256 指纹：${publicCa!.fingerprint256}\n\n请与开发电脑显示的指纹核对；不要安装私钥。安装后用 HTTPS 地址重新打开工作台，允许浏览器使用相机。\n测试结束后可在平板删除此测试 CA。公司部署应替换为公司 CA 签发的服务器证书。\n`);
  }):undefined;
  bootstrap?.setTimeout(15000);
  const ready=new Promise<void>((resolve,reject)=>{
    const fail=(error:Error)=>{server.closeAllConnections();server.close();bootstrap?.closeAllConnections();bootstrap?.close();reject(error);};
    server.once('error',fail);bootstrap?.once('error',fail);
    server.listen(config.port,config.host,()=>{
      if(bootstrap)bootstrap.listen(config.bootstrapPort,config.host,resolve);else resolve();
    });
  });
  return {server,bootstrap,ready,caFingerprint:publicCa?.fingerprint256,async close(){
    await Promise.all([server,bootstrap].filter(s=>s!==undefined).map(s=>new Promise<void>(resolve=>{s.closeAllConnections();s.close(()=>resolve());})));
  }};
}
