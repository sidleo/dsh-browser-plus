window.__ModuleLoader__.load({
  id: '@sidleo3/dsh-browser-plus',
  factory: (require) => {
    const React = require('react');
    const e = React.createElement;

    /** 以调试端口重启 DSH 的命令（macOS）。 */
    /** 页面静默刷新间隔（毫秒）。 */
    const REFRESH_MS = 4000;

    const CSS = `
.bpRoot { display:flex; flex-direction:column; gap:12px; max-width:760px; color:var(--dsw-alias-label-primary); font:var(--dsw-font-xs-13) }
.bpHead { display:flex; flex-direction:column; gap:4px }
.bpTitle { margin:0; font-size:18px; font-weight:600; line-height:1.4; color:var(--dsw-alias-label-primary) }
.bpIntro { margin:0; font:var(--dsw-font-xxs-12); color:var(--dsw-alias-label-tertiary) }
.bpCard { display:flex; flex-direction:column; gap:8px; padding:12px 14px; border:1px solid var(--dsw-alias-border-l2); border-radius:var(--dsw-radius-md, 12px); background:var(--dsw-alias-bg-layer-2) }
.bpCardHead { display:flex; align-items:center; gap:8px; min-width:0 }
.bpCardTitle { margin:0; font:var(--dsw-font-xs-13); font-weight:600; color:var(--dsw-alias-label-primary) }
.bpCardExtra { display:flex; align-items:center; gap:8px; margin-left:auto; flex-wrap:wrap; justify-content:flex-end }
.bpRow { display:flex; align-items:center; flex-wrap:wrap; gap:8px; min-width:0 }
.bpHint { margin:0; font:var(--dsw-font-xxxs-11); line-height:1.55; color:var(--dsw-alias-label-tertiary); word-break:break-word }
.bpWarn { margin:0; font:var(--dsw-font-xxs-12); line-height:1.55; color:var(--dsw-alias-state-warn-primary); word-break:break-word }
.bpErr { margin:0; font:var(--dsw-font-xxs-12); line-height:1.55; color:var(--dsw-alias-state-error-primary); white-space:pre-wrap; word-break:break-word }
.bpOk { margin:0; font:var(--dsw-font-xxs-12); line-height:1.55; color:var(--dsw-alias-state-success-primary) }
.bpDot { flex:none; width:8px; height:8px; border-radius:999px; background:var(--dsw-alias-label-tertiary) }
.bpDotOn { background:var(--dsw-alias-state-success-primary) }
.bpDotWarn { background:var(--dsw-alias-state-warn-primary) }
.bpBadge { flex:none; font:var(--dsw-font-xxxs-11); padding:1px 7px; border-radius:999px; border:1px solid var(--dsw-alias-border-l2); color:var(--dsw-alias-label-tertiary); white-space:nowrap }
.bpBadgeOn { color:var(--dsw-alias-state-success-primary); border-color:var(--dsw-alias-state-success-primary) }
.bpBadgeWarn { color:var(--dsw-alias-state-warn-primary); border-color:var(--dsw-alias-state-warn-primary) }
.bpBtn { appearance:none; font:var(--dsw-font-xxs-12); font-weight:500; padding:5px 10px; border:1px solid var(--dsw-alias-border-l2); border-radius:var(--dsw-radius-sm); background:var(--dsw-alias-bg-layer-3); color:var(--dsw-alias-label-secondary); cursor:pointer; white-space:nowrap }
.bpBtn:hover:not(:disabled) { color:var(--dsw-alias-label-primary); border-color:var(--dsw-alias-label-dimmed) }
.bpBtn:disabled { opacity:.45; cursor:default }
.bpBtnPrimary, .bpBtnPrimary:hover:not(:disabled) { background:var(--dsw-alias-label-primary); color:var(--dsw-alias-bg-layer-3); border-color:transparent }
.bpBtnPrimary:hover:not(:disabled) { opacity:.85 }
.bpInput { box-sizing:border-box; min-width:0; padding:5px 8px; border:1px solid var(--dsw-alias-border-l2); border-radius:var(--dsw-radius-sm); background:var(--dsw-alias-bg-layer-3); color:var(--dsw-alias-label-primary); font:var(--dsw-font-xxs-12) }
.bpInput:disabled { opacity:.6 }
select.bpInput { max-width:260px }
.bpTextarea { width:100%; min-height:78px; resize:vertical; line-height:1.6 }
.bpField { display:flex; flex-direction:column; gap:3px; min-width:0 }
.bpLabel { font:var(--dsw-font-xxs-12); color:var(--dsw-alias-label-secondary) }
.bpGrid { display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:8px 12px }
.bpChoices { display:flex; flex-direction:column; gap:5px }
.bpCheck { display:flex; align-items:flex-start; gap:6px; font:var(--dsw-font-xxs-12); color:var(--dsw-alias-label-secondary); cursor:pointer }
.bpCheck input { flex:none; margin:2px 0 0 }
.bpStats { display:grid; grid-template-columns:repeat(auto-fit, minmax(150px, 1fr)); gap:6px 12px; margin:0 }
.bpStat { display:flex; flex-direction:column; gap:1px; min-width:0 }
.bpStatLabel { font:var(--dsw-font-xxxs-11); color:var(--dsw-alias-label-tertiary) }
.bpStatValue { font:var(--dsw-font-xxs-12); color:var(--dsw-alias-label-primary); word-break:break-word }
.bpTargets { display:flex; flex-direction:column; gap:4px; list-style:none; margin:0; padding:0 }
.bpTarget { display:flex; align-items:baseline; gap:8px; min-width:0; padding:4px 0; border-top:1px solid var(--dsw-alias-border-l2) }
.bpTarget:first-child { border-top:none }
.bpTargetUrl { flex:1; min-width:0; font:var(--dsw-font-xxxs-11); font-family:var(--ds-font-family-code, ui-monospace, Menlo, Consolas, monospace); line-height:1.6; color:var(--dsw-alias-label-secondary); word-break:break-all }
.bpTargetMeta { flex:none; font:var(--dsw-font-xxxs-11); color:var(--dsw-alias-label-tertiary) }
.bpTargetMetaOk { color:var(--dsw-alias-state-success-primary) }
.bpTargetMetaErr { color:var(--dsw-alias-state-error-primary) }
.bpChips { display:flex; flex-wrap:wrap; gap:4px }
.bpChip { font:var(--dsw-font-xxxs-11); padding:1px 7px; border:1px solid var(--dsw-alias-border-l2); border-radius:999px; color:var(--dsw-alias-label-tertiary); white-space:nowrap }
.bpSecurity { margin:0; padding:8px 10px; border:1px dashed var(--dsw-alias-border-l3); border-radius:var(--dsw-radius-sm); background:var(--dsw-alias-bg-layer-2); font:var(--dsw-font-xxs-12); line-height:1.6; color:var(--dsw-alias-label-tertiary) }
`;

    function injectStyles() {
      if (typeof document === 'undefined') return;
      if (document.querySelector('style[data-browser-plus]')) return;
      const tag = document.createElement('style');
      tag.setAttribute('data-browser-plus', '');
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    const api = async (path, init) => {
      const res = await fetch('/api/browser-plus' + path, {
        headers: { 'content-type': 'application/json' },
        ...init,
      });
      let body = null;
      try {
        body = await res.json();
      } catch {}
      if (!res.ok || (body && body.ok === false)) throw new Error((body && body.error) || ('HTTP ' + res.status));
      return body;
    };
    const post = (path, payload) => api(path, { method: 'POST', body: JSON.stringify(payload || {}) });

    function errText(error) {
      return error && error.message ? error.message : String(error);
    }

    function pad2(n) {
      return n < 10 ? '0' + n : String(n);
    }

    /** 时间显示：兼容毫秒数、秒数与 ISO 字符串；无法解析时原样显示。 */
    function fmtTime(value) {
      if (value === undefined || value === null || value === '') return '—';
      let stamp = typeof value === 'number' ? value : Date.parse(String(value));
      if (!Number.isFinite(stamp)) {
        const num = Number(value);
        if (Number.isFinite(num) && num > 0) stamp = num < 1e12 ? num * 1000 : num;
      }
      if (!Number.isFinite(stamp)) return String(value);
      const d = new Date(stamp);
      if (Number.isNaN(d.getTime())) return String(value);
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
    }

    function fmtNum(value) {
      return typeof value === 'number' && Number.isFinite(value) ? String(value) : '—';
    }

    function bridgeSourceLabel(source) {
      if (source === 'configured') return '手动配置的端口';
      if (source === 'user-data-dir') return 'DevToolsActivePort 文件';
      if (source === 'scan') return '本机端口探测';
      return '未知';
    }

    function draftFromSettings(settings) {
      const source = settings && typeof settings === 'object' ? settings : {};
      const domains = Array.isArray(source.domains)
        ? source.domains.filter((d) => typeof d === 'string' || typeof d === 'number').map(String)
        : [];
      return {
        browser: typeof source.browser === 'string' && source.browser ? source.browser : 'auto',
        profile: typeof source.profile === 'string' ? source.profile : '',
        scope: source.scope === 'allowlist' ? 'allowlist' : 'all',
        domainsText: domains.join('\n'),
        includeSessionCookies: source.includeSessionCookies !== false,
        autoInject: source.autoInject !== false,
        autoBridge: source.autoBridge !== false,
        reloadAfterInject: source.reloadAfterInject !== false,
        refreshSeconds: typeof source.refreshSeconds === 'number' && Number.isFinite(source.refreshSeconds) ? String(source.refreshSeconds) : '60',
      };
    }

    /** 校验并构造 POST /settings 的 patch；返回字符串表示本地校验失败原因。 */
    function buildPatch(draft) {
      const rawDomains = String(draft.domainsText || '').split(/[\n,，;；]+/);
      const domains = [];
      for (const item of rawDomains) {
        const value = item.trim();
        if (value && domains.indexOf(value) < 0) domains.push(value);
      }
      if (draft.scope === 'allowlist' && domains.length === 0) {
        return '共享范围为「仅指定域名」时，请至少填写一个域名（每行一个）。';
      }
      const seconds = Number(String(draft.refreshSeconds === undefined || draft.refreshSeconds === null ? '' : draft.refreshSeconds).trim());
      if (!Number.isFinite(seconds) || seconds < 10 || seconds > 3600) {
        return '自动注入检查间隔需为 10–3600 之间的数字（秒）。';
      }
      return {
        browser: draft.browser,
        profile: draft.profile,
        scope: draft.scope === 'allowlist' ? 'allowlist' : 'all',
        domains,
        includeSessionCookies: draft.includeSessionCookies === true,
        autoInject: draft.autoInject === true,
        autoBridge: draft.autoBridge === true,
        reloadAfterInject: draft.reloadAfterInject === true,
        refreshSeconds: Math.round(seconds),
      };
    }

    function isDraftDirty(draft, settings) {
      if (!draft || !settings) return false;
      const base = draftFromSettings(settings);
      const keys = ['browser', 'profile', 'scope', 'domainsText', 'includeSessionCookies', 'autoInject', 'autoBridge', 'reloadAfterInject', 'refreshSeconds'];
      return keys.some((key) => draft[key] !== base[key]);
    }

    function Card(props) {
      return e(
        'section',
        { className: 'bpCard' },
        e(
          'div',
          { className: 'bpCardHead' },
          e('h3', { className: 'bpCardTitle' }, props.title),
          props.extra ? e('div', { className: 'bpCardExtra' }, props.extra) : null,
        ),
        props.children,
      );
    }

    function Hint(props) {
      const tone = props.tone;
      const cls = tone === 'warn' ? 'bpWarn' : tone === 'error' ? 'bpErr' : tone === 'ok' ? 'bpOk' : 'bpHint';
      return e('p', { className: cls }, props.text);
    }

    function Field(props) {
      return e(
        'div',
        { className: 'bpField' },
        e('span', { className: 'bpLabel' }, props.label),
        e('input', {
          className: 'bpInput',
          type: props.type || 'text',
          value: props.value === undefined || props.value === null ? '' : String(props.value),
          placeholder: props.placeholder || '',
          min: props.min,
          max: props.max,
          step: props.step,
          disabled: props.disabled === true,
          onChange: (ev) => props.onChange(ev.target.value),
        }),
        props.hint ? e('span', { className: 'bpHint' }, props.hint) : null,
      );
    }

    function Select(props) {
      const options = Array.isArray(props.options) ? props.options : [];
      return e(
        'div',
        { className: 'bpField' },
        e('span', { className: 'bpLabel' }, props.label),
        e(
          'select',
          {
            className: 'bpInput',
            value: props.value === undefined || props.value === null ? '' : String(props.value),
            disabled: props.disabled === true,
            onChange: (ev) => props.onChange(ev.target.value),
          },
          options.map((option, index) => e('option', { key: String(option.value) + '#' + index, value: option.value }, option.label)),
        ),
        props.hint ? e('span', { className: 'bpHint' }, props.hint) : null,
      );
    }

    function Check(props) {
      return e(
        'label',
        { className: 'bpCheck' },
        e('input', {
          type: 'checkbox',
          checked: props.checked === true,
          disabled: props.disabled === true,
          onChange: (ev) => props.onChange(ev.target.checked),
        }),
        e('span', null, props.label, props.hint ? e('span', { className: 'bpHint' }, '　' + props.hint) : null),
      );
    }

    function Radio(props) {
      return e(
        'label',
        { className: 'bpCheck' },
        e('input', {
          type: 'radio',
          name: props.name,
          checked: props.checked === true,
          disabled: props.disabled === true,
          onChange: () => props.onChange(props.value),
        }),
        e('span', null, props.label, props.hint ? e('span', { className: 'bpHint' }, '　' + props.hint) : null),
      );
    }

    function Stat(props) {
      return e('div', { className: 'bpStat' }, e('span', { className: 'bpStatLabel' }, props.label), e('span', { className: 'bpStatValue' }, props.value));
    }

    /** 设置区块与插件页共用同一组件（`head` 只在前者渲染标题）。 */
    function BrowserPlusPage(props) {
      const [state, setState] = React.useState(null);
      const [draft, setDraft] = React.useState(null);
      const [loadErr, setLoadErr] = React.useState('');
      const [notice, setNotice] = React.useState('');
      const [busy, setBusy] = React.useState('');
      const [bridgeErr, setBridgeErr] = React.useState('');
      const [sourceErr, setSourceErr] = React.useState('');
      const [saveErr, setSaveErr] = React.useState('');
      const [actionErr, setActionErr] = React.useState('');
      const draftInitRef = React.useRef(false);

      // 首屏加载一次；之后每 4 秒静默刷新状态。静默刷新只更新 state，绝不覆盖本地草稿。
      React.useEffect(() => {
        let alive = true;
        let inflight = false;
        let loadedOnce = false;
        const pull = async () => {
          if (inflight) return;
          inflight = true;
          try {
            const next = await api('/state?refresh=1');
            if (!alive) return;
            loadedOnce = true;
            setState(next);
            if (!draftInitRef.current) {
              draftInitRef.current = true;
              setDraft(draftFromSettings(next && next.settings));
            }
            setLoadErr('');
          } catch (error) {
            if (alive && !loadedOnce) setLoadErr(errText(error));
          } finally {
            inflight = false;
          }
        };
        pull();
        const timer = setInterval(pull, REFRESH_MS);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, []);

      const run = React.useCallback(async (name, fn, report) => {
        setBusy(name);
        setNotice('');
        try {
          await fn();
        } catch (error) {
          if (report) report(errText(error));
        } finally {
          setBusy('');
        }
      }, []);

      const patchDraft = (part) => setDraft((current) => (current ? { ...current, ...part } : current));

      const reload = () =>
        run(
          'reload',
          async () => {
            const next = await api('/state?refresh=1');
            setState(next);
            if (!draftInitRef.current) {
              draftInitRef.current = true;
              setDraft(draftFromSettings(next && next.settings));
            }
            setLoadErr('');
          },
          setLoadErr,
        );

      const trigger = (action, report, name) =>
        run(
          name || action,
          async () => {
            const res = await post('/action', { action });
            if (res && res.state) setState(res.state);
            if (report) report('');
            setNotice((res && res.message) || '操作完成');
          },
          report,
        );

      const saveSettings = () => {
        if (!draft) return;
        const patch = buildPatch(draft);
        if (typeof patch === 'string') {
          setSaveErr(patch);
          setNotice('');
          return;
        }
        run(
          'save',
          async () => {
            const res = await post('/settings', { patch });
            if (res && res.settings) {
              draftInitRef.current = true;
              setDraft(draftFromSettings(res.settings));
            }
            setSaveErr('');
            setNotice('设置已保存');
            try {
              const next = await api('/state?refresh=1');
              setState(next);
            } catch {
              // 保存已经成功，刷新失败不覆盖成功提示。
            }
          },
          setSaveErr,
        );
      };

      const settings = state && state.settings && typeof state.settings === 'object' ? state.settings : null;
      const bridge = state && state.bridge && typeof state.bridge === 'object' ? state.bridge : null;
      const bridgeAvailable = Boolean(bridge && bridge.available === true);
      const bridgeTargets = bridge && Array.isArray(bridge.targets) ? bridge.targets : [];
      const platform = state && state.platform && typeof state.platform === 'object' ? state.platform : null;
      const jar = state && state.jar && typeof state.jar === 'object' ? state.jar : null;
      const lastInject = state && state.lastInject && typeof state.lastInject === 'object' ? state.lastInject : null;
      const activeSource = state && state.activeSource && typeof state.activeSource === 'object' ? state.activeSource : null;
      const browsers = state && Array.isArray(state.browsers) ? state.browsers : [];
      const installed = browsers.filter((browser) => browser && browser.installed === true);
      const autoInjectOn = Boolean(settings && settings.autoInject === true);
      const autoBridgeState = state && state.autoBridge && typeof state.autoBridge === 'object' ? state.autoBridge : null;
      const autoBridgeActionLabels = {
        pending: '等待自检',
        'already-ported': '本次启动已带调试端口',
        skip: '本次未自动重启',
        relaunching: '已自动带端口重启',
        failed: '自动重启失败',
        error: '自检失败',
      };
      const controlsDisabled = !draft || busy !== '';
      const dirty = isDraftDirty(draft, settings);

      const draftBrowser = draft ? draft.browser : 'auto';
      const draftProfile = draft ? draft.profile : '';
      const currentBrowser = installed.find((browser) => browser && browser.id === draftBrowser) || null;
      const profileList = currentBrowser && Array.isArray(currentBrowser.profiles) ? currentBrowser.profiles : [];
      const browserOptions = [{ value: 'auto', label: '自动（优先 Edge，其次 Chrome）' }].concat(
        installed
          .filter((browser) => browser && browser.id)
          .map((browser) => ({ value: browser.id, label: browser.name || browser.id })),
      );
      if (draft && draftBrowser && !browserOptions.some((option) => option.value === draftBrowser)) {
        browserOptions.push({ value: draftBrowser, label: draftBrowser + '（当前设置，未检测到）' });
      }
      const profileOptions = [{ value: '', label: '默认配置（Default）' }].concat(
        profileList
          .filter((profile) => profile && profile.id)
          .map((profile) => ({
            value: profile.id,
            label: (profile.name || profile.id) + (typeof profile.cookieCount === 'number' ? '（' + profile.cookieCount + ' 条 cookie）' : ''),
          })),
      );
      if (draft && draftProfile && !profileOptions.some((option) => option.value === draftProfile)) {
        profileOptions.push({ value: draftProfile, label: draftProfile + '（当前设置）' });
      }

      const sourceLabel = activeSource && activeSource.label ? String(activeSource.label) : '';
      const fallbackSourceLabel = settings ? String(settings.browser || 'auto') + (settings.profile ? ' / ' + settings.profile : '') : '';
      const keychain = platform && platform.keychain ? String(platform.keychain) : 'unknown';

      const head = props.head === false
        ? null
        : e(
            'div',
            { className: 'bpHead' },
            e('h2', { className: 'bpTitle' }, '浏览器 Cookie 同步'),
            e(
              'p',
              { className: 'bpIntro' },
              '读取本机 Chrome / Edge 的登录 Cookie，通过本机 CDP 调试桥注入 DSH 内置浏览器分区，免去重复登录；侧栏「插件」页也可打开同一设置。',
            ),
          );

      const loadErrLine = loadErr
        ? e(
            'div',
            { className: 'bpCard' },
            e(Hint, { tone: 'error', text: '读取状态失败：' + loadErr }),
            e(
              'div',
              { className: 'bpRow' },
              e('button', { className: 'bpBtn', disabled: busy !== '', onClick: reload }, busy === 'reload' ? '重试中…' : '重试'),
            ),
          )
        : null;

      const noticeLine = notice ? e(Hint, { tone: 'ok', text: '✓ ' + notice }) : null;

      /** 「自动启用桥接」这一行的说明：把上次失败/重试原因讲清楚，避免用户只看到"未连接"。 */
      const autoBridgeHint = (() => {
        if (!autoBridgeState) return null;
        const attempted = Number(autoBridgeState.attempts) > 0 ? `（第 ${autoBridgeState.attempts} 次）` : '';
        const failed = autoBridgeState.lastOutcome === 'failed' || autoBridgeState.action === 'failed' || autoBridgeState.action === 'error';
        let detail = '';
        if (autoBridgeState.reason === 'recent-attempt') {
          detail = failed
            ? '（上次自动重启没有把调试端口带起来；本实例保持现状，下次启动会自动重试）'
            : '（刚自动重启过，本次跳过以避免循环）';
        } else if (autoBridgeState.reason === 'max-attempts') {
          detail = '（连续多次未成功，进入冷却；下次启动会再自动尝试）';
        } else if (autoBridgeState.reason === 'retry-after-failure') {
          detail = '（上次未成功，本次自动重试）';
        } else if (autoBridgeState.reason === 'cooldown-expired') {
          detail = '（冷却结束，重新自动尝试）';
        } else if (autoBridgeState.reason === 'missing-debug-port') {
          detail = '（当前实例未带调试端口，正在自动处理）';
        }
        return {
          tone: failed ? 'warn' : undefined,
          text:
            '自动启用桥接：' +
            (autoBridgeState.enabled === false ? '已关闭' : '开') +
            ' · ' +
            (autoBridgeActionLabels[autoBridgeState.action] || autoBridgeState.action) +
            attempted +
            detail +
            (autoBridgeState.error ? '：' + autoBridgeState.error : ''),
        };
      })();

      const bridgeCard = e(
        Card,
        {
          title: '桥接状态',
          extra: e(
            'div',
            { className: 'bpRow' },
            e('span', { className: 'bpBadge' + (bridgeAvailable ? ' bpBadgeOn' : ' bpBadgeWarn') }, bridgeAvailable ? '已连接' : '未连接'),
            e(
              'button',
              { className: 'bpBtn', disabled: busy !== '', onClick: () => trigger('rescan', setBridgeErr, 'rescan-bridge') },
              busy === 'rescan-bridge' ? '检测中…' : '重新检测',
            ),
          ),
        },
        autoBridgeHint ? e(Hint, autoBridgeHint) : null,
        bridgeAvailable
          ? e(
              'div',
              null,
              e(
                'div',
                { className: 'bpRow' },
                e('span', { className: 'bpDot bpDotOn' }),
                e(
                  'span',
                  { className: 'bpStatValue' },
                  'CDP 已连接 · 端口 ' + fmtNum(bridge.port) + ' · 当前 ' + bridgeTargets.length + ' 个浏览标签',
                ),
              ),
              e(Hint, {
                text:
                  '发现方式：' + bridgeSourceLabel(bridge.source) + (bridge.checkedAt ? ' · 最近检测 ' + fmtTime(bridge.checkedAt) : ''),
              }),
              bridgeTargets.length
                ? e(
                    'ul',
                    { className: 'bpTargets' },
                    bridgeTargets.slice(0, 5).map((target, index) =>
                      e(
                        'li',
                        { className: 'bpTarget', key: (target && target.id) || String(index) },
                        e('span', { className: 'bpTargetUrl' }, (target && target.url) || '（空白页）'),
                        e('span', { className: 'bpTargetMeta' }, (target && target.title) || ''),
                      ),
                    ),
                  )
                : e(Hint, { text: '还没有打开内置浏览器标签；在右侧栏打开 Browser 标签后即可注入。' }),
              bridgeTargets.length > 5 ? e(Hint, { text: '另有 ' + (bridgeTargets.length - 5) + ' 个标签未列出。' }) : null,
              bridge.userDataDir ? e(Hint, { text: 'userDataDir：' + bridge.userDataDir }) : null,
            )
          : e(
              'div',
              null,
              e(
                'div',
                { className: 'bpRow' },
                e('span', { className: 'bpDot bpDotWarn' }),
                e('span', { className: 'bpStatValue' }, '未连接内置浏览器调试端口'),
              ),
              e(Hint, {
                tone: 'warn',
                text:
                  bridge && (bridge.error || bridge.hint)
                    ? bridge.error || bridge.hint
                    : '内置浏览器的 Cookie 注入需要 DSH 以调试端口（--remote-debugging-port）启动。',
              }),
              e(Hint, {
                text:
                  '插件会在 DSH 启动时自动处理：检测到本次启动没带调试端口，就自动带端口重启一次（窗口关掉几秒后自动回来），无需手动操作；失败时本实例保持可用，下次启动会自动重试。',
              }),
              e(Hint, { text: '调试端口只监听本机 127.0.0.1；日志：$DSH_HOME/browser-plus/relaunch.log' }),
              bridge && bridge.error && bridge.hint ? e(Hint, { text: bridge.hint }) : null,
            ),
        bridgeErr ? e(Hint, { tone: 'error', text: bridgeErr }) : null,
      );

      const sourceCard = e(
        Card,
        {
          title: 'Cookie 来源',
          extra: e(
            'button',
            { className: 'bpBtn', disabled: busy !== '', onClick: () => trigger('rescan', setSourceErr, 'rescan-source') },
            busy === 'rescan-source' ? '扫描中…' : '重新扫描',
          ),
        },
        e(
          'div',
          { className: 'bpGrid' },
          e(Select, {
            label: '浏览器',
            value: draftBrowser,
            disabled: controlsDisabled,
            options: browserOptions,
            onChange: (value) => patchDraft({ browser: value, profile: '' }),
            hint: installed.length ? '只列出检测到 cookie 数据库的浏览器' : '未检测到已安装的 Chrome / Edge，请先打开一次浏览器',
          }),
          e(Select, {
            label: '用户配置（profile）',
            value: draftProfile,
            disabled: controlsDisabled,
            options: profileOptions,
            onChange: (value) => patchDraft({ profile: value }),
            hint: '「默认配置」即该浏览器的 Default 配置；多用户配置可指定',
          }),
        ),
        e(Hint, { text: '当前来源：' + (sourceLabel || fallbackSourceLabel || '尚未扫描') }),
        currentBrowser && currentBrowser.dataDir ? e(Hint, { text: '数据目录：' + currentBrowser.dataDir }) : null,
        keychain === 'denied'
          ? e(Hint, { tone: 'warn', text: '钥匙串访问被拒绝：请在系统钥匙串弹窗中点「允许」，然后点「重新扫描」。' })
          : e(Hint, { text: '钥匙串（解密密钥）：' + (keychain === 'ok' ? '可用' : '未知，首次读取时 macOS 可能弹窗') }),
        platform && platform.supported === false ? e(Hint, { tone: 'warn', text: platform.note || '当前系统暂不支持自动解密浏览器 Cookie（v1 仅支持 macOS）。' }) : null,
        platform && platform.note && platform.supported !== false ? e(Hint, { text: platform.note }) : null,
        sourceErr ? e(Hint, { tone: 'error', text: '操作失败：' + sourceErr }) : null,
      );

      const scopeCard = e(
        Card,
        {
          title: '共享范围',
          extra: dirty ? e('span', { className: 'bpChip' }, '有未保存的修改') : null,
        },
        e(
          'div',
          { className: 'bpChoices' },
          e(Radio, {
            name: 'bp-scope',
            value: 'all',
            checked: Boolean(draft) && draft.scope === 'all',
            disabled: controlsDisabled,
            onChange: () => patchDraft({ scope: 'all' }),
            label: '全部 cookie',
            hint: '当前浏览器配置里的 cookie 全部注入',
          }),
          e(Radio, {
            name: 'bp-scope',
            value: 'allowlist',
            checked: Boolean(draft) && draft.scope === 'allowlist',
            disabled: controlsDisabled,
            onChange: () => patchDraft({ scope: 'allowlist' }),
            label: '仅指定域名',
            hint: '按域名后缀匹配，例如 .example.com 会匹配 a.example.com',
          }),
        ),
        draft && draft.scope === 'allowlist'
          ? e(
              'div',
              { className: 'bpField' },
              e('span', { className: 'bpLabel' }, '域名白名单（每行一个）'),
              e('textarea', {
                className: 'bpInput bpTextarea',
                value: draft.domainsText,
                disabled: controlsDisabled,
                placeholder: '.example.com\n.example.org',
                onChange: (ev) => patchDraft({ domainsText: ev.target.value }),
              }),
              e('span', { className: 'bpHint' }, '支持带前导点（含子域）或不带点（后缀匹配）；也接受逗号分隔。'),
            )
          : null,
        e(
          'div',
          { className: 'bpGrid' },
          e(Field, {
            label: '自动注入检查间隔（秒）',
            type: 'number',
            min: 10,
            max: 3600,
            step: 1,
            value: draft ? draft.refreshSeconds : '60',
            disabled: controlsDisabled,
            onChange: (value) => patchDraft({ refreshSeconds: value }),
            hint: '10–3600 秒；Cookie 数据库没有变化时不会真正重读',
          }),
        ),
        e(
          'div',
          { className: 'bpChoices' },
          e(Check, {
            checked: Boolean(draft) && draft.includeSessionCookies === true,
            disabled: controlsDisabled,
            onChange: (value) => patchDraft({ includeSessionCookies: value }),
            label: '包含会话 cookie',
            hint: '关闭后只注入带过期时间的持久 cookie',
          }),
          e(Check, {
            checked: Boolean(draft) && draft.autoInject === true,
            disabled: controlsDisabled,
            onChange: (value) => patchDraft({ autoInject: value }),
            label: '自动注入新标签页',
            hint: '轮询新出现的内置浏览器标签并自动注入',
          }),
          e(Check, {
            checked: Boolean(draft) && draft.reloadAfterInject === true,
            disabled: controlsDisabled,
            onChange: (value) => patchDraft({ reloadAfterInject: value }),
            label: '注入后重新加载页面',
            hint: '首次注入已打开的页面时刷新一次，让登录态立即生效',
          }),
          e(Check, {
            checked: Boolean(draft) && draft.autoBridge === true,
            disabled: controlsDisabled,
            onChange: (value) => patchDraft({ autoBridge: value }),
            label: '正常启动时自动启用桥接',
            hint: 'DSH 未带调试端口启动时，自动退出并带端口重开一次（无需任何操作）',
          }),
        ),
        e(
          'div',
          { className: 'bpRow' },
          e('button', { className: 'bpBtn bpBtnPrimary', disabled: busy !== '' || !draft, onClick: saveSettings }, busy === 'save' ? '保存中…' : '保存设置'),
          e(Hint, { text: dirty ? '修改尚未保存' : '设置已与当前状态一致' }),
        ),
        saveErr ? e(Hint, { tone: 'error', text: saveErr }) : null,
      );

      const injectTargets = lastInject && Array.isArray(lastInject.targets) ? lastInject.targets : [];
      const hasLastInject = Boolean(lastInject && (lastInject.at || lastInject.error || injectTargets.length));

      const statusCard = e(
        Card,
        {
          title: '状态与操作',
          extra: e(
            'span',
            { className: 'bpBadge' + (autoInjectOn ? ' bpBadgeOn' : '') },
            settings ? (autoInjectOn ? '自动注入已开启' : '自动注入已关闭') : '自动注入状态未知',
          ),
        },
        jar && jar.loaded
          ? e(
              'div',
              { className: 'bpField' },
              e(
                'div',
                { className: 'bpStats' },
                e(Stat, { label: 'Cookie 条数', value: fmtNum(jar.count) }),
                e(Stat, { label: '域名数', value: fmtNum(jar.domainCount) }),
                e(Stat, { label: 'HttpOnly', value: fmtNum(jar.httpOnly) }),
                e(Stat, { label: '会话 cookie', value: fmtNum(jar.session) }),
                e(Stat, { label: 'Secure', value: fmtNum(jar.secure) }),
                e(Stat, { label: '读取耗时', value: typeof jar.durationMs === 'number' ? jar.durationMs + ' ms' : '—' }),
                e(Stat, { label: '来源', value: (jar.browser || '—') + (jar.profile ? ' / ' + jar.profile : '') }),
                e(Stat, { label: '读取时间', value: fmtTime(jar.loadedAt) }),
              ),
              jar.topDomains && Array.isArray(jar.topDomains) && jar.topDomains.length
                ? e(
                    'div',
                    { className: 'bpChips' },
                    jar.topDomains.slice(0, 8).map((item, index) =>
                      e('span', { className: 'bpChip', key: (item && item.domain) || String(index) }, ((item && item.domain) || '?') + ' ' + fmtNum(item && item.count)),
                    ),
                  )
                : null,
            )
          : e(Hint, { text: '尚未读取 Cookie；点「立即同步并注入」会读取并注入，也可点「仅注入」复用现有 jar。' }),
        jar && jar.error ? e(Hint, { tone: 'error', text: 'jar 读取失败：' + jar.error }) : null,
        e(
          'div',
          { className: 'bpRow' },
          e(
            'button',
            { className: 'bpBtn bpBtnPrimary', disabled: busy !== '', onClick: () => trigger('sync', setActionErr, 'sync') },
            busy === 'sync' ? '同步并注入中…' : '立即同步并注入',
          ),
          e(
            'button',
            { className: 'bpBtn', disabled: busy !== '', onClick: () => trigger('inject', setActionErr, 'inject') },
            busy === 'inject' ? '注入中…' : '仅注入（用现有 jar）',
          ),
        ),
        hasLastInject
          ? e(
              'div',
              { className: 'bpField' },
              e(
                'div',
                { className: 'bpRow' },
                e('span', { className: 'bpDot ' + (lastInject.ok ? 'bpDotOn' : 'bpDotWarn') }),
                e(
                  'span',
                  { className: 'bpStatValue' },
                  '上次注入：' + fmtTime(lastInject.at) + ' · ' + (lastInject.ok ? '成功 ' + fmtNum(lastInject.count) + ' 条' : '未成功'),
                ),
              ),
              injectTargets.length
                ? e(
                    'ul',
                    { className: 'bpTargets' },
                    injectTargets.map((target, index) =>
                      e(
                        'li',
                        { className: 'bpTarget', key: (target && target.id) || String(index) },
                        e('span', { className: 'bpTargetUrl' }, (target && target.url) || '（未命名标签）'),
                        e(
                          'span',
                          { className: 'bpTargetMeta ' + (target && target.ok ? 'bpTargetMetaOk' : 'bpTargetMetaErr') },
                          target && target.ok
                            ? '注入 ' + fmtNum(target.count) + ' 条' + (target.reloaded ? ' · 已刷新' : '')
                            : (target && target.error) || '失败',
                        ),
                      ),
                    ),
                  )
                : e(Hint, { text: '没有可注入的内置浏览器标签：需要先在右侧栏打开 Browser 标签。' }),
              lastInject.error ? e(Hint, { tone: 'error', text: '上次注入失败：' + lastInject.error }) : null,
            )
          : e(Hint, { text: '尚未执行过注入。' }),
        actionErr ? e(Hint, { tone: 'error', text: '操作失败：' + actionErr }) : null,
      );

      const security = e(
        'p',
        { className: 'bpSecurity' },
        '安全提示：Cookie 只在本机内存中解密，并通过 127.0.0.1 上的调试端口注入 DSH 内置浏览器的会话分区——不写入磁盘、不上传网络、不进日志，页面也不显示 cookie 的 name/value。注入后如需关闭调试端口，退出 DSH 再正常启动即可。',
      );

      return e('div', { className: 'bpRoot' }, head, loadErrLine, noticeLine, bridgeCard, sourceCard, scopeCard, statusCard, security);
    }

    function apply(ctx) {
      const slots = ctx.get('slots');
      if (slots === undefined) return;
      injectStyles();
      slots.inject('settings.section', () => slots.register({ name: 'settings.section', id: 'browser-plus', order: 65, label: '浏览器 Cookie 同步' }, () => e(BrowserPlusPage, { head: true })));
      slots.inject('plugins.bundle.config', () => slots.register({ name: 'plugins.bundle.config', key: '@sidleo3/dsh-browser-plus' }, () => e(BrowserPlusPage, { head: false })));
    }

    return { inject: ['slots'], apply };
  },
});
