/** 部署人员在终端交互配置账号；密码不经过命令行参数、日志或 Git。 */
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { configureAdminAccount } from './admin-settings.ts';
const root=fileURLToPath(new URL('../',import.meta.url));
async function main(){
  if(process.argv.slice(2).some(arg=>arg!=='--replace'))throw new Error('用法：npm run admin:account；更新已有账号：npm run admin:account -- --replace。');
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
    console.log('设置正品管理员账号。可重复运行，为不同录入人员分别配置账号。');
    const id=await ask('账号（字母、数字、. _ @ -）：'),name=await ask('显示姓名：'),password=await ask('密码（至少12个字符，不显示输入）：',true),repeat=await ask('再次输入密码：',true);
    if(password!==repeat)throw new Error('两次密码不一致，未保存。');
    const result=configureAdminAccount(root,{id,name,password},process.argv.includes('--replace'));
    console.log(`已保存账号 ${result.id}（${result.name}）。密码仅保存为 scrypt 哈希。\n当前访问范围：${result.localOnly?'仅本机':'允许远程录入'}。重启业务服务后生效。\n需要临时开放：npm run admin:access -- lan\n恢复仅本机：npm run admin:access -- local`);
  }finally{rl.close();}
}
void main().catch(error=>{console.error(error.name==='AbortError'?'已取消，未保存账号。':error.message);process.exitCode=1;});
