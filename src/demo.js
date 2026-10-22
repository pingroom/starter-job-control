import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCheckpoint } from './engine.js';
import { mockSource,JOB,POLICY,TOKEN,ROOM_CODE,NOW } from './mock.js';
const directory=await mkdtemp(join(tmpdir(),'pingroom-control-demo-'));
try {
  const mock=mockSource(),args={client:mock.client,directory,job:JOB,policy:POLICY,token:TOKEN,room:ROOM_CODE,now:()=>NOW};
  const show=r=>console.log(JSON.stringify({status:r.status,completed:r.completed,remaining:r.remaining}));
  show(await runCheckpoint({...args,operation:'init'}));
  mock.add('resume');show(await runCheckpoint(args));
  mock.add('pause');show(await runCheckpoint(args));
  mock.add('resume');show(await runCheckpoint(args));
  mock.add('cancel');show(await runCheckpoint(args));
  mock.add('resume');show(await runCheckpoint(args));
} finally {await rm(directory,{recursive:true,force:true});}
