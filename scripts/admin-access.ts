import { fileURLToPath } from 'node:url';
import { readAdminAccess } from '../server/admin/access-config.ts';
import { configureAdminAccess, localAdminEnvironment } from './admin-settings.ts';
const root=fileURLToPath(new URL('../',import.meta.url));
try{
  const args=process.argv.slice(2),scope=args[0];
  if(args.length>1||scope&&!['local','lan'].includes(scope))throw new Error('用法：npm run admin:access -- local（仅本机）或 lan（临时开放）；不带参数查看配置。');
  const config=scope?configureAdminAccess(root,scope as 'local'|'lan'):readAdminAccess(localAdminEnvironment(root),root);
  console.log(`正品管理配置范围（重启时应用）：${config.localOnly?'仅服务器本机':'允许其他电脑账号密码登录'}\n服务器配置账号（不含网页新增人员）：${config.users?.map(u=>u.id+'（'+u.name+' · '+(u.role==='owner'?'系统负责人':'正品管理员')+'）').join('、')??'本机默认试用账号'}`);
  if(scope)console.log('配置已写入 .env.local，停止并重新启动业务服务后生效。不会改变检验端和模型调试权限。');
  if(!config.localOnly)console.log('局域网连接还需 SV_HOST=0.0.0.0、网络互通及系统防火墙允许业务端口。');
  if(process.env.SV_ADMIN_LOCAL_ONLY!==undefined)console.log('注意：当前终端设置了 SV_ADMIN_LOCAL_ONLY，它会优先于 .env.local，请一并核对。');
}catch(error){console.error((error as Error).message);process.exitCode=1;}
