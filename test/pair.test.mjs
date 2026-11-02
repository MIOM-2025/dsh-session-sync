import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import assert from 'node:assert';
import { SyncEngine, SESSION_FILE } from '../src/engine.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function makeLog(lines) { return zlib.zstdCompressSync(Buffer.from(lines.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8')); }
async function writeSession(home, group, id, title) {
  const dir = path.join(home, '.dsh', 'sessions', group, id);
  await fsp.mkdir(dir, { recursive: true });
  const bytes = makeLog([{ type: 'session', version: 4, id, createdAt: 1, cwd: '/tmp/demo' }, { type: 'session/title', seq: 1, time: 1, data: { title } }]);
  await fsp.writeFile(path.join(dir, SESSION_FILE), bytes);
  return bytes;
}

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-pair-test-'));
const homeA = path.join(root, 'a');
const homeB = path.join(root, 'b');
const groupB = '--tmp-b--';
const idB = 'session-cccccccc-0000-4000-8000-000000000003';
const bytesB = await writeSession(homeB, groupB, idB, 'B 共享的会话');

const a = new SyncEngine({ home: homeA, port: 17150, host: '127.0.0.1', intervalMs: 400, manifestMs: 1200, device: 'A' });
const b = new SyncEngine({ home: homeB, port: 17151, host: '127.0.0.1', intervalMs: 400, manifestMs: 1200, device: 'B' });
await a.start();
await b.start();
a.advertiseHost = '127.0.0.1';
assert.notEqual(a.state.token, b.state.token, 'tokens start different');

const paired = await a.pairWith('127.0.0.1:17151');
assert.equal(paired.device, 'B');
assert.equal(a.state.peers.length, 1);
assert.equal(a.state.peers[0].token, b.state.token, 'A learnt B token');
assert.equal(b.state.peers.length, 1);
assert.equal(b.state.peers[0].token, a.state.token, 'B learnt A token');
console.log('PASS pair both directions');

// B turns on sharing only after pairing, then A pulls it once by hand
await b.setEnabled(idB, true);
await b.syncNow();
let target = path.join(homeA, '.dsh', 'sessions', groupB, idB, SESSION_FILE);
let got = false;
for (let i = 0; i < 20; i += 1) {
  await sleep(300);
  if (fs.existsSync(target)) { got = true; break; }
}
assert.ok(got, 'A should receive B shared session after pairing');
assert.deepEqual(await fsp.readFile(target), bytesB);
console.log('PASS A receives B session');

// opt out of pairing on B: another engine must not pair
const c = new SyncEngine({ home: path.join(root, 'c'), port: 17152, host: '127.0.0.1', device: 'C' });
await c.start();
await fsp.mkdir(path.join(root, 'c'), { recursive: true });
b.state.allowPair = false;
await assert.rejects(() => c.pairWith('127.0.0.1:17151'), /pair rejected|403/);
console.log('PASS pairing can be refused');

await a.stop(); await b.stop(); await c.stop();
await fsp.rm(root, { recursive: true, force: true });
console.log('PAIR TESTS PASSED');
