import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SyncEngine } from '../src/engine.js';
const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dbg-net-'));
const e = new SyncEngine({ home: root, port: 17170, host: '127.0.0.1', device: 'X' });
await e.start();
console.log('start host', e.host, e.port, (await (await fetch('http://127.0.0.1:17170/ping')).json()).port);
try {
  const mode = await e.setNetwork('local');
  console.log('set local ->', mode, e.host, e.port);
} catch (err) { console.log('setNetwork threw', err); }
await new Promise((r) => setTimeout(r, 300));
for (let i = 0; i < 3; i += 1) {
  try { console.log('ping', i, (await (await fetch('http://127.0.0.1:17170/ping')).json()).app); }
  catch (err) { console.log('ping', i, 'ERR', err.cause?.code ?? err.message); }
  await new Promise((r) => setTimeout(r, 300));
}
try { await e.setNetwork('lan'); console.log('set lan ->', e.host); } catch (err) { console.log('lan threw', err); }
try { console.log('ping after lan', (await (await fetch('http://127.0.0.1:17170/ping')).json()).app); } catch (err) { console.log('ping lan ERR', err.cause?.code ?? err.message); }
await e.stop();
await fsp.rm(root, { recursive: true, force: true });
