import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { makeClient } from './client.js';
import { readJson, atomicJson, acquireLock } from './storage.js';
import { loadEnvironment, loadConnection, loadInputs, validateConnection, credentialDirectory, jobDirectory } from './config.js';
import { roomValue, isId } from './model.js';
import { runCheckpoint, localStatus } from './engine.js';
const controller = new AbortController();
const stop = () => controller.abort(new Error('Stopped.'));
process.once('SIGINT', stop); process.once('SIGTERM', stop);
async function connect() {
  const release = await acquireLock(credentialDirectory);
  try {
    if (await readJson(join(credentialDirectory, 'credentials.json'), 32 * 1024)) throw new Error('Saved connection already exists; inspect it or archive it deliberately before reconnecting.');
    const client = makeClient({ signal: controller.signal, pairing: true });
    let pending = await readJson(join(credentialDirectory, 'pairing.json'), 64 * 1024);
    if (pending === null) {
      const pairing = await client.auth.startPairing({ agent_label: 'Job control' });
      pending = { pairing, token: client.getToken(), createdAt: Date.now() };
      await atomicJson(credentialDirectory, 'pairing.json', pending, 64 * 1024);
    }
    if (typeof pending.token !== 'string' || !pending.token || !Number.isSafeInteger(pending.createdAt)
      || !Number.isInteger(pending.pairing?.expires_in) || pending.pairing.expires_in < 1 || pending.pairing.expires_in > 3600) throw new Error('Invalid saved pairing; inspect it before reconnecting.');
    const remaining = Math.floor((pending.createdAt + pending.pairing.expires_in * 1000 - Date.now()) / 1000);
    if (remaining <= 0) throw new Error('Saved pairing expired. Remove only .pingroom/pairing.json after confirming it is no longer usable, then reconnect.');
    const url = new URL(pending.pairing.pair_browser_url);
    if (url.origin !== 'https://pingroom.io' || url.username || url.password) throw new Error('Unexpected pairing URL.');
    client.setToken(pending.token);
    console.log('Install PingRoom: https://pingroom.io/i');
    console.log(`Approve the job controller and select your shared private room: ${url.href}`);
    const active = await client.auth.waitForPairing({ ...pending.pairing, expires_in: remaining }, { signal: controller.signal });
    // Save an approved credential before further network checks, so interrupted
    // setup does not force another robot registration.
    const connection = validateConnection({ token: active.credential, room: (active.home_room ?? active.room)?.invite_code });
    await atomicJson(credentialDirectory, 'credentials.json', connection, 32 * 1024);
    await rm(join(credentialDirectory, 'pairing.json'));
    console.log('Saved private credentials. Run npm run inspect, then configure config.json and job.json.');
  } finally { await release(); }
}

async function inspect() {
  const c=await loadConnection(),client=makeClient({token:c.token,signal:controller.signal});
  const room=roomValue(await client.rooms.list(),c.room);
  const actions=await client.actions.list(c.room);
  if (!Array.isArray(actions) || actions.length>16 || actions.some(a=>!isId(a?.id))) throw new Error('Invalid actions.');
  const recent=await client.notifications.list({limit:25});
  if (!Array.isArray(recent?.data) || recent.data.length>25) throw new Error('Invalid recent feed.');
  console.log(JSON.stringify({room:c.room,memberIds:room.members,actions:actions.map(a=>({id:a.id,slot:a.action_number,label:a.label,input_type:a.input_type??'none'})),
    recent:recent.data.filter(e=>e.room?.code===c.room).map(e=>({id:e.id,senderId:e.sender?.id,slot:e.action_number,at:e.created_at,manualHuman:e.trigger_source==='manual'&&e.origin_agent===null&&e.question===null&&e.is_handoff===false}))},null,2));
  console.log('Choose exact UUIDs of OTHER trusted members. Your connecting account own taps are excluded by the feed.');
}
try {
  await loadEnvironment();
  const [command,...rest]=process.argv.slice(2);
  if (rest.length) throw new Error('No extra arguments are supported.');
  if (command==='connect') await connect();
  else if (command==='inspect') await inspect();
  else if (command==='status') console.log(JSON.stringify(await localStatus(jobDirectory),null,2));
  else if (['init','tick'].includes(command)) {
    const c=await loadConnection(),inputs=await loadInputs();
    const result=await runCheckpoint({...c,...inputs,directory:jobDirectory,operation:command,client:makeClient({token:c.token,signal:controller.signal}),signal:controller.signal});
    console.log(JSON.stringify(result,null,2));
    process.exitCode=result.status==='complete'?0:result.status==='cancelled'?2:3;
  } else throw new Error('Use init, start, status, connect or inspect through npm scripts.');
} catch (error) {
  if (controller.signal.aborted) {console.error('Interrupted; committed checkpoints retained.');process.exitCode=130;}
  else {console.error(error.name==='Error' && !('code' in error)?error.message:'Operation failed. Check access, configuration, network and saved state.');process.exitCode=1;}
} finally {process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
