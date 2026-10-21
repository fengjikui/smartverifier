/** 只生成本项目联调用证书；不会安装或修改任何设备的信任库。 */
import { mkdirSync,writeFileSync,readFileSync,existsSync,chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';

export function prepareHttps(root:string,names:string[],openssl='openssl'){
  if(!names.length||names.some(name=>!isIP(name)&&! /^(?=.{1,253}$)[a-z\d](?:[a-z\d.-]*[a-z\d])?$/i.test(name)))throw new Error('请提供当前局域网 IP 或域名，例如 npm run https:prepare -- 10.0.0.2。');
  const directory=path.join(root,'var/https');
  // 从不静默覆盖既有证书，避免让已经安装的 CA 失效。
  if(existsSync(directory))throw new Error('var/https 已存在，请复用现有证书；IP 变化需要重建时，先停止 HTTPS 入口并将该目录移到安全备份位置。');
  const version=spawnSync(openssl,['version'],{encoding:'utf8',windowsHide:true});
  if(version.error||version.status!==0)throw new Error('找不到 OpenSSL；本机测试证书生成需要 OpenSSL。公司已签发的证书可直接配置，无需此工具。');
  mkdirSync(directory,{recursive:true,mode:0o700});
  const run=(args:string[])=>{
    const result=spawnSync(openssl,args,{cwd:directory,encoding:'utf8',windowsHide:true});
    if(result.error||result.status!==0)throw new Error('OpenSSL 生成失败，请检查版本及输出目录；已生成的文件保留在 var/https 以便排查。');
  };
  const sans=[...new Set([...names,'localhost','127.0.0.1','::1'])].map(name=>(isIP(name)?'IP:':'DNS:')+name).join(',');
  writeFileSync(path.join(directory,'ca.conf'),'[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=Jianwei Local Test CA\n[ext]\nbasicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n',{mode:0o600});
  writeFileSync(path.join(directory,'server.conf'),`[req]\nprompt=no\ndistinguished_name=dn\n[dn]\nCN=Jianwei Local Test\n[ext]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=${sans}\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n`,{mode:0o600});
  run(['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:prime256v1','-nodes','-sha256','-days','30','-config','ca.conf','-keyout','ca.key','-out','ca.pem']);
  run(['req','-new','-newkey','ec','-pkeyopt','ec_paramgen_curve:prime256v1','-nodes','-config','server.conf','-keyout','server.key','-out','server.csr']);
  run(['x509','-req','-in','server.csr','-CA','ca.pem','-CAkey','ca.key','-CAcreateserial','-out','server.pem','-days','14','-sha256','-extfile','server.conf','-extensions','ext']);
  for(const name of ['ca.key','server.key'])chmodSync(path.join(directory,name),0o600);
  writeFileSync(path.join(directory,'local.env'),'# 独立联调入口，不改变业务配置或任何设备信任库。\nSV_HTTPS_HOST=0.0.0.0\nSV_HTTPS_PORT=5443\nSV_PORT=5190\nSV_HTTPS_CERT_FILE=./var/https/server.pem\nSV_HTTPS_KEY_FILE=./var/https/server.key\nSV_HTTPS_TEST_CA_FILE=./var/https/ca.pem\nSV_HTTPS_BOOTSTRAP_PORT=5442\n',{mode:0o600});
  return {directory,fingerprint:new X509Certificate(readFileSync(path.join(directory,'ca.pem'))).fingerprint256};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{
    const result=prepareHttps(fileURLToPath(new URL('../',import.meta.url)),process.argv.slice(2));
    console.log('已生成独立测试 CA（30 天）及服务器证书（14 天），文件留在被 Git 忽略的 var/https。');
    console.log('CA SHA-256 指纹：'+result.fingerprint);
    console.log('保持业务服务运行，另开终端执行：npm run https -- --config var/https/local.env');
    console.log('仅将公开 ca.pem（或下载口的 ca.cer）安装到测试平板；不要分享 ca.key / server.key。');
  }catch(error){console.error((error as Error).message);process.exitCode=1;}
}
