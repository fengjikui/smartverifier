import { useEffect, useRef } from 'react';
import { bindImageWheel } from '../../shared/image-gestures';
import type { View } from '../../shared/image-editor';
export function useImageWheel(element:HTMLElement|null,update:(fn:(v:View)=>View)=>void,onStart?:()=>void,disabled=false){
 const latest=useRef({update,onStart,disabled});latest.current={update,onStart,disabled};
 useEffect(()=>{if(!element)return;return bindImageWheel(element,fn=>latest.current.update(fn),()=>latest.current.onStart?.(),()=>latest.current.disabled);},[element]);
}
