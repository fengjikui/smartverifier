/** 部署人员在终端交互配置账号；密码不经过命令行参数、日志或 Git。 */
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { configureAdminAccount } from './admin-settings.ts';
const root=fileURLToPath(new URL('../',import.meta.url));
async function main(){
  if(process.argv.slice(2).some(arg=>!['--replace','--owner'].includes(arg)))throw new Error('用法：npm run admin:account；负责人：npm run admin:owner；更新已有账号追加 -- --replace。');
  if(!process.stdin.isTTY)throw new Error('请在交互式终端运行，密码只接受隐藏输入，不接受命令行参数。');
  let hidden=false;
  const output=new Writable({write(chunk,_encoding,callback){if(!hidden)process.stdout.write(chunk);callback();}});
  const rl=createInterface({input:process.stdin,output,terminal:true}),abort=new AbortController();rl.on('SIGINT',()=>abort.abort());
  async function ask(prompt:string,secret=false){
    if(!secret)return rl.question(prompt,{signal:abort.signal});
    process.stdout.write(prompt);hidden=true;
    try{return await rl.question('',{signal:abort.signal});}finally{hidden=false;process.stdout.write('\n');}
  }
  try{
    console.log(process.argv.includes('--owner')?'设置系统负责人。只有服务器部署人员可执行此初始化或恢复；负责人可在网页配置普通管理员。':'设置普通正品管理员。系统负责人请运行 npm run admin:owner；日常录入账号推荐在人员与权限页添加。');
    const id=await ask('账号（字母、数字、. _ @ -）：'),name=await ask('显示姓名：'),password=await ask('密码（至少12个字符，不显示输入）：',true),repeat=await ask('再次输入密码：',true);
    if(password!==repeat)throw new Error('两次密码不一致，未保存。');
    const result=configureAdminAccount(root,{id,name,password},process.argv.includes('--replace'),process.argv.includes('--owner')?'owner':undefined);
    console.log(`已保存${result.role==='owner'?'系统负责人':'正品管理员'} ${result.id}（${result.name}）。密码仅保存为 scrypt 哈希。\n配置范围：${result.localOnly?'仅本机':'允许远程录入'}。重启业务服务后生效。\n需要临时开放：npm run admin:access -- lan\n恢复仅本机：npm run admin:access -- local`);
  }finally{rl.close();}
}
void main().catch(error=>{console.error(error.name==='AbortError'?'已取消，未保存账号。':error.message);process.exitCode=1;});
