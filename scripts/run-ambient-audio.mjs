import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AmbientAudio } from '../src/ambient-audio.mjs';

const home = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const owner = Number(process.argv[3] || 0);
// Initialize capture and native ASR imports at normal scheduling priority.
// The ASR worker lowers its own priority after local model initialization.
if (process.platform === 'win32') os.setPriority(0, os.constants.priority.PRIORITY_NORMAL);
fs.mkdirSync(path.join(home,'state'),{recursive:true});
const name = crypto.createHash('sha256').update(home.toLowerCase()).digest('hex').slice(0,20);
const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\PersonalMemoryAudio-${name}` : path.join(home,'state','audio.sock');
const lock = net.createServer(socket=>socket.end());
lock.on('error', error=>process.exit(error.code === 'EADDRINUSE' ? 0 : 1));
lock.listen(pipe, ()=>{
  const audio = new AmbientAudio(home, {ownerAlive:()=>{
    if (!owner) return true;
    try {process.kill(owner,0); return true;} catch {return false;}
  }});
  let shuttingDown = false;
  const shutdown = async()=>{
    if (shuttingDown) return;
    shuttingDown = true; await audio.stop(); lock.close(); process.exit(0);
  };
  process.on('SIGINT',shutdown); process.on('SIGTERM',shutdown);
  audio.start();
  const ownerTimer = setInterval(()=>{if(audio.closed){clearInterval(ownerTimer);lock.close();process.exit(0);}},1000);
});
