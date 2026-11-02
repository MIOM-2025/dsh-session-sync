import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { SyncEngine } from './src/engine.js';

// 实时事件只带渲染需要的内容，避免把大块工具输出也推过去。
function summarizeEvent(event) {
  if (event === null || typeof event !== 'object') return { type: 'unknown' };
  const data = event.data ?? {};
  const type = String(event.type ?? 'unknown');
  const clip = (value, max = 4000) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text.length > max ? text.slice(0, max) + '…' : text;
  };
  const summary = { type, seq: event.seq, time: event.time };
  if (type === 'assistant/message' || type === 'user/message') {
    summary.text = clip(data.content ?? data.text ?? '', 4000);
  } else if (type === 'tool/call') {
    summary.text = clip({ name: data.name, args: data.args }, 2000);
  } else if (type === 'tool/result') {
    summary.text = clip(data.data ?? data.result ?? data, 1500);
  } else if (type === 'turn/start' || type === 'turn/end' || type === 'step/start' || type === 'step/end') {
    summary.text = '';
  } else {
    summary.text = clip(data, 800);
  }
  return summary;
}

export const name = 'dsh-session-sync';
export const inject = [];

const PREFIX = '/session-sync';

function warn(ctx, message) {
  try { ctx.logger?.warn?.('[session-sync] ' + message); } catch { /* ignore */ }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function jsonOf(req) {
  const text = (await readBody(req)).toString('utf8');
  return text.length === 0 ? {} : JSON.parse(text);
}

// cordis 的服务读取默认要求 inject 声明；面板接口和工具都是可选能力，
// 所以统一用 reflect.get 读取，拿不到就跳过。
function optionalService(ctx, name) {
  try { return ctx.reflect?.get?.(name); } catch { return undefined; }
}

export function apply(ctx, config = {}) {
  const engine = new SyncEngine({
    home: config.home ?? process.env.DSH_HOME ?? os.homedir(),
    port: Number(config.port ?? 1111),
    host: config.host ?? '0.0.0.0',
    device: config.device ?? os.hostname(),
    intervalMs: Number(config.intervalMs ?? 2000),
    manifestMs: Number(config.manifestMs ?? 10000),
    log: (message) => warn(ctx, message),
  });
  engine.advertiseHost = config.advertiseHost ?? '';

  // 把本机共享会话的实时事件推给已配对的对端
  try {
    ctx.on('session/event', (session, event) => {
      const id = session?.id;
      if (typeof id !== 'string') return;
      if (engine.state.sessions[id]?.sync !== true) return;
      engine.publishLocal(id, summarizeEvent(event));
    });
  } catch (error) { warn(ctx, 'session event subscription failed: ' + String(error)); }

  // 对端发来的停止/输入指令
  engine.commandHandler = async (command) => {
    const id = String(command?.id ?? '');
    if (!id.startsWith('session-')) return { ok: false, error: 'bad session id' };
    const controller = optionalService(ctx, 'sessionController');
    if (controller === undefined) return { ok: false, error: 'session controller unavailable' };
    if (command.type === 'stop') {
      try {
        controller.cancel({ sessionId: id });
        return { ok: true };
      } catch (error) { return { ok: false, error: String(error?.message ?? error) }; }
    }
    if (command.type === 'message') {
      const text = String(command.text ?? '').trim();
      if (text.length === 0) return { ok: false, error: 'empty message' };
      try {
        await controller.prompt({
          sessionId: id,
          content: [{ type: 'text', text }],
          mode: command.mode === 'steer' ? 'steer' : 'followup',
          requestId: randomUUID(),
        }, { kind: 'user' });
        return { ok: true };
      } catch (error) { return { ok: false, error: String(error?.message ?? error) }; }
    }
    return { ok: false, error: 'unknown command' };
  };

  engine.start().catch((error) => warn(ctx, 'start failed: ' + String(error)));

  try { ctx.provide?.('sessionSync', engine); } catch { /* optional */ }
  ctx.sessionSync = engine;

  const dispose = () => { engine.stop().catch(() => {}); };
  try {
    if (typeof ctx.effect === 'function') ctx.effect(() => dispose);
    else ctx.on?.('dispose', dispose);
  } catch { ctx.on?.('dispose', dispose); }

  // 面板接口挂在 DSH 自己的 webserver 上：/session-sync/api/*
  const mountPanel = (web) => {
    const connection = optionalService(web, 'connection');
    const handler = (req, res) => {
      panel(engine, connection, req, res).catch((error) => {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(error?.message ?? error) }));
      });
    };
    try {
      web.webServer.register({ kind: 'prefix', path: PREFIX, handler });
    } catch (error) {
      warn(ctx, 'panel route registration failed: ' + String(error));
    }
  };
  if (typeof ctx.inject === 'function') ctx.inject(['webServer'], mountPanel);
  else if (optionalService(ctx, 'webServer')) mountPanel(ctx);

  // agent 工具（可选）
  const mountTool = (toolsCtx) => {
    const tools = toolsCtx.tools;
    if (!tools || typeof tools.register !== 'function') return;
    buildTool(engine).then((tool) => {
      try { tools.register(tool); } catch (error) { warn(ctx, 'tool registration failed: ' + String(error)); }
    }).catch(() => {});
  };
  if (typeof ctx.inject === 'function') ctx.inject(['tools'], mountTool);
  else if (optionalService(ctx, 'tools')) mountTool(ctx);
}

async function panel(engine, connection, req, res) {
  const json = (status, value) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  if (typeof connection?.authorizeIndex === 'function' && !connection.authorizeIndex(req, res)) return;
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
      return json(200, await engine.pullOne(peer, body.id));
    }
    if (route === '/api/network' && req.method === 'POST') {
      const body = await jsonOf(req);
      const network = await engine.setNetwork(body.mode === 'local' ? 'local' : 'lan');
      return json(200, { network, host: engine.host, port: engine.port });
    }
    if (route === '/api/watch' && req.method === 'POST') {
      const body = await jsonOf(req);
      engine.watchRemote(body.url, String(body.id ?? ''));
      return json(200, { ok: true });
    }
    if (route === '/api/unwatch' && req.method === 'POST') {
      const body = await jsonOf(req);
      engine.unwatchRemote(body.url, String(body.id ?? ''));
      return json(200, { ok: true });
    }
    if (route === '/api/live' && req.method === 'GET') {
      return json(200, { events: engine.liveSnapshot(url.searchParams.get('url') ?? '', url.searchParams.get('id') ?? '') });
    }
    if (route === '/api/command' && req.method === 'POST') {
      const body = await jsonOf(req);
      const command = { id: body.id, type: body.type, text: body.text, mode: body.mode };
      if (typeof body.url === 'string' && body.url.length > 0) return json(200, await engine.sendCommand(body.url, command));
      return json(200, await engine.handleCommand(command));
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
      url: { type: 'string', description: 'pair/pull 时的对端地址，例如 192.168.1.8:1111。' },
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
