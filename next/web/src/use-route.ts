import { useEffect, useState } from 'react';
export type Route = {task?:string;view?:'overview'|'detail'|'report'|'transfer';photo?:string;component?:string};
function current():Route{const p=new URLSearchParams(location.search);return {task:p.get('task')??undefined,view:(p.get('view') as Route['view'])??'overview',photo:p.get('photo')??undefined,component:p.get('component')??undefined};}
export function useRoute(){
  const [route,setRoute]=useState<Route>(current);
  useEffect(()=>{const listener=()=>setRoute(current());window.addEventListener('popstate',listener);return()=>window.removeEventListener('popstate',listener);},[]);
  function navigate(next:Route,replace=false){const p=new URLSearchParams();for(const [key,value]of Object.entries(next))if(value)p.set(key,value);history[replace?'replaceState':'pushState'](null,'',location.pathname+(p.size?'?'+p:''));setRoute(current());}
  return {route,navigate};
}
