import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,readFile,writeFile,mkdir,stat,symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCheckpoint,localStatus } from '../src/engine.js';
import { mockSource,JOB,POLICY,TOKEN,ROOM_CODE,NOW,PERSON,OWNER,id,ZERO } from '../src/mock.js';
import { stateValue,transformItem,jobValue,policyValue,stamp,MAX_BYTES } from '../src/model.js';
import { readJson,atomicJson } from '../src/storage.js';
import { makeClient } from '../src/client.js';
import { loadConnection,validateConnection,loadEnvironment } from '../src/config.js';
async function setup(t,{initialize=true}={}) {
  const directory=await mkdtemp(join(tmpdir(),'control-test-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const mock=mockSource(),args={directory,client:mock.client,job:JOB,policy:POLICY,token:TOKEN,room:ROOM_CODE,now:()=>NOW};
  if(initialize)await runCheckpoint({...args,operation:'init'});
  return {directory,mock,args};
}
const saved=f=>readJson(join(f.directory,'state.json'),MAX_BYTES);
test('init captures head, skips old controls and starts paused without work',async t=>{
  const f=await setup(t,{initialize:false});f.mock.add('resume');const r=await runCheckpoint({...f.args,operation:'init'});
  assert.equal(r.status,'paused');assert.equal(r.completed,0);assert.equal(r.observedCursor,id(1));
  assert.equal((await runCheckpoint(f.args)).completed,0);
});
test('resume runs one unit; pause prevents future units; resume continues after restart',async t=>{
  const f=await setup(t);f.mock.add('resume');assert.equal((await runCheckpoint(f.args)).completed,1);
  f.mock.add('pause');const pause=await runCheckpoint(f.args);assert.equal(pause.status,'paused');assert.equal(pause.completed,1);
  assert.equal((await runCheckpoint(f.args)).completed,1);
  f.mock.add('resume');assert.equal((await runCheckpoint({...f.args})).completed,2);
  const done=await runCheckpoint(f.args);assert.equal(done.status,'complete');assert.equal(done.results[2].output.uppercase,'PINGROOM');
});
test('cancel preserves completed work and later Resume never restarts it',async t=>{
  const f=await setup(t);f.mock.add('resume');await runCheckpoint(f.args);f.mock.add('cancel');f.mock.add('resume');
  const r=await runCheckpoint(f.args);assert.equal(r.status,'cancelled');assert.equal(r.completed,1);
  const count=f.mock.requests.length;f.mock.add('resume');assert.equal((await runCheckpoint(f.args)).status,'cancelled');assert.equal(f.mock.requests.length,count);
});
test('completed run is terminal and local status needs no API access',async t=>{
  const f=await setup(t);f.mock.add('resume');for(let i=0;i<3;i++)await runCheckpoint(f.args);
  f.mock.fail=true;assert.equal((await runCheckpoint(f.args)).status,'complete');assert.equal((await localStatus(f.directory)).status,'complete');
});
test('ordered controls in the same batch apply before work',async t=>{
  const f=await setup(t);f.mock.add('resume');f.mock.add('pause');assert.equal((await runCheckpoint(f.args)).completed,0);
  f.mock.add('pause');f.mock.add('resume');assert.equal((await runCheckpoint(f.args)).completed,1);
});
test('all full pages are drained before work, so later-page Pause takes effect',async t=>{
  const f=await setup(t);f.mock.add('resume');for(let i=0;i<49;i++)f.mock.add('resume',{sender:{id:OWNER.replace('2','4')}});f.mock.add('pause');
  const r=await runCheckpoint(f.args);assert.equal(r.status,'paused');assert.equal(r.completed,0);assert.equal(r.observedCursor,id(51));
});
test('five full batches defer work and persist controls/cursor together',async t=>{
  const f=await setup(t);for(let i=0;i<250;i++)f.mock.add('resume');const r=await runCheckpoint(f.args);
  assert.equal(r.deferred,'control_backlog');assert.equal(r.completed,0);assert.equal((await saved(f)).cursor,id(250));
  assert.equal((await runCheckpoint(f.args)).completed,1);
});
test('own connecting account, unknown people, foreign room and non-human provenance cannot control',async t=>{
  for(const extra of [{sender:{id:OWNER}},{sender:{id:id(999)}},{room:{code:'OTHERROOM001'}},{trigger_source:'agent'},{origin_agent:{}},{question:{}},{is_handoff:true},{origin_agent:undefined}]) {
    const f=await setup(t);f.mock.add('resume',extra);assert.equal((await runCheckpoint(f.args)).completed,0);
  }
});
test('duplicate, backwards, mismatched and empty advancing cursors fail before work',async t=>{
  for(const make of [e=>({notifications:[e,e],cursor:e.id}),e=>({notifications:[{...e,id:ZERO}],cursor:ZERO}),e=>({notifications:[e],cursor:id(99)}),()=>({notifications:[],cursor:id(99)})]) {
    const f=await setup(t);const e=f.mock.add('resume');f.mock.scripted.push(make(e));
    await assert.rejects(runCheckpoint(f.args));assert.equal((await saved(f)).results.length,0);assert.equal((await saved(f)).cursor,ZERO);
  }
});
test('failed control write retains original cursor and retry does not duplicate controls',async t=>{
  const f=await setup(t);f.mock.add('resume');await assert.rejects(runCheckpoint({...f.args,write:async()=>{throw new Error('disk failure');}}));
  assert.equal((await saved(f)).cursor,ZERO);const r=await runCheckpoint(f.args);assert.equal(r.controlCount,1);assert.equal(r.completed,1);
});
test('failed result write leaves safe pure transformation retry at the same unit',async t=>{
  const f=await setup(t);f.mock.add('resume');let writes=0,transforms=0;
  const transform=i=>{transforms++;return transformItem(i);};
  await assert.rejects(runCheckpoint({...f.args,transform,write:async(...a)=>{if(++writes===2)throw new Error('disk failure');return atomicJson(...a);}}));
  assert.equal((await saved(f)).results.length,0);assert.equal((await saved(f)).controls.length,1);
  const r=await runCheckpoint({...f.args,transform});assert.equal(r.completed,1);assert.equal(transforms,2);assert.equal(r.controlCount,1);
});
test('work failure and wrong output preserve last checkpoint without fabricating success',async t=>{
  for(const transform of [()=>{throw new Error('work failed');},()=>({wrong:true})]) {
    const f=await setup(t);f.mock.add('resume');await assert.rejects(runCheckpoint({...f.args,transform}));assert.equal((await saved(f)).results.length,0);
  }
});
test('failed API read does not run work or advance cursor',async t=>{
  const f=await setup(t);f.mock.add('resume');f.mock.scripted.push(new Error('network failure'));await assert.rejects(runCheckpoint(f.args));assert.equal((await saved(f)).cursor,ZERO);
});
test('input, token, room, action identity or controller membership drift blocks work',async t=>{
  for(const change of [f=>({...f.args,token:'changed'}),f=>({...f.args,room:'OTHERROOM001'}),f=>({...f.args,job:{...JOB,runId:'other'}}),f=>{f.mock.actions[0].id=id(888);return f.args;},f=>{f.mock.rooms[0].members=[{user_id:OWNER}];return f.args;}]) {
    const f=await setup(t);f.mock.add('resume');await assert.rejects(runCheckpoint(change(f)));assert.equal((await saved(f)).results.length,0);
  }
});
test('public/personal/duplicate rooms and required-input or relabeled controls fail setup',async t=>{
  for(const change of [f=>f.mock.rooms[0].is_public=true,f=>f.mock.rooms[0].type='personal',f=>f.mock.rooms.push(structuredClone(f.mock.rooms[0])),f=>f.mock.actions[0].input_type='text',f=>f.mock.actions[0].label='Other']) {
    const f=await setup(t,{initialize:false});change(f);await assert.rejects(runCheckpoint({...f.args,operation:'init'}));assert.equal(await saved(f),null);
  }
});
test('repeated init never captures a new head or discards existing controls',async t=>{
  const f=await setup(t);f.mock.add('resume');await runCheckpoint(f.args);const count=f.mock.requests.length;
  const r=await runCheckpoint({...f.args,operation:'init'});assert.equal(r.completed,1);assert.equal(f.mock.requests.length,count);
});
test('future timestamps and clock rollback fail closed',async t=>{
  const f=await setup(t);f.mock.add('resume',{created_at:'2026-10-22T05:01:01Z'});await assert.rejects(runCheckpoint(f.args));
  f.mock.events[0].created_at=NOW;await assert.rejects(runCheckpoint({...f.args,now:()=> '2026-10-22T04:59:59Z'}));assert.equal((await saved(f)).results.length,0);
});
test('saved result must match both original item and running control evidence',async t=>{
  const f=await setup(t);const s=await saved(f);s.results=[{output:transformItem(JOB.items[0]),afterCursor:ZERO}];assert.throws(()=>stateValue(s));
  f.mock.add('resume');await runCheckpoint(f.args);const a=await saved(f);a.results[0].output.uppercase='OTHER';assert.throws(()=>stateValue(a));
});
test('capacity refusal preserves last cursor and executes no further unit',async t=>{
  const f=await setup(t);for(let i=0;i<500;i++)f.mock.add('pause');await runCheckpoint(f.args);await runCheckpoint(f.args);
  f.mock.add('resume');await assert.rejects(runCheckpoint(f.args));assert.equal((await saved(f)).cursor,id(500));assert.equal((await saved(f)).results.length,0);
});
test('maximum manifest and 500 control receipts fit the bounded state',async t=>{
  const f=await setup(t,{initialize:false});f.args.job={runId:'largest',items:Array.from({length:50},(_,i)=>({id:`item-${i}`,text:'a'.repeat(1000)}))};
  await runCheckpoint({...f.args,operation:'init'});for(let i=0;i<499;i++)f.mock.add('pause');f.mock.add('resume');await runCheckpoint(f.args);await runCheckpoint(f.args);
  for(let i=0;i<50;i++)await runCheckpoint(f.args);assert.equal((await localStatus(f.directory)).status,'complete');assert.ok((await stat(join(f.directory,'state.json'))).size<MAX_BYTES);
});
test('private bounded files reject malformed input, symlinks and concurrent writers',async t=>{
  const f=await setup(t);assert.equal((await stat(join(f.directory,'state.json'))).mode&0o777,0o600);assert.equal((await stat(f.directory)).mode&0o777,0o700);
  assert.ok(!(await readFile(join(f.directory,'state.json'),'utf8')).includes(TOKEN));
  await mkdir(join(f.directory,'.lock'));await assert.rejects(runCheckpoint(f.args));await rm(join(f.directory,'.lock'),{recursive:true});
  const bad=join(f.directory,'bad.json');await writeFile(bad,'{"secret-token":');await assert.rejects(readJson(bad),e=>!e.message.includes('secret-token'));
  await writeFile(bad,Buffer.from([0xc3,0x28]));await assert.rejects(readJson(bad));await writeFile(bad,'x'.repeat(MAX_BYTES+1));await assert.rejects(readJson(bad,MAX_BYTES));
  await symlink(bad,join(f.directory,'link.json'));await assert.rejects(readJson(join(f.directory,'link.json')));
});
test('partial credentials are refused and input validation is strict',async t=>{
  const f=await setup(t);await assert.rejects(loadConnection(f.directory,{PINGROOM_TOKEN:'token'}));assert.throws(()=>validateConnection({token:'',room:ROOM_CODE}));
  assert.throws(()=>jobValue({...JOB,items:[JOB.items[0],JOB.items[0]]}));assert.throws(()=>policyValue({...POLICY,resumeAction:1}));assert.throws(()=>stamp('2026-02-30T00:00:00Z'));
});
test('a partial external credential pair cannot silently combine with dotenv or saved credentials',async t=>{
  const f=await setup(t),path=join(f.directory,'.env');
  await writeFile(path,`PINGROOM_TOKEN=file-token\nPINGROOM_ROOM=${ROOM_CODE}\n`);
  for(const env of [{PINGROOM_TOKEN:'external-token'},{PINGROOM_ROOM:ROOM_CODE},{PINGROOM_TOKEN:''}]) {
    await loadEnvironment(env,path);await assert.rejects(loadConnection(f.directory,env));
  }
  const env={};await loadEnvironment(env,path);assert.equal((await loadConnection(f.directory,env)).token,'file-token');
});
test('aborted tick performs no requests or work',async t=>{
  const f=await setup(t),controller=new AbortController();controller.abort();const count=f.mock.requests.length;await assert.rejects(runCheckpoint({...f.args,signal:controller.signal}));assert.equal(f.mock.requests.length,count);
});
test('transport rejects oversized/invalid bodies and redirects',async()=>{
  for(const response of [()=>new Response('x'.repeat(512*1024+1)),()=>new Response(new Uint8Array([0xc3,0x28])),()=>new Response(null,{status:302})]) {
    const c=makeClient({token:'fixture',fetchImpl:async()=>response()});await assert.rejects(c.rooms.list());
  }
});
test('complete-body deadline bounds stalled and infinitely ready empty streams',async()=>{
  for(const mode of ['stall','empty']) {
    const c=makeClient({token:'fixture',deadlineMs:30,fetchImpl:async()=>new Response(new ReadableStream({pull:controller=>mode==='empty'?controller.enqueue(new Uint8Array()):new Promise(()=>{})}))});
    await assert.rejects(c.rooms.list());
  }
});
