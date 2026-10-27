import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function ensureClosedPcmWav(file, home, now=Date.now()) {
  const before=fs.statSync(file);
  if(before.size<44) throw new Error('音频文件过短，原件保留');
  const fd=fs.openSync(file,'r'), header=Buffer.alloc(Math.min(before.size,65536));
  try {fs.readSync(fd,header,0,header.length,0);} finally {fs.closeSync(fd);}
  if(header.toString('ascii',0,4)!=='RIFF'||header.toString('ascii',8,12)!=='WAVE') throw new Error('不是可恢复的PCM WAV，原件保留');
  if(header.readUInt32LE(4)===before.size-8) return {repaired:false};
  if(now-before.mtimeMs<15000) throw new Error('音频刚发生变化，稍后重试');
  let format=null, dataOffset=-1, dataSizeOffset=-1;
  for(let offset=12;offset+8<=header.length;) {
    const id=header.toString('ascii',offset,offset+4), size=header.readUInt32LE(offset+4);
    if(id==='fmt ' && size>=16 && offset+24<=header.length) format={codec:header.readUInt16LE(offset+8),channels:header.readUInt16LE(offset+10),rate:header.readUInt32LE(offset+12),align:header.readUInt16LE(offset+20),bits:header.readUInt16LE(offset+22)};
    if(id==='data') {dataOffset=offset+8;dataSizeOffset=offset+4;break;}
    offset+=8+size+(size%2);
  }
  if(!format||format.codec!==1||format.channels!==1||format.rate!==16000||format.bits!==16||format.align!==2||dataOffset<0)
    throw new Error('音频格式不能安全恢复，原件保留');
  const bytes=before.size-dataOffset;
  if(bytes<=0||bytes%format.align!==0||before.size>128*1024**2) throw new Error('音频数据长度异常，原件保留');
  const current=fs.statSync(file);
  if(current.size!==before.size||current.mtimeMs!==before.mtimeMs) throw new Error('音频仍在变化，稍后重试');
  const original=fs.readFileSync(file), hash=crypto.createHash('sha256').update(original).digest('hex');
  const folder=path.join(home,'recovered-audio-originals',path.basename(path.dirname(file)));
  fs.mkdirSync(folder,{recursive:true});
  const backup=path.join(folder,path.basename(file)+'.'+hash.slice(0,12)+'.original');
  if(!fs.existsSync(backup)) {fs.writeFileSync(backup,original,{flag:'wx'});}
  if(crypto.createHash('sha256').update(fs.readFileSync(backup)).digest('hex')!==hash) throw new Error('原件备份核验失败，停止恢复');
  const repaired=Buffer.from(original);
  repaired.writeUInt32LE(repaired.length-8,4);repaired.writeUInt32LE(bytes,dataSizeOffset);
  const temp=file+'.repair.tmp';fs.writeFileSync(temp,repaired);
  if(!fs.readFileSync(temp).equals(repaired)) throw new Error('恢复副本读回失败');
  const after=fs.statSync(file);
  if(after.size!==before.size||after.mtimeMs!==before.mtimeMs) throw new Error('音频发生变化，保留原件后重试');
  fs.renameSync(temp,file);
  return {repaired:true,backup,originalSha256:hash,durationSeconds:bytes/(format.rate*format.align)};
}
