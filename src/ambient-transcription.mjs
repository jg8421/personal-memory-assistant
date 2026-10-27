import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';

export function terminateOwnedTranscriber(child, launch=spawn, timeoutMs=60000) {
  if(!child?.pid)return Promise.resolve();
  if(process.platform!=='win32'){child.kill();return Promise.resolve();}
  return new Promise((resolve,reject)=>{
    const killer=launch('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
    const timer=setTimeout(()=>{killer.kill();const error=new Error('Owned transcription tree stop timed out');error.code='ASR_STOP_TIMEOUT';reject(error);},timeoutMs);
    killer.once('error',error=>{clearTimeout(timer);reject(error);});
    killer.once('close',code=>{
      clearTimeout(timer);
      if(code===0)return resolve();
      try{process.kill(child.pid,0);}catch(error){if(error.code==='ESRCH')return resolve();return reject(error);}
      reject(new Error('Owned transcription process remains active after stop'));
    });
  });
}


function atomicText(file, text) {
  if(fs.existsSync(file) && fs.readFileSync(file,'utf8')===text) return;
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temp=`${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp,text,'utf8'); fs.renameSync(temp,file);
  if(fs.readFileSync(file,'utf8')!==text) throw new Error('转写文件读回失败，音频保留');
}

function saveSilenceReceipt(directory, day, name, duration) {
  if(!directory) throw new Error('未配置本地静音处理凭据目录，音频保留');
  fs.mkdirSync(directory,{recursive:true});
  const receipt=path.join(directory,`${day}.jsonl`);
  const bytes=Buffer.from(JSON.stringify({source:name,durationSeconds:duration,result:'no-recognized-speech'})+'\n','utf8');
  const fd=fs.openSync(receipt,'a+');
  try {
    const offset=fs.fstatSync(fd).size;
    if(fs.writeSync(fd,bytes)!==bytes.length) throw new Error('静音处理凭据未完整写入');
    fs.fsyncSync(fd);
    const readback=Buffer.alloc(bytes.length);
    if(fs.readSync(fd,readback,0,bytes.length,offset)!==bytes.length || !readback.equals(bytes))
      throw new Error('静音处理凭据读回失败，音频保留');
  } finally {fs.closeSync(fd);}
  return receipt;
}

export function rebuildDailyTranscript(options, day) {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('音频日期目录无效');
  const folder=path.join(options.outputDir,day);
  const records=fs.existsSync(folder) ? fs.readdirSync(folder).filter(x=>x.endsWith('.json')).sort()
    .map(x=>JSON.parse(fs.readFileSync(path.join(folder,x),'utf8'))) : [];
  const speech=records.map(item=>({...item,segments:item.segments.filter(s=>s.text.trim())}))
    .filter(item=>item.segments.length);
  const daily=path.join(options.outputDir,`${day}.txt`);
  if(!speech.length) {
    // A rebuild without speech does not authorize deleting an existing document.
    return null;
  }
  const lines=[`${day} 环境语音转写`,'本地自动识别，可能有错字、漏字；不代表人工确认。',''];
  for(const item of speech) {
    lines.push(`[${item.startedAt}] (${Math.round(item.durationSeconds)}秒)`);
    for(const s of item.segments)lines.push(`  +${s.start.toFixed(1)}s–${s.end.toFixed(1)}s  ${s.text}`);
    lines.push('');
  }
  atomicText(daily,lines.join('\n'));
  return daily;
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
  const segments=result.segments.filter(segment=>segment.text.trim());
  if(!segments.length) {
    const receipt=saveSilenceReceipt(options.silenceReceiptDir,day,name,result.duration);
    return {receipt,daily:null,segments:0,skipped:true};
  }
  const receipt=path.join(options.outputDir,day,`${name}.json`);
  const record={version:1,date:day,startedAt:name.slice(0,8).replaceAll('-',':'),
    durationSeconds:result.duration,language:result.language || 'zh',
    segments,recognizedSpeech:true};
  atomicText(receipt,JSON.stringify(record,null,2)+'\n');
  const daily=rebuildDailyTranscript(options,day);
  return {receipt,daily,segments:record.segments.length};
}

export class AmbientTranscription {
  constructor(home, options) {
    this.home=home;this.options={...options,silenceReceiptDir:path.join(home,'state','ambient-silence')};
    this.child=null;this.pending=null;this.buffer='';
  }
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
    if(this.stopping)await this.stopping;
    if(this.stopFailure)throw this.stopFailure;
    if(this.pending) throw new Error('转写正在进行');
    this.start();
    const result=await new Promise((resolve,reject)=>{
      const id=crypto.randomUUID();
      const timeout=setTimeout(()=>{this.fail(new Error('本地转写超时，音频保留重试'));void this.stop().catch(error=>{this.stopFailure=error;});},900000);
      this.pending={id,timeout,resolve,reject};
      this.child.stdin.write(JSON.stringify({id,path:input})+'\n');
    });
    return saveTranscript(input,result,this.options);
  }
  async stop() {
    if(this.stopping)return this.stopping;
    const error=new Error('Transcription paused; closed input retained');error.code='ASR_PAUSED';
    this.fail(error);const child=this.child;
    if(!child?.pid)return;
    this.stopping=(this.stopTree || terminateOwnedTranscriber)(child);
    try{await this.stopping;if(this.child===child)this.child=null;this.stopFailure=null;}
    finally{this.stopping=null;}
  }
}
