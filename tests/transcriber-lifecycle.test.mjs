import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {AmbientTranscription,terminateOwnedTranscriber} from '../src/ambient-transcription.mjs';

test('owned Windows teardown requests a hidden process tree stop and reports timeout',async()=>{
 if(process.platform!=='win32')return;
 let args,options,killed=false;
 const launch=(exe,a,o)=>{assert.equal(exe,'taskkill.exe');args=a;options=o;const child=new EventEmitter();child.kill=()=>{killed=true;};setImmediate(()=>child.emit('close',0));return child;};
 await terminateOwnedTranscriber({pid:123},launch);
 assert.deepEqual(args,['/PID','123','/T','/F']);assert.equal(options.windowsHide,true);assert.equal(killed,false);
 const stalled=()=>{const p=new EventEmitter();p.kill=()=>{killed=true;};return p;};
 await assert.rejects(terminateOwnedTranscriber({pid:123},stalled,10),{code:'ASR_STOP_TIMEOUT'});
 assert.equal(killed,true);
});

test('a stopping worker retains its reference and blocks replacement until confirmed',async()=>{
 const asr=new AmbientTranscription('unused',{});const original={pid:123};asr.child=original;
 let finish,calls=0;asr.stopTree=()=>{calls++;return new Promise(resolve=>{finish=resolve;});};
 const first=asr.stop();const second=asr.stop();
 assert.equal(asr.child,original);assert.equal(calls,1);assert.ok(asr.stopping);
 finish();await Promise.all([first,second]);assert.equal(asr.child,null);assert.equal(asr.stopping,null);
});

test('a failed stop retains ownership instead of allowing an orphan replacement',async()=>{
 const asr=new AmbientTranscription('unused',{});const original={pid:123};asr.child=original;
 asr.stopTree=async()=>{const error=new Error('timeout');error.code='ASR_STOP_TIMEOUT';throw error;};
 await assert.rejects(asr.stop(),{code:'ASR_STOP_TIMEOUT'});assert.equal(asr.child,original);
});

test('job timeout tears down the owned tree before another worker can replace it',async()=>{
 const asr=new AmbientTranscription('unused',{});const original={pid:123,stdin:{write(){}}};asr.child=original;asr.start=()=>{};
 let timerCallback,finish;const timer=global.setTimeout;
 global.setTimeout=(callback,ms,...args)=>{if(ms===900000){timerCallback=callback;return timer(()=>{},3600000);}return timer(callback,ms,...args);};
 asr.stopTree=()=>new Promise(resolve=>{finish=resolve;});
 try{
  const pending=asr.transcribe('unused.wav');const rejected=assert.rejects(pending);
  timerCallback();await rejected;assert.equal(asr.child,original);assert.ok(asr.stopping);
  finish();await asr.stopping;assert.equal(asr.child,null);
 }finally{global.setTimeout=timer;}
});
