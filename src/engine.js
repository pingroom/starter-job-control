import { join } from 'node:path';
import { readJson, atomicJson, acquireLock } from './storage.js';
import { policyValue, jobValue, roomValue, actionBinding, batchValue, stateValue, ingest, report, modeFrom, transformItem, hash, stamp, ROOM, MAX_BYTES } from './model.js';

export async function runCheckpoint({client,directory,job:rawJob,policy:rawPolicy,token,room,operation='tick',signal,now=()=>new Date().toISOString(),write=atomicJson,transform=transformItem}) {
  const job=jobValue(rawJob),policy=policyValue(rawPolicy);
  if (typeof token!=='string' || !token || !ROOM.test(room) || !['init','tick'].includes(operation)) throw new Error('Invalid connection or operation.');
  const release=await acquireLock(directory);
  try {
    signal?.throwIfAborted();
    let s=await readJson(join(directory,'state.json'),MAX_BYTES);
    if (s!==null) {
      stateValue(s);
      if (hash(job)!==hash(s.job) || hash(policy)!==hash(s.policy) || hash(token)!==s.credentialHash || room!==s.room) throw new Error('Job, policy, room or credential changed. Preserve the original run.');
      if (operation==='init' || ['cancelled','complete'].includes(report(s).status)) return report(s);
    } else if (operation!=='init') throw new Error('Initialize the run before ticking.');
    const identity=roomValue(await client.rooms.list(),room,policy);
    const actions=actionBinding(await client.actions.list(room),policy);
    signal?.throwIfAborted();
    if (s===null) {
      const head=batchValue(await client.notifications.wait({timeout:0,limit:50,signal}));
      signal?.throwIfAborted();const at=stamp(now());
      s=stateValue({version:1,job,policy,room,roomId:identity.id,credentialHash:hash(token),actions,initialCursor:head.cursor,cursor:head.cursor,startedAt:at,checkedAt:at,controls:[],results:[]});
      await write(directory,'state.json',s,MAX_BYTES);return report(s);
    }
    if (identity.id!==s.roomId || hash(actions)!==hash(s.actions)) throw new Error('Room or control actions changed. No work performed.');
    let drained=false;
    // Save controls before work. A full bounded backlog always defers work.
    for (let page=0;page<5;page++) {
      signal?.throwIfAborted();
      const batch=await client.notifications.wait({after:s.cursor,timeout:0,limit:50,signal});
      signal?.throwIfAborted();
      const next=ingest(s,batch,now());await write(directory,'state.json',next,MAX_BYTES);s=next;
      if (batch.notifications.length<50) {drained=true;break;}
    }
    if (!drained) return {...report(s),deferred:'control_backlog'};
    if (modeFrom(s.controls)!=='running') return report(s);
    signal?.throwIfAborted();
    const output=await transform(structuredClone(job.items[s.results.length]));
    signal?.throwIfAborted();
    const next=stateValue({...s,results:[...s.results,{output,afterCursor:s.cursor}]});
    await write(directory,'state.json',next,MAX_BYTES);return report(next);
  } finally {await release();}
}

export async function localStatus(directory) {
  const release=await acquireLock(directory);
  try {
    const s=await readJson(join(directory,'state.json'),MAX_BYTES);
    if (s===null) throw new Error('No initialized run.');
    return report(s);
  } finally {await release();}
}
