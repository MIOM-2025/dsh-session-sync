window.__ModuleLoader__.load({
  id: 'dsh-session-sync',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require('react');
    const { useState, useEffect, useCallback, useRef } = React;
    const API = '/session-sync/api';

    async function call(path, body) {
      const init = body === undefined
        ? { headers: { accept: 'application/json' } }
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
      const response = await fetch(API + path, init);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'HTTP ' + response.status);
      return data;
    }

    const ui = {
      section: { display: 'flex', flexDirection: 'column', gap: 16, padding: '4px 2px 24px', maxWidth: 860 },
      card: { border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.25))', borderRadius: 10, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 },
      title: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      hint: { fontSize: 11, lineHeight: 1.6, color: 'var(--dsw-alias-label-tertiary)' },
      row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      input: { flex: 1, minWidth: 160, fontSize: 12, padding: '5px 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.35))', background: 'transparent', color: 'var(--dsw-alias-label-primary)' },
      button: { fontSize: 12, padding: '5px 10px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.35))', background: 'transparent', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer' },
      active: { fontSize: 12, padding: '5px 10px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-accent, #4a7dff)', background: 'rgba(74,125,255,.12)', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer' },
      list: { display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 260, overflow: 'auto' },
      item: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, padding: '5px 4px', borderBottom: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.12))' },
      name: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      meta: { fontSize: 10, color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap' },
      error: { fontSize: 12, color: 'var(--dsw-alias-label-error, #d9534f)' },
      ok: { color: 'var(--dsw-alias-label-success, #3a9d5d)' },
      stream: { display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 380, overflow: 'auto', fontFamily: 'ui-monospace, monospace', fontSize: 11, padding: '6px 8px', border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.2))', borderRadius: 8 },
      badge: { fontSize: 10, padding: '1px 6px', borderRadius: 999, border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.35))', whiteSpace: 'nowrap' },
    };

    function bytes(value) {
      if (!Number.isFinite(value)) return '--';
      if (value < 1024) return value + ' B';
      if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
      return (value / 1024 / 1024).toFixed(1) + ' MB';
    }

    function time(value) {
      if (!value) return '--';
      return new Date(value).toLocaleTimeString();
    }

    const LABEL = {
      'assistant/message': '回复',
      'user/message': '输入',
      'tool/call': '工具调用',
      'tool/result': '工具结果',
      'turn/start': '开始',
      'turn/end': '结束',
      'step/start': '思考',
      'step/end': '思考结束',
    };

    function Section(props) {
      const [state, setState] = useState(null);
      const [error, setError] = useState('');
      const [status, setStatus] = useState('');
      const [url, setUrl] = useState('');
      const [draft, setDraft] = useState('');
      const [target, setTarget] = useState(null);
      const [events, setEvents] = useState([]);
      const [busy, setBusy] = useState('');
      const targetRef = useRef(null);
      targetRef.current = target;

      const refresh = useCallback(async () => {
        try { setState(await call('/state')); setError(''); }
        catch (cause) { setError(String(cause.message || cause)); }
      }, []);

      useEffect(() => {
        refresh();
        const timer = setInterval(refresh, 3000);
        return () => clearInterval(timer);
      }, [refresh]);

      useEffect(() => {
        if (target === null) return undefined;
        let stopped = false;
        const tick = async () => {
          try {
            const data = await call('/live?url=' + encodeURIComponent(target.url) + '&id=' + encodeURIComponent(target.id));
            if (!stopped) setEvents(Array.isArray(data.events) ? data.events : []);
          } catch (cause) { /* keep last view */ }
        };
        tick();
        const timer = setInterval(tick, 700);
        return () => { stopped = true; clearInterval(timer); };
      }, [target]);

      const run = async (label, action) => {
        setBusy(label);
        try { await action(); await refresh(); setError(''); }
        catch (cause) { setError(String(cause.message || cause)); }
        finally { setBusy(''); }
      };

      if (state === null) {
        return React.createElement('div', { style: ui.section }, error ? React.createElement('div', { style: ui.error }, error) : React.createElement('div', { style: ui.hint }, '正在读取同步状态…'));
      }

      const enabledCount = state.sessions.filter((session) => session.enabled).length;
      const localIds = new Set(state.sessions.map((session) => session.id));

      const watch = async (group, session) => {
        await call('/watch', { url: group.url, id: session.id });
        setEvents([]);
        setTarget({ url: group.url, id: session.id, title: session.title || session.id, peer: group.url });
        setStatus('正在实时查看：' + (session.title || session.id));
      };

      const closeLive = async () => {
        if (target === null) return;
        try { await call('/unwatch', { url: target.url, id: target.id }); } catch (cause) { /* ignore */ }
        setTarget(null);
        setEvents([]);
      };

      return React.createElement('div', { style: ui.section },
        // 连接与网络模式
        React.createElement('div', { style: ui.card },
          React.createElement('div', { style: ui.row },
            React.createElement('div', { style: ui.title }, '会话同步'),
            React.createElement('span', { style: { flex: 1 } }),
            React.createElement('span', { style: ui.meta }, state.device + ' · ' + (state.host === '0.0.0.0' ? (state.lanAddress || '?') : '127.0.0.1') + ':' + state.port)
          ),
          React.createElement('div', { style: ui.row },
            React.createElement('span', { style: ui.hint }, '网络：'),
            React.createElement('button', { style: state.network === 'local' ? ui.active : ui.button, onClick: () => run('net', () => call('/network', { mode: 'local' })) }, '仅本机'),
            React.createElement('button', { style: state.network === 'lan' ? ui.active : ui.button, onClick: () => run('net', () => call('/network', { mode: 'lan' })) }, '局域网'),
            React.createElement('span', { style: { flex: 1 } }),
            React.createElement('label', { style: ui.row },
              React.createElement('input', { type: 'checkbox', checked: state.autoSync, onChange: (event) => run('auto', () => call('/settings', { autoSync: event.target.checked })) }),
              React.createElement('span', { style: ui.hint }, '自动同步文件')
            ),
            React.createElement('button', { style: ui.button, disabled: busy !== '', onClick: () => run('sync', () => call('/sync', {})) }, busy === 'sync' ? '同步中…' : '立即同步')
          ),
          React.createElement('div', { style: ui.row },
            React.createElement('input', { style: ui.input, value: url, placeholder: '对方地址，例如 192.168.1.8:' + state.port, onChange: (event) => setUrl(event.target.value) }),
            React.createElement('button', { style: ui.button, disabled: url.trim() === '' || busy !== '', onClick: () => run('pair', async () => { const paired = await call('/pair', { url: url.trim() }); setStatus('已连接 ' + (paired.device || paired.url)); setUrl(''); }) }, busy === 'pair' ? '连接中…' : '连接')
          ),
          React.createElement('div', { style: ui.hint }, '配对只需填对方地址；地址与令牌由双方自动交换。'),
          error ? React.createElement('div', { style: ui.error }, error) : null,
          status ? React.createElement('div', { style: ui.hint }, status) : null
        ),

        // 已配对设备
        React.createElement('div', { style: ui.card },
          React.createElement('div', { style: ui.title }, '已配对设备'),
          (state.peers || []).length === 0
            ? React.createElement('div', { style: ui.hint }, '还没有配对设备。')
            : React.createElement('div', { style: ui.list },
              state.peers.map((peer) => React.createElement('div', { key: peer.url, style: ui.item },
                React.createElement('span', { style: peer.ok ? ui.ok : ui.error }, peer.ok ? '●' : '○'),
                React.createElement('span', { style: ui.name }, peer.url),
                React.createElement('span', { style: ui.meta }, peer.ok ? '在线' : (peer.error || '离线')),
                React.createElement('button', { style: ui.button, onClick: () => run('rm', () => call('/peer', { remove: peer.url })) }, '删除')
              ))
            )
        ),

        // 本机会话
        React.createElement('div', { style: ui.card },
          React.createElement('div', { style: ui.row },
            React.createElement('div', { style: ui.title }, '本机会话'),
            React.createElement('span', { style: ui.meta }, '共享中 ' + enabledCount + ' / ' + state.sessions.length)
          ),
          React.createElement('div', { style: ui.hint }, '勾选后，对方能实时看到这个会话的思考和工具调用，也能对它发送消息或停止。'),
          state.sessions.length === 0
            ? React.createElement('div', { style: ui.hint }, '本机还没有会话。')
            : React.createElement('div', { style: ui.list },
              state.sessions.map((session) => React.createElement('label', { key: session.id, style: ui.item },
                React.createElement('input', { type: 'checkbox', checked: session.enabled, onChange: (event) => run(session.id, () => call('/toggle', { id: session.id, enabled: event.target.checked })) }),
                React.createElement('span', { style: ui.name, title: session.cwd || session.group }, (session.title || '(无标题)') + ' · ' + session.id.slice(8, 16)),
                React.createElement('span', { style: ui.meta }, bytes(session.size))
              ))
            )
        ),

        // 对方会话 + 实时查看
        (state.remote || []).length > 0 ? React.createElement('div', { style: ui.card },
          React.createElement('div', { style: ui.title }, '对方的共享会话'),
          (state.remote || []).map((group) => React.createElement('div', { key: group.url, style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            React.createElement('div', { style: ui.meta }, group.url + (group.ok ? '' : ' · 离线')),
            (group.sessions || []).length === 0
              ? React.createElement('div', { style: ui.hint }, '对方暂时没有共享的会话。')
              : React.createElement('div', { style: ui.list },
                (group.sessions || []).map((session) => React.createElement('div', { key: session.id, style: ui.item },
                  React.createElement('span', { style: ui.name, title: session.cwd || session.group }, (session.title || '(无标题)') + ' · ' + session.id.slice(8, 16)),
                  React.createElement('span', { style: ui.meta }, bytes(session.size)),
                  React.createElement('button', { style: ui.button, onClick: () => run(session.id, () => watch(group, session)) }, '实时查看'),
                  React.createElement('button', { style: ui.button, onClick: () => run('pull-' + session.id, () => call('/pull', { id: session.id, url: group.url })) }, localIds.has(session.id) ? '重新拉取' : '拉取')
                ))
              )
          ))
        ) : null,

        // 实时视图
        target !== null ? React.createElement('div', { style: ui.card },
          React.createElement('div', { style: ui.row },
            React.createElement('div', { style: ui.title }, '实时 · ' + (target.title || target.id)),
            React.createElement('span', { style: ui.meta }, target.peer),
            React.createElement('span', { style: { flex: 1 } }),
            React.createElement('button', { style: ui.button, onClick: closeLive }, '关闭')
          ),
          React.createElement('div', { style: ui.stream },
            events.length === 0
              ? React.createElement('div', { style: ui.hint }, '等待对方的事件…')
              : events.map((event, index) => React.createElement('div', { key: String(event.seq ?? index), style: { display: 'flex', gap: 8, alignItems: 'flex-start' } },
                React.createElement('span', { style: ui.badge }, LABEL[event.type] || event.type),
                React.createElement('span', { style: { flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, typeof event.text === 'string' && event.text.length > 0 ? event.text : '· ' + (event.seq ?? '')),
                React.createElement('span', { style: ui.meta }, time(event.time))
              ))
          ),
          React.createElement('div', { style: ui.row },
            React.createElement('input', { style: ui.input, value: draft, placeholder: '给这个会话发一条消息（由对方执行）', onChange: (event) => setDraft(event.target.value) }),
            React.createElement('button', { style: ui.button, disabled: draft.trim() === '', onClick: () => run('send', async () => { const result = await call('/command', { url: target.url, id: target.id, type: 'message', text: draft }); if (result.ok === false) throw new Error(result.error || '发送失败'); setDraft(''); setStatus(result.queued === true ? '已排队，第 ' + (result.position ?? 1) + ' 位，等对方当前回合结束再执行' : '已发送'); }) }, '发送'),
            React.createElement('button', { style: ui.button, onClick: () => run('stop', async () => { const result = await call('/command', { url: target.url, id: target.id, type: 'stop' }); if (result.ok === false) throw new Error(result.error || '停止失败'); setStatus('已请求对方停止'); }) }, '停止对方')
          )
        ) : null
      );
    }

    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'session-sync',
        order: 60,
        label: () => '会话同步',
      }, Section));
    }

    module.exports = { apply, inject: ['slots'] };
    return module.exports;
  },
});
