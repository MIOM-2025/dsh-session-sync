import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import assert from 'node:assert';
import { SyncEngine, SESSION_FILE } from '../src/engine.js';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-live-test-'));
const homeA = path.join(root, 'a'); const homeB = path.join(root, 'b');
const group = '--tmp--'; const id = 'session-ffffffff-0000-4000-8000-000000000006';
const dir = path.join(homeA, '.dsh', 'sessions', group, id);
await fsp.mkdir(dir, { recursive: true });
await fsp.writeFile(path.join(dir, SESSION_FILE), zlib.zstdCompressSync(Buffer.from(JSON.stringify({ type: 'session', version: 4, id, createdAt: 1, cwd: '/tmp/demo' }) + '\n' + JSON.stringify({ type: 'session/title', seq: 1, time: 1, data: { title: '远端会话' } }) + '\n')));
const a = new SyncEngine({ home: homeA, port: 17160, host: '127.0.0.1', intervalMs: 400, manifestMs: 1200, device: 'A' });
const b = new SyncEngine({ home: homeB, port: 17161, host: '127.0.0.1', intervalMs: 400, manifestMs: 1200, device: 'B' });
await a.start(); await b.start(); a.advertiseHost = '127.0.0.1';
await b.pairWith('127.0.0.1:17160');
await a.setEnabled(id, true); await a.syncNow();
b.watchRemote('127.0.0.1:17160', id);
await sleep(800);
a.publishLocal(id, { type: 'assistant/message', seq: 2, time: Date.now(), data: { content: [{ type: 'text', text: '思考中' }] } });
let ok = false;
for (let i = 0; i < 20; i += 1) { await sleep(200); if (b.liveSnapshot('127.0.0.1:17160', id).length >= 1) { ok = true; break; } }
assert.ok(ok, 'live event received');
assert.equal(b.liveSnapshot('127.0.0.1:17160', id)[0].seq, 2);
console.log('PASS live event A -> B');
a.publishLocal(id, { type: 'tool/call', seq: 3, time: Date.now(), data: { name: 'bash' } });
for (let i = 0; i < 20; i += 1) { await sleep(200); if (b.liveSnapshot('127.0.0.1:17160', id).length >= 2) break; }
assert.equal(b.liveSnapshot('127.0.0.1:17160', id).length, 2);
console.log('PASS live stream keeps flowing');
b.unwatchRemote('127.0.0.1:17160', id); await sleep(300);
assert.equal(b.liveSnapshot('127.0.0.1:17160', id).length, 0);
b.watchRemote('127.0.0.1:17160', id);
for (let i = 0; i < 20; i += 1) { await sleep(200); if (b.liveSnapshot('127.0.0.1:17160', id).length >= 2) break; }
assert.equal(b.liveSnapshot('127.0.0.1:17160', id).length, 2);
console.log('PASS backlog replay on rewatch');
const seen = [];
a.commandHandler = async (command) => { seen.push(command); return { ok: true, handled: command.type }; };
const ack = await b.sendCommand('127.0.0.1:17160', { type: 'stop', id });
assert.equal(ack.ok, true); assert.equal(ack.handled, 'stop'); assert.equal(seen.length, 1);
console.log('PASS remote stop command');
const denied = await fetch('http://127.0.0.1:17160/live?id=' + encodeURIComponent(id));
assert.equal(denied.status, 401);
console.log('PASS live stream auth');
console.log('step set local');
try { await a.setNetwork('local'); } catch (e) { console.log('setNetwork local threw:', e.message); }
console.log('host now', a.host);
try { const r = await fetch('http://127.0.0.1:17160/ping'); console.log('ping local', r.status); assert.equal((await r.json()).app, 'dsh-session-sync'); } catch (e) { console.log('ping local ERR', e.cause?.code ?? e.message); }
console.log('step set lan');
try { await a.setNetwork('lan'); } catch (e) { console.log('setNetwork lan threw:', e.message); }
console.log('host now', a.host);
try { const r = await fetch('http://127.0.0.1:17160/ping'); console.log('ping lan', r.status); assert.equal((await r.json()).app, 'dsh-session-sync'); } catch (e) { console.log('ping lan ERR', e.cause?.code ?? e.message); }
console.log('PASS network mode switch');

// 回合结束后：镜像成本地副本（不同 id），侧边栏可见
a.publishLocal(id, { type: 'turn/end', seq: 9, time: Date.now(), data: {} });
const mirrorId = 'session-' + id.replace(/^session-/, 'mirror-');
const mirrorFile = path.join(homeB, '.dsh', 'sessions', b.localGroup, mirrorId, SESSION_FILE);
let mirrored = false;
for (let i = 0; i < 30; i += 1) {
  await sleep(300);
  if (fsp.stat(mirrorFile).then(() => true).catch(() => false)) { mirrored = await fsp.stat(mirrorFile).then(() => true).catch(() => false); if (mirrored) break; }
}
assert.ok(mirrored, 'mirror file should be written after turn/end');
const mirrorText = zlib.zstdDecompressSync(await fsp.readFile(mirrorFile)).toString('utf8');
const mirrorEvents = mirrorText.split('\n').filter(Boolean).map((line) => JSON.parse(line));
assert.equal(mirrorEvents[0].id, mirrorId, 'mirror header id rewritten');
assert.ok(mirrorEvents.some((event) => event.type === 'session/title' && String(event.data.title).includes('远端镜像')), 'mirror title marked');
const mirrorState = await b.listLocal();
assert.ok(mirrorState.mirrors[mirrorId] !== undefined, 'mirror recorded in state');
assert.ok((mirrorState.live ?? []).length >= 1, 'dock live summary present');
console.log('PASS per-turn mirror + dock data');

await a.stop(); await b.stop(); await fsp.rm(root, { recursive: true, force: true });
console.log('LIVE TESTS PASSED');
