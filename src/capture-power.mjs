import fs from 'node:fs';
import path from 'node:path';
const lastGood=new Map();
export function capturePower(home, now=Date.now()) {
  try {
    const p=JSON.parse(fs.readFileSync(path.join(home,'state','capture-power.json'),'utf8'));
    const at=Date.parse(p.checkedAt);
    if(!Number.isFinite(at) || now-at>15000) return {paused:true,reason:'power-monitor-stale'};
    lastGood.set(home,{value:p,at});
    return {...p,paused:p.paused===true};
  } catch {
    const previous=lastGood.get(home);
    if(previous && now-previous.at<=15000)return {...previous.value,paused:previous.value.paused===true};
    return {paused:true,reason:'power-monitor-unavailable'};
  }
}

export function audioPower(home, now=Date.now()) {
  const policy=capturePower(home,now);
  if(policy.acConnected!==true) return {...policy,paused:true,reason:policy.acConnected===false?'battery-powered':'power-source-unknown'};
  if(policy.batterySaver===true || policy.energySaver===true || policy.powerEfficiency===true || policy.effectivePowerMode===0 || policy.effectivePowerMode===1)
    return {...policy,paused:true,reason:'energy-saver'};
  if(policy.audioPaused===true) return {...policy,paused:true,reason:policy.audioPauseReason || policy.reason};
  return policy;
}
