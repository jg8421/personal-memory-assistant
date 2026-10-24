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
