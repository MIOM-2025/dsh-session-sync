import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

export const SESSION_FILE = 'session.v4.jsonl.zstd';
export const APP_ID = 'dsh-session-sync';
const MAX_BODY = 256 * 1024 * 1024;
const MAX_EVENTS = 120;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

export function normalizeUrl(raw) {
  let url = String(raw ?? '').trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
  return url.replace(/\/+$/, '');
}

function safeGroup(group) {
  const name = path.basename(String(group ?? '').trim() || '--synced--');
  return name.replace(/[/\\]/g, '_') || '--synced--';
}

function decodeMeta(bytes) {
  const meta = {};
  if (typeof zlib.zstdDecompressSync !== 'function') return meta;
  let text;
  try { text = zlib.zstdDecompressSync(bytes).toString('utf8'); } catch { return meta; }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event;
    try { event = JSON.parse(trimmed); } catch { continue; }
    if (event.type === 'session' && typeof event.cwd === 'string') meta.cwd = event.cwd;
    if (event.type === 'session/title' && typeof event.data?.title === 'string') meta.title = event.data.title;
  }
  return meta;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export class SyncEngine {
  constructor(options = {}) {
    this.home = options.home ?? os.homedir();
    this.sessionsRoot = path.join(this.home, '.dsh', 'sessions');
    this.stateDir = path.join(this.home, '.dsh', 'session-sync');
    this.stateFile = path.join(this.stateDir, 'state.json');
    this.port = Number(options.port ?? 6120);
    this.host = options.host ?? '0.0.0.0';
    this.device = options.device ?? os.hostname();
    this.intervalMs = Math.max(500, Number(options.intervalMs ?? 2000));
    this.manifestEvery = Math.max(1, Math.round(Number(options.manifestMs ?? 10000) / this.intervalMs));
    this.log = typeof options.log === 'function' ? options.log : () => {};
    this.state = null;
    this.server = null;
    this.timer = null;
    this.ticks = 0;
    this.busy = false;
    this.hashes = new Map();
    this.remote = new Map();
    this.stopFlag = false;
    this.saveTimer = null;
    this.installHooks = [];
    this.live = null;
    this.commandHandler = null;
    this.network = this.host === '127.0.0.1' || this.host === 'localhost' ? 'local' : 'lan';
  }

  defaultState() {
    return {
      version: 1,
      device: this.device,
      port: this.port,
      token: crypto.randomBytes(16).toString('hex'),
      autoSync: true,
      allowPair: true,
      pairCode: '',
      peers: [],
      sessions: {},
      events: [],
    };
  }

  async load() {
    await fsp.mkdir(this.stateDir, { recursive: true });
    let raw;
    try { raw = JSON.parse(await fsp.readFile(this.stateFile, 'utf8')); } catch { raw = null; }
    this.state = { ...this.defaultState(), ...(raw ?? {}) };
    this.state.sessions = this.state.sessions ?? {};
    this.state.peers = (Array.isArray(this.state.peers) ? this.state.peers : [])
      .map((peer) => ({ url: normalizeUrl(peer.url), name: peer.name ?? '', token: peer.token }))
      .filter((peer) => peer.url.length > 0);
    if (!Array.isArray(this.state.events)) this.state.events = [];
    this.device = this.state.device || this.device;
    this.port = Number(this.state.port || this.port);
  }

  save() {
    if (this.saveTimer !== null) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush().catch((error) => this.log('state save failed: ' + String(error)));
    }, 300);
    this.saveTimer.unref?.();
  }

  async flush() {
    const tmp = this.stateFile + '.tmp';
    const body = JSON.stringify(this.state, null, 2);
    await fsp.writeFile(tmp, body);
    await fsp.rename(tmp, this.stateFile);
  }

  record(text) {
    this.state.events.push({ at: Date.now(), text });
    if (this.state.events.length > MAX_EVENTS) this.state.events.splice(0, this.state.events.length - MAX_EVENTS);
  }

  async start() {
    await this.load();
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        this.log('request failed: ' + String(error));
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(error?.message ?? error) }));
      });
    });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => resolve());
    });
    this.port = this.server.address().port;
    this.state.port = this.port;
    this.save();
    this.timer = setInterval(() => { this.tick(); }, this.intervalMs);
    this.timer.unref?.();
    this.record('listening on ' + this.host + ':' + this.port);
    const { LiveRelay } = await import('./live.js');
    this.live = new LiveRelay(this, {
      getSharedIds: () => this.enabledIds(),
      onCommand: (command) => this.handleCommand(command),
      onRemoteEvent: (id, event) => this.remoteEventHook?.(id, event),
      log: (message) => this.log(message),
    });
    return this;
  }

  async stop() {
    this.stopFlag = true;
    this.live?.close();
    if (this.timer !== null) { clearInterval(this.timer); this.timer = null; }
    if (this.server !== null) {
      const closing = this.server;
      await new Promise((resolve) => {
        closing.close(() => resolve());
        closing.closeAllConnections?.();
      });
      this.server = null;
    }
    if (this.saveTimer !== null) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    await this.flush().catch(() => {});
    return this;
  }

  peerUrlSet() { return new Set(this.state.peers.map((peer) => peer.url)); }

  scanSessions() {
    const out = [];
    let groups;
    try { groups = fs.readdirSync(this.sessionsRoot, { withFileTypes: true }); } catch { return out; }
    for (const group of groups) {
      if (!group.isDirectory()) continue;
      const groupDir = path.join(this.sessionsRoot, group.name);
      let entries;
      try { entries = fs.readdirSync(groupDir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith('session-')) continue;
        const file = path.join(groupDir, entry.name, SESSION_FILE);
        let stat;
        try { stat = fs.statSync(file); } catch { continue; }
        out.push({ id: entry.name, group: group.name, file, size: stat.size, mtime: stat.mtimeMs });
      }
    }
    out.sort((a, b) => b.mtime - a.mtime);
    return out;
  }

  async describe(session, withBytes = false) {
    const cached = this.hashes.get(session.id);
    if (cached && cached.mtime === session.mtime && cached.size === session.size && cached.group === session.group) {
      if (!withBytes || cached.bytes !== undefined) return cached;
    }
    const bytes = await fsp.readFile(session.file);
    const meta = decodeMeta(bytes);
    const record = {
      id: session.id,
      group: session.group,
      file: session.file,
      mtime: session.mtime,
      size: session.size,
      hash: sha256(bytes),
      title: meta.title ?? (this.state.sessions[session.id]?.title ?? ''),
      cwd: meta.cwd ?? (this.state.sessions[session.id]?.cwd ?? ''),
      bytes: withBytes ? bytes : undefined,
    };
    this.hashes.set(session.id, record);
    return record;
  }

  enabledIds() {
    return Object.keys(this.state.sessions).filter((id) => this.state.sessions[id]?.sync === true);
  }

  async listLocal({ withRemote = true } = {}) {
    const sessions = [];
    for (const raw of this.scanSessions()) {
      const record = await this.describe(raw);
      const st = this.state.sessions[raw.id] ?? {};
      sessions.push({
        id: raw.id,
        group: raw.group,
        title: record.title || st.title || '',
        cwd: record.cwd || st.cwd || '',
        size: raw.size,
        mtime: raw.mtime,
        hash: record.hash,
        enabled: st.sync === true,
        lastPushedHash: st.lastHash ?? null,
        lastSyncAt: st.lastSyncAt ?? null,
      });
    }
    const result = { device: this.state.device, port: this.port, token: this.state.token, network: this.network, host: this.host, autoSync: this.state.autoSync !== false, allowPair: this.state.allowPair !== false, pairCode: this.state.pairCode ?? '', lanAddress: this.lanAddress(), sessions };
    if (withRemote) {
      result.peers = this.state.peers.map((peer) => ({ url: peer.url, name: peer.name, ok: peer.ok === true, lastSeen: peer.lastSeen ?? null, error: peer.error ?? null }));
      result.remote = [...this.remote.entries()].map(([url, value]) => ({ url, ok: value.ok, at: value.at, sessions: value.sessions }));
    }
    return result;
  }

  async setEnabled(id, enabled) {
    if (typeof id !== 'string' || !id.startsWith('session-')) throw new Error('invalid session id');
    const st = this.state.sessions[id] ?? {};
    this.state.sessions[id] = { ...st, sync: enabled === true, blocked: enabled !== true };
    if (enabled === true) {
      delete this.state.sessions[id].lastHash;
      const raw = this.scanSessions().find((session) => session.id === id);
      if (raw) {
        const record = await this.describe(raw);
        this.state.sessions[id].title = record.title;
        this.state.sessions[id].cwd = record.cwd;
      }
    }
    this.record((enabled ? 'enabled ' : 'disabled ') + id);
    this.save();
    if (enabled) this.tick();
    return this.state.sessions[id];
  }

  addPeer(rawUrl, name = '', token) {
    const url = normalizeUrl(rawUrl);
    if (!url) throw new Error('empty peer url');
    if (!this.peerUrlSet().has(url)) {
      this.state.peers.push({ url, name, token });
      this.record('added peer ' + url);
      this.save();
      this.tick();
    }
    return this.state.peers;
  }

  removePeer(rawUrl) {
    const url = normalizeUrl(rawUrl);
    this.state.peers = this.state.peers.filter((peer) => peer.url !== url);
    this.remote.delete(url);
    this.record('removed peer ' + url);
    this.save();
  }

  authOk(req) {
    const header = req.headers['x-session-sync-token'];
    const token = Array.isArray(header) ? header[0] : header;
    if (typeof token !== 'string' || token.length === 0) return false;
    if (token === this.state.token) return true;
    return this.state.peers.some((peer) => typeof peer.token === 'string' && peer.token === token);
  }

  lanAddress() {
    const interfaces = os.networkInterfaces();
    for (const entries of Object.values(interfaces)) {
      for (const entry of entries ?? []) {
        if (entry && entry.family === 'IPv4' && entry.internal === false) return entry.address;
      }
    }
    return '127.0.0.1';
  }

  async pairWith(rawUrl) {
    const url = normalizeUrl(rawUrl);
    if (!url) throw new Error('empty peer url');
    const ping = await fetch(url + '/ping').then((response) => response.json());
    if (ping.app !== APP_ID) throw new Error('not a dsh-session-sync peer');
    const response = await fetch(url + '/pair-request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'http://' + (this.advertiseHost || this.lanAddress()) + ':' + this.port, device: this.state.device, token: this.state.token, code: this.state.pairCode ?? '' }),
    });
    if (!response.ok) throw new Error('pair rejected: HTTP ' + response.status);
    const data = await response.json();
    this.addPeer(url, data.device ?? ping.device ?? '', data.token);
    this.record('paired with ' + (data.device ?? url));
    return { url, device: data.device ?? ping.device };
  }

  setToken(token) {
    const value = String(token ?? '').trim();
    if (value.length < 8) throw new Error('token too short');
    this.state.token = value;
    this.record('token updated');
    this.save();
    return this.state.token;
  }

  async handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://sync.invalid');
    const json = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    if (url.pathname === '/ping') {
      return json(200, { app: APP_ID, device: this.state.device, port: this.port, time: Date.now() });
    }
    if (url.pathname === '/pair-request' && req.method === 'POST') {
      if (this.state.allowPair === false) return json(403, { error: 'pairing disabled' });
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      if (this.state.pairCode && body.code !== this.state.pairCode) return json(403, { error: 'bad pair code' });
      const peerUrl = normalizeUrl(body.url ?? '');
      if (peerUrl) this.addPeer(peerUrl, body.device ?? '', body.token);
      this.record('paired with ' + (body.device ?? peerUrl));
      return json(200, { app: APP_ID, device: this.state.device, port: this.port, token: this.state.token });
    }

    if (!this.authOk(req)) return json(401, { error: 'bad token' });

    if (url.pathname === '/live' && req.method === 'GET') {
      await this.live.serve(req, res, url);
      return;
    }

    if (url.pathname === '/command' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      return json(200, await this.handleCommand(body));
    }

    if (url.pathname === '/sessions' && req.method === 'GET') {
      const out = [];
      for (const raw of this.scanSessions()) {
        const st = this.state.sessions[raw.id];
        if (!st || st.sync !== true) continue;
        const record = await this.describe(raw);
        out.push({ id: raw.id, group: raw.group, title: record.title, cwd: record.cwd, size: raw.size, mtime: raw.mtime, hash: record.hash });
      }
      return json(200, { device: this.state.device, port: this.port, sessions: out });
    }

    if (url.pathname === '/session' && req.method === 'GET') {
      const id = url.searchParams.get('id') ?? '';
      const raw = this.scanSessions().find((session) => session.id === id);
      if (!raw) return json(404, { error: 'not found' });
      const st = this.state.sessions[id];
      if (!st || st.sync !== true) return json(403, { error: 'not shared' });
      const record = await this.describe(raw, true);
      return json(200, { id, group: raw.group, title: record.title, cwd: record.cwd, size: raw.size, mtime: raw.mtime, hash: record.hash, data: record.bytes.toString('base64') });
    }

    if (url.pathname === '/push' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const accepted = [];
      for (const item of Array.isArray(body.sessions) ? body.sessions : []) {
        const outcome = await this.install(item, body.device ?? url.host);
        accepted.push({ id: item?.id, ...outcome });
      }
      return json(200, { ok: true, accepted });
    }

    return json(404, { error: 'unknown route' });
  }

  async install(item, from) {
    if (!item || typeof item.id !== 'string' || !item.id.startsWith('session-')) return { skipped: 'bad id' };
    if (typeof item.data !== 'string') return { skipped: 'no data' };
    const st = this.state.sessions[item.id] ?? {};
    if (st.blocked === true) return { skipped: 'opted out' };
    let bytes;
    try { bytes = Buffer.from(item.data, 'base64'); } catch { return { skipped: 'bad base64' }; }
    const hash = item.hash ?? sha256(bytes);
    if (sha256(bytes) !== hash) return { skipped: 'hash mismatch' };
    const group = safeGroup(item.group);
    const dir = path.join(this.sessionsRoot, group, item.id);
    const file = path.join(dir, SESSION_FILE);
    let localMtime = 0;
    let localHash = null;
    try {
      localMtime = (await fsp.stat(file)).mtimeMs;
      localHash = (await this.describe({ id: item.id, group, file, size: 0, mtime: localMtime })).hash;
    } catch {}
    if (localHash === hash) return { unchanged: true };
    const incomingMtime = Number(item.mtime ?? Date.now());
    if (localHash !== null && localMtime > incomingMtime + 1000 && st.lastHash !== localHash) {
      this.record('conflict kept local ' + item.id + ' from ' + from);
      return { conflict: 'kept local' };
    }
    await fsp.mkdir(dir, { recursive: true });
    const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
    await fsp.writeFile(tmp, bytes);
    await fsp.rename(tmp, file);
    const mtime = new Date(incomingMtime);
    await fsp.utimes(file, mtime, mtime).catch(() => {});
    this.hashes.set(item.id, { id: item.id, group, file, mtime: incomingMtime, size: bytes.length, hash, title: item.title ?? '', cwd: item.cwd ?? '', bytes: undefined });
    this.state.sessions[item.id] = {
      ...st,
      sync: st.sync === true,
      blocked: st.blocked === true,
      follow: true,
      title: item.title ?? st.title ?? '',
      cwd: item.cwd ?? st.cwd ?? '',
      lastHash: hash,
      lastSyncAt: Date.now(),
    };
    this.record('installed ' + item.id + ' from ' + from);
    this.save();
    for (const hook of this.installHooks) {
      try { await hook({ id: item.id, group, file, from }); } catch (error) { this.log('install hook failed: ' + String(error)); }
    }
    return { installed: true };
  }

  async fetchWithRetry(run, attempts = 3) {
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try { return await run(); } catch (error) {
        lastError = error;
        const code = error?.cause?.code ?? error?.code ?? '';
        if (!/UND_ERR_SOCKET|ECONNRESET|other side closed|EPIPE/.test(String(code)) && !/other side closed/.test(String(error?.message))) throw error;
        await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
      }
    }
    throw lastError;
  }

  async postJson(peer, pathname, payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(peer.url + pathname, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-session-sync-token': peer.token ?? this.state.token },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async getJson(peer, pathname) {
    return this.fetchWithRetry(async () => this.getJsonOnce(peer, pathname));
  }

  async getJsonOnce(peer, pathname) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(peer.url + pathname, {
        headers: { 'x-session-sync-token': peer.token ?? this.state.token },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  markPeer(peer, ok, error) {
    peer.ok = ok;
    peer.error = ok ? null : String(error ?? 'unreachable');
    if (ok) peer.lastSeen = Date.now();
  }

  tokenFor(rawUrl) {
    const url = normalizeUrl(rawUrl);
    const peer = this.state.peers.find((entry) => entry.url === url);
    return peer?.token ?? this.state.token;
  }

  publishLocal(sessionId, event) {
    this.live?.publish(sessionId, event);
  }

  watchRemote(rawUrl, id) {
    this.live?.watch(normalizeUrl(rawUrl), id);
    return { ok: true };
  }

  unwatchRemote(rawUrl, id) {
    this.live?.unwatch(normalizeUrl(rawUrl), id);
    return { ok: true };
  }

  liveSnapshot(rawUrl, id) {
    return this.live?.snapshot(normalizeUrl(rawUrl), id) ?? [];
  }

  async handleCommand(command) {
    if (typeof this.commandHandler !== 'function') return { ok: false, error: 'no command handler' };
    try {
      return await this.commandHandler(command);
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  async sendCommand(rawUrl, command) {
    const url = normalizeUrl(rawUrl);
    const peer = this.state.peers.find((entry) => entry.url === url);
    if (peer === undefined) throw new Error('unknown peer');
    return this.postJson(peer, '/command', command);
  }

  async setNetwork(mode) {
    const next = mode === 'local' ? '127.0.0.1' : '0.0.0.0';
    this.network = mode === 'local' ? 'local' : 'lan';
    if (this.host === next) {
      this.state.network = this.network;
      this.save();
      return this.network;
    }
    const running = this.server !== null;
    if (running) {
      const closing = this.server;
      await new Promise((resolve) => {
        closing.close(() => resolve());
        closing.closeAllConnections?.();
      });
    }
    this.server = null;
    this.host = next;
    if (running) {
      this.server = http.createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: String(error?.message ?? error) }));
        });
      });
      await new Promise((resolve, reject) => {
        this.server.once('error', reject);
        this.server.listen(this.port, this.host, () => resolve());
      });
      this.port = this.server.address().port;
    }
    this.state.network = this.network;
    this.save();
    this.record('network ' + this.network + ' on ' + this.host + ':' + this.port);
    return this.network;
  }

  async tick() {
    if (this.busy || this.stopFlag || this.state === null) return;
    this.busy = true;
    this.ticks += 1;
    try {
      await this.pushPhase();
      if (this.ticks % this.manifestEvery === 1 || this.ticks === 1) await this.pullPhase();
    } catch (error) {
      this.log('tick failed: ' + String(error));
    } finally {
      this.busy = false;
    }
  }

  async pushPhase() {
    if (this.state.autoSync === false) return;
    for (const raw of this.scanSessions()) {
      const st = this.state.sessions[raw.id];
      if (!st || st.sync !== true) continue;
      let record;
      try { record = await this.describe(raw, true); } catch { continue; }
      if (st.lastHash === record.hash) continue;
      const payload = {
        device: this.state.device,
        sessions: [{ id: raw.id, group: raw.group, title: record.title, cwd: record.cwd, mtime: raw.mtime, hash: record.hash, data: record.bytes.toString('base64') }],
      };
      let delivered = 0;
      for (const peer of this.state.peers) {
        try {
          await this.postJson(peer, '/push', payload);
          delivered += 1;
          this.markPeer(peer, true);
        } catch (error) {
          this.markPeer(peer, false, error?.message ?? error);
        }
      }
      if (delivered > 0) {
        this.state.sessions[raw.id] = { ...st, lastHash: record.hash, lastSyncAt: Date.now(), title: record.title, cwd: record.cwd };
        this.save();
      }
    }
  }

  async pullPhase() {
    if (this.state.autoSync === false) return;
    if (this.state.peers.length === 0) return;
    for (const peer of this.state.peers) {
      let manifest;
      try {
        manifest = await this.getJson(peer, '/sessions');
        this.markPeer(peer, true);
      } catch (error) {
        this.markPeer(peer, false, error?.message ?? error);
        this.remote.set(peer.url, { ok: false, at: Date.now(), sessions: this.remote.get(peer.url)?.sessions ?? [] });
        continue;
      }
      const list = Array.isArray(manifest.sessions) ? manifest.sessions : [];
      this.remote.set(peer.url, { ok: true, at: Date.now(), sessions: list });
      for (const remoteSession of list) {
        const st = this.state.sessions[remoteSession.id];
        if (!st || (st.sync !== true && st.follow !== true)) continue;
        if (st.lastHash === remoteSession.hash) continue;
        if (this.hashes.get(remoteSession.id)?.hash === remoteSession.hash) continue;
        try { await this.pullOne(peer, remoteSession.id); } catch (error) { this.log('pull failed: ' + String(error)); }
      }
    }
    this.save();
  }

  async pullOne(peer, id) {
    const payload = await this.getJson(peer, '/session?id=' + encodeURIComponent(id));
    return this.install(payload, peer.name || peer.url);
  }

  async syncNow() {
    this.record('manual sync');
    await this.pushPhase();
    await this.pullPhase();
    return this.listLocal();
  }
}
