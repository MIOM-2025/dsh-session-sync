import os from 'node:os';
import { SyncEngine } from './src/engine.js';

export const name = 'dsh-session-sync';
export const inject = [];

const PREFIX = '/session-sync';

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function jsonOf(req) {
  return readBody(req).then((buffer) => {
    const text = buffer.toString('utf8');
    return text.length === 0 ? {} : JSON.parse(text);
  });
}

export function apply(ctx, config = {}) {
  const engine = new SyncEngine({
    home: config.home ?? process.env.DSH_HOME ?? os.homedir(),
    port: Number(config.port ?? 6120),
    host: config.host ?? '0.0.0.0',
    device: config.device ?? os.hostname(),
    intervalMs: Number(config.intervalMs ?? 2000),
    manifestMs: Number(config.manifestMs ?? 10000),
    log: (message) => { try { ctx.logger?.info?.('[session-sync] ' + message); } catch { /* ignore */ } },
  });
  engine.advertiseHost = config.advertiseHost ?? '';

  engine.start().catch((error) => {
    try { ctx.logger?.warn?.('[session-sync] start failed: ' + String(error)); } catch { /* ignore */ }
  });

  // 供其它 Host 插件/工具拿到同一个引擎。
  try { ctx.provide?.('sessionSync', engine); } catch { /* ignore */ }
  ctx.sessionSync = engine;

  const dispose = () => { engine.stop().catch(() => {}); };
  if (typeof ctx.effect === 'function') {
    try { ctx.effect(() => dispose); } catch { /* ignore */ }
  } else if (typeof ctx.on === 'function') {
    ctx.on('dispose', dispose);
  }

  const panelHandler = async (req, res) => {
    const json = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    if (typeof ctx.connection?.authorizeIndex === 'function' && !ctx.connection.authorizeIndex(req, res)) return;
    const url = new URL(req.url ?? '/', 'http://panel.invalid');
    const route = url.pathname.slice(PREFIX.length) || '/';
    try {
      if (route === '/api/state' && req.method === 'GET') {
        return json(200, await engine.listLocal());
      }
      if (route === '/api/toggle' && req.method === 'POST') {
        const body = await jsonOf(req);
        return json(200, await engine.setEnabled(body.id, body.enabled === true));
      }
      if (route === '/api/pair' && req.method === 'POST') {
        const body = await jsonOf(req);
        return json(200, await engine.pairWith(body.url));
      }
      if (route === '/api/peer' && req.method === 'POST') {
        const body = await jsonOf(req);
        if (body.remove) engine.removePeer(body.remove);
        else engine.addPeer(body.url, body.name);
        return json(200, { ok: true });
      }
      if (route === '/api/pull' && req.method === 'POST') {
        const body = await jsonOf(req);
        const peer = engine.state.peers.find((entry) => entry.url === body.url);
        if (!peer) return json(404, { error: 'unknown peer' });
        const outcome = await engine.pullOne(peer, body.id);
        return json(200, outcome);
      }
      if (route === '/api/sync' && req.method === 'POST') {
        return json(200, await engine.syncNow());
      }
      if (route === '/api/settings' && req.method === 'POST') {
        const body = await jsonOf(req);
        if (typeof body.autoSync === 'boolean') engine.state.autoSync = body.autoSync;
        if (typeof body.allowPair === 'boolean') engine.state.allowPair = body.allowPair;
        if (typeof body.pairCode === 'string') engine.state.pairCode = body.pairCode;
        engine.save();
        return json(200, { ok: true });
      }
      if (route === '/api/token' && req.method === 'POST') {
        const body = await jsonOf(req);
        return json(200, { token: engine.setToken(body.token) });
      }
      return json(404, { error: 'unknown route' });
    } catch (error) {
      return json(400, { error: String(error?.message ?? error) });
    }
  };

  if (ctx.webServer && typeof ctx.webServer.register === 'function') {
    ctx.webServer.register({
      kind: 'prefix',
      path: PREFIX,
      handler: (req, res) => {
        panelHandler(req, res).catch((error) => {
          if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: String(error?.message ?? error) }));
        });
      },
    });
  }

  registerSessionSyncTool(ctx, engine);
}

export function registerSessionSyncTool(ctx, engine) {
  let attempts = 0;
  const attempt = () => {
    attempts += 1;
    if (!ctx.tools || typeof ctx.tools.register !== 'function') {
      if (attempts < 10) setTimeout(attempt, 1000).unref?.();
      return;
    }
    buildTool(engine).then((tool) => {
      try { ctx.tools.register(tool); } catch (error) { ctx.logger?.warn?.('[session-sync] tool registration failed: ' + String(error)); }
    }).catch(() => {});
  };
  attempt();
}

async function buildTool(engine) {
  let defineTool;
  try { ({ defineTool } = await import('@deepseek-ai/dsh-tools')); } catch { defineTool = undefined; }
  const tool = {
    name: 'session_sync',
    description: '查看/控制 DSH 会话同步：status 看状态，list 列出会话与勾选状态，enable/disable 勾选某个会话，pair 与另一台设备配对，sync 立即同步，pull 从对端拉取某个会话。',
    parameters: {
      action: { type: 'string', required: true, enum: ['status', 'list', 'enable', 'disable', 'pair', 'sync', 'pull'], description: '要执行的操作。' },
      sessionId: { type: 'string', description: 'enable/disable/pull 时的会话 id（session-...）。' },
      url: { type: 'string', description: 'pair/pull 时的对端地址，例如 192.168.1.8:6120。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean', required: true },
          summary: { type: 'string', required: true },
          data: { type: 'object', additionalProperties: true },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: value.summary }];
      },
    },
    async execute(args) {
      const action = String(args.action ?? 'status');
      if (action === 'enable' || action === 'disable') {
        await engine.setEnabled(String(args.sessionId ?? ''), action === 'enable');
        return { ok: true, summary: (action === 'enable' ? '已勾选同步 ' : '已取消同步 ') + args.sessionId, data: { sessionId: args.sessionId } };
      }
      if (action === 'pair') {
        const paired = await engine.pairWith(String(args.url ?? ''));
        return { ok: true, summary: '已与 ' + (paired.device ?? paired.url) + ' 配对', data: paired };
      }
      if (action === 'sync') {
        await engine.syncNow();
        return { ok: true, summary: '已触发一次同步', data: {} };
      }
      if (action === 'pull') {
        const peer = engine.state.peers.find((entry) => entry.url === String(args.url ?? '') || entry.url.replace(/^https?:\/\//, '') === String(args.url ?? ''));
        if (!peer) return { ok: false, summary: '未找到对端，请先 pair', data: {} };
        const outcome = await engine.pullOne(peer, String(args.sessionId ?? ''));
        return { ok: true, summary: '拉取完成：' + JSON.stringify(outcome), data: outcome };
      }
      const state = await engine.listLocal();
      if (action === 'list') {
        const lines = state.sessions.map((session) => (session.enabled ? '[x] ' : '[ ] ') + (session.title || session.id) + ' (' + session.id + ')');
        return { ok: true, summary: lines.join('\n') || '(没有本地会话)', data: state };
      }
      const peers = state.peers.map((peer) => peer.url + (peer.ok ? ' ✓' : ' ✗')).join(', ') || '(未配对)';
      return { ok: true, summary: '设备 ' + state.device + '，监听 :' + state.port + '，自动同步 ' + (state.autoSync ? '开' : '关') + '，对端 ' + peers + '，已勾选 ' + state.sessions.filter((s) => s.enabled).length + ' 个会话', data: state };
    },
  };
  return defineTool === undefined ? tool : defineTool(tool);
}
