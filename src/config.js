import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { readText, readJson } from './storage.js';
import { ROOM, hash, isId, policyValue, jobValue } from './model.js';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const credentialDirectory = join(root, '.pingroom');
export const jobDirectory = join(root, '.job');

export async function loadEnvironment(env = process.env, path = join(root, '.env')) {
  const externalConnection = env.PINGROOM_TOKEN !== undefined || env.PINGROOM_ROOM !== undefined;
  const text = await readText(path, 16 * 1024);
  if (text !== null) for (const [key, value] of Object.entries(parseEnv(text))) {
    if (externalConnection && ['PINGROOM_TOKEN', 'PINGROOM_ROOM'].includes(key)) continue;
    if (env[key] === undefined) env[key] = value;
  }
}

export function validateConnection(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)
    || typeof raw.token !== 'string' || !/^[^\s\x00-\x1f\x7f]{1,8192}$/.test(raw.token)
    || typeof raw.room !== 'string' || !ROOM.test(raw.room.toUpperCase())) throw new Error('Invalid connection. Set both PINGROOM_TOKEN and PINGROOM_ROOM, or connect first.');
  return { token: raw.token, room: raw.room.toUpperCase() };
}

export async function loadConnection(directory = credentialDirectory, env = process.env) {
  if (env.PINGROOM_TOKEN !== undefined || env.PINGROOM_ROOM !== undefined) {
    return validateConnection({ token: env.PINGROOM_TOKEN, room: env.PINGROOM_ROOM });
  }
  return validateConnection(await readJson(join(directory, 'credentials.json'), 32 * 1024));
}

export async function loadInputs() {
  const policy = await readJson(join(root, 'config.json'), 16384);
  const job = await readJson(join(root, 'job.json'), 65536);
  if (policy === null || job === null) throw new Error('Copy config.example.json to config.json and examples/job.json to job.json, then edit them.');
  return { policy: policyValue(policy), job: jobValue(job) };
}
