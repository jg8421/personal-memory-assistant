import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {saveTranscript} from '../src/ambient-transcription.mjs';
import {AmbientAudio,audioArgs} from '../src/ambient-audio.mjs';

function fixture(){const home=fs.mkdtempSync(path.join(os.tmpdir(),'ambient-text-'));const outputDir=path.join(home,'audio');
 const day=path.join(outputDir,'2026-10-24');fs.mkdirSync(day,{recursive:true});fs.mkdirSync(path.join(home,'state'));
 const input=path.join(day,'12-34-56-test.capture.wav');fs.writeFileSync(input,'audio');
 return {home,input,config:{outputDir,transcription:{enabled:true,outputDir:path.join(home,'transcripts')}}};}

test('audio is removed only after timestamped daily transcript has been saved and read back',async()=>{
 const f=fixture();try{
 const audio=new AmbientAudio(f.home);audio.config=f.config;
 audio.transcriber={transcribe:async input=>saveTranscript(input,{ok:true,duration:60,language:'zh',segments:[{start:0,end:3,text:'测试文字'}]},f.config.transcription)};
 await audio.finalizeFiles();assert.equal(fs.existsSync(f.input),false);
 const text=fs.readFileSync(path.join(f.config.transcription.outputDir,'2026-10-24.txt'),'utf8');
 assert.ok(text.includes('12:34:56'));assert.ok(text.includes('测试文字'));assert.equal(audio.state.transcriptionStatus,'ready');
 }finally{fs.rmSync(f.home,{recursive:true,force:true});}
});
test('failed transcription preserves the original audio and exposes an error',async()=>{
 const f=fixture();try{
 const audio=new AmbientAudio(f.home);audio.config=f.config;audio.transcriber={transcribe:async()=>{throw new Error('offline failure');}};
 await audio.finalizeFiles();assert.ok(fs.existsSync(f.input));assert.equal(audio.state.transcriptionStatus,'error');
 }finally{fs.rmSync(f.home,{recursive:true,force:true});}
});
test('invalid receipts cannot authorize removing audio; silence is explicitly represented',()=>{
 const f=fixture();try{
 assert.throws(()=>saveTranscript(f.input,{ok:true,segments:[]},f.config.transcription));assert.ok(fs.existsSync(f.input));
 const saved=saveTranscript(f.input,{ok:true,duration:60,segments:[]},f.config.transcription);
 assert.ok(fs.readFileSync(saved.daily,'utf8').includes('未检测到可识别人声'));assert.ok(fs.existsSync(f.input));
 }finally{fs.rmSync(f.home,{recursive:true,force:true});}
});
test('transcription mode uses small 16kHz capture buffers without silence deletion',()=>{
 const args=audioArgs({transcription:{enabled:true},device:'test',segmentSeconds:60},'out.wav','list.csv');
 assert.equal(args[args.indexOf('-ar')+1],'16000');assert.equal(args[args.indexOf('-segment_time')+1],'60');
 assert.ok(!args.some(x=>x.includes('silenceremove')));
});

test('a failed head never blocks later audio, including after supervisor restart',async()=>{
 const f=fixture();try{
 const good=path.join(path.dirname(f.input),'12-35-56-good.capture.wav');fs.writeFileSync(good,'valid audio');
 const audio=new AmbientAudio(f.home);audio.config=f.config;
 audio.transcriber={transcribe:async input=>{
  if(input===f.input)throw new Error('invalid audio');
  return saveTranscript(input,{ok:true,duration:60,segments:[]},f.config.transcription);
 }};
 await audio.finalizeFiles();assert.ok(fs.existsSync(f.input));assert.equal(fs.existsSync(good),false);
 assert.equal(audio.state.deferredTranscriptionFiles,1);
 assert.ok(JSON.parse(fs.readFileSync(audio.transcriptionRetryPath,'utf8')).files[f.input].retryAt>Date.now());
 const next=path.join(path.dirname(f.input),'12-36-56-next.capture.wav');fs.writeFileSync(next,'next audio');
 const restarted=new AmbientAudio(f.home);restarted.config=f.config;
 restarted.transcriber={transcribe:async input=>{
  assert.notEqual(input,f.input,'persisted per-file backoff must survive restart');
  return saveTranscript(input,{ok:true,duration:60,segments:[]},f.config.transcription);
 }};
 await restarted.finalizeFiles();assert.equal(fs.existsSync(next),false);assert.ok(fs.existsSync(f.input));
 }finally{fs.rmSync(f.home,{recursive:true,force:true});}
});

test('a changed failed file becomes eligible without waiting for old backoff',async()=>{
 const f=fixture();try{
 const audio=new AmbientAudio(f.home);audio.config=f.config;
 audio.transcriber={transcribe:async()=>{throw new Error('partial audio');}};
 await audio.finalizeFiles();fs.appendFileSync(f.input,'completed');
 audio.transcriber={transcribe:async input=>saveTranscript(input,{ok:true,duration:60,segments:[]},f.config.transcription)};
 await audio.finalizeFiles();assert.equal(fs.existsSync(f.input),false);assert.equal(audio.state.deferredTranscriptionFiles,0);
 }finally{fs.rmSync(f.home,{recursive:true,force:true});}
});

test('backfill gives recent closed audio a turn without starving older audio or touching active capture',async()=>{
 const f=fixture();try{
 fs.unlinkSync(f.input);const files=[];
 for(let i=0;i<12;i++){const file=path.join(path.dirname(f.input),`12-34-${String(i).padStart(2,'0')}-queue.capture.wav`);fs.writeFileSync(file,'audio');files.push(file);}
 const audio=new AmbientAudio(f.home);audio.config=f.config;const calls=[];
 audio.transcriber={transcribe:async input=>{calls.push(input);return saveTranscript(input,{ok:true,duration:60,segments:[]},f.config.transcription);}};
 await audio.finalizeFiles(files[11]);assert.equal(calls[0],files[10]);assert.equal(calls[1],files[0]);
 assert.equal(calls.length,4);assert.ok(fs.existsSync(files[11]));
 await audio.finalizeFiles(files[11]);assert.equal(calls[4],files[3]);assert.ok(fs.existsSync(files[11]));
 }finally{fs.rmSync(f.home,{recursive:true,force:true});}
});
