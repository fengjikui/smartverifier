import type { TaskView } from '../../shared/types';
export class ApiError extends Error { status: number; constructor(message:string,status:number){super(message);this.status=status;} }
export async function request<T>(url:string, data?:unknown, method?:string):Promise<T>{
  const response=await fetch('/api'+url,{method:method??(data===undefined?'GET':'POST'),credentials:'same-origin',headers:data instanceof FormData?undefined:data===undefined?undefined:{'Content-Type':'application/json'},body:data instanceof FormData?data:data===undefined?undefined:JSON.stringify(data)});
  const result=await response.json();if(!response.ok)throw new ApiError(result.message??'操作未完成，请稍后重试。',response.status);return result;
}
export function action(view:TaskView, name:string, data:Record<string,unknown>={}){
  if(!view.round)throw new Error('未建立本轮检测。');return request<TaskView>('/rounds/'+view.round.id+'/'+name,{revision:view.round.revision,...data});
}
export async function imageSize(file:File):Promise<{width:number;height:number}>{
  const url=URL.createObjectURL(file);
  try{return await new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve({width:image.naturalWidth,height:image.naturalHeight});image.onerror=()=>reject(new Error('无法读取这张照片，请选择JPG、PNG或WebP图片。'));image.src=url;});}finally{URL.revokeObjectURL(url);}
}
