import { useEffect, useState } from 'react';
import { assetPath } from '../../shared/paths';
import { Btn, Pill, Spinner } from './ui';
import './login-screen.css';

export const loginBrands = [
  { id:'jianwei', name:'鉴微', meaning:'细微之处，有据可鉴' },
  { id:'guanwei', name:'观微', meaning:'观察细节，清楚留证' },
  { id:'mingjian', name:'明鉴', meaning:'让判断清楚，让依据可见' },
] as const;
export type LoginLayout = 'auto' | 'split' | 'stacked';
export function loginLayout(value:string|null):LoginLayout{return value==='split'||value==='stacked'?value:'auto';}
export function loginBrand(id:string|null){return loginBrands.find(brand=>brand.id===id)??loginBrands[0];}

/** 正常登录与设计对照共用同一组件，预览不绕过身份校验。 */
export function LoginScreen({layout='auto',brand=loginBrands[0].name,busy=false,error='',onEnter}:{layout?:LoginLayout;brand?:string;busy?:boolean;error?:string;onEnter:()=>void}){
  const [portrait,setPortrait]=useState(()=>window.matchMedia('(orientation: portrait)').matches);
  useEffect(()=>{
    const media=window.matchMedia('(orientation: portrait)');
    const update=()=>setPortrait(media.matches);
    update();media.addEventListener('change',update);
    return ()=>media.removeEventListener('change',update);
  },[]);
  const effectiveLayout=layout==='auto'?(portrait?'stacked':'split'):layout;
  return <div className={'sv-login sv-login--'+effectiveLayout} data-layout={layout}>
    <section className="sv-login-brand" aria-label={brand+' · 产品介绍'}>
      <img src={assetPath('login-scan.svg')} width="48" height="48" alt=""/>
      <h1>{brand}</h1>
      <h2>让每一次丝印检验，<br/>清楚、有据可查。</h2>
      <div className="sv-login-spacer"/>
      <p>拍照检测 / 自动比对 / MES 回填</p>
      <small>丝印检测工作台</small>
    </section>
    <section className="sv-login-content" aria-label="进入检验工作台">
      <img src={assetPath('login-shield.svg')} width="36" height="36" alt=""/>
      <h2>登录检验工作台</h2>
      <p>从拍照到结果保存，在平板上轻松完成。</p>
      <Pill tone="warning">本机开发试用</Pill>
      <Btn tone="primary" disabled={busy} onClick={onEnter}>{busy?<Spinner/>:null}进入本地试用</Btn>
      <p className="sv-description">支持配置的 VLM 服务识别。身份及MES仍为模拟，未连接公司系统；任务内会标明照片和结果来源。</p>
      <hr/>
      <small>华为平板 · 横竖屏自适应 · 支持中途继续</small>
      {error?<p className="sv-error" role="alert">{error}</p>:null}
    </section>
  </div>;
}
