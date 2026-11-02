window.__ModuleLoader__.load({
  id: 'dsh-session-sync',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require('react');
    const { useState, useEffect, useCallback } = React;
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
      section: { display: 'flex', flexDirection: 'column', gap: 16, padding: '4px 2px 24px', maxWidth: 760 },
      card: { border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.25))', borderRadius: 10, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 },
      title: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      hint: { fontSize: 11, lineHeight: 1.6, color: 'var(--dsw-alias-label-tertiary)' },
      row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      input: { flex: 1, minWidth: 140, fontSize: 12, padding: '5px 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.35))', background: 'transparent', color: 'var(--dsw-alias-label-primary)' },
      button: { fontSize: 12, padding: '5px 10px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.35))', background: 'transparent', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer' },
      list: { display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 280, overflow: 'auto' },
      item: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, padding: '5px 4px', borderBottom: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.12))' },
      name: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      meta: { fontSize: 10, color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap' },
      error: { fontSize: 12, color: 'var(--dsw-alias-label-error, #d9534f)' },
      ok: { color: 'var(--dsw-alias-label-success, #3a9d5d)' },
    };

    function bytes(value) {
      if (!Number.isFinite(value)) return '--';
      if (value < 1024) return value + ' B';
      if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
      return (value / 1024 / 1024).toFixed(1) + ' MB';
    }

    function time(value) {
      if (!value) return '--';
      const date = new Date(value);
      return date.toLocaleString();
    }

    function Section(props) {
      const [state, setState] = useState(null);
      const [error, setError] = useState('');
      const [url, setUrl] = useState('');
      const [busy, setBusy] = useState('');

      const refresh = useCallback(async () => {
        try {
          const next = await call('/state');
          setState(next);
          setError('');
        } catch (cause) {
          setError(String(cause.message || cause));
        }
      }, []);

      useEffect(() => {
        refresh();
        const timer = setInterval(refresh, 3000);
        return () => clearInterval(timer);
      }, [refresh]);

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

      return React.createElement('div', { style: ui.section },
        React.createElement('div', { style: ui.card },
          React.createElement('div', { style: ui.row },
            React.createElement('div', { style: ui.title }, '会话同步（局域网）'),
            React.createElement('span', { style: { flex: 1 } }),
            React.createElement('span', { style: ui.meta }, state.device + ' · ' + (state.lanAddress || '?') + ':' + state.port)
          ),
          React.createElement('div', { style: ui.hint },
            '两端都装本插件后，在一边填对方地址点「连接」即可互相配对：本机会把地址和令牌发给对方，对方自动加入。之后勾选想同步的会话即可实时互传；对方的会话可在下方一键拉取到本地。'
          ),
          React.createElement('div', { style: ui.row },
            React.createElement('label', { style: ui.row },
              React.createElement('input', { type: 'checkbox', checked: state.autoSync, onChange: (event) => run('auto', () => call('/settings', { autoSync: event.target.checked })) }),
              React.createElement('span', { style: ui.hint }, '自动同步')
            ),
            React.createElement('label', { style: ui.row },
              React.createElement('input', { type: 'checkbox', checked: state.allowPair, onChange: (event) => run('pair-perm', () => call('/settings', { allowPair: event.target.checked })) }),
              React.createElement('span', { style: ui.hint }, '允许对方配对')
            ),
            React.createElement('span', { style: { flex: 1 } }),
            React.createElement('button', { style: ui.button, disabled: busy !== '', onClick: () => run('sync', () => call('/sync', {})) }, busy === 'sync' ? '同步中…' : '立即同步'),
            React.createElement('button', { style: ui.button, onClick: refresh }, '刷新')
          ),
          React.createElement('div', { style: ui.row },
            React.createElement('input', { style: ui.input, value: url, placeholder: '对方地址，例如 192.168.1.8:6120', onChange: (event) => setUrl(event.target.value) }),
            React.createElement('button', { style: ui.button, disabled: url.trim() === '' || busy !== '', onClick: () => run('pair', async () => { await call('/pair', { url: url.trim() }); setUrl(''); }) }, busy === 'pair' ? '连接中…' : '连接')
          ),
          React.createElement('div', { style: ui.row },
            React.createElement('span', { style: ui.hint }, '本机令牌/配对码：'),
            React.createElement('code', { style: { fontSize: 10, wordBreak: 'break-all' } }, state.token),
            React.createElement('button', { style: ui.button, onClick: () => { try { navigator.clipboard.writeText(state.token); } catch (cause) { /* ignore */ } } }, '复制')
          ),
          error ? React.createElement('div', { style: ui.error }, error) : null
        ),

        React.createElement('div', { style: ui.card },
          React.createElement('div', { style: ui.title }, '已配对设备'),
          (state.peers || []).length === 0
            ? React.createElement('div', { style: ui.hint }, '还没有配对设备。在上面填对方地址点「连接」即可。')
            : React.createElement('div', { style: ui.list },
              state.peers.map((peer) => React.createElement('div', { key: peer.url, style: ui.item },
                React.createElement('span', { style: peer.ok ? ui.ok : ui.error }, peer.ok ? '●' : '○'),
                React.createElement('span', { style: ui.name }, peer.url),
                React.createElement('span', { style: ui.meta }, peer.ok ? '在线 · ' + time(peer.lastSeen) : (peer.error || '离线')),
                React.createElement('button', { style: ui.button, onClick: () => run('remove', () => call('/peer', { remove: peer.url })) }, '删除')
              ))
            )
        ),

        React.createElement('div', { style: ui.card },
          React.createElement('div', { style: ui.row },
            React.createElement('div', { style: ui.title }, '本地会话'),
            React.createElement('span', { style: ui.meta }, '已勾选 ' + enabledCount + ' / ' + state.sessions.length)
          ),
          React.createElement('div', { style: ui.hint }, '只有勾选的会话会推送出去；取消勾选后本机不再推送，也不再接收对方对这个会话的更新。'),
          state.sessions.length === 0
            ? React.createElement('div', { style: ui.hint }, '本机还没有会话。')
            : React.createElement('div', { style: ui.list },
              state.sessions.map((session) => React.createElement('label', { key: session.id, style: ui.item },
                React.createElement('input', { type: 'checkbox', checked: session.enabled, onChange: (event) => run(session.id, () => call('/toggle', { id: session.id, enabled: event.target.checked })) }),
                React.createElement('span', { style: ui.name, title: session.cwd || session.group }, (session.title || '(无标题)') + ' · ' + session.id.slice(8, 16)),
                React.createElement('span', { style: ui.meta }, bytes(session.size)),
                React.createElement('span', { style: ui.meta }, time(session.mtime))
              ))
            )
        ),

        (state.remote || []).length > 0 ? React.createElement('div', { style: ui.card },
          React.createElement('div', { style: ui.title }, '对方设备上的会话'),
          React.createElement('div', { style: ui.hint }, '这些是对方勾选共享的会话。点「拉取」会把对方当前的会话文件写到本地（之后按对方更新继续跟随）。'),
          (state.remote || []).map((group) => React.createElement('div', { key: group.url, style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            React.createElement('div', { style: ui.meta }, group.url + (group.ok ? '' : ' · 离线')),
            (group.sessions || []).length === 0
              ? React.createElement('div', { style: ui.hint }, '对方暂时没有共享的会话。')
              : React.createElement('div', { style: ui.list },
                (group.sessions || []).map((session) => React.createElement('div', { key: session.id, style: ui.item },
                  React.createElement('span', { style: ui.name, title: session.cwd || session.group }, (session.title || '(无标题)') + ' · ' + session.id.slice(8, 16)),
                  React.createElement('span', { style: ui.meta }, bytes(session.size)),
                  React.createElement('span', { style: ui.meta }, localIds.has(session.id) ? '已在本机' : '未拉取'),
                  React.createElement('button', { style: ui.button, onClick: () => run(session.id, () => call('/pull', { id: session.id, url: group.url })) }, '拉取')
                ))
              )
          ))
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
