/** 所有本进程检验、正品分析与调试请求共用一个推理槽，避免同时挤占本机。 */
let tail:Promise<void>=Promise.resolve();
export async function inModelSlot<T>(run:()=>Promise<T>):Promise<T>{const previous=tail;let release!:()=>void;tail=new Promise<void>(resolve=>{release=resolve;});await previous;try{return await run();}finally{release();}}
