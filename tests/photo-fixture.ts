/** 将真实 JPEG 的 APP1 插入明确的 EXIF 时间；不依赖文件修改时间、操作系统时区或 Pillow。 */
export function datedPhotoFrom(jpeg:Buffer,date:string,offset='+08:00'){
  const values=[Buffer.from(date+'\0'),Buffer.from(offset+'\0')];let cursor=56;
  // EXIF 子 IFD pointer lives in IFD0, rather than a next-IFD chain.
  const body=Buffer.alloc(26+2+24+4+values.reduce((n,v)=>n+v.length,0));
  body.write('II');body.writeUInt16LE(42,2);body.writeUInt32LE(8,4);body.writeUInt16LE(1,8);body.writeUInt16LE(0x8769,10);body.writeUInt16LE(4,12);body.writeUInt32LE(1,14);body.writeUInt32LE(26,18);body.writeUInt16LE(2,26);
  [0x9003,0x9011].forEach((tag,i)=>{const at=28+i*12;body.writeUInt16LE(tag,at);body.writeUInt16LE(2,at+2);body.writeUInt32LE(values[i].length,at+4);body.writeUInt32LE(cursor,at+8);values[i].copy(body,cursor);cursor+=values[i].length;});
  const data=Buffer.concat([Buffer.from('Exif\0\0'),body]),marker=Buffer.alloc(4);marker[0]=255;marker[1]=225;marker.writeUInt16BE(data.length+2,2);
  return Buffer.concat([jpeg.subarray(0,2),marker,data,jpeg.subarray(2)]);
}
