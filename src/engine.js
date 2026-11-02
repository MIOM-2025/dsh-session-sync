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
    this.localGroup = options.localGroup ?? this.encodeGroup(process.cwd());
    this.mirrors = {};
    this.turns = new Map();
    this.queue = [];
    this.queueRunning = null;
    this.queueWake = null;
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
      .map((peer) => ({ url: normalizeUrl(peer.url), name: peer.name ?? '', token: peer.token, scope: peer.scope === 'read' ? 'read' : 'work' }))
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
      onRemoteEvent: (id, event, url) => this.handleRemoteEvent(id, event, url),
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
    const result = { device: this.state.device, port: this.port, token: this.state.token, network: this.network, host: this.host, autoSync: this.state.autoSync !== false, allowPair: this.state.allowPair !== false, pairCode: this.state.pairCode ?? '', lanAddress: this.lanAddress(), sessions, queue: this.queueStatus(), live: this.liveSummary(), mirrors: this.state.mirrors ?? {} };
    if (withRemote) {
      result.peers = this.state.peers.map((peer) => ({ url: peer.url, name: peer.name, scope: peer.scope ?? 'work', ok: peer.ok === true, lastSeen: peer.lastSeen ?? null, error: peer.error ?? null }));
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

  setPeerScope(rawUrl, scope) {
    const url = normalizeUrl(rawUrl);
    const peer = this.state.peers.find((entry) => entry.url === url);
    if (peer === undefined) throw new Error('unknown peer');
    peer.scope = scope === 'read' ? 'read' : 'work';
    this.record('scope ' + url + ' -> ' + peer.scope);
    this.save();
    return { url, scope: peer.scope };
  }

  addPeer(rawUrl, name = '', token, scope = 'work') {
    const url = normalizeUrl(rawUrl);
    if (!url) throw new Error('empty peer url');
    if (!this.peerUrlSet().has(url)) {
      this.state.peers.push({ url, name, token, scope: scope === 'read' ? 'read' : 'work' });
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

  tokenOf(req) {
    const header = req.headers['x-session-sync-token'];
    const token = Array.isArray(header) ? header[0] : header;
    return typeof token === 'string' ? token : '';
  }

  // 令牌 → 身份：本机令牌是 owner（可写），每个配对设备有自己的令牌和权限
  peerForToken(token) {
    if (typeof token !== 'string' || token.length === 0) return null;
    if (token === this.state.token) return { self: true, scope: 'work', peer: null };
    const peer = this.state.peers.find((entry) => typeof entry.token === 'string' && entry.token === token);
    return peer === undefined ? null : { self: false, scope: peer.scope ?? 'work', peer };
  }

  authOk(req) {
    return this.peerForToken(this.tokenOf(req)) !== null;
  }

  scopeOf(req) {
    return this.peerForToken(this.tokenOf(req))?.scope ?? null;
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

  encodeGroup(cwd) {
    return '--' + String(cwd).replace(/^\//, '').replace(/\//g, '-') + '--';
  }

  // 回合结束 → 把远端会话镜像成本地副本（不同 id，避免两个写者）
  async handleRemoteEvent(sessionId, event, url) {
    if (typeof sessionId !== 'string') return;
    if (event?.type === 'turn/end') {
      this.mirrorRemote(url, sessionId).catch((error) => this.log('mirror failed: ' + String(error)));
    }
  }

  async mirrorRemote(rawUrl, id) {
    const url = normalizeUrl(rawUrl);
    const peer = this.state.peers.find((entry) => entry.url === url);
    if (peer === undefined) throw new Error('unknown peer');
    const payload = await this.getJson(peer, '/session?id=' + encodeURIComponent(id));
    if (typeof payload.data !== 'string') throw new Error('no data');
    const bytes = Buffer.from(payload.data, 'base64');
    const mirrorId = 'session-' + id.replace(/^session-/, 'mirror-');
    const out = this.rewriteMirror(bytes, mirrorId, this.localGroup);
    const dir = path.join(this.sessionsRoot, this.localGroup, mirrorId);
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, SESSION_FILE);
    const tmp = file + '.tmp-' + process.pid;
    await fsp.writeFile(tmp, out);
    await fsp.rename(tmp, file);
    this.state.mirrors = this.state.mirrors ?? {};
    this.state.mirrors[mirrorId] = { source: id, peer: url, at: Date.now(), title: payload.title ?? '' };
    this.hashes.delete(mirrorId);
    this.record('mirrored ' + id + ' -> ' + mirrorId);
    this.save();
    return { mirrorId, file };
  }

  rewriteMirror(bytes, mirrorId, group) {
    const cwd = process.cwd();
    const text = zlib.zstdDecompressSync(bytes).toString('utf8');
    const lines = text.split('\n').filter((line) => line.trim().length > 0).map((line) => {
      try {
        const event = JSON.parse(line);
        if (event.type === 'session') {
          event.id = mirrorId;
          event.cwd = cwd;
        }
        if (event.type === 'session/title' && typeof event.data?.title === 'string') {
          event.data.title = event.data.title + ' · 远端镜像';
        }
        return JSON.stringify(event);
      } catch { return line; }
    });
    return zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n'));
  }

  liveSummary() {
    return (this.live?.watches() ?? []).map((entry) => ({
      url: entry.url,
      id: entry.id,
      events: (this.live?.snapshot(entry.url, entry.id) ?? []).slice(-40),
    }));
  }

  // 一次性令牌配对：对方把本机面板上显示的令牌填进来即可，双方从此各用各的设备令牌。
  async pairWith(rawUrl, providedToken = '', scope = 'work') {
    const url = normalizeUrl(rawUrl);
    if (!url) throw new Error('empty peer url');
    const wanted = scope === 'read' ? 'read' : 'work';
    const ping = await fetch(url + '/ping').then((response) => response.json());
    if (ping.app !== APP_ID) throw new Error('not a dsh-session-sync peer');
    const response = await fetch(url + '/pair-request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: 'http://' + (this.advertiseHost || this.lanAddress()) + ':' + this.port,
        device: this.state.device,
        token: this.state.token,
        code: String(providedToken ?? ''),
        scope: wanted,
      }),
    });
    if (!response.ok) throw new Error('pair rejected: HTTP ' + response.status);
    const data = await response.json();
    this.addPeer(url, data.device ?? ping.device ?? '', data.token, data.scope ?? wanted);
    this.record('paired with ' + (data.device ?? url) + ' (' + (data.scope ?? wanted) + ')');
    return { url, device: data.device ?? ping.device, scope: data.scope ?? wanted };
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
      // 配对码优先；没设配对码时，填本机令牌也算一次性凭证；都没填则按 allowPair 放行。
      const code = String(body.code ?? '');
      if (this.state.pairCode) {
        if (code !== this.state.pairCode && code !== this.state.token) return json(403, { error: 'bad pair code' });
      } else if (code.length > 0 && code !== this.state.token) {
        return json(403, { error: 'bad pair token' });
      }
      const peerUrl = normalizeUrl(body.url ?? '');
      const scope = body.scope === 'read' ? 'read' : 'work';
      if (peerUrl) this.addPeer(peerUrl, body.device ?? '', body.token, scope);
      this.record('paired with ' + (body.device ?? peerUrl) + ' (' + scope + ')');
      return json(200, { app: APP_ID, device: this.state.device, port: this.port, token: this.state.token, scope });
    }

    if (!this.authOk(req)) return json(401, { error: 'bad token' });

    if (url.pathname === '/live' && req.method === 'GET') {
      await this.live.serve(req, res, url);
      return;
    }

    if (url.pathname === '/command' && req.method === 'POST') {
      if (this.scopeOf(req) !== 'work') return json(403, { error: 'read-only peer' });
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      return json(200, await this.submitCommand(body));
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
      if ((!st || st.sync !== true) && this.state.shared[id] !== true) return json(403, { error: 'not shared' });
      const record = await this.describe(raw, true);
      return json(200, { id, group: raw.group, title: record.title, cwd: record.cwd, size: raw.size, mtime: raw.mtime, hash: record.hash, data: record.bytes.toString('base64') });
    }

    if (url.pathname === '/push' && req.method === 'POST') {
      if (this.scopeOf(req) !== 'work') return json(403, { error: 'read-only peer' });
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

  // ── 串行命令队列：远端操作排队，等当前回合结束再生效 ────────────────────
  markTurn(sessionId, phase) {
    if (typeof sessionId !== 'string') return;
    if (phase === 'start') this.turns.set(sessionId, Date.now());
    else this.turns.delete(sessionId);
    if (phase !== 'start') this.pumpQueue();
  }

  isSessionBusy(sessionId) {
    return this.turns.has(sessionId) || (this.queueRunning !== null && this.queueRunning.sessionId === sessionId);
  }

  queueStatus() {
    return {
      running: this.queueRunning === null ? null : { sessionId: this.queueRunning.sessionId, type: this.queueRunning.type, since: this.queueRunning.at },
      pending: this.queue.map((item) => ({ sessionId: item.sessionId, type: item.type, at: item.at, from: item.from })),
    };
  }

  async submitCommand(command) {
    const type = String(command?.type ?? '');
    if (type === 'stop') {
      // 停止必须立刻生效，不能排在回合后面
      return this.handleCommand(command);
    }
    if (type !== 'message') return { ok: false, error: 'unknown command' };
    const item = { ...command, at: Date.now(), from: command?.from ?? 'remote' };
    this.queue.push(item);
    this.pumpQueue();
    return { ok: true, queued: true, position: this.queue.length, queue: this.queueStatus() };
  }

  pumpQueue() {
    if (this.queueRunning !== null) return;
    const next = this.queue[0];
    if (next === undefined) return;
    if (this.turns.has(next.sessionId)) {
      if (this.queueWake === null) {
        this.queueWake = setTimeout(() => { this.queueWake = null; this.pumpQueue(); }, 1000);
        this.queueWake.unref?.();
      }
      return;
    }
    this.queue.shift();
    this.queueRunning = next;
    this.runQueued(next).finally(() => {
      this.queueRunning = null;
      this.pumpQueue();
    });
  }

  async runQueued(item) {
    try {
      await this.handleCommand(item);
      await this.waitForTurnEnd(item.sessionId);
    } catch (error) { this.log('queued command failed: ' + String(error)); }
  }

  async waitForTurnEnd(sessionId) {
    const deadline = Date.now() + 10 * 60 * 1000;
    await new Promise((resolve) => setTimeout(resolve, 600));
    while (this.turns.has(sessionId)) {
      if (Date.now() > deadline) { this.log('waitForTurnEnd timeout: ' + sessionId); return; }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }

  // 只在文件稳定时取快照，避免读到正在写的半截日志
  async stableSnapshot(session, record) {
    try {
      const first = await fsp.stat(session.file);
      if (first.size !== record.size || first.mtimeMs !== record.mtime) return null;
      await new Promise((resolve) => setTimeout(resolve, 120));
      const second = await fsp.stat(session.file);
      if (second.size !== record.size || second.mtimeMs !== record.mtime) return null;
    } catch { return null; }
    return record;
  }

  async install(item, from) {
    if (!item || typeof item.id !== 'string' || !item.id.startsWith('session-')) return { skipped: 'bad id' };
    if (this.turns.has(item.id)) return { skipped: 'local turn active' };
    if (typeof item.data !== 'string') return { skipped: 'no data' };
    const st = this.state.sessions[item.id] ?? {};
    if (st.blocked === true) return { skipped: 'opted out' };
    if (st.sync === true) return { skipped: 'local owner' }; // 一方勾选即一方是写者，拒绝反向写

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
      if (this.turns.has(raw.id)) continue; // 正在跑回合，等结束再同步，避免读到半截
      let record;
      try { record = await this.describe(raw, true); } catch { continue; }
      if (st.lastHash === record.hash) continue;
      if ((await this.stableSnapshot(raw, record)) === null) continue;
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
