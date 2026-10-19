import { useEffect, useState } from 'react';
import { markingPaths } from '../../shared/paths';
import { request } from './api';
import { LoginScreen, loginBrand, loginLayout } from './login-screen';

/** 独立设计入口，即使已登录也能查看，不退出或改写已有检测。 */
export function LoginPreview(){
  const params=new URLSearchParams(location.search),brand=loginBrand(params.get('brand'));
  const layout=loginLayout(params.get('layout'));
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{document.title=brand.name+' · 登录页方案';},[brand.name]);
  async function enter(){setBusy(true);setError('');try{await request('/session',{});location.assign(markingPaths.workbench);}catch(e){setError((e as Error).message);setBusy(false);}}
  return <LoginScreen brand={brand.name} layout={layout} busy={busy} error={error} onEnter={()=>void enter()}/>;
}
