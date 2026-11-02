import assert from 'node:assert';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { apply } from '../index.js';

const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-port-test-'));
process.env.DSH_HOME = home;
const sessionDir = path.join(home, '.dsh', 'sessions', '--tmp--', 'session-eeeeeeee-0000-4000-8000-000000000005');
await fsp.mkdir(sessionDir, { recursive: true });
const zlib = await import('node:zlib');
await fsp.writeFile(path.join(sessionDir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(
  JSON.stringify({ type: 'session', version: 4, id: 'session-eeeeeeee-0000-4000-8000-000000000005', createdAt: 1, cwd: '/tmp/demo' }) + '\n' +
  JSON.stringify({ type: 'session/title', seq: 1, time: 1, data: { title: '1111 端口测试' } }) + '\n')));

const ctx = {
  logger: { info: () => {}, warn: (m) => console.log('WARN', m) },
  effect: () => {}, provide: () => {}, on: () => {},
  webServer: { register: (route) => { ctx.route = route; return () => {}; } },
  tools: { register: () => {} },
  inject: (names, callback) => callback(ctx),
  reflect: { get: (name) => (name === 'webServer' ? ctx.webServer : name === 'tools' ? ctx.tools : undefined) },
};
apply(ctx, { port: 1111, host: '0.0.0.0', intervalMs: 1000 });
await new Promise((resolve) => setTimeout(resolve, 700));

const ping = await (await fetch('http://127.0.0.1:1111/ping')).json();
assert.equal(ping.app, 'dsh-session-sync');
assert.equal(ping.port, 1111);
console.log('PASS engine listening on 1111:', JSON.stringify(ping));

const state = await new Promise((resolve, reject) => {
  const req = Readable.from([]);
  req.method = 'GET';
  req.url = '/session-sync/api/state';
  req.headers = {};
  const res = { writeHead(code) { this.status = code; return this; }, end(text) { resolve(JSON.parse(text)); } };
  try { ctx.route.handler(req, res); } catch (error) { reject(error); }
});
assert.equal(state.port, 1111);
assert.equal(state.sessions.length, 1);
assert.equal(state.sessions[0].title, '1111 端口测试');
console.log('PASS panel reports port', state.port, 'session title', state.sessions[0].title);

await ctx.sessionSync.stop();
await fsp.rm(home, { recursive: true, force: true });
console.log('SMOKE PASSED');
