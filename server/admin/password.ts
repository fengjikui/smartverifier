import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';
const derive=promisify(scrypt);
export const accountPassword=z.string().min(12).max(256).refine(value=>value.trim().length>=12,'密码至少需要12个非边缘空白字符。');
export async function newPassword(password:string){
  accountPassword.parse(password);const salt=randomBytes(24).toString('hex');
  return {salt,hash:(await derive(password,salt,32) as Buffer).toString('hex')};
}
export async function matchesPassword(password:string,credential?:{salt:string;hash:string}){
  const value=await derive(password.length<=256?password:'',credential?.salt??'unknown-account-salt',32) as Buffer;
  return !!credential&&!!password&&password.length<=256&&timingSafeEqual(value,Buffer.from(credential.hash,'hex'));
}
