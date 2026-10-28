/** 仅供测试：按 RARLAB 公布的 RAR5 格式构造无压缩小包，不依赖外部安装器。
 * https://www.rarlab.com/technote.htm */
import { crc32 } from 'node:zlib';
const vint=(value:number)=>{const bytes=[];do{let n=value%128;value=Math.floor(value/128);if(value)n|=128;bytes.push(n);}while(value);return Buffer.from(bytes);};
const u32=(n:number)=>{const b=Buffer.alloc(4);b.writeUInt32LE(n>>>0);return b;};
const header=(body:Buffer)=>{const payload=Buffer.concat([vint(body.length),body]);return Buffer.concat([u32(crc32(payload)),payload]);};
export function storedRar(entries:{name:string;data:Buffer;reportedSize?:number}[]){return Buffer.concat([Buffer.from([0x52,0x61,0x72,0x21,0x1a,0x07,1,0]),header(Buffer.from([1,0,0])),...entries.flatMap(e=>{const name=Buffer.from(e.name);return [header(Buffer.concat([Buffer.from([2,2]),vint(e.data.length),vint(4),vint(e.reportedSize??e.data.length),vint(0),u32(crc32(e.data)),vint(0),vint(1),vint(name.length),name])),e.data];}),header(Buffer.from([5,0,0]))]);}
