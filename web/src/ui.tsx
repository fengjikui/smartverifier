import { assetPath } from '../../shared/paths';
import type { ComponentProps, ReactNode } from 'react';
import { X, LoaderCircle, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { alignText, finalVerdict } from '../../shared/domain';
import type { ComponentResult, Photo, Verdict } from '../../shared/types';

export function Btn({tone='secondary',className='',...props}:ComponentProps<typeof Button>&{tone?:'primary'|'secondary'|'quiet'|'danger'}){
  return <Button {...props} variant="outline" className={'sv-btn sv-btn-'+tone+' '+className}/>;
}
export function Field(props:ComponentProps<typeof Input>){return <Input {...props} className={'sv-input '+(props.className??'')}/>;}
export function Pill({tone='neutral',children}:{tone?:'neutral'|'success'|'warning'|'danger';children:ReactNode}){return <Badge variant="outline" className={'sv-pill '+tone}>{children}</Badge>;}
export function Spinner(){return <LoaderCircle className="sv-spin" size={20} aria-hidden="true"/>;}
export function VerdictPill({verdict}:{verdict:Verdict|null}){return <Pill tone={verdict==='PASS'?'success':verdict==='FAIL'?'danger':'neutral'}>{verdict==='PASS'?<><img src={assetPath('album-check.svg')} width="20" height="20" alt=""/>合格</>:verdict==='FAIL'?<><img src={assetPath('album-frame.svg')} width="20" height="20" alt=""/>不合格</>:'待检测'}</Pill>;}
export function PhotoPill({photo}:{photo:Photo}){
  if(photo.status==='running')return <Pill><Spinner/>正在检测</Pill>;
  if(photo.status==='queued')return <Pill>排队中</Pill>;
  if(photo.status==='quality')return <Pill tone="warning"><AlertTriangle size={17}/>需要重拍</Pill>;
  if(photo.status==='error')return <Pill tone="warning"><AlertTriangle size={17}/>未完成</Pill>;
  if(photo.status==='pending')return <Pill>待检测</Pill>;
  return <VerdictPill verdict={photo.components.some(c=>finalVerdict(c)==='FAIL')?'FAIL':'PASS'}/>;
}
export function Modal({title,description,children,onClose,actions}:{title:string;description?:string;children?:ReactNode;onClose:()=>void;actions?:ReactNode}){
  return <Dialog open onOpenChange={open=>{if(!open)onClose();}}><DialogContent className="sv-dialog" showCloseButton={false}>
    <div className="sv-dialog-heading"><DialogTitle>{title}</DialogTitle><Btn tone="quiet" className="sv-icon-button" onClick={onClose} aria-label="关闭"><X size={22}/></Btn></div>
    <DialogDescription className="sv-description">{description??'请确认后继续。'}</DialogDescription>
    {children}{actions?<div className="sv-dialog-actions">{actions}</div>:null}
  </DialogContent></Dialog>;
}
export function PhotoCrop({photo,component}:{photo:Photo;component:ComponentResult}){
  if(component.crop)return <div className="sv-crop sv-rectified-crop"><img src={component.crop.url} alt={'元件 '+component.label+' 的转正裁片'}/></div>;
  const [x,y,w,h]=component.bbox;
  return <div className="sv-crop" style={{aspectRatio:`${photo.width*w}/${photo.height*h}`}}><img src={photo.url} alt={'元件 '+component.label+' 的图像'} style={{width:100/w+'%',height:100/h+'%',left:-100*x/w+'%',top:-100*y/h+'%'}}/></div>;
}
export function DiffTable({expected,actual,title='丝印逐行对照',reason}:{expected:string[];actual:string[];title?:string;reason?:string}){
  if(!expected.length)return <section className="sv-panel sv-diff"><h2>实拍丝印识别</h2>{actual.map((line,i)=><p key={i}><code>{line}</code></p>)}<p className="sv-description">正品未录入文字转写，本次依据正品图片比对。</p>{reason?<p>{reason}</p>:null}</section>;
  const lines=Array.from({length:Math.max(expected.length,actual.length)},(_,i)=>{
    const a=expected[i]??'',b=actual[i]??'';
    return {index:i,aligned:alignText(a,b),different:a!==b};
  });
  return <section className="sv-panel sv-diff"><h2>{title}</h2><div className="sv-diff-head"><span>实拍识别</span><span>正品基准</span></div>
    {lines.flatMap(({index,aligned,different})=>{
      const chunks=Array.from({length:Math.max(1,Math.ceil(aligned.length/24))},(_,k)=>aligned.slice(k*24,(k+1)*24));
      return chunks.map((chunk,k)=><div className="sv-diff-pair" key={index+'-'+k}>{(['actual','expected'] as const).map(side=><div className="sv-diff-cell" key={side}>
        <span className="sv-line-number">第{index+1}行{k?'续':''}</span><code className={different?'has-difference':''} aria-label={`${side==='actual'?'实拍':'正品'}第${index+1}行`}>
          {chunk.length?chunk.map((c,j)=><span key={j} className={c.different?'sv-character-diff':''} title={c[side]===null?'对齐空位，不是原文字符':undefined}>{c[side]??'·'}</span>):'—'}
        </code></div>)}</div>);
    })}
    {reason?<p className={lines.some(l=>l.different)?'sv-diff-note':'sv-description'}>{reason}</p>:null}
    {lines.some(l=>l.aligned.some(c=>c.expected===null||c.actual===null))?<p className="sv-description">· 表示对齐空位，不是丝印原文中的字符。</p>:null}
  </section>;
}
