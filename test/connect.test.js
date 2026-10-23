import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, symlink, writeFile, readFile, rm, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('..', import.meta.url));
// The actual CLI and pinned SDK run in an isolated copy. No fetch falls through
// to the network, including unexpected routes.
const preload = `
import { appendFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
globalThis.fetch = async (input, init) => {
  const url = new URL(input), path = url.pathname;
  if (url.origin !== 'https://api.pingroom.io') throw new Error('Unexpected mock origin');
  appendFileSync(process.env.PROBE_LOG, JSON.stringify({ run: process.env.PROBE_RUN, method: init.method, path }) + '\\n');
  if (path === '/api/agent/auth' && init.method === 'POST') {
    if (process.env.PROBE_MODE === 'inspect-intent') {
      const intent = JSON.parse(await readFile('.pingroom/pairing.json', 'utf8'));
      if (intent.phase !== 'creating' || ((await stat('.pingroom/pairing.json')).mode & 0o777) !== 0o600) throw new Error('No private intent before registration');
    }
    if (process.env.PROBE_MODE === 'lost-register') throw new Error('Registration created but response lost');
    return Response.json({ credential: 'offline-pending-token', credential_type: 'pre_claim', expires_in: 900 });
  }
  if (path === '/api/agent/auth/pair/start' && init.method === 'POST') {
    if (process.env.PROBE_MODE === 'lost-pair') throw new Error('Pairing created but response lost');
    return Response.json({ pair_browser_url: 'https://pingroom.io/claim/offline', pair_url: 'https://pingroom.io/claim/offline', expires_in: 900, poll_interval_ms: 1000 });
  }
  if (path === '/api/agent/auth/pair/status' && init.method === 'GET') {
    if (new Headers(init.headers).get('authorization') !== 'Bearer offline-pending-token') throw new Error('Wrong pending credential');
    if (process.env.PROBE_MODE === 'interrupt') {
      setTimeout(() => process.kill(process.pid, 'SIGINT'), 1);
      return Response.json({ status: 'pending' });
    }
    return Response.json({ status: 'active', credential: 'offline-approved-token', credential_type: 'active', expires_in: null, home_room: { invite_code: 'CTRLROOM0001' } });
  }
  throw new Error('Unexpected mock route');
};
`;

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'job-control-connect-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(join(source, 'src'), join(directory, 'src'), { recursive: true });
  await cp(join(source, 'package.json'), join(directory, 'package.json'));
  await symlink(join(source, 'node_modules'), join(directory, 'node_modules'));
  await writeFile(join(directory, 'preload.mjs'), preload);
  return directory;
}
async function run(t, directory, mode, runId = mode) {
  const env = { ...process.env, PROBE_MODE: mode, PROBE_RUN: runId, PROBE_LOG: join(directory, 'requests.jsonl') };
  for (const key of ['NODE_OPTIONS', 'PINGROOM_TOKEN', 'PINGROOM_ROOM', 'CI']) delete env[key];
  const child = spawn(process.execPath, ['--import', join(directory, 'preload.mjs'), join(directory, 'src/cli.js'), 'connect'], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await done; });
  return done;
}
async function requests(directory) {
  try { return (await readFile(join(directory, 'requests.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
const pairingPath = directory => join(directory, '.pingroom', 'pairing.json');

for (const mode of ['lost-register', 'lost-pair']) test(`${mode} preserves uncertain creation and retry never registers again`, async t => {
  const directory = await fixture(t);
  assert.equal((await run(t, directory, mode)).code, 1);
  const saved = await readFile(pairingPath(directory), 'utf8');
  assert.equal(JSON.parse(saved).phase, 'creating');
  assert.equal((await stat(pairingPath(directory))).mode & 0o777, 0o600);
  assert.equal((await stat(join(directory, '.pingroom'))).mode & 0o777, 0o700);
  await assert.rejects(stat(join(directory, '.pingroom', '.lock')), { code: 'ENOENT' });
  const retry = await run(t, directory, 'active', 'retry');
  assert.equal(retry.code, 1); assert.match(retry.stderr, /uncertain/);
  assert.equal((await requests(directory)).filter(r => r.run === 'retry').length, 0);
  assert.equal(await readFile(pairingPath(directory), 'utf8'), saved);
});

test('private creation intent is readable before the actual SDK registration POST', async t => {
  const directory = await fixture(t), result = await run(t, directory, 'inspect-intent');
  assert.equal(result.code, 0, result.stderr);
  assert.equal((await requests(directory)).filter(r => r.path === '/api/agent/auth').length, 1);
  assert.equal(JSON.parse(await readFile(join(directory, '.pingroom', 'credentials.json'), 'utf8')).token, 'offline-approved-token');
});

test('known pending pairing resumes after SIGINT without another registration', async t => {
  const directory = await fixture(t);
  assert.equal((await run(t, directory, 'interrupt')).code, 130);
  const saved = JSON.parse(await readFile(pairingPath(directory), 'utf8'));
  assert.equal(saved.token, 'offline-pending-token');
  const result = await run(t, directory, 'active', 'retry');
  assert.equal(result.code, 0, result.stderr);
  const calls = await requests(directory);
  assert.equal(calls.filter(r => r.path === '/api/agent/auth').length, 1);
  assert.equal(calls.filter(r => r.path === '/api/agent/auth/pair/start').length, 1);
  assert.ok(calls.filter(r => r.run === 'retry').every(r => r.method === 'GET'));
  await assert.rejects(readFile(pairingPath(directory)), { code: 'ENOENT' });
});

test('existing credential and job state remain unchanged without setup API calls', async t => {
  const directory = await fixture(t);
  await mkdir(join(directory, '.pingroom')); await mkdir(join(directory, '.job'));
  const credential = JSON.stringify({ token: 'offline-existing-token', room: 'CTRLROOM0001' });
  const state = '{"preserve":"existing-job-evidence"}';
  await writeFile(join(directory, '.pingroom', 'credentials.json'), credential);
  await writeFile(join(directory, '.job', 'state.json'), state);
  const result = await run(t, directory, 'active');
  assert.equal(result.code, 1); assert.match(result.stderr, /already exists/);
  assert.deepEqual(await requests(directory), []);
  assert.equal(await readFile(join(directory, '.pingroom', 'credentials.json'), 'utf8'), credential);
  assert.equal(await readFile(join(directory, '.job', 'state.json'), 'utf8'), state);
});
