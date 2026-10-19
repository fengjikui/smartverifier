import { apiPath } from '../../../shared/paths';
import { useEffect, useRef, useState } from 'react';
import { ImagePlus, Plus, Upload, Check } from 'lucide-react';
import { Btn, Field, Pill, Spinner } from '../ui';
import { request } from '../api';
import { Heading, Loading } from './common';
import type { Navigate } from './index';
import type { Person } from '../../../shared/types';
import type { ReferenceAsset, ReferenceDetail, ReferenceInput, ReferenceRecord } from '../../../shared/admin';
const empty=(supplier=''):ReferenceInput=>({material:'',supplier,modelNumber:'',name:'',description:'',lines:[],assetId:'',status:'active'});
export function ReferenceForm({mode,id,person,navigate,onDirty,onSaved,onError}:{mode:string;id?:string;person:Person;navigate:Navigate;onDirty:(d:boolean)=>void;onSaved:(s:string,to?:string)=>void;onError:(e:unknown)=>void}){
  const key='sv-admin-form:'+person.id+':'+mode+':'+(id??'new'),[input,setInput]=useState<ReferenceInput>(empty),[asset,setAsset]=useState<ReferenceAsset|null>(null),[version,setVersion]=useState(0),[loading,setLoading]=useState(!!id),[busy,setBusy]=useState(false),[uploading,setUploading]=useState(false),[recovered,setRecovered]=useState(false),[saveMessage,setSaveMessage]=useState(''),[formError,setFormError]=useState('');
  const mounted=useRef(true);
  useEffect(()=>()=>{mounted.current=false;},[]);
  const picker=useRef<HTMLInputElement>(null),material=useRef<HTMLInputElement>(null),changed=useRef(false);
  useEffect(()=>{let active=true;const draft=localStorage.getItem(key);if(draft){try{const d=JSON.parse(draft);setInput({...empty(),...d.input});setAsset(d.asset);setVersion(d.version);setRecovered(true);changed.current=true;onDirty(true);setLoading(false);return;}catch{localStorage.removeItem(key);}}
    if(id)void request<ReferenceDetail>('/admin/standards/'+id).then(v=>{if(!active)return;const r=v.record;setInput({material:mode==='copy'?'':r.material,supplier:r.supplier,modelNumber:r.modelNumber??'',name:r.name,description:r.description,lines:r.lines,assetId:r.assetId,status:r.status});setAsset(r.asset);setVersion(r.version);}).catch(onError).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[id,mode,key]);
  function update(values:Partial<ReferenceInput>,newAsset=asset){const next={...input,...values};changed.current=true;onDirty(true);setInput(next);setSaveMessage('');try{localStorage.setItem(key,JSON.stringify({input:next,asset:newAsset,version}));}catch{/* Server-side save remains available if browser storage is full. */}}
  async function upload(file:File){setUploading(true);try{const f=new FormData();f.set('image',file);const a=await request<ReferenceAsset>('/admin/assets',f);if(!mounted.current)return;setAsset(a);update({assetId:a.id},a);}catch(e){onError(e);}finally{setUploading(false);}}
  async function save(next:boolean,status=input.status){if(busy||uploading)return;setBusy(true);setFormError('');try{
    const record=await request<ReferenceRecord>('/admin/standards'+(mode==='edit'?'/'+id:''),{...input,status,...(mode==='edit'?{version}:{})},mode==='edit'?'PUT':'POST');
    localStorage.removeItem(key);if(!mounted.current)return;changed.current=false;onDirty(false);
    if(next){setInput(empty(input.supplier));setAsset(null);setVersion(0);setRecovered(false);setSaveMessage(`${record.material} 已保存，可以继续录入下一条。`);onSaved('标准已保存。');material.current?.focus();}
    else onSaved(status==='draft'?'草稿已保存，启用后即可关联检测。':'正品标准已保存，可用于后续检测。','detail/'+record.id);
  }catch(e){setFormError((e as Error).message);onError(e);}finally{setBusy(false);}}
  if(loading)return <Loading/>;
  return <form className="adm-form" onSubmit={e=>{e.preventDefault();void save(false);}}>
    <Heading title={mode==='edit'?'编辑正品标准':mode==='copy'?'复制新增标准':'新增正品标准'} description={mode==='edit'?'修改用于后续检测，已经开始的检测仍保留原标准版本。':'填写物料与供应商，添加一张清晰的正品图片。'}/>
    {recovered?<div className="adm-notice" role="status">已恢复上次未保存的输入，请确认后保存。<button type="button" onClick={()=>{if(confirm('清除恢复的输入并重新填写？')){localStorage.removeItem(key);onDirty(false);navigate('references');}}}>放弃草稿</button></div>:null}
    {saveMessage?<div className="adm-notice" role="status"><Check size={18}/>{saveMessage}</div>:null}
    <div className="adm-two-columns"><section className="adm-panel adm-image-editor"><div className="adm-panel-heading"><h2>正品图片 <span className="adm-required">*</span></h2>{asset?<Pill tone="success">已添加 1 张</Pill>:null}</div>
      {asset?<a className="adm-reference-image" href={apiPath('/reference-assets/'+asset.id)} target="_blank" rel="noreferrer"><img src={apiPath('/reference-assets/'+asset.id)} alt="当前正品原图"/></a>:<button type="button" className="adm-upload-zone" disabled={uploading} onClick={()=>picker.current?.click()}><ImagePlus size={34}/><strong>点击添加正品图片</strong><span>清晰展示丝印与器件外形</span><small>JPG / PNG / WebP · 单张最多 20MB</small></button>}
      <input ref={picker} hidden type="file" accept="image/jpeg,image/png,image/webp" onChange={e=>{const f=e.target.files?.[0];if(f)void upload(f);e.target.value='';}}/>
      {uploading?<div className="adm-loading" role="status"><Spinner/>正在校验与保存原图…</div>:null}
      <div className="adm-actions"><Btn disabled={uploading||busy} type="button" onClick={()=>picker.current?.click()}><Upload size={17}/>{asset?'更换图片':'选择图片'}</Btn>{asset?<a href={apiPath('/reference-assets/'+asset.id)} target="_blank" rel="noreferrer">查看原图 ↗</a>:null}</div>
      {asset?<p className="adm-footnote">{asset.filename} · {asset.width} × {asset.height} · {(asset.bytes/1024/1024).toFixed(2)} MB</p>:null}<p className="adm-image-tip">建议一次拍摄一个器件，丝印清晰、角度端正。原图保留，列表仅使用缩略图。</p>
    </section><section className="adm-panel adm-form-fields"><h2>标准信息</h2><div className="adm-field-pair"><label>物料编号 <span className="adm-required">*</span><Field ref={material} required maxLength={160} value={input.material} onChange={e=>update({material:e.target.value})} placeholder="如 MAT-358-08" autoComplete="off"/></label><label>供应商名称 <span className="adm-required">*</span><Field required maxLength={160} value={input.supplier} onChange={e=>update({supplier:e.target.value})} placeholder="与任务中的名称保持一致"/></label></div>
      <p className="adm-footnote">物料编号与供应商共同唯一，保留前导零。</p>
      <label>型号 <small>选填</small><Field maxLength={200} value={input.modelNumber??''} onChange={e=>update({modelNumber:e.target.value})} placeholder="如 STM32F407VGT6"/></label>
      <label>正品丝印文字 <small>选填，每行一条</small><textarea rows={4} value={input.lines.join('\n')} onChange={e=>update({lines:e.target.value.split('\n')})} placeholder={'按图片上的顺序逐行填写\n不填也可直接依据正品图片比对'}/></label><p className="adm-footnote">填写后可在检测结果中逐字展示差异。</p>
      <details className="adm-optional"><summary>更多信息：检测说明、物料名称与状态{input.description?' · 已有检测说明':''}</summary>
        <label>检测说明 <small>有特殊要求时填写</small><textarea maxLength={8000} rows={4} value={input.description} onChange={e=>update({description:e.target.value})} placeholder="例如：允许批次码变化，重点核对型号与 Logo。"/></label><p className="adm-footnote">通常可留空；说明会和正品图片一起提供给模型。</p>
        <label>物料名称 <small>选填</small><Field maxLength={200} value={input.name} onChange={e=>update({name:e.target.value})}/></label>
        <label>使用状态<select value={input.status} onChange={e=>update({status:e.target.value as 'active'|'draft'})}><option value="active">启用：可关联新检测</option><option value="draft">草稿：暂不用于检测</option></select></label>
      </details>
    </section></div>
    <footer className="adm-form-footer">{formError?<p className="adm-error adm-form-error" role="alert">{formError}</p>:null}<span>保存后按版本留痕；不会改写历史检测。</span><Btn type="button" disabled={busy} onClick={()=>navigate('references')}>取消</Btn><Btn type="button" disabled={busy||uploading} onClick={()=>void save(false,'draft')}>保存草稿</Btn>{mode!=='edit'?<Btn type="button" disabled={busy||uploading} onClick={()=>void save(true)}><Plus size={17}/>保存并继续新增</Btn>:null}<Btn tone="primary" disabled={busy||uploading} type="submit">{busy?<Spinner/>:null}{busy?'正在保存…':'保存标准'}</Btn></footer>
  </form>;
}
