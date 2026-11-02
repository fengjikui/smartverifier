import exifr from 'exifr';
import type { PhotoPolicy } from '../shared/types.ts';
import { ApiError } from './errors.ts';

export function photoPolicy(env:NodeJS.ProcessEnv=process.env):PhotoPolicy {
  const minutes=Number(env.SV_ALBUM_MAX_AGE_MINUTES??10),offset=env.SV_PHOTO_TIMEZONE_OFFSET??'+08:00';
  if(env.SV_ALBUM_MAX_AGE_MINUTES?.trim()===''||!Number.isInteger(minutes)||minutes<0||minutes>10080)throw new Error('SV_ALBUM_MAX_AGE_MINUTES 必须为 0 至 10080 的整数，0 表示关闭相册时间限制。');
  if(!/^[+-](?:0\d|1[0-3]):[0-5]\d$|^[+-]14:00$/.test(offset))throw new Error('SV_PHOTO_TIMEZONE_OFFSET 必须为 +08:00 这样的时区偏移。');
  return {albumMaxAgeMinutes:minutes,timezoneOffset:offset};
}

/** 不使用文件修改时间。缺少 EXIF 时区时按部署现场时区解释，与服务器操作系统时区无关。 */
export function parseCaptureTime(value:unknown,offset:unknown,fallback:string):number|null {
  if(typeof value!=='string')return null;
  const match=/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value.trim());
  if(!match)return null;
  const [,year,month,day,hour,minute,second]=match,zone=typeof offset==='string'?offset.trim():fallback;
  if(!/^[+-](?:0\d|1[0-3]):[0-5]\d$|^[+-]14:00$/.test(zone))return null;
  const wall=Date.UTC(+year,+month-1,+day,+hour,+minute,+second),check=new Date(wall);
  if(check.getUTCFullYear()!==+year||check.getUTCMonth()!==+month-1||check.getUTCDate()!==+day||check.getUTCHours()!==+hour||check.getUTCMinutes()!==+minute||check.getUTCSeconds()!==+second)return null;
  const delta=(Number(zone.slice(1,3))*60+Number(zone.slice(4,6)))*60000*(zone[0]==='+'?1:-1);
  return wall-delta;
}

export async function admitPhotoTime(bytes:Buffer,source:'camera'|'album',policy:PhotoPolicy,now=Date.now()):Promise<string|undefined>{
  // 网页曝光通常没有 EXIF。系统相机按钮由 OS 管理，当前来源字段不是可信拍摄证明。
  let captured:number|null=null;
  try{const tags=await exifr.parse(bytes,{pick:['DateTimeOriginal','OffsetTimeOriginal'],reviveValues:false});captured=parseCaptureTime(tags?.DateTimeOriginal,tags?.OffsetTimeOriginal,policy.timezoneOffset);}catch{/* 乱码或不支持的元数据按无法确认处理。 */}
  if(source==='album'&&policy.albumMaxAgeMinutes>0){
    if(captured===null)throw new ApiError(422,'无法确认这张照片的拍摄时间，请选择保留拍摄信息的原始照片，或使用相机重新拍摄。','PHOTO_TIME_MISSING');
    if(captured>now+120000)throw new ApiError(422,'照片拍摄时间晚于服务器时间，请检查设备时钟后重新拍摄。','PHOTO_TIME_FUTURE');
    if(now-captured>policy.albumMaxAgeMinutes*60000)throw new ApiError(422,`仅可添加最近 ${policy.albumMaxAgeMinutes} 分钟拍摄的照片，请重新拍摄。`,'PHOTO_TOO_OLD');
  }
  return captured===null?undefined:new Date(captured).toISOString();
}
