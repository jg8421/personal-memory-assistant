import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {inQuietHours,selectAudioInput} from '../src/ambient-audio.mjs';
import {capturePower,audioPower} from '../src/capture-power.mjs';
import {ensureClosedPcmWav} from '../src/audio-recovery.mjs';
import {rebuildDailyTranscript} from '../src/ambient-transcription.mjs';

test('Shanghai quiet interval is audio-only and has inclusive start/exclusive end',()=>{
  const cfg={quietHours:{enabled:true,start:'02:00',end:'09:00',timeZone:'Asia/Shanghai'}};
  for(const [time,expected] of [['01:59:59',false],['02:00:00',true],['08:59:59',true],['09:00:00',false]])
    assert.equal(inQuietHours(cfg,new Date(`2026-10-28T${time}+08:00`)),expected);
});

test('pinned environment input never follows a communications default or implicit fallback',()=>{
  assert.deepEqual(selectAudioInput({device:'Built-in',deviceId:'test-built-in-id'},['USB']),{device:'Built-in',input:'test-built-in-id'});
  assert.throws(()=>selectAudioInput({device:'Built-in'},['USB']),/fallback is disabled/);
  assert.deepEqual(selectAudioInput({device:'Built-in',allowDeviceFallback:true},['USB']),{device:'USB',input:'USB'});
});

test('power status reads tolerate a brief atomic-replacement gap but fail closed when stale',()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'pm-policy-'));fs.mkdirSync(path.join(home,'state'));
  const file=path.join(home,'state','capture-power.json'),now=Date.now();
  fs.writeFileSync(file,JSON.stringify({checkedAt:new Date(now).toISOString(),acConnected:true,paused:false}));
  assert.equal(capturePower(home,now).paused,false);fs.unlinkSync(file);
  assert.equal(capturePower(home,now+100).paused,false);
  assert.equal(capturePower(home,now+16000).paused,true);
});

test('audio energy policy does not change the desktop battery/lid decision',()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'pm-power-role-'));fs.mkdirSync(path.join(home,'state'));
  const file=path.join(home,'state','capture-power.json');
  fs.writeFileSync(file,JSON.stringify({checkedAt:new Date().toISOString(),acConnected:true,paused:false,energySaver:true}));
  assert.equal(capturePower(home).paused,false);assert.equal(audioPower(home).paused,true);
});

test('interrupted PCM repair preserves a verified original and never repairs a fresh active file',()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'pm-wav-recovery-'));const dir=path.join(home,'2026-10-28');fs.mkdirSync(dir);
  const file=path.join(dir,'sample.capture.wav'),wav=Buffer.alloc(44+32000);
  wav.write('RIFF',0);wav.writeUInt32LE(0xffffffff,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(0xffffffff,40);fs.writeFileSync(file,wav);
  assert.throws(()=>ensureClosedPcmWav(file,home));
  const old=new Date(Date.now()-30000);fs.utimesSync(file,old,old);
  const result=ensureClosedPcmWav(file,home);assert.equal(result.repaired,true);
  assert.deepEqual(fs.readFileSync(result.backup),wav);
  assert.equal(fs.readFileSync(file).readUInt32LE(4),wav.length-8);
});

test('an empty rebuild cannot delete an existing daily document',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pm-no-delete-'));const file=path.join(dir,'2026-10-28.txt');fs.writeFileSync(file,'existing speech');
  assert.equal(rebuildDailyTranscript({outputDir:dir},'2026-10-28'),null);assert.equal(fs.readFileSync(file,'utf8'),'existing speech');
});
