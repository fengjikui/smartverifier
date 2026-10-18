import { useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

const preferenceKey=(task:string)=>'sv-next:album-density:v1:'+task;
function readPreference(task:string|undefined){try{return !!task&&localStorage.getItem(preferenceKey(task))==='compact';}catch{return false;}}
export function useAlbumDensity(gallery:RefObject<HTMLDivElement|null>, scroll:RefObject<number>, task:string|undefined) {
  const [preference,setPreference]=useState(()=>({task,compact:readPreference(task)}));
  const compact=preference.task===task&&preference.compact;
  const anchor=useRef<{id:string;offset:number}|null>(null);
  useLayoutEffect(()=>{setPreference({task,compact:readPreference(task)});},[task]);
  function toggle() {
    const area=gallery.current;
    if(area){
      const top=area.getBoundingClientRect().top;
      const first=Array.from(area.querySelectorAll<HTMLElement>('[data-photo-id]')).find(el=>el.getBoundingClientRect().bottom>top+8);
      if(first)anchor.current={id:first.dataset.photoId!,offset:first.getBoundingClientRect().top-top};
    }
    const next=!compact;setPreference({task,compact:next});
    try{if(task)localStorage.setItem(preferenceKey(task),next?'compact':'normal');}catch{/* 不可用时只保留本次页面选择。 */}
  }
  useLayoutEffect(()=>{
    const area=gallery.current,previous=anchor.current;anchor.current=null;
    if(area&&previous){
      const element=Array.from(area.querySelectorAll<HTMLElement>('[data-photo-id]')).find(el=>el.dataset.photoId===previous.id);
      if(element)area.scrollTop+=element.getBoundingClientRect().top-area.getBoundingClientRect().top-previous.offset;
      scroll.current=area.scrollTop;
    }
  },[compact,gallery,scroll]);
  return {compact,toggle};
}
