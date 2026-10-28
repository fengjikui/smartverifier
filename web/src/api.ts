import { deadline } from './camera-diagnostics';
import type { TaskView } from '../../shared/types';
import { apiPath } from '../../shared/paths';
export class ApiError extends Error { status: number; constructor(message:string,status:number){super(message);this.status=status;} }
export async function request<T>(url:string, data?:unknown, method?:string):Promise<T>{
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),data instanceof FormData?120000:30000);
  try{const response=await fetch(apiPath(url),{signal:controller.signal,method:method??(data===undefined?'GET':'POST'),credentials:'same-origin',headers:data instanceof FormData?undefined:data===undefined?undefined:{'Content-Type':'application/json'},body:data instanceof FormData?data:data===undefined?undefined:JSON.stringify(data)});
  const result=await response.json();if(!response.ok)throw new ApiError(result.message??'操作未完成，请稍后重试。',response.status);return result;
  }catch(e){if(controller.signal.aborted)throw new ApiError('连接超时，已保留当前照片与输入，请重试。',408);throw e;}finally{clearTimeout(timer);}
}
export function action(view:TaskView, name:string, data:Record<string,unknown>={}){
  if(!view.round)throw new Error('未建立本轮检测。');return request<TaskView>('/rounds/'+view.round.id+'/'+name,{revision:view.round.revision,...data});
}
export async function imageSize(file:File):Promise<{width:number;height:number}>{
  const url=URL.createObjectURL(file);
  try{return await deadline(new Promise<{width:number;height:number}>((resolve,reject)=>{const image=new Image();image.onload=()=>resolve({width:image.naturalWidth,height:image.naturalHeight});image.onerror=()=>reject(new Error('无法读取这张照片，请选择JPG、PNG或WebP图片。'));image.src=url;}),10000,'照片解码超时，请重拍或使用系统相机。');}finally{URL.revokeObjectURL(url);}
}
