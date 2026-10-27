import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {audioArgs, localDay, AmbientAudio, atomicJson} from '../src/ambient-audio.mjs';

test('continuous PCM segmentation includes silence and passes device name as one argument', ()=>{
  const args=audioArgs({device:'Mic (USB & audio)',segmentSeconds:600},'out.flac','list.csv');
  assert.equal(args[args.indexOf('-i')+1],'audio=Mic (USB & audio)');
  assert.equal(args[args.indexOf('-segment_time')+1],'600');
  assert.equal(args[args.indexOf('-c:a')+1],'pcm_s16le');
  assert.ok(!args.includes('-af')); assert.ok(!args.some(x=>x.includes('silenceremove')));
});

test('paused configuration prevents launching and leaves recordings intact',async()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'ambient-audio-'));
  try {
    fs.mkdirSync(path.join(home,'state')); const out=path.join(home,'recordings'); fs.mkdirSync(out);
    fs.writeFileSync(path.join(out,'keep.flac'),'original');
    atomicJson(path.join(home,'ambient-audio.config.json'),{enabled:true,outputDir:out});
    fs.writeFileSync(path.join(home,'state','ambient-audio.paused'),'pause');
    const audio=new AmbientAudio(home); audio.launch=()=>assert.fail('paused must not launch');
    await audio.tick(); assert.equal(audio.state.status,'paused');
    assert.equal(fs.readFileSync(path.join(out,'keep.flac'),'utf8'),'original');
    await audio.stop();
  } finally {fs.rmSync(home,{recursive:true,force:true});}
});

test('disk reserve stops recording without deleting files',async()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'ambient-audio-'));
  try {
    fs.mkdirSync(path.join(home,'state')); const out=path.join(home,'recordings'); fs.mkdirSync(out);
    fs.writeFileSync(path.join(out,'keep.flac'),'original');
    atomicJson(path.join(home,'ambient-audio.config.json'),{enabled:true,outputDir:out,minFreeBytes:1e20});
    const audio=new AmbientAudio(home); audio.launch=()=>assert.fail('low space must not launch');
    await audio.tick(); assert.equal(audio.state.status,'disk-full');
    assert.equal(fs.readFileSync(path.join(out,'keep.flac'),'utf8'),'original'); await audio.stop();
  } finally {fs.rmSync(home,{recursive:true,force:true});}
});

test('owner exit stops the recorder; day names use local calendar',async()=>{
  assert.equal(localDay(new Date(2026,9,24,23,59)),'2026-10-24');
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'ambient-audio-'));
  try {
    fs.mkdirSync(path.join(home,'state'));
    const audio=new AmbientAudio(home,{ownerAlive:()=>false}); await audio.tick();
    assert.equal(audio.closed,true); assert.equal(audio.state.status,'stopped');
  } finally {fs.rmSync(home,{recursive:true,force:true});}
});

test('Windows sharing conflicts retry the same atomic operation without replacing permissions',()=>{
 if(process.platform!=='win32')return;
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'ambient-sharing-'));
 const target=path.join(home,'state.json');const rename=fs.renameSync;let calls=0;
 try {
  fs.writeFileSync(target,'{"old":true}');
  fs.renameSync=(from,to)=>{calls++;if(calls===1){const error=new Error('shared reader');error.code='EPERM';throw error;}return rename(from,to);};
  atomicJson(target,{new:true});assert.equal(calls,2);assert.deepEqual(JSON.parse(fs.readFileSync(target,'utf8')),{new:true});
  fs.renameSync=()=>{calls++;const error=new Error('access denied');error.code='EACCES';throw error;};
  assert.throws(()=>atomicJson(target,{unwritten:true}),{code:'EACCES'});
  assert.deepEqual(JSON.parse(fs.readFileSync(target,'utf8')),{new:true});
 }finally{fs.renameSync=rename;fs.rmSync(home,{recursive:true,force:true});}
});