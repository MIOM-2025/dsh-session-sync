import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import assert from 'node:assert';
import { SyncEngine, SESSION_FILE } from '../src/engine.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeLog(lines) { return zlib.zstdCompressSync(Buffer.from(lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8')); }

async function writeSession(home, group, id, title, extra = []) {
  const dir = path.join(home, '.dsh', 'sessions', group, id);
  await fsp.mkdir(dir, { recursive: true });
  const events = [
    { type: 'session', version: 4, id, createdAt: Date.now(), cwd: '/tmp/demo' },
    { type: 'session/title', seq: 1, time: Date.now(), data: { title } },
    ...extra,
  ];
  const bytes = makeLog(events);
  await fsp.writeFile(path.join(dir, SESSION_FILE), bytes);
  return bytes;
}

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-test-'));
const homeA = path.join(root, 'a');
const homeB = path.join(root, 'b');
await fsp.mkdir(homeA, { recursive: true });
await fsp.mkdir(homeB, { recursive: true });

const groupA = '--tmp-demo--';
const idA = 'session-aaaaaaaa-0000-4000-8000-000000000001';
const originalA = await writeSession(homeA, groupA, idA, '第一个会话');

const a = new SyncEngine({ home: homeA, port: 17120, host: '127.0.0.1', intervalMs: 400, manifestMs: 1200, device: 'A' });
const b = new SyncEngine({ home: homeB, port: 17121, host: '127.0.0.1', intervalMs: 400, manifestMs: 1200, device: 'B' });
await a.start();
await b.start();
const shared = 'test-token';
a.state.token = shared;
b.state.token = shared;

// pairing both directions
a.addPeer('127.0.0.1:17121', 'B');
b.addPeer('127.0.0.1:17120', 'A');

// opt-in on A only
await a.setEnabled(idA, true);

const targetB = path.join(homeB, '.dsh', 'sessions', groupA, idA, SESSION_FILE);
let pushed = false;
for (let i = 0; i < 30; i += 1) {
  await sleep(300);
  if (fs.existsSync(targetB)) { pushed = true; break; }
}
assert.ok(pushed, 'B should receive the enabled session');
assert.deepEqual(await fsp.readFile(targetB), originalA, 'B bytes must equal A bytes');
console.log('PASS push: A -> B');

// B must not echo the session back as a new change or lose it
const before = (await fsp.readFile(targetB)).length;
await sleep(1500);
assert.equal((await fsp.readFile(targetB)).length, before, 'B file should stay stable');
console.log('PASS stability after push');

// live update: A rewrites the log, B follows
const updatedA = await writeSession(homeA, groupA, idA, '第一个会话（改）', [{ type: 'user/message', seq: 2, time: Date.now(), data: { text: 'hi' } }]);
let updated = false;
for (let i = 0; i < 30; i += 1) {
  await sleep(300);
  const bytes = await fsp.readFile(targetB);
  if (bytes.equals(updatedA)) { updated = true; break; }
}
assert.ok(updated, 'B should follow the live update');
console.log('PASS live update A -> B');

// reverse direction: new session created on B, opt-in, appears on A
const groupB = '--tmp-other--';
const idB = 'session-bbbbbbbb-0000-4000-8000-000000000002';
const originalB = await writeSession(homeB, groupB, idB, 'B 的会话');
await b.setEnabled(idB, true);
const targetA = path.join(homeA, '.dsh', 'sessions', groupB, idB, SESSION_FILE);
let reversed = false;
for (let i = 0; i < 30; i += 1) {
  await sleep(300);
  if (fs.existsSync(targetA)) { reversed = true; break; }
}
assert.ok(reversed, 'A should receive B enabled session');
assert.deepEqual(await fsp.readFile(targetA), originalB, 'A bytes must equal B bytes');
console.log('PASS push: B -> A');

// opt-out: disable on A, change, B must not change
const beforeOptOut = await fsp.readFile(targetB);
await a.setEnabled(idA, false);
await writeSession(homeA, groupA, idA, '不该同步的名字', [{ type: 'user/message', seq: 3, time: Date.now(), data: { text: 'secret' } }]);
await sleep(2500);
assert.deepEqual(await fsp.readFile(targetB), beforeOptOut, 'opt-out session must not sync');
console.log('PASS opt-out');

// remote manifest only exposes enabled sessions
const manifestA = await (await fetch('http://127.0.0.1:17120/sessions', { headers: { 'x-session-sync-token': shared } })).json();
assert.equal(manifestA.sessions.length, 0, 'A has no enabled sessions now');
assert.equal((await fetch('http://127.0.0.1:17120/sessions', { headers: { 'x-session-sync-token': 'wrong' } })).status, 401, 'bad token rejected');
console.log('PASS manifest + auth');

// state listing
const listA = await a.listLocal();
assert.ok(listA.sessions.some((s) => s.id === idA && s.enabled === false));
assert.ok(listA.remote.length >= 1);
console.log('PASS listLocal', JSON.stringify({ local: listA.sessions.length, peers: listA.peers.length, remoteSessions: listA.remote.map((r) => r.sessions.length) }));

await a.stop();
await b.stop();
await fsp.rm(root, { recursive: true, force: true });
console.log('ALL TESTS PASSED');
