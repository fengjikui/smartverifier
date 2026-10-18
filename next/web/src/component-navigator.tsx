import { Btn } from './ui';
import { finalVerdict } from '../../shared/domain';
import type { ComponentResult } from '../../shared/types';

export function ComponentNavigator({components, selected, onSelect, scope='photo'}: {components:ComponentResult[]; selected:string; onSelect:(component:ComponentResult)=>void; scope?:'photo'|'task'}) {
  const many = components.length > 8;
  if(components.length<2)return null;
  return <div className={'sv-detail-nav'+(many?' sv-detail-nav-many':'')}>
    <span>{scope==='task'?'本轮':'照片内'}{components.length}个元件<small><span className="sv-component-legend-pass">绿色合格</span><span className="sv-component-legend-fail">红色不合格</span></small></span>
    <div className={'sv-component-tabs'+(many?' sv-component-tabs-many':'')} role="group" aria-label={scope==='task'?'切换本轮检测的元件':'选择这张照片中的元件'}>
      {components.map((c,order)=>{
        const value=finalVerdict(c),low=value==='PASS'&&c.ai&&c.ai.confidence<.8&&!c.review;
        const state=!c.ai?'pending':value==='FAIL'?'fail':'pass';
        const label=state==='pending'?'待检测':state==='fail'?'不合格':low?'合格，建议按需复核':'合格';
        const number=String(scope==='task'?order+1:c.index+1).padStart(2,'0');
        return <Btn key={c.id} className={'sv-component-choice is-'+state} aria-pressed={c.id===selected} aria-label={`元件${number}，${scope==='task'?c.label+'，':''}${label}`} title={c.label+' · '+label} disabled={!c.ai} onClick={()=>onSelect(c)}>
          <span>{number}</span>
        </Btn>;
      })}
    </div>
  </div>;
}
