import { createHash } from 'node:crypto';

export const ROOM = /^[A-Z0-9]{12}$/;
export const isId = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
export const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const MAX_EVENTS = 500;
export const MAX_BYTES = 512 * 1024;
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v, keys) => record(v) && Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const slug = v => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(v);
export function stamp(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(v)
    || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString().slice(0,19) !== v.slice(0,19)) throw new Error('Invalid UTC timestamp.');
  return new Date(v).toISOString();
}
export function policyValue(p) {
  const slots = [p?.pauseAction, p?.resumeAction, p?.cancelAction];
  if (!exact(p, ['pauseAction','resumeAction','cancelAction','controllers']) || slots.some(n => !Number.isInteger(n) || n < 1 || n > 16)
    || new Set(slots).size !== 3 || !Array.isArray(p.controllers) || p.controllers.length < 1 || p.controllers.length > 5
    || p.controllers.some(id => !isId(id)) || new Set(p.controllers).size !== p.controllers.length) throw new Error('Use three distinct slots and 1–5 exact controller UUIDs.');
  return { pauseAction:p.pauseAction, resumeAction:p.resumeAction, cancelAction:p.cancelAction, controllers:[...p.controllers].sort() };
}
export function jobValue(j) {
  if (!exact(j, ['runId','items']) || !slug(j.runId) || !Array.isArray(j.items) || j.items.length < 1 || j.items.length > 50
    || j.items.some(i => !exact(i,['id','text']) || !slug(i.id) || typeof i.text !== 'string' || !/^[\x20-\x7e]{1,1000}$/.test(i.text))
    || new Set(j.items.map(i => i.id)).size !== j.items.length) throw new Error('Job requires an immutable run ID and 1–50 unique text items.');
  return structuredClone(j);
}
export function transformItem(item) {
  return { id:item.id, uppercase:item.text.toUpperCase(), inputSha256:createHash('sha256').update(item.text).digest('hex') };
}
export function roomValue(rooms, code, policy) {
  if (!Array.isArray(rooms) || rooms.length > 1000) throw new Error('Invalid room inventory.');
  const matches = rooms.filter(r => r?.invite_code === code), r = matches[0];
  if (matches.length !== 1 || !isId(r.id) || r.type !== 'standard' || r.is_public !== false || !Array.isArray(r.members) || r.members.length > 1000) throw new Error('Use a granted standard private room.');
  const ids = r.members.filter(m => isId(m?.user_id)).map(m => m.user_id);
  if (new Set(ids).size !== ids.length || ids.length < 2 || policy?.controllers.some(id => !ids.includes(id))) throw new Error('Controllers must be members of the shared room.');
  return { id:r.id, members:ids };
}
export function actionBinding(actions, policy) {
  if (!Array.isArray(actions) || actions.length > 16) throw new Error('Invalid action inventory.');
  return [['pause',policy.pauseAction,'Pause'],['resume',policy.resumeAction,'Resume'],['cancel',policy.cancelAction,'Cancel']].map(([kind,slot,label]) => {
    const found = actions.filter(a => a?.action_number === slot), a = found[0];
    if (found.length !== 1 || !isId(a.id) || a.label !== label || ![null,undefined,'none'].includes(a.input_type)) throw new Error('Configure plain Pause, Resume, Cancel actions without required input.');
    return { kind, slot, id:a.id, label };
  });
}
export function batchValue(batch, after) {
  if (!record(batch) || !isId(batch.cursor) || !Array.isArray(batch.notifications) || batch.notifications.length > 50) throw new Error('Invalid notification batch.');
  if (after === undefined) {
    if (batch.notifications.length) throw new Error('Initial cursor must not replay historical controls.');
  } else {
    let last = after;
    for (const e of batch.notifications) {
      if (!record(e) || !isId(e.id) || e.id <= last) throw new Error('Repeated, old, or unordered feed event.');
      last = e.id;
    }
    if (batch.cursor !== last) throw new Error('Feed cursor does not match its events.');
  }
  return batch;
}
function controlRecord(raw, s, observedAt) {
  const binding = s.actions.find(a => a.slot === raw.action_number);
  if (!binding || raw.room?.code !== s.room || !s.policy.controllers.includes(raw.sender?.id)
    || raw.trigger_source !== 'manual' || raw.origin_agent !== null || raw.question !== null || raw.is_handoff !== false) return null;
  const at = stamp(raw.created_at);
  if (Date.parse(at) > Date.parse(observedAt) + 60000) throw new Error('Control timestamp is ahead of the local clock.');
  return { id:raw.id, kind:binding.kind, personId:raw.sender.id, at };
}
export function modeFrom(events) {
  let mode = 'paused';
  for (const e of events) {
    if (mode === 'cancelled') continue;
    mode = e.kind === 'cancel' ? 'cancelled' : e.kind === 'pause' ? 'paused' : 'running';
  }
  return mode;
}
export function stateValue(s) {
  if (!exact(s,['version','job','policy','room','roomId','credentialHash','actions','initialCursor','cursor','startedAt','checkedAt','controls','results'])
    || s.version !== 1 || typeof s.room !== 'string' || !ROOM.test(s.room) || !isId(s.roomId)
    || !/^[a-f0-9]{64}$/.test(s.credentialHash) || !isId(s.initialCursor) || !isId(s.cursor) || s.cursor < s.initialCursor
    || !Array.isArray(s.controls) || s.controls.length > MAX_EVENTS || !Array.isArray(s.results)
    || stamp(s.startedAt) !== s.startedAt || stamp(s.checkedAt) !== s.checkedAt || s.checkedAt < s.startedAt) throw new Error('Invalid job state; restore a valid backup.');
  jobValue(s.job); if (hash(policyValue(s.policy)) !== hash(s.policy)) throw new Error('Invalid saved policy.');
  if (!Array.isArray(s.actions) || s.actions.length !== 3) throw new Error('Invalid saved action binding.');
  for (const [i,kind] of ['pause','resume','cancel'].entries()) {
    const a=s.actions[i];
    if (!exact(a,['kind','slot','id','label']) || a.kind !== kind || a.slot !== s.policy[`${kind}Action`] || !isId(a.id)
      || a.label !== kind[0].toUpperCase()+kind.slice(1)) throw new Error('Invalid saved action binding.');
  }
  if (new Set(s.actions.map(a=>a.id)).size !== 3) throw new Error('Repeated action identity.');
  let last=s.initialCursor;
  for (const e of s.controls) {
    if (!exact(e,['id','kind','personId','at']) || !isId(e.id) || e.id <= last || e.id > s.cursor
      || !['pause','resume','cancel'].includes(e.kind) || !s.policy.controllers.includes(e.personId) || stamp(e.at) !== e.at
      || Date.parse(e.at) > Date.parse(s.checkedAt)+60000) throw new Error('Invalid control evidence.');
    last=e.id;
  }
  if (s.results.length > s.job.items.length) throw new Error('Too many completed units.');
  let previousCursor=s.initialCursor;
  for (const [i,r] of s.results.entries()) {
    if (!exact(r,['output','afterCursor']) || !isId(r.afterCursor) || r.afterCursor < previousCursor || r.afterCursor > s.cursor
      || hash(r.output) !== hash(transformItem(s.job.items[i])) || modeFrom(s.controls.filter(e=>e.id<=r.afterCursor)) !== 'running') throw new Error('Completed work contradicts its checkpoint evidence.');
    previousCursor=r.afterCursor;
  }
  if (Buffer.byteLength(JSON.stringify(s,null,2))+1 > MAX_BYTES) throw new Error('Job state exceeds storage capacity.');
  return s;
}
export function ingest(s, raw, observedAt) {
  stateValue(s);const batch=batchValue(raw,s.cursor), checkedAt=stamp(observedAt);
  if (checkedAt < s.checkedAt) throw new Error('Local clock moved backwards.');
  const controls=batch.notifications.map(e=>controlRecord(e,s,checkedAt)).filter(Boolean);
  return stateValue({...s,cursor:batch.cursor,checkedAt,controls:[...s.controls,...controls]});
}
export function report(s) {
  stateValue(s);
  return {runId:s.job.runId,status:s.results.length===s.job.items.length?'complete':modeFrom(s.controls),completed:s.results.length,total:s.job.items.length,
    remaining:s.job.items.length-s.results.length,lastCheckedAt:s.checkedAt,observedCursor:s.cursor,controlCount:s.controls.length,results:s.results,
    completeFeedHistory:false,instantInterruption:false};
}
