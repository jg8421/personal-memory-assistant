import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { AmbientTranscription } from './ambient-transcription.mjs';
import { audioPower } from './capture-power.mjs';
import { ensureClosedPcmWav } from './audio-recovery.mjs';

export function localDay(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}

export function inQuietHours(config, date = new Date()) {
  const rule = config.quietHours;
  if (!rule?.enabled) return false;
  const minutes = value => {
    if (!/^\d{2}:\d{2}$/.test(value || '')) throw new Error('停录时间格式无效');
    const [h,m] = value.split(':').map(Number);
    if (h > 23 || m > 59) throw new Error('停录时间无效');
    return h*60+m;
  };
  const start=minutes(rule.start), end=minutes(rule.end);
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:rule.timeZone || 'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date);
  const current=Number(parts.find(p=>p.type==='hour').value)*60+Number(parts.find(p=>p.type==='minute').value);
  return start===end || (start<end ? current>=start && current<end : current>=start || current<end);
}

export function selectAudioInput(config, devices) {
  if(config.deviceId) return {device:config.device || 'Pinned microphone',input:config.deviceId};
  if(devices.includes(config.device))return {device:config.device,input:config.device};
  if(config.allowDeviceFallback===true && devices.length)return {device:devices[0],input:devices[0]};
  throw new Error('Configured microphone is unavailable; automatic fallback is disabled');
}

export function audioArgs(config, outputPattern, manifest) {
  const seconds = Math.max(2, Math.min(3600, Number(config.segmentSeconds) || 600));
  return ['-hide_banner', '-nostats', '-loglevel', 'warning', '-stats_period', '1',
    '-progress', 'pipe:1', '-thread_queue_size', '1024', '-f', 'dshow',
    '-audio_buffer_size', '100', '-i', `audio=${config.device}`, '-vn',
    '-ac', '1', '-ar', config.transcription?.enabled ? '16000' : '48000', '-c:a', 'pcm_s16le',
    '-flush_packets', '1', '-f', 'segment', '-segment_format', 'wav',
    '-segment_time', String(seconds), '-reset_timestamps', '1', '-strftime', '1',
    '-segment_list', manifest, '-segment_list_type', 'csv', '-segment_list_size', '16', outputPattern];
}

export function atomicJson(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2)+'\n', 'utf8');
  // Windows readers may briefly hold a handle without FILE_SHARE_DELETE.
  // Retry the same atomic rename only; never change ACLs or use a partial write.
  for (let attempt=0;;attempt++) {
    try { fs.renameSync(temp, file); break; }
    catch(error) {
      if(process.platform!=='win32' || !['EPERM','EBUSY'].includes(error.code) || attempt>=9) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50);
    }
  }
}

export function freeSpace(directory) {
  const s = fs.statfsSync(directory);
  return Number(s.bavail) * Number(s.bsize);
}

export class AmbientAudio {
  constructor(home, {ownerAlive = () => true, now = () => new Date()} = {}) {
    this.home = home; this.ownerAlive = ownerAlive; this.now=now;
    this.configPath = path.join(home, 'ambient-audio.config.json');
    this.statePath = path.join(home, 'state', 'ambient-audio.json');
    this.pausePath = path.join(home, 'state', 'ambient-audio.paused');
    this.child = null; this.nextStart = 0; this.closed = false; this.lastProgress = 0;
    this.failures = 0; this.timer = null; this.buffer = ''; this.stderr = '';
    this.transcriptionFailures = null;
    this.transcriptionRetryPath = path.join(home, 'state', 'ambient-transcription-retries.json');
    this.state = { supervisorPid: process.pid, status: 'starting', startedAt: new Date().toISOString() };
  }
  write(extra = {}) {
    Object.assign(this.state, extra, {checkedAt: new Date().toISOString()});
    atomicJson(this.statePath, this.state);
  }
  prepareDays() {
    for (let offset = 0; offset < 3; offset++) {
      const date = new Date(); date.setDate(date.getDate()+offset);
      fs.mkdirSync(path.join(this.config.outputDir, localDay(date)), {recursive:true});
    }
  }
  devices() {
    const r = spawnSync(this.config.ffmpegPath, ['-hide_banner','-list_devices','true','-f','dshow','-i','dummy'],
      {windowsHide:true, encoding:'utf8', timeout:12000, maxBuffer:1024*1024});
    if (r.error) throw r.error;
    return [...(r.stderr || '').matchAll(/"([^"\r\n]+)" \(audio\)/g)].map(m=>m[1]);
  }
  recoverOrphan() {
    let previous;
    try {previous=JSON.parse(fs.readFileSync(this.statePath,'utf8'));} catch {return;}
    if (!previous.recorderPid || !previous.supervisorPid) return;
    try {process.kill(previous.recorderPid,0);} catch(error) {if(error.code==='ESRCH')return;throw error;}
    // Only a receipt-backed child of the previous supervisor with our exact output path can be stopped.
    const script = '$p=Get-CimInstance Win32_Process -Filter ("ProcessId="+[int]$env:PM_AUDIO_OLD_PID); '+
      'if($p -and $p.ParentProcessId -eq [int]$env:PM_AUDIO_OLD_OWNER -and '+
      '$p.ExecutablePath -eq $env:PM_AUDIO_EXE -and $p.CommandLine -and '+
      '$p.CommandLine.Contains($env:PM_AUDIO_OUTPUT) -and $p.CommandLine.Contains("dshow")) '+
      '{ Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop }';
    const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{
      windowsHide:true,encoding:'utf8',timeout:10000,
      env:{...process.env,PM_AUDIO_OLD_PID:String(previous.recorderPid),PM_AUDIO_OLD_OWNER:String(previous.supervisorPid),
        PM_AUDIO_EXE:this.config.ffmpegPath,PM_AUDIO_OUTPUT:this.config.outputDir}});
    if(result.error || result.status!==0) throw new Error('无法核验旧录音进程，等待重试');
  }
  latestFile() {
    const files = [];
    for (const date of [new Date(Date.now()-86400000), new Date()]) {
      const directory = path.join(this.config.outputDir, localDay(date));
      if (!fs.existsSync(directory)) continue;
      for (const name of fs.readdirSync(directory)) {
        if (name.endsWith(`-${this.session}.capture.wav`)) {
          const file = path.join(directory, name), s = fs.statSync(file);
          files.push({file, bytes:s.size, mtime:s.mtimeMs});
        }
      }
    }
    return files.sort((a,b)=>b.mtime-a.mtime)[0] || {};
  }
  async finalizeFiles(activeFile = '') {
    if (!this.config?.outputDir || !fs.existsSync(this.config.outputDir)) return;
    const pending=[];
    for(const day of fs.readdirSync(this.config.outputDir)) {
      if(!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      const directory=path.join(this.config.outputDir,day);
      if(!fs.statSync(directory).isDirectory()) continue;
      for(const name of fs.readdirSync(directory)) {
        const file=path.join(directory,name);
        if((name.endsWith('.capture.wav') || (this.config.transcription?.enabled && name.endsWith('.flac'))) && file !== activeFile) pending.push(file);
      }
    }
    pending.sort();
    this.write({pendingAudioFiles:pending.length});
    if(this.config.transcription?.enabled && !this.transcriptionFailures) {
      let saved={files:{}};
      try {saved=JSON.parse(fs.readFileSync(this.transcriptionRetryPath,'utf8'));}
      catch(error) {if(error.code!=='ENOENT')throw new Error('无法读取逐段转写重试状态，音频保留');}
      if(!saved.files || typeof saved.files!=='object')throw new Error('逐段转写重试状态无效，音频保留');
      this.transcriptionFailures=new Map(Object.entries(saved.files));
      for(const file of this.transcriptionFailures.keys()) if(!fs.existsSync(file))this.transcriptionFailures.delete(file);
    }
    const recent=this.config.transcription?.enabled && pending.length>8 &&
      Date.now()-(this.lastRecentTranscriptionAt||0)>=60000 ? pending.at(-1) : '';
    const candidates=recent ? [recent,...pending.slice(0,-1)] : pending;
    let attempts=0;
    for(const file of candidates) {
      if(attempts>=4)break;
      if(this.config.transcription?.enabled) {
        const before=fs.statSync(file);
        const previous=this.transcriptionFailures.get(file);
        const unchanged=previous && previous.size===before.size && previous.mtimeMs===before.mtimeMs;
        if(unchanged && Date.now()<previous.retryAt)continue;
        attempts++;
        if(file===recent)this.lastRecentTranscriptionAt=Date.now();
        try {
          if(!this.transcriber)this.transcriber=new AmbientTranscription(this.home,this.config.transcription);
          this.write({transcriptionStatus:'transcribing',transcribingFile:file});
          if(this.config.recoverInterruptedPcmWav===true)ensureClosedPcmWav(file,this.home);
          const verifiedBefore=fs.statSync(file);
          const saved=await this.transcriber.transcribe(file);
          const after=fs.statSync(file);
          if(verifiedBefore.size!==after.size||verifiedBefore.mtimeMs!==after.mtimeMs)throw new Error('音频仍在变化，暂不删除');
          fs.unlinkSync(file);
          this.transcriptionFailures.delete(file);
          atomicJson(this.transcriptionRetryPath,{version:1,files:Object.fromEntries(this.transcriptionFailures)});
          const processedAt=new Date().toISOString();
          this.write({transcriptionStatus:'ready',lastProcessedAt:processedAt,
            lastProcessingResult:saved.skipped?'no-recognized-speech':'transcribed',
            ...(saved.skipped ? {lastSkippedAt:processedAt} : {lastTranscript:saved.daily,lastTranscribedAt:processedAt}),
            transcriptionError:'',transcribingFile:'',audioRetention:'delete-after-transcript-or-silence-receipt',
            deferredTranscriptionFiles:this.transcriptionFailures.size,
            transcriptionWarning:this.transcriptionFailures.size ? '部分片段失败暂存，后续片段继续转写' : '',
            pendingAudioFiles:pending.filter(p=>fs.existsSync(p)).length});
        } catch(error) {
          if(this.closed)return;
          const count=unchanged ? (Number(previous.attempts)||0)+1 : 1;
          this.transcriptionFailures.set(file,{size:before.size,mtimeMs:before.mtimeMs,attempts:count,
            retryAt:Date.now()+Math.min(3600000,60000*2**Math.min(count-1,6)),error:String(error.message).slice(0,1000)});
          atomicJson(this.transcriptionRetryPath,{version:1,files:Object.fromEntries(this.transcriptionFailures)});
          this.write({transcriptionStatus:'error',transcriptionError:String(error.message),transcribingFile:'',
            deferredTranscriptionFiles:this.transcriptionFailures.size,
            transcriptionWarning:'失败片段已保留并单独退避，后续片段继续转写'});
        }
        continue;
      }
      attempts++;
      const final=file.replace(/\.capture\.wav$/,'.flac');
      const temp=`${final}.${process.pid}.tmp`;
      try {
        await new Promise((resolve,reject)=>{
          const child=spawn(this.config.ffmpegPath,['-hide_banner','-v','error','-nostdin','-y','-i',file,
            '-map','0:a:0','-af','asetpts=PTS-STARTPTS','-c:a','flac','-compression_level','3','-f','flac',temp],
            {windowsHide:true,stdio:'ignore'});
          const timeout=setTimeout(()=>{child.kill();reject(new Error('分段压缩超时，原始片段已保留'));},60000);
          child.once('error',e=>{clearTimeout(timeout);reject(e);});
          child.once('close',code=>{clearTimeout(timeout);code===0?resolve():reject(new Error('分段压缩失败，原始片段已保留'));});
        });
        if(fs.statSync(temp).size<42) throw new Error('压缩输出无效，原始片段已保留');
        fs.renameSync(temp,final); fs.unlinkSync(file);
      } catch(error) {this.write({compressionError:String(error.message)});}
    }
  }
  launch() {
    this.prepareDays();
    const selected = selectAudioInput(this.config, this.config.deviceId ? [] : this.devices());
    this.device = selected.device;
    const inputDevice = selected.input;
    const preferred = this.config.device;
    this.session = crypto.randomBytes(4).toString('hex');
    const pattern = path.join(this.config.outputDir, '%Y-%m-%d', `%H-%M-%S-${this.session}.capture.wav`);
    const manifest = path.join(this.home, 'state', 'ambient-audio-segments.csv');
    this.buffer = ''; this.stderr = ''; this.lastProgress = Date.now(); this.lastOut = -1;
    const child = spawn(this.config.ffmpegPath, audioArgs({...this.config, device:inputDevice}, pattern, manifest),
      {windowsHide:true, stdio:['pipe','pipe','pipe']});
    this.child = child;
    child.stdin.on('error', ()=>{});
    this.write({status:'starting', recorderPid:child.pid, device:this.device, deviceId:this.config.deviceId || null,
      warning:this.device !== preferred ? '首选麦克风不可用，已切换到可用输入' : '',
      outputDir:this.config.outputDir, segmentSeconds:this.config.segmentSeconds || 600,
      session:this.session, lastError:'', currentFile:'', currentBytes:0});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', text => {
      this.buffer += text;
      const lines = this.buffer.split(/\r?\n/); this.buffer = lines.pop().slice(-10000);
      for (const line of lines) {
        if (!line.startsWith('out_time_us=')) continue;
        const value = Number(line.slice(12));
        if (Number.isFinite(value) && value >= 0 && value !== this.lastOut) {
          this.lastOut = value; this.lastProgress = Date.now(); this.failures = 0;
          if (value > 0) this.write({status:'recording', lastAudioAt:new Date().toISOString()});
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', text => {this.stderr = (this.stderr+text).slice(-3000);});
    child.on('error', error => {this.stderr = String(error.message);});
    child.on('close', code => {
      if (this.child !== child) return;
      this.child = null;
      const unexpected = !this.closed && !this.stoppingReason;
      if (unexpected) {
        this.failures++; this.nextStart = Date.now()+Math.min(30000, this.failures*3000);
      }
      this.write({status:this.closed?'stopped':this.stoppingReason || 'retrying', recorderPid:null,
        lastError:unexpected ? (this.stderr.trim() || `录音进程已退出 (${code})`) : this.state.lastError});
      this.stoppingReason = null;
    });
  }
  async stopRecorder(reason) {
    if (!this.child) return;
    this.stoppingReason = reason;
    this.write({status:reason});
    const child = this.child;
    child.stdin.write('q\n');
    await new Promise(resolve => {
      const timeout = setTimeout(()=>{ child.kill(); resolve(); }, 8000);
      child.once('close', ()=>{ clearTimeout(timeout); resolve(); });
    });
    // Finish transcription asynchronously through tick; do not stall stopping the input device.
    if(!this.config.transcription?.enabled)await this.finalizeFiles();
  }
  async tick() {
    if (this.closed || this.busy) return;
    this.busy = true;
    try {
      if (!this.ownerAlive()) { await this.stop(); return; }
      this.config = JSON.parse(fs.readFileSync(this.configPath,'utf8'));
      if (!this.orphanChecked) {this.recoverOrphan(); this.orphanChecked=true;}
      const policy=this.config.powerPolicy?.enabled ? audioPower(this.home) : {paused:false};
      const quiet=inQuietHours(this.config,this.now());
      const paused = this.config.enabled !== true || fs.existsSync(this.pausePath) || policy.paused || quiet;
      if (paused) { const reason=quiet?'scheduled-paused':policy.paused?'power-paused':'paused'; await this.stopRecorder(reason);this.write({status:reason,powerReason:policy.reason});return; }
      fs.mkdirSync(this.config.outputDir, {recursive:true});
      const bytes = freeSpace(this.config.outputDir);
      if (bytes < (Number(this.config.minFreeBytes) || 10*1024**3)) {
        await this.stopRecorder('disk-full');
        this.write({status:'disk-full', freeBytes:bytes, lastError:'剩余空间低于保留值，已停止录音；未删除旧录音'}); return;
      }
      this.prepareDays();
      if (this.child && Date.now()-this.lastProgress > 45000) {
        await this.stopRecorder('retrying'); this.nextStart = Date.now()+3000;
        this.write({lastError:'音频输入超过45秒无进度，正在重新连接'});
      }
      if (!this.child && Date.now() >= this.nextStart) this.launch();
      const latest = this.session ? this.latestFile() : {};
      if(this.config.transcription?.enabled) {
        if(!this.finalizing) this.finalizing=this.finalizeFiles(this.child ? latest.file : '')
          .catch(error=>this.write({transcriptionStatus:'error',transcriptionError:String(error.message)}))
          .finally(()=>{this.finalizing=null;});
      } else await this.finalizeFiles(this.child ? latest.file : '');
      this.write({freeBytes:bytes, currentFile:latest.file || this.state.currentFile || '',
        currentBytes:latest.bytes || 0});
    } catch (error) {
      await this.stopRecorder('retrying');
      this.nextStart = Date.now()+10000;
      this.write({status:'retrying', lastError:String(error.message)});
    } finally {this.busy = false;}
  }
  start() { this.tick(); this.timer = setInterval(()=>this.tick(), 3000); }
  async stop() {
    if (this.closed) return;
    this.closed = true; clearInterval(this.timer);
    await this.stopRecorder('stopped');
    await this.transcriber?.stop(); this.write({status:'stopped', recorderPid:null});
  }
}
