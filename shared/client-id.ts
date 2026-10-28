/** 页面可在局域网 HTTP 下打开；randomUUID 在部分浏览器只在安全上下文提供。 */
export function clientId(){if(typeof crypto.randomUUID==='function')return crypto.randomUUID();return Date.now().toString(36)+'-'+Array.from(crypto.getRandomValues(new Uint8Array(16)),v=>v.toString(16).padStart(2,'0')).join('');}
