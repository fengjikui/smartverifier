import type { IncomingMessage } from 'node:http';

/** 仅直接访问服务器本机；反向代理的回环连接不能视为用户在本机。 */
export function directLoopback(req: IncomingMessage): boolean {
  return ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress??'')
    && !Object.keys(req.headers).some(key=>key==='forwarded'||key.startsWith('x-forwarded-'));
}
