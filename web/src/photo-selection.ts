export type SelectedPhoto={file:File;source:'camera'|'album'};
/** 原始字节摘要，与服务端的 SHA-256 一致；HTTP 不支持时仍由服务端拦截。 */
export async function photoHash(file:File):Promise<string|undefined>{
  if(!globalThis.crypto?.subtle)return undefined;
  const digest=await crypto.subtle.digest('SHA-256',await file.arrayBuffer());
  return Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join('');
}
