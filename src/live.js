// 实时通道：主机端把某个共享会话的 session/event 事件通过 SSE 推给对端，
// 对端可以用 POST /command 反向发送 stop / message。只依赖 Node 内置能力。
const MAX_BUFFER = 400;

function sseWrite(res, payload) {
  if (res.writableEnded) return false;
  try {
    res.write('data: ' + JSON.stringify(payload) + '\n\n');
    return true;
  } catch {
    return false;
  }
}

export class LiveRelay {
  constructor(engine, options = {}) {
    this.engine = engine;
    this.getSharedIds = options.getSharedIds ?? (() => []);
    this.onCommand = options.onCommand ?? (() => ({ ok: false, error: 'no handler' }));
    this.log = options.log ?? (() => {});
    this.clients = new Set(); // { res, id, peer }
    this.buffers = new Map(); // id -> events[]
    this.remote = new Map(); // "url|id" -> { events, controller, retry }
    this.onRemoteEvent = options.onRemoteEvent ?? (() => {});
    this.closed = false;
  }

  bufferOf(id) {
    let list = this.buffers.get(id);
    if (list === undefined) {
      list = [];
      this.buffers.set(id, list);
    }
    return list;
  }

  publish(sessionId, event) {
    if (this.closed || typeof sessionId !== 'string') return;
    const list = this.bufferOf(sessionId);
    list.push(event);
    if (list.length > MAX_BUFFER) list.splice(0, list.length - MAX_BUFFER);
    for (const client of this.clients) {
      if (client.id === sessionId) sseWrite(client.res, { sessionId, event });
    }
  }

  // 主机端：GET /live?id=... （SSE）
  async serve(req, res, url) {
    if (this.closed) return false;
    const id = url.searchParams.get('id') ?? '';
    if (!this.getSharedIds().includes(id)) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'session not shared' }));
      return true;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    const backlog = this.bufferOf(id);
    for (const event of backlog) sseWrite(res, { sessionId: id, event });
    const client = { res, id };
    this.clients.add(client);
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, 15000);
    heartbeat.unref?.();
    const close = () => {
      clearInterval(heartbeat);
      this.clients.delete(client);
    };
    req.on('close', close);
    res.on('close', close);
    req.on('error', close);
    return true;
  }

  // 对端：订阅某个主机上的会话
  watch(rawUrl, id) {
    const key = rawUrl + '|' + id;
    const existing = this.remote.get(key);
    if (existing !== undefined) return;
    const entry = { events: [], controller: new AbortController(), url: rawUrl, id, closed: false };
    this.remote.set(key, entry);
    this.consume(entry, key).catch((error) => this.log('live stream failed: ' + String(error)));
  }

  async consume(entry, key) {
    while (!entry.closed && !this.closed) {
      try {
        const response = await fetch(entry.url + '/live?id=' + encodeURIComponent(entry.id), {
          headers: { accept: 'text/event-stream', 'x-session-sync-token': this.engine.tokenFor(entry.url) },
          signal: entry.controller.signal,
        });
        if (!response.ok || response.body === null) throw new Error('HTTP ' + response.status);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let pending = '';
        while (!entry.closed) {
          const chunk = await reader.read();
          if (chunk.done) break;
          pending += decoder.decode(chunk.value, { stream: true });
          let index;
          while ((index = pending.indexOf('\n\n')) >= 0) {
            const frame = pending.slice(0, index);
            pending = pending.slice(index + 2);
            for (const line of frame.split('\n')) {
              if (!line.startsWith('data:')) continue;
              let payload;
              try { payload = JSON.parse(line.slice(5).trim()); } catch { continue; }
              entry.events.push(payload.event);
              if (entry.events.length > MAX_BUFFER) entry.events.splice(0, entry.events.length - MAX_BUFFER);
              try { this.onRemoteEvent(payload.sessionId ?? entry.id, payload.event); } catch { /* ignore */ }
            }
          }
        }
      } catch (error) {
        if (entry.closed || this.closed) return;
        this.log('live stream error: ' + String(error));
      }
      if (entry.closed || this.closed) return;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  unwatch(rawUrl, id) {
    const key = rawUrl + '|' + id;
    const entry = this.remote.get(key);
    if (entry === undefined) return;
    entry.closed = true;
    try { entry.controller.abort(); } catch { /* ignore */ }
    this.remote.delete(key);
  }

  snapshot(rawUrl, id) {
    return this.remote.get(rawUrl + '|' + id)?.events ?? [];
  }

  close() {
    this.closed = true;
    for (const client of this.clients) {
      try { client.res.end(); } catch { /* ignore */ }
    }
    this.clients.clear();
    for (const [key] of this.remote) {
      const [url, id] = key.split('|');
      this.unwatch(url, id);
    }
  }
}
