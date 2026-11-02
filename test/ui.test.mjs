import assert from 'node:assert';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { apply } from '../index.js';

const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-ui-test-'));
process.env.DSH_HOME = home;
const sessionDir = path.join(home, '.dsh', 'sessions', '--tmp--', 'session-dddddddd-0000-4000-8000-000000000004');
await fsp.mkdir(sessionDir, { recursive: true });
const zlib = await import('node:zlib');
await fsp.writeFile(path.join(sessionDir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(JSON.stringify({ type: 'session', version: 4, id: 'session-dddddddd-0000-4000-8000-000000000004', createdAt: 1, cwd: '/tmp/demo' }) + '\n' + JSON.stringify({ type: 'session/title', seq: 1, time: 1, data: { title: '面板测试会' } }) + '\n')));

const routes = [];
const tools = [];
const warnings = [];
const ctx = {
  logger: { info: () => {}, warn: (message) => warnings.push(String(message)) },
  effect: () => {},
  provide: () => {},
  on: () => {},
  webServer: { register: (route) => { routes.push(route); return () => {}; } },
  tools: { register: (tool) => tools.push(tool) },
};
apply(ctx, { port: 17170, host: '127.0.0.1', intervalMs: 500 });
await new Promise((resolve) => setTimeout(resolve, 600));

assert.equal(routes.length, 1, 'one panel route registered');
assert.equal(routes[0].path, '/session-sync');
assert.equal(routes[0].kind, 'prefix');
assert.equal(tools.length, 1, 'session_sync tool registered');
assert.equal(tools[0].name, 'session_sync');
assert.deepEqual(warnings, []);

function invoke(method, pathname, payload) {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))];
    const req = Readable.from(body);
    req.method = method;
    req.url = pathname;
    req.headers = {};
    const res = {
      headersSent: false,
      writeHead(code) { this.status = code; return this; },
      end(text) {
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
        resolve({ status: this.status, body: parsed });
      },
    };
    try { routes[0].handler(req, res); } catch (error) { reject(error); }
  });
}

const state = await invoke('GET', '/session-sync/api/state');
assert.equal(state.status, 200);
assert.equal(typeof state.body.token, 'string');
assert.ok(Array.isArray(state.body.sessions));
assert.equal(state.body.sessions.length, 1, 'engine sees the session dir');
assert.equal(state.body.sessions[0].enabled, false);
console.log('PASS panel state');

const toggled = await invoke('POST', '/session-sync/api/toggle', { id: state.body.sessions[0].id, enabled: true });
assert.equal(toggled.status, 200);
assert.equal(toggled.body.sync, true);
const after = await invoke('GET', '/session-sync/api/state');
assert.equal(after.body.sessions[0].enabled, true);
console.log('PASS panel toggle');

const settings = await invoke('POST', '/session-sync/api/settings', { autoSync: false, allowPair: false, pairCode: '1234' });
assert.equal(settings.status, 200);
const afterSettings = await invoke('GET', '/session-sync/api/state');
assert.equal(afterSettings.body.autoSync, false);
assert.equal(afterSettings.body.allowPair, false);
assert.equal(afterSettings.body.pairCode, '1234');
console.log('PASS panel settings');

assert.equal((await invoke('POST', '/session-sync/api/pull', { id: 'session-x', url: 'http://nope' })).status, 404);
assert.equal((await invoke('GET', '/session-sync/api/nope')).status, 404);
console.log('PASS panel 404s');

const sync = await invoke('POST', '/session-sync/api/sync', {});
assert.equal(sync.status, 200);
assert.ok(Array.isArray(sync.body.sessions));
console.log('PASS panel sync');

// tool executes real actions
const toolResult = await tools[0].execute({ action: 'status' }, { signal: new AbortController().signal });
assert.equal(toolResult.ok, true);
assert.match(toolResult.summary, /监听 :17170/);
const listResult = await tools[0].execute({ action: 'list' }, { signal: new AbortController().signal });
assert.equal(listResult.ok, true);
console.log('PASS tool actions');

// client bundle loads under the module loader contract
const clientSource = await fsp.readFile(new URL('../client.js', import.meta.url), 'utf8');
let exported;
const React = {
  createElement: (...args) => ({ args }),
  useState: (value) => [value, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
};
const sandbox = {
  window: { __ModuleLoader__: { load: ({ id, factory }) => { assert.equal(id, 'dsh-session-sync'); exported = factory((name) => { assert.equal(name, 'react'); return React; }); } } },
  navigator: {},
  setInterval: () => 0,
  clearInterval: () => {},
  fetch: async () => ({ ok: true, json: async () => ({}) }),
  console,
};
const vm = await import('node:vm');
vm.createContext(sandbox);
vm.runInContext(clientSource, sandbox);
assert.equal(typeof exported.apply, 'function');
assert.deepEqual(exported.inject, ['slots']);
let section;
const clientCtx = { slots: { inject: (name, register) => { assert.equal(name, 'settings.section'); register(); }, register: (decl, component) => { assert.equal(decl.id, 'session-sync'); section = component; return () => {}; } } };
exported.apply(clientCtx);
assert.equal(typeof section, 'function');
console.log('PASS client bundle');

await ctx.sessionSync.stop();
await fsp.rm(home, { recursive: true, force: true });
console.log('UI TESTS PASSED');
