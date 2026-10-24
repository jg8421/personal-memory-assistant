import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';

function atomicText(file, text) {
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temp=`${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp,text,'utf8'); fs.renameSync(temp,file);
  if(fs.readFileSync(file,'utf8')!==text) throw new Error('转写文件读回失败，音频保留');
}

export function saveTranscript(input, result, options) {
  if(result.ok!==true || !Number.isFinite(result.duration) || result.duration<=0 || !Array.isArray(result.segments))
    throw new Error('转写回执无效，音频保留');
  for(const segment of result.segments) {
    if(typeof segment.text!=='string'||!Number.isFinite(segment.start)||!Number.isFinite(segment.end)||segment.end<segment.start)
      throw new Error('转写片段无效，音频保留');
  }
  const day=path.basename(path.dirname(input));
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('音频日期目录无效');
  const name=path.basename(input).replace(/(?:\.capture\.wav|\.flac)$/i,'');
  const receipt=path.join(options.outputDir,day,`${name}.json`);
  const record={version:1,date:day,startedAt:name.slice(0,8).replaceAll('-',':'),
    durationSeconds:result.duration,language:result.language || 'zh',
    segments:result.segments,recognizedSpeech:result.segments.length>0};
  atomicText(receipt,JSON.stringify(record,null,2)+'\n');
  const folder=path.dirname(receipt);
  const records=fs.readdirSync(folder).filter(x=>x.endsWith('.json')).sort().map(x=>JSON.parse(fs.readFileSync(path.join(folder,x),'utf8')));
  const lines=[`${day} 环境语音转写`,'本地自动识别，可能有错字、漏字；不代表人工确认。',''];
  for(const item of records) {
    lines.push(`[${item.startedAt}] (${Math.round(item.durationSeconds)}秒)`);
    if(!item.segments.length) lines.push('未检测到可识别人声。');
    else for(const s of item.segments) lines.push(`  +${s.start.toFixed(1)}s–${s.end.toFixed(1)}s  ${s.text}`);
    lines.push('');
  }
  const daily=path.join(options.outputDir,`${day}.txt`);
  atomicText(daily,lines.join('\n'));
  return {receipt,daily,segments:record.segments.length};
}

export class AmbientTranscription {
  constructor(home, options) {this.home=home;this.options=options;this.child=null;this.pending=null;this.buffer='';}
  start() {
    if(this.child) return;
    const child=spawn(this.options.pythonPath,['-X','utf8','-u',path.join(this.home,'scripts','transcribe-ambient.py'),
      path.join(this.home,'ambient-audio.config.json')],{windowsHide:true,stdio:['pipe','pipe','ignore'],
      env:{...process.env,HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',OMP_NUM_THREADS:'2'}});
    this.child=child;this.buffer='';child.stdin.on('error',()=>{});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',text=>{
      this.buffer+=text;
      if(this.buffer.length>2*1024*1024) {this.fail(new Error('转写输出超限'));child.kill();return;}
      let pos;
      while((pos=this.buffer.indexOf('\n'))>=0) {
        const line=this.buffer.slice(0,pos);this.buffer=this.buffer.slice(pos+1);
        let result;try{result=JSON.parse(line);}catch{continue;}
        if(result.ready) continue;
        if(this.pending && result.id===this.pending.id) {
          const job=this.pending;this.pending=null;clearTimeout(job.timeout);
          result.ok===true?job.resolve(result):job.reject(new Error(result.error||'转写失败'));
        }
      }
    });
    child.on('error',()=>{if(this.child===child)this.fail(new Error('本地转写程序启动失败，音频保留'));});
    child.on('close',()=>{if(this.child===child){this.child=null;this.fail(new Error('本地转写程序已退出，音频保留'));}});
  }
  fail(error) {if(this.pending){const p=this.pending;this.pending=null;clearTimeout(p.timeout);p.reject(error);}}
  async transcribe(input) {
    if(this.pending) throw new Error('转写正在进行');
    this.start();
    const result=await new Promise((resolve,reject)=>{
      const id=crypto.randomUUID();
      const timeout=setTimeout(()=>{this.fail(new Error('本地转写超时，音频保留重试'));this.child?.kill();},900000);
      this.pending={id,timeout,resolve,reject};
      this.child.stdin.write(JSON.stringify({id,path:input})+'\n');
    });
    return saveTranscript(input,result,this.options);
  }
  stop() {this.fail(new Error('转写暂停，音频保留'));this.child?.kill();this.child=null;}
}
