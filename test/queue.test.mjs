import assert from 'node:assert';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SyncEngine } from '../src/engine.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-queue-test-'));
const id = 'session-qqqqqqqq-0000-4000-8000-000000000007';

const executed = [];
let engine;
engine = new SyncEngine({
  home,
  port: 17170,
  host: '127.0.0.1',
  intervalMs: 500,
});
engine.commandHandler = async (command) => {
    executed.push({ type: command.type, text: command.text ?? null, at: Date.now() });
    if (command.type === 'message') {
      engine.markTurn(id, 'start');
      setTimeout(() => engine.markTurn(id, 'end'), 300);
    }
  return { ok: true };
};
await engine.start();

// 第一条：空闲时立即执行
const first = await engine.submitCommand({ id, type: 'message', text: 'one' });
assert.equal(first.queued, true);
await sleep(80);

// 第二条：必须排队
const second = await engine.submitCommand({ id, type: 'message', text: 'two' });
assert.equal(second.queued, true);
assert.ok(second.position >= 1, 'second should be queued behind');
console.log('PASS queued', JSON.stringify({ first: first.position, second: second.position }));

assert.equal(executed.length, 1, 'only one command runs at a time');
assert.equal(executed[0].text, 'one');

// 停止指令不排队，立即执行
await engine.submitCommand({ id, type: 'stop' });
assert.equal(executed.length, 2, 'stop executes immediately');
assert.equal(executed[1].type, 'stop');
console.log('PASS stop bypasses queue');

// 等第一条回合结束，第二条才执行
await sleep(1200);
assert.equal(executed.filter((item) => item.type === 'message').length, 2, 'second message eventually runs');
const messages = executed.filter((item) => item.type === 'message');
assert.deepEqual(messages.map((item) => item.text), ['one', 'two']);
const gap = messages[1].at - messages[0].at;
assert.ok(gap >= 300, 'second must wait for the first turn to finish, gap=' + gap);
console.log('PASS serialized order, gap', gap, 'ms');

// 队列条目在状态里可见
const state = await engine.listLocal();
assert.ok(state.queue !== undefined);
console.log('PASS queue status visible');

// 本机是写者（勾选同步）时，拒绝对方推来的同一会话，避免双向互相覆盖
const zlib = await import('node:zlib');
const bytes = zlib.zstdCompressSync(Buffer.from(JSON.stringify({ type: 'session', version: 4, id, createdAt: 1, cwd: '/tmp/demo' }) + '\n'));
await fsp.mkdir(path.join(home, '.dsh', 'sessions', '--tmp--', id), { recursive: true });
await fsp.writeFile(path.join(home, '.dsh', 'sessions', '--tmp--', id, 'session.v4.jsonl.zstd'), bytes);
await engine.setEnabled(id, true);
const rejected = await engine.install({ id, group: '--tmp--', data: bytes.toString('base64'), hash: '0'.repeat(64), mtime: Date.now() + 5000 }, 'peer');
assert.equal(rejected.skipped, 'local owner');
console.log('PASS single writer guard');

await engine.stop();
await fsp.rm(home, { recursive: true, force: true });
console.log('QUEUE TESTS PASSED');
