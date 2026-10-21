import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { once } from 'node:events';
import { mkdtempSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { httpsConfig,startHttpsGateway } from '../server/https-gateway.ts';
import type { HttpsConfig } from '../server/https-gateway.ts';
import { prepareHttps } from '../scripts/prepare-https.ts';
import { startServer } from '../server/index.ts';
import { MARKING_API } from '../shared/paths.ts';

const root=mkdtempSync(path.join(tmpdir(),'sv-https-中文 ')),certDir=path.join(root,'var/https');
const hasOpenSSL=spawnSync('openssl',['version'],{encoding:'utf8'}).status===0;
before(()=>{if(hasOpenSSL)prepareHttps(root,['127.0.0.1','10.0.0.2','test.internal']);});
after(()=>rmSync(root,{recursive:true,force:true}));
function config(upstreamPort:number):HttpsConfig{return {host:'127.0.0.1',port:0,upstreamPort,certFile:path.join(certDir,'server.pem'),keyFile:path.join(certDir,'server.key'),testCaFile:path.join(certDir,'ca.pem'),bootstrapPort:0};}
function port(server:http.Server){const address=server.address();assert.ok(address&&typeof address!=='string');return address.port;}
function call(target:number,route:string,options:https.RequestOptions={},body?:Buffer|string){
  return new Promise<{status:number;headers:http.IncomingHttpHeaders;body:Buffer}>((resolve,reject)=>{
    const request=https.request({hostname:'127.0.0.1',port:target,path:route,ca:readFileSync(path.join(certDir,'ca.pem')),agent:false,...options},response=>{
      const chunks:Buffer[]=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve({status:response.statusCode!,headers:response.headers,body:Buffer.concat(chunks)}));response.on('error',reject);
    });request.on('error',reject);request.end(body);
  });
}
const skip=hasOpenSSL?false:'此环境没有 OpenSSL，跳过本地测试证书生成与 TLS 集成；公司证书部署不需要 OpenSSL。';
test('HTTPS 配置要求完整证书链和私钥，拒绝无效或冲突端口',()=>{
  assert.throws(()=>httpsConfig(root,{}),/CERT_FILE/);
  const env={SV_HTTPS_CERT_FILE:'cert.pem',SV_HTTPS_KEY_FILE:'server.key'};
  const c=httpsConfig(root,env);assert.equal(c.certFile,path.join(root,'cert.pem'));assert.equal(c.testCaFile,undefined);assert.equal(c.upstreamPort,5190);
  for(const n of ['0','abc','65536'])assert.throws(()=>httpsConfig(root,{...env,SV_HTTPS_PORT:n}),/端口/);
  assert.throws(()=>httpsConfig(root,{...env,SV_HTTPS_PORT:'5190'}),/不能相同/);
  assert.throws(()=>httpsConfig(root,{...env,SV_HTTPS_TEST_CA_FILE:'ca.pem',SV_HTTPS_BOOTSTRAP_PORT:'5443'}),/不能相同/);
  assert.throws(()=>prepareHttps(root,['a\n[bad]']),/IP 或域名/);
});
test('联调证书覆盖指定 IP，私钥只留本机且不会静默覆盖原有 CA',{skip},()=>{
  const ca=new X509Certificate(readFileSync(path.join(certDir,'ca.pem'))),leaf=new X509Certificate(readFileSync(path.join(certDir,'server.pem')));
  assert.equal(ca.ca,true);assert.equal(leaf.ca,false);assert.equal(leaf.verify(ca.publicKey),true);
  assert.equal(leaf.checkIP('10.0.0.2'),'10.0.0.2');assert.equal(leaf.checkHost('localhost'),'localhost');
  assert.throws(()=>prepareHttps(root,['127.0.0.1']),/已存在/);
  assert.throws(()=>startHttpsGateway({...config(5190),testCaFile:path.join(certDir,'ca.key')}),/不能包含私钥/);
  assert.throws(()=>startHttpsGateway({...config(5190),testCaFile:path.join(certDir,'server.pem')}),/CA 证书/);
});
test('真实 TLS 转发保留上传字节、Host、查询与流式响应，覆盖伪造代理头并使用安全 Cookie',{skip},async t=>{
  let received:Buffer|undefined,headers:http.IncomingHttpHeaders|undefined;
  const upstream=http.createServer(async(req,res)=>{
    headers=req.headers;const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);received=Buffer.concat(chunks);
    res.writeHead(201,{'Content-Type':'text/plain','Set-Cookie':['one=1; HttpOnly','two=2; Secure; SameSite=Strict'],'Connection':'keep-alive, X-Remove','X-Remove':'private'});
    res.write(req.url+'\n');setTimeout(()=>res.end('结束'),5);
  });upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
  t.after(()=>{upstream.closeAllConnections();upstream.close();});
  const gateway=startHttpsGateway(config(port(upstream)));t.after(()=>gateway.close());await gateway.ready;
  const query='/upload?a='+encodeURIComponent('中文');
  const bytes=Buffer.from([0,1,2,128,255]),result=await call(port(gateway.server),query,{method:'POST',headers:{Host:'test.internal:5443',Origin:'https://test.internal:5443','Content-Type':'application/octet-stream','X-Forwarded-For':'203.0.113.88','X-Forwarded-Proto':'http',Forwarded:'for=127.0.0.1'}},bytes);
  assert.equal(result.status,201);assert.deepEqual(received,bytes);assert.equal(headers!.host,'test.internal:5443');
  assert.equal(headers!['x-forwarded-for'],'127.0.0.1');assert.equal(headers!['x-forwarded-proto'],'https');assert.equal(headers!.forwarded,undefined);
  assert.equal(result.body.toString(),query+'\n结束');assert.equal(result.headers['x-remove'],undefined);
  assert.ok(result.headers['set-cookie']!.every(c=>/; Secure/i.test(c)));
  assert.equal(result.headers['set-cookie']![1].match(/Secure/g)!.length,1);
  await assert.rejects(()=>call(port(gateway.server),'/',{servername:'wrong.example.invalid'}),{code:'ERR_TLS_CERT_ALTNAME_INVALID'});
  await assert.rejects(()=>call(port(gateway.server),'/',{ca:undefined}));
  const download=await fetch('http://127.0.0.1:'+port(gateway.bootstrap!)+'/ca.cer');
  assert.equal(download.status,200);assert.deepEqual(Buffer.from(await download.arrayBuffer()),new X509Certificate(readFileSync(path.join(certDir,'ca.pem'))).raw);
  for(const route of ['/server.key','/ca.key','/../ca.key','/ca.cer?file=server.key'])assert.equal((await fetch('http://127.0.0.1:'+port(gateway.bootstrap!)+route)).status,404);
  assert.equal((await fetch('http://127.0.0.1:'+port(gateway.bootstrap!)+'/ca.cer',{method:'POST'})).status,405);
});
test('转发真实业务：HTTPS 同源登录和 Cookie 正常，跨源写入及本机管理/调试特权不能绕过',{skip},async t=>{
  const state=mkdtempSync(path.join(tmpdir(),'sv-https-state-'));
  const {server,service,admin}=startServer({state,port:0,host:'127.0.0.1',real:false,debug:true});
  t.after(async()=>{service.closing=true;admin.files.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));service.store.close();rmSync(state,{recursive:true,force:true});});
  await once(server,'listening');const gateway=startHttpsGateway({...config(port(server)),testCaFile:undefined});t.after(()=>gateway.close());await gateway.ready;
  assert.equal(gateway.bootstrap,undefined);
  const p=port(gateway.server),origin='https://127.0.0.1:'+p;
  const login=await call(p,MARKING_API+'/session',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'}},'{}');
  assert.equal(login.status,200);const cookie=login.headers['set-cookie']![0].split(';')[0];
  assert.equal((await call(p,MARKING_API+'/bootstrap',{headers:{Cookie:cookie}})).status,200);
  assert.equal((await call(p,MARKING_API+'/session',{method:'POST',headers:{Origin:'https://attacker.invalid','Content-Type':'application/json'}},'{}')).status,403);
  assert.equal((await call(p,MARKING_API+'/debug/traces',{headers:{Cookie:cookie,'X-Forwarded-For':'127.0.0.1'}})).status,403);
  assert.equal((await call(p,MARKING_API+'/admin/session',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'}},JSON.stringify({id:'admin',code:'admin123'}))).status,403);
});
test('业务服务不可用时返回明确的 502，不伪造业务成功',{skip},async t=>{
  const unused=http.createServer();unused.listen(0,'127.0.0.1');await once(unused,'listening');const target=port(unused);await new Promise<void>(resolve=>unused.close(()=>resolve()));
  const gateway=startHttpsGateway(config(target));t.after(()=>gateway.close());await gateway.ready;
  const result=await call(port(gateway.server),'/');assert.equal(result.status,502);assert.match(result.body.toString(),/业务服务/);
});
