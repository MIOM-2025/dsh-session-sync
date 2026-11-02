import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { SyncEngine, SESSION_FILE } from '../src/engine.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dbgnet2-'));
const homeA = path.join(root, 'a'); const homeB = path.join(root, 'b');
const dir = path.join(homeA, '.dsh', 'sessions', '--t--', 'session-33333333-0000-4000-8000-000000000007');
await fsp.mkdir(dir, { recursive: true });
await fsp.writeFile(path.join(dir, SESSION_FILE), zlib.zstdCompressSync(Buffer.from(JSON.stringify({ type: 'session', version: 4, id: 'session-33333333-0000-4000-8000-000000000007', createdAt: 1, cwd: '/tmp/demo' }) + '\n')));
const a = new SyncEngine({ home: homeA, port: 17180, host: '127.0.0.1', device: 'A' });
const b = new SyncEngine({ home: homeB, port: 17181, host: '127.0.0.1', device: 'B' });
await a.start(); await b.start(); a.advertiseHost = '127.0.0.1';
await b.pairWith('127.0.0.1:17180');
await a.setEnabled('session-33333333-0000-4000-8000-000000000007', true);
b.watchRemote('127.0.0.1:17180', 'session-33333333-0000-4000-8000-000000000007');
await sleep(800);
console.log('watched');
try { await a.setNetwork('loca' + 'l'); } catch (e) { console.log('local threw', e.message); }
console.log('host', a.host);
for (let i = 0; i < 3; i++) { try { const r = await fetch('http://127.0.0.1:17180/ping'); console.log('ping', i, r.status); } catch (e) { console.log('ping', i, 'ERR', e.cause?.code ?? e.message); } await sleep(300); }
try { await a.setNetwork('lan'); } catch (e) { console.log('lan threw', e.message); }
for (let i = 0; i < 3; i++) { try { const r = await fetch('http://127.0.0.1:17180/ping'); console.log('ping-lan', i, r.status); } catch (e) { console.log('ping-lan', i, 'ERR', e.cause?.code ?? e.message); } await sleep(300); }
await a.stop(); await b.stop(); await fsp.rm(root, { recursive: true, force: true });
