/* 小满 · web/app.js —— 无构建、原生 JS。契约：docs/21-MVP契约.md（字段名不改）。
   视图：chat（L0）/ models（L1 模型管理）/ provider（L1 详情）/ form（L1 添加-连接）
   弹层：模型弹层（按 provider 分组）/ 断开确认
   流：POST /chat 读 text/event-stream，按 meta / reasoning / text / done / error 渲染 */
(function () {
  'use strict';

  var API = '/api/v1';
  var THINK = ['off', 'med', 'high'];

  var state = {
    view: 'chat',            // chat | page
    page: null,              // {kind:'models'} | {kind:'provider',providerId} | {kind:'form',providerId}
    overlay: null,           // {kind:'models'} | {kind:'confirm',pid,name}
    overlayFrom: null,
    focusPending: '',
    conversation: null,
    providers: null,
    providersState: 'loading',   // loading | ready | error
    providersError: '',
    models: {},              // providerId -> [model]（undefined = 未加载）
    modelsError: {},
    settings: null,
    settingsState: 'loading',
    messages: [],
    msgState: 'loading',     // loading | ready | error
    msgError: '',
    sending: false,
    pending: [],             // 待发送图片 {tmpId,id,url,mime,uploading}
    stick: true,
    toastTimer: 0
  };

  /* ── 基础工具 ─────────────────────────────────────── */
  function q(sel, root) { return (root || document).querySelector(sel); }
  function qa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function ic(name, cls) {
    return '<svg class="ic' + (cls ? ' ' + cls : '') + '" aria-hidden="true"><use href="#i-' + name + '"/></svg>';
  }
  function idVal(x) { return x != null && /^\d+$/.test(String(x)) ? Number(x) : x; }
  function fmtCtx(n) {
    var v = Number(n);
    if (!isFinite(v) || v <= 0) return '';
    if (v >= 1000000) return (v % 1000000 === 0 ? String(v / 1000000) : (v / 1000000).toFixed(1)) + 'M';
    if (v >= 1000) return Math.round(v / 1000) + 'K';
    return String(v);
  }
  function normThink(v) {
    var s = String(v || '');
    if (s === 'high') return 'high';
    if (s === 'med' || s === 'medium' || s === 'low') return 'med';
    return 'off';
  }
  function thinkValue() { return normThink(state.settings && state.settings.thinking); }
  function findProvider(pid) {
    return (state.providers || []).filter(function (p) { return String(p.id) === String(pid); })[0] || null;
  }
  function findModel(pid, mid) {
    return (state.models[pid] || []).filter(function (m) { return String(m.id) === String(mid); })[0] || null;
  }
  function settingProvider() {
    return state.settings && state.settings.provider_id != null ? findProvider(state.settings.provider_id) : null;
  }
  function settingModel() {
    var s = state.settings;
    if (!s || s.provider_id == null || s.model_id == null) return null;
    return findModel(s.provider_id, s.model_id);
  }
  function attachmentUrl(id) { return API + '/attachments/' + encodeURIComponent(id); }
  function imgSrc(u) {
    if (!u) return '';
    var s = String(u);
    if (/^(https?:)?\/\//.test(s) || s.charAt(0) === '/' || s.indexOf('data:') === 0) return s;
    return attachmentUrl(s);
  }

  /* ── Markdown（先转义、再拼标签：不含原始 HTML 通路）──── */
  function mdInline(raw) {
    var codes = [];
    var s = esc(raw);
    s = s.replace(/`([^`]+)`/g, function (_, c) { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    s = s.replace(/\[([^\]]+)\]\((https?:[^\s)]+)\)/g, function (_, t, u) {
      return '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + t + '</a>';
    });
    s = s.replace(/\u0000(\d+)\u0000/g, function (_, i) { return '<code>' + codes[Number(i)] + '</code>'; });
    return s;
  }

  function renderMarkdown(md) {
    var lines = String(md == null ? '' : md).replace(/\r\n?/g, '\n').split('\n');
    var out = [];
    var para = [];
    var i = 0;

    function flush() {
      if (!para.length) return;
      out.push('<p>' + para.map(mdInline).join('<br>') + '</p>');
      para = [];
    }

    while (i < lines.length) {
      var line = lines[i];

      if (/^\s*```/.test(line)) {
        flush();
        var buf = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++;
        out.push('<pre class="md-pre"><code>' + esc(buf.join('\n')) + '</code></pre>');
        continue;
      }

      var h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        flush();
        out.push('<div class="' + (h[1].length <= 2 ? 'mdh' : 'mdh2') + '">' + mdInline(h[2]) + '</div>');
        i++;
        continue;
      }

      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
        flush();
        out.push('<hr class="md-hr">');
        i++;
        continue;
      }

      var ulRe = /^\s*[-*+]\s+(.*)$/;
      var olRe = /^\s*\d+[.)]\s+(.*)$/;
      if (ulRe.test(line) || olRe.test(line)) {
        flush();
        var isUl = ulRe.test(line);
        var re = isUl ? ulRe : olRe;
        var items = [];
        while (i < lines.length) {
          var mm = lines[i].match(re);
          if (!mm) break;
          items.push('<li class="md-li">' + mdInline(mm[1]) + '</li>');
          i++;
        }
        var tag = isUl ? 'ul' : 'ol';
        out.push('<' + tag + ' class="md-' + tag + '">' + items.join('') + '</' + tag + '>');
        continue;
      }

      if (/^>\s?/.test(line)) {
        flush();
        var quoted = [];
        while (i < lines.length) {
          var qm = lines[i].match(/^>\s?(.*)$/);
          if (!qm) break;
          quoted.push(qm[1]);
          i++;
        }
        out.push('<div class="md-q"><p>' + quoted.map(mdInline).join('<br>') + '</p></div>');
        continue;
      }

      if (!line.trim()) { flush(); i++; continue; }

      para.push(line);
      i++;
    }
    flush();
    return out.join('');
  }

  function escText(s) { return esc(s).replace(/\n/g, '<br>'); }

  /* ── HTTP ─────────────────────────────────────────── */
  async function api(path, opts) {
    opts = opts || {};
    var init = { method: opts.method || 'GET', headers: Object.assign({}, opts.headers) };
    if (opts.json !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.json);
    } else if (opts.form) {
      init.body = opts.form;
    }
    var res;
    try {
      res = await fetch(API + path, init);
    } catch (e) {
      throw new Error('连接不上 ' + API);
    }
    var raw = await res.text();
    if (!res.ok) {
      var detail = '';
      try {
        var j = JSON.parse(raw);
        detail = j.detail || j.message || j.error || '';
        if (detail && typeof detail !== 'string') detail = JSON.stringify(detail);
      } catch (e2) { detail = ''; }
      if (typeof detail !== 'string') detail = '';
      // 纯静态服务下的 404 会回一整页 HTML：只留状态码，不把 HTML 塞进错误态
      if (detail.charAt(0) === '<') detail = '';
      if (detail.length > 160) detail = detail.slice(0, 160) + '…';
      throw new Error((detail ? detail + ' · ' : '') + 'HTTP ' + res.status);
    }
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e3) { return raw; }
  }

  /* ── 图标雪碧图 ───────────────────────────────────── */
  async function loadSprite() {
    try {
      var res = await fetch('sprite.svg', { cache: 'no-cache' });
      if (!res.ok) return;
      var txt = await res.text();
      txt = txt.replace(/^<\?xml[^>]*>\s*/, '');
      q('#sprite-host').innerHTML = txt;
    } catch (e) { /* 图标缺失不影响文字与功能 */ }
  }
  function hydrateIcons() {
    qa('use[data-i]').forEach(function (u) { u.setAttribute('href', '#i-' + u.getAttribute('data-i')); });
  }

  /* ── 加载器 ───────────────────────────────────────── */
  async function loadProviders() {
    state.providersState = 'loading';
    try {
      var list = await api('/providers');
      if (list && !Array.isArray(list) && Array.isArray(list.items)) list = list.items;
      state.providers = Array.isArray(list) ? list : [];
      state.providersState = 'ready';
    } catch (e) {
      state.providersState = 'error';
      state.providersError = e.message;
    }
  }

  async function loadConversation() {
    try { state.conversation = await api('/conversation'); }
    catch (e) { state.conversation = null; }
  }

  async function loadSettings(silent) {
    try {
      var s = await api('/settings');
      state.settings = s && typeof s === 'object' ? s : {};
      state.settingsState = 'ready';
    } catch (e) {
      state.settingsState = 'error';
      if (!state.settings) state.settings = { thinking: 'off' };
      if (!silent) toast('设置未加载 · ' + e.message);
    }
  }

  async function loadMessages() {
    state.msgState = 'loading';
    state.stick = true;
    renderStream();
    try {
      var data = await api('/messages?limit=50');
      var items = data && Array.isArray(data.items) ? data.items : [];
      state.messages = items.map(normalizeMessage);
      state.msgState = 'ready';
    } catch (e) {
      state.msgState = 'error';
      state.msgError = e.message;
    }
    renderStream();
  }

  function normalizeMessage(m) {
    return {
      id: m.id,
      role: m.role,
      kind: m.kind,
      content_md: m.content_md || '',
      reasoning_md: m.reasoning_md || '',
      images: Array.isArray(m.images) ? m.images : [],
      provider_id: m.provider_id,
      model_key: m.model_key,
      thinking: m.thinking,
      status: m.status || 'done',
      error: m.error || '',
      created_at: m.created_at
    };
  }

  async function loadModelsFor(pid) {
    try {
      var list = await api('/models?provider_id=' + encodeURIComponent(pid));
      if (list && !Array.isArray(list) && Array.isArray(list.items)) list = list.items;
      if (list && !Array.isArray(list) && Array.isArray(list.models)) list = list.models;
      state.models[pid] = Array.isArray(list) ? list : [];
      delete state.modelsError[pid];
    } catch (e) {
      state.models[pid] = [];
      state.modelsError[pid] = e.message;
    }
    return state.models[pid];
  }

  async function reloadAll() {
    state.models = {};
    state.modelsError = {};
    state.msgState = 'loading';
    await Promise.all([loadProviders(), loadConversation(), loadSettings(true)]);
    render();
    if (state.settings && state.settings.provider_id != null) {
      await loadModelsFor(state.settings.provider_id);
    }
    await loadMessages();
    render();
  }

  /* ── 渲染：外壳 / 顶栏 / 胶囊 / 思考 ───────────────── */
  function render() {
    renderTop();
    var isChat = state.view === 'chat';
    q('#view-chat').hidden = !isChat;
    q('#view-page').hidden = isChat;
    if (isChat) {
      renderPill();
      renderThink();
      renderThumbs();
      renderStream();
      syncSend();
    } else {
      renderPage();
    }
    renderOverlay();
  }

  function renderTop() {
    var el = q('#top-subject');
    if (state.conversation && state.conversation.subject) el.textContent = state.conversation.subject;
  }

  function renderPill() {
    var p = settingProvider();
    var m = settingModel();
    q('#pill-provider').textContent = p ? p.name
      : (state.providersState === 'loading' ? '加载中' : '未配置');
    q('#pill-model').textContent = m ? m.model_key
      : (state.settings && state.settings.model_id != null ? '—' : '选择模型');
  }

  function renderThink() {
    var cur = thinkValue();
    qa('.tpill[data-think]').forEach(function (btn) {
      var on = btn.getAttribute('data-think') === cur;
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function renderThumbs() {
    var host = q('#thumbs');
    if (!state.pending.length) { host.hidden = true; host.innerHTML = ''; return; }
    host.hidden = false;
    host.innerHTML = state.pending.map(function (x, i) {
      return '<div class="thumb' + (x.uploading ? ' uploading' : '') + '">' +
        (x.url ? '<img src="' + esc(imgSrc(x.url)) + '" alt="">' : '') +
        (x.uploading ? '<span class="up">上传中</span>' : '') +
        '<button type="button" class="rm" data-act="remove-image" data-i="' + i + '" aria-label="移除图片">' +
        '<span class="rmd">' + ic('x', 'sm') + '</span></button></div>';
    }).join('');
  }

  function syncSend() {
    var ta = q('#ta');
    var has = !!(ta && ta.value.trim()) || state.pending.length > 0;
    q('#btn-send').disabled = state.sending || !has;
  }

  /* ── 渲染：对话流 ─────────────────────────────────── */
  function skelRows(n) {
    var w = ['w60', 'w80', 'w40'];
    var rows = '';
    for (var i = 0; i < n; i++) rows += '<div class="row ' + w[i % 3] + '"></div>';
    return rows;
  }

  function emptyChatState() {
    var hasModel = !!(state.settings && state.settings.model_id != null);
    var action = hasModel
      ? '<button type="button" class="btn" data-act="focus-composer">开始对话</button>'
      : '<button type="button" class="btn" data-act="open-add-form">添加端点</button>';
    return '<div class="empty">' + ic('message-square') +
      '<div class="t">还没有对话</div>' + action + '</div>';
  }

  function pageErrorState(title, msg, retryAct, backAct, backLabel) {
    return '<div class="err">' + ic('alert-circle') +
      '<div class="t">' + esc(title) + '</div>' +
      '<div class="d">' + esc(msg || '') + '</div>' +
      '<div class="btnbar">' +
      '<button type="button" class="btn" data-act="' + retryAct + '">重试</button>' +
      '<button type="button" class="btn g" data-act="' + backAct + '">' + esc(backLabel) + '</button>' +
      '</div></div>';
  }

  function renderStream() {
    var el = q('#stream');
    var prev = el.scrollTop;
    el.setAttribute('aria-busy', state.msgState === 'loading' ? 'true' : 'false');

    if (state.msgState === 'loading') {
      el.innerHTML = '<div class="col"><div class="skel">' + skelRows(3) + '</div></div>';
      return;
    }
    if (state.msgState === 'error') {
      el.innerHTML = '<div class="col">' +
        pageErrorState('加载失败', state.msgError, 'reload-all', 'open-models', '模型管理') + '</div>';
      return;
    }
    if (!state.messages.length) {
      el.innerHTML = '<div class="col">' + emptyChatState() + '</div>';
      return;
    }

    var streaming = state.messages.some(function (m) { return m.status === 'streaming'; });
    el.setAttribute('aria-live', streaming ? 'off' : 'polite');
    el.innerHTML = '<div class="col">' + state.messages.map(msgHtml).join('') + '</div>';
    if (state.stick) el.scrollTop = el.scrollHeight;
    else el.scrollTop = prev;
  }

  function msgHtml(m) {
    if (m.role === 'user') {
      var imgs = (m.images || []).map(function (im) {
        return '<div class="thumb"><img src="' + esc(imgSrc(im.url || im.id)) + '" alt=""></div>';
      }).join('');
      var text = m.content_md ? '<span class="utext">' + escText(m.content_md) + '</span>' : '';
      return '<div class="me"><div class="ubx">' +
        (imgs ? '<div class="ustack">' + imgs + '</div>' : '') + text + '</div></div>';
    }
    var inner = '';
    if (m.reasoning_md) inner += reasoningHtml(m);
    if (m.content_md) inner += '<div class="agbody">' + renderMarkdown(m.content_md) + '</div>';
    else if (m.status === 'streaming') inner += '<div class="skel inmsg">' + skelRows(2) + '</div>';
    if (m.error) inner += msgErrorHtml(m);
    return '<div class="ag">' + inner + '</div>';
  }

  function reasoningHtml(m) {
    var live = m.status === 'streaming' && !m.content_md;
    var open = m._open !== undefined ? m._open : live;
    var label = m.status === 'streaming' ? '思考中' : '思考';
    return '<details class="rbox" data-mid="' + esc(m.id) + '"' + (open ? ' open' : '') + '>' +
      '<summary class="rsum">' + ic('zap', 'sm') + '<span>' + label + '</span>' + ic('chevron-down', 'sm rcar') +
      '</summary><div class="rbody">' + renderMarkdown(m.reasoning_md) + '</div></details>';
  }

  function msgErrorHtml(m) {
    var canRetry = !!m.canRetry && state.messages[state.messages.length - 1] === m;
    return '<div class="merr">' + ic('alert-circle') +
      '<span class="msg">' + esc(m.error || '') + '</span>' +
      (canRetry ? '<button type="button" class="btn" data-act="retry" data-mid="' + esc(m.id) + '">重试</button>' : '') +
      '</div>';
  }

  /* ── 渲染：模型弹层 ───────────────────────────────── */
  function modelSheetHtml() {
    var body = '';
    if (state.providersState === 'loading') {
      body = '<div class="skel inmsg">' + skelRows(3) + '</div>';
    } else if (state.providersState === 'error') {
      body = pageErrorState('加载失败', state.providersError, 'reload-providers', 'close-sheet', '关闭');
    } else if (!state.providers || !state.providers.length) {
      body = '<div class="empty">' + ic('message-square') + '<div class="t">还没有端点</div>' +
        '<button type="button" class="btn" data-act="open-add-form">添加端点</button></div>';
    } else {
      body = state.providers.map(function (p) {
        var head = '<div class="pgrp"><div class="ph"><span class="pn">' + esc(p.name) + '</span>' +
          '<span class="au' + (p.connected ? ' ok' : '') + '">' + (p.connected ? '已连接' : '未连接') + '</span></div>';
        var rows = '';
        if (!p.connected) {
          rows = '<button type="button" class="mrow link" data-act="connect" data-pid="' + esc(p.id) + '">' +
            '<span class="nm">去连接</span>' + ic('chevron-right', 'sm chev') + '</button>';
        } else if (state.models[p.id] === undefined) {
          rows = '<div class="skel inmsg">' + skelRows(2) + '</div>';
        } else if (!state.models[p.id].length) {
          rows = '<button type="button" class="mrow link" data-act="sync" data-pid="' + esc(p.id) + '">' +
            '<span class="nm">更新模型目录</span>' + ic('refresh-cw', 'sm chev') + '</button>';
        } else {
          rows = state.models[p.id].map(function (m) {
            var on = !!state.settings && state.settings.model_id != null &&
              String(state.settings.model_id) === String(m.id);
            return '<button type="button" class="mrow' + (on ? ' on' : '') + '" data-act="pick-model" ' +
              'data-pid="' + esc(p.id) + '" data-mid="' + esc(m.id) + '"' + (on ? ' aria-current="true"' : '') + '>' +
              '<span class="nm">' + esc(m.model_key) + '</span>' +
              '<span class="chk">' + (on ? ic('check', 'sm') : '') + '</span></button>';
          }).join('');
        }
        return head + rows + '</div>';
      }).join('');
    }

    return '<div class="scrim" data-act="close-sheet"></div>' +
      '<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-ttl" tabindex="-1">' +
      '<div class="grab"></div>' +
      '<div class="shd"><div class="ttl" id="sheet-ttl">模型</div>' +
      '<button type="button" class="hit" data-act="close-sheet" aria-label="关闭">' + ic('x') + '</button></div>' +
      '<div class="sheet-body">' + body + '</div>' +
      '<div class="sheet-foot"><button type="button" class="mrow link" data-act="open-models">' +
      '<span class="nm">模型管理</span>' + ic('chevron-right', 'sm chev') + '</button></div>' +
      '</div>';
  }

  function confirmSheetHtml(o) {
    return '<div class="scrim" data-act="close-sheet"></div>' +
      '<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="cf-ttl" tabindex="-1">' +
      '<div class="grab"></div>' +
      '<div class="shd"><div class="ttl" id="cf-ttl">断开</div>' +
      '<button type="button" class="hit" data-act="close-sheet" aria-label="关闭">' + ic('x') + '</button></div>' +
      '<div class="sheet-body"><div class="confirm-name">' + esc(o.name || '') + '</div></div>' +
      '<div class="sheet-foot"><div class="btnbar full">' +
      '<button type="button" class="btn g" data-act="close-sheet">取消</button>' +
      '<button type="button" class="btn d" data-act="confirm-disconnect">断开</button>' +
      '</div></div></div>';
  }

  function renderOverlay() {
    var host = q('#overlay');
    if (!state.overlay) {
      host.hidden = true;
      host.innerHTML = '';
      return;
    }
    host.hidden = false;
    host.innerHTML = state.overlay.kind === 'confirm'
      ? confirmSheetHtml(state.overlay)
      : modelSheetHtml();
  }

  /* ── 渲染：模型管理 / provider 详情 / 表单 ─────────── */
  function navbar(title, sub, backAct, backLabel, closeIcon) {
    var btn = '<button type="button" class="hit" data-act="' + backAct + '" aria-label="' + esc(backLabel) + '">' +
      ic(closeIcon ? 'x' : 'chevron-left') + '</button>';
    return '<div class="navbar' + (closeIcon ? ' flow' : '') + '">' + btn +
      '<div class="tbox"><div class="ttl">' + esc(title) + '</div>' +
      (sub ? '<div class="sub">' + esc(sub) + '</div>' : '') + '</div></div>';
  }

  function providerRow(p) {
    var trail = p.connected
      ? '<span class="val">' + Number(p.model_count || 0) + ' 个模型</span>'
      : '<span class="val">连接</span>';
    return '<button type="button" class="srow" data-act="open-provider" data-pid="' + esc(p.id) + '">' +
      '<span class="lead">' + ic(p.connected ? 'plug' : 'key') + '</span>' +
      '<span class="md"><span class="n1">' + esc(p.name) + '</span></span>' +
      '<span class="trail">' + trail + ic('chevron-right', 'sm chev') + '</span></button>';
  }

  function groupHtml(label, rows) {
    return '<div class="sgroup"><div class="slabel">' + esc(label) + '</div>' +
      '<div class="scard">' + rows + '</div></div>';
  }

  function voidRow(text) {
    return '<div class="srow void"><span class="md"><span class="n1">' + esc(text) + '</span></span></div>';
  }

  function modelsPageHtml() {
    var nav = navbar('模型管理', '', 'goto-chat', '返回', false);

    if (state.providersState === 'loading') {
      return nav + '<div class="settings"><div class="skel">' + skelRows(3) + '</div></div>';
    }
    if (state.providersState === 'error') {
      return nav + '<div class="settings">' +
        pageErrorState('加载失败', state.providersError, 'reload-providers', 'goto-chat', '返回对话') + '</div>';
    }

    var conn = (state.providers || []).filter(function (p) { return p.connected; });
    var disc = (state.providers || []).filter(function (p) { return !p.connected; });

    return nav + '<div class="settings">' +
      groupHtml('已连接', conn.length ? conn.map(providerRow).join('') : voidRow('还没有已连接的端点')) +
      groupHtml('未连接', disc.length ? disc.map(providerRow).join('') : voidRow('没有未连接的端点')) +
      groupHtml('自定义', '<button type="button" class="srow" data-act="open-add-form">' +
        '<span class="lead">' + ic('plus') + '</span>' +
        '<span class="md"><span class="n1">添加 OpenAI 兼容端点</span></span>' +
        '<span class="trail">' + ic('chevron-right', 'sm chev') + '</span></button>') +
      '</div>';
  }

  function keyMask(tail) {
    if (!tail) return '—';
    return '••••' + String(tail).slice(-4);
  }

  function modelListHtml(pid) {
    var models = state.models[pid];
    if (models === undefined) {
      return '<div class="skel inmsg">' + skelRows(2) + '</div>';
    }
    if (!models.length) {
      return '<div class="mlist"><div class="mitem void">' +
        '<span class="id">还没有模型</span></div></div>';
    }
    var cur = state.settings && state.settings.model_id;
    return '<div class="mlist">' + models.map(function (m) {
      var on = cur != null && String(m.id) === String(cur);
      return '<div class="mitem"><span class="ck">' + (on ? ic('check', 'sm') : '') + '</span>' +
        '<span class="id mono">' + esc(m.model_key) + '</span>' +
        '<span class="ctx2">' + esc(fmtCtx(m.context_len)) + '</span></div>';
    }).join('') + '</div>';
  }

  function providerPageHtml(pid) {
    var p = findProvider(pid);
    var nav = navbar(p.name, '模型管理', 'back-models', '返回', false);
    var models = state.models[pid];
    var count = models ? models.length : (p.model_count || 0);

    var body = '<div class="det">' +
      '<div class="sgroup"><div class="slabel">认证</div><div class="scard">' +
      '<div class="kvrow"><span class="k">状态</span><span class="v' + (p.connected ? ' ok' : '') + '">' +
      (p.connected ? '已连接' : '未连接') + '</span></div>' +
      '<div class="kvrow"><span class="k">API Key</span><span class="v mono">' + esc(keyMask(p.api_key_tail)) + '</span></div>' +
      '<div class="kvrow"><span class="k">端点</span><span class="v mono">' + esc(p.base_url || '—') + '</span></div>' +
      '</div></div>' +
      '<div class="sgroup"><div class="slabel">模型 · ' + Number(count) + '</div>' + modelListHtml(pid) + '</div>';

    if (p.connected) {
      body += '<div class="btnbar">' +
        '<button type="button" class="btn" data-act="sync" data-pid="' + esc(p.id) + '">' +
        ic('refresh-cw') + '更新模型目录</button>' +
        '<button type="button" class="btn d" data-act="ask-disconnect" data-pid="' + esc(p.id) + '">' +
        ic('x') + '断开</button></div>';
    } else {
      body += '<div class="btnbar">' +
        '<button type="button" class="btn p" data-act="edit-provider" data-pid="' + esc(p.id) + '">' +
        ic('key') + '连接</button></div>';
    }
    body += '</div>';
    return nav + body;
  }

  function formField(label, key, input) {
    return '<div class="field"><label class="fl" for="f-' + key + '">' + label + '</label>' + input +
      '<div class="fmsg" data-msg="' + key + '"></div></div>';
  }

  function formHtml(page) {
    var p = page.providerId ? findProvider(page.providerId) : null;
    var pid = p ? p.id : '';
    var title = p ? '连接端点' : '添加端点';
    var nav = navbar(title, '', 'close-form', '关闭', true);
    return nav + '<form class="formpane" id="provider-form" data-pid="' + esc(pid) + '" novalidate>' +
      '<div class="fields">' +
      formField('名称', 'name', '<input class="fi" id="f-name" name="name" type="text" maxlength="80" ' +
        'autocomplete="off" spellcheck="false" value="' + esc(p ? p.name : '') + '">') +
      formField('端点', 'base_url', '<input class="fi" id="f-base_url" name="base_url" type="text" ' +
        'inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://" ' +
        'value="' + esc(p ? p.base_url : '') + '">') +
      formField('API Key', 'api_key', '<input class="fi" id="f-api_key" name="api_key" type="password" ' +
        'autocomplete="off" spellcheck="false" placeholder="' + (p ? '保持不变' : '') + '">') +
      '<div class="field"><div class="fl">接口类型</div><div class="fi static mono">openai</div></div>' +
      '</div>' +
      '<div class="btnbar full">' +
      '<button type="button" class="btn g" data-act="close-form">取消</button>' +
      '<button type="submit" class="btn p" id="f-submit">保存</button>' +
      '</div></form>';
  }

  function renderPage() {
    var host = q('#view-page');
    var page = state.page;
    if (!page) { host.innerHTML = ''; return; }
    var html = '';
    if (page.kind === 'models') html = modelsPageHtml();
    else if (page.kind === 'provider') {
      html = findProvider(page.providerId) ? providerPageHtml(page.providerId) : modelsPageHtml();
    } else if (page.kind === 'form') {
      html = formHtml(page);
    }
    host.innerHTML = html;
    if (page.kind === 'form') {
      var form = q('#provider-form', host);
      if (form) form.addEventListener('submit', onProviderSubmit);
    }
    if (state.focusPending === 'page') {
      state.focusPending = '';
      var hit = q('#view-page .navbar .hit');
      if (hit) hit.focus();
    }
  }

  /* ── 视图切换 / 弹层 ──────────────────────────────── */
  function openPage(page) {
    var next = page ? JSON.stringify(page) : '';
    var cur = state.page ? JSON.stringify(state.page) : '';
    state.page = page;
    state.view = page ? 'page' : 'chat';
    if (next !== cur) state.focusPending = page ? 'page' : 'chat';
    render();
    if (state.focusPending === 'chat') {
      state.focusPending = '';
      var ta = q('#ta');
      if (ta) ta.focus();
    }
  }

  function setOverlay(o) {
    if (o && !state.overlay) state.overlayFrom = document.activeElement;
    state.overlay = o;
    renderOverlay();
    if (o) {
      var sheet = q('.sheet');
      if (sheet) sheet.focus();
    } else if (state.overlayFrom) {
      var el = state.overlayFrom;
      state.overlayFrom = null;
      if (el && el.isConnected && typeof el.focus === 'function') el.focus();
    }
  }

  function closeOverlay() { setOverlay(null); }

  function openModelSheet() {
    setOverlay({ kind: 'models' });
    if (state.providersState !== 'ready' || !state.providers) return;
    var todo = state.providers.filter(function (p) {
      return p.connected && state.models[p.id] === undefined;
    }).map(function (p) { return p.id; });
    if (!todo.length) return;
    Promise.all(todo.map(loadModelsFor)).then(function () {
      if (state.overlay && state.overlay.kind === 'models') renderOverlay();
    });
  }

  async function openProvider(pid) {
    openPage({ kind: 'provider', providerId: pid });
    if (state.models[pid] === undefined) {
      await loadModelsFor(pid);
      if (state.page && state.page.kind === 'provider' &&
        String(state.page.providerId) === String(pid)) render();
    }
  }

  /* ── 动作 ─────────────────────────────────────────── */
  async function setThinking(v) {
    var val = THINK.indexOf(v) >= 0 ? v : 'med';
    if (normThink(state.settings && state.settings.thinking) === val) return;
    var prev = state.settings ? Object.assign({}, state.settings) : null;
    state.settings = Object.assign({}, state.settings, { thinking: val });
    renderThink();
    try {
      var s = await api('/settings', { method: 'PATCH', json: { thinking: val } });
      if (s && typeof s === 'object') state.settings = Object.assign({}, state.settings, s);
    } catch (e) {
      state.settings = prev;
      toast('未保存 · ' + e.message);
    }
    renderThink();
  }

  async function pickModel(pid, mid) {
    var prev = state.settings ? Object.assign({}, state.settings) : null;
    state.settings = Object.assign({}, state.settings, { provider_id: idVal(pid), model_id: idVal(mid) });
    closeOverlay();
    renderPill();
    try {
      var s = await api('/settings', { method: 'PATCH', json: { provider_id: idVal(pid), model_id: idVal(mid) } });
      if (s && typeof s === 'object') state.settings = Object.assign({}, state.settings, s);
    } catch (e) {
      state.settings = prev;
      toast('未保存 · ' + e.message);
    }
    renderPill();
  }

  async function reloadProviders() {
    await loadProviders();
    render();
  }

  async function syncProvider(pid) {
    try {
      var r = await api('/providers/' + encodeURIComponent(pid) + '/sync-models', { method: 'POST' });
      delete state.models[pid];
      delete state.modelsError[pid];
      await loadModelsFor(pid);
      await loadProviders();
      render();
      toast(r && r.total != null ? Number(r.total) + ' 个模型' : '已更新');
    } catch (e) {
      toast('更新失败 · ' + e.message);
    }
  }

  function askDisconnect(pid) {
    var p = findProvider(pid);
    setOverlay({ kind: 'confirm', pid: pid, name: p ? p.name : '' });
  }

  async function doDisconnect() {
    var o = state.overlay;
    if (!o || !o.pid) return;
    var pid = o.pid;
    closeOverlay();
    try {
      await api('/providers/' + encodeURIComponent(pid), { method: 'PATCH', json: { connected: false } });
      await loadProviders();
      render();
      toast('已断开');
    } catch (e) {
      toast('未断开 · ' + e.message);
    }
  }

  function removePending(i) {
    state.pending.splice(i, 1);
    renderThumbs();
    syncSend();
  }

  async function onFiles(list) {
    var files = Array.prototype.slice.call(list || []).filter(function (f) {
      return f && /^image\//.test(f.type || '');
    });
    for (var k = 0; k < files.length; k++) {
      var f = files[k];
      var tmp = { tmpId: 'u' + Math.random().toString(36).slice(2), name: f.name, url: '', mime: f.type, uploading: true };
      state.pending.push(tmp);
      renderThumbs();
      syncSend();
      try {
        var fd = new FormData();
        fd.append('file', f, f.name || 'image');
        var r = await api('/uploads', { method: 'POST', form: fd });
        tmp.id = r && r.id;
        tmp.url = (r && r.url) || (tmp.id != null ? attachmentUrl(tmp.id) : '');
        tmp.mime = (r && r.mime) || tmp.mime;
        tmp.uploading = false;
        if (tmp.id == null) throw new Error('无 id');
      } catch (e) {
        state.pending = state.pending.filter(function (x) { return x !== tmp; });
        toast('上传失败 · ' + e.message);
      }
      renderThumbs();
      syncSend();
    }
  }

  function pickFile(id) {
    var el = q('#' + id);
    if (!el) return;
    el.value = '';
    el.click();
  }

  function autosize() {
    var ta = q('#ta');
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  }

  /* ── 发送 / SSE ───────────────────────────────────── */
  var rafPending = false;

  function scheduleRender(now) {
    if (now) { renderStream(); return; }
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(function () { rafPending = false; renderStream(); });
  }

  async function submitMessage() {
    if (state.sending) return;
    var ta = q('#ta');
    var text = (ta.value || '').trim();
    var ready = state.pending.filter(function (x) { return x.id != null; });
    if (!text && !ready.length) return;
    if (state.pending.some(function (x) { return x.uploading; })) {
      toast('图片还在上传');
      return;
    }
    var imgs = ready.map(function (x) { return { id: x.id, url: imgSrc(x.url), mime: x.mime }; });
    ta.value = '';
    autosize();
    state.pending = [];
    renderThumbs();
    syncSend();
    await doSend(text, imgs.map(function (x) { return x.id; }), imgs);
  }

  async function doSend(text, imageIds, imgs) {
    var payload = { text: text, image_ids: imageIds || [], thinking: thinkValue() };
    var userMsg = {
      id: 'tmp-u-' + Date.now(), role: 'user', kind: (imgs && imgs.length) ? 'image' : 'text',
      content_md: text, reasoning_md: '', images: imgs || [], status: 'done', error: ''
    };
    var asst = {
      id: 'tmp-a-' + Date.now(), role: 'assistant', kind: 'text', content_md: '', reasoning_md: '',
      images: [], status: 'streaming', error: '', _payload: payload, _userMsg: userMsg
    };
    state.messages.push(userMsg, asst);
    state.sending = true;
    state.stick = true;
    renderStream();
    syncSend();
    try {
      await streamRequest(payload, userMsg, asst);
    } catch (e) {
      asst.status = 'error';
      asst.error = e.message;
      asst.canRetry = true;
    } finally {
      state.sending = false;
      renderStream();
      syncSend();
    }
  }

  async function streamRequest(payload, userMsg, asst) {
    var res;
    try {
      res = await fetch(API + '/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } catch (e) {
      throw new Error('连接不上 ' + API);
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    if (!res.body) throw new Error('该浏览器不支持流式读取');

    var reader = res.body.getReader();
    var dec = new TextDecoder();
    var buf = '';
    var sawDone = false;
    var srvErr = '';

    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      var idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        var line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line || line.charAt(0) === ':') continue;
        if (line.slice(0, 5) !== 'data:') continue;
        var data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        var ev;
        try { ev = JSON.parse(data); } catch (e) { continue; }
        if (ev.type === 'meta') {
          if (ev.user_message_id != null) userMsg.id = ev.user_message_id;
          if (ev.assistant_message_id != null) asst.id = ev.assistant_message_id;
          if (ev.provider_id != null) asst.provider_id = ev.provider_id;
          if (ev.model_key) asst.model_key = ev.model_key;
          if (ev.thinking) asst.thinking = ev.thinking;
          scheduleRender();
        } else if (ev.type === 'reasoning') {
          asst.reasoning_md += ev.delta || '';
          scheduleRender();
        } else if (ev.type === 'text') {
          asst.content_md += ev.delta || '';
          scheduleRender();
        } else if (ev.type === 'done') {
          sawDone = true;
          asst.status = 'done';
          asst.usage = ev.usage || null;
          if (ev.message_id != null) asst.id = ev.message_id;
          scheduleRender();
        } else if (ev.type === 'error') {
          srvErr = ev.message || ev.code || '流式错误';
        }
      }
    }

    if (srvErr) {
      asst.status = 'error';
      asst.error = srvErr;
      asst.canRetry = true;
    } else if (!sawDone) {
      asst.status = 'error';
      asst.error = '连接中断';
      asst.canRetry = true;
    } else {
      asst.status = 'done';
    }
    scheduleRender(true);
  }

  async function retryMessage(mid) {
    var idx = -1;
    for (var i = 0; i < state.messages.length; i++) {
      if (String(state.messages[i].id) === String(mid)) { idx = i; break; }
    }
    if (idx < 0 || idx !== state.messages.length - 1) return;
    var old = state.messages[idx];
    if (!old._payload) return;
    var userMsg = old._userMsg || state.messages[idx - 1] || null;
    state.messages.splice(idx, 1);
    var fresh = {
      id: 'tmp-a-' + Date.now(), role: 'assistant', kind: 'text', content_md: '', reasoning_md: '',
      images: [], status: 'streaming', error: '', _payload: old._payload, _userMsg: userMsg
    };
    state.messages.push(fresh);
    state.sending = true;
    state.stick = true;
    renderStream();
    syncSend();
    try {
      await streamRequest(old._payload, userMsg || {}, fresh);
    } catch (e) {
      fresh.status = 'error';
      fresh.error = e.message;
      fresh.canRetry = true;
    } finally {
      state.sending = false;
      renderStream();
      syncSend();
    }
  }

  /* ── toast ────────────────────────────────────────── */
  function toast(msg) {
    var el = q('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(function () { el.hidden = true; }, 4000);
  }

  /* ── 表单提交 ─────────────────────────────────────── */
  function showMsg(form, key, text) {
    var el = form.querySelector('[data-msg="' + key + '"]');
    if (el) el.textContent = text;
    var input = form.querySelector('#' + 'f' + '-' + key);
    if (input) input.classList.add('err');
  }
  function clearMsgs(form) {
    qa('.fmsg', form).forEach(function (el) { el.textContent = ''; });
    qa('.fi', form).forEach(function (el) { el.classList.remove('err'); });
  }

  async function onProviderSubmit(e) {
    e.preventDefault();
    var form = e.currentTarget;
    var nameEl = form.querySelector('[name="name"]');
    var urlEl = form.querySelector('[name="base_url"]');
    var keyEl = form.querySelector('[name="api_key"]');
    var pid = form.getAttribute('data-pid') || '';
    var name = (nameEl.value || '').trim();
    var baseUrl = (urlEl.value || '').trim();
    var key = (keyEl.value || '').trim();

    clearMsgs(form);
    var bad = '';
    if (!name) { showMsg(form, 'name', '必填'); bad = 'name'; }
    if (!baseUrl) {
      showMsg(form, 'base_url', '必填');
      if (!bad) bad = 'base_url';
    } else if (!/^https?:\/\//i.test(baseUrl)) {
      showMsg(form, 'base_url', '需 http:// 或 https://');
      if (!bad) bad = 'base_url';
    }
    if (!pid && !key) {
      showMsg(form, 'api_key', '必填');
      if (!bad) bad = 'api_key';
    }
    if (bad) {
      var el = form.querySelector('[name="' + bad + '"]');
      if (el) el.focus();
      return;
    }

    var btn = q('#f-submit', form);
    if (btn) btn.disabled = true;
    var newId = '';

    try {
      if (pid) {
        var body = { name: name, base_url: baseUrl };
        if (key) body.api_key = key;
        await api('/providers/' + encodeURIComponent(pid), { method: 'PATCH', json: body });
        newId = pid;
      } else {
        var created = await api('/providers', {
          method: 'POST',
          json: { name: name, base_url: baseUrl, api_key: key, api_style: 'openai' }
        });
        newId = created && (created.id != null ? created.id : created.provider_id);
      }
    } catch (err) {
      toast('保存失败 · ' + err.message);
      if (btn) btn.disabled = false;
      return;
    }

    await loadProviders();
    if (newId != null && newId !== '') {
      delete state.models[newId];
      openPage({ kind: 'provider', providerId: newId });
      try {
        await api('/providers/' + encodeURIComponent(newId) + '/sync-models', { method: 'POST' });
        await loadModelsFor(newId);
        await loadProviders();
        render();
      } catch (err2) {
        toast('更新失败 · ' + err2.message);
      }
    } else {
      openPage({ kind: 'models' });
    }
  }

  /* ── 事件 ─────────────────────────────────────────── */
  var ACTS = {
    'open-sheet': function () { openModelSheet(); },
    'close-sheet': function () { closeOverlay(); },
    'pick-model': function (el) { pickModel(el.getAttribute('data-pid'), el.getAttribute('data-mid')); },
    'connect': function (el) {
      closeOverlay();
      openPage({ kind: 'form', providerId: el.getAttribute('data-pid') });
    },
    'edit-provider': function (el) { openPage({ kind: 'form', providerId: el.getAttribute('data-pid') }); },
    'open-models': function () { closeOverlay(); openPage({ kind: 'models' }); },
    'goto-chat': function () { openPage(null); },
    'open-provider': function (el) { openProvider(el.getAttribute('data-pid')); },
    'back-models': function () { openPage({ kind: 'models' }); },
    'open-add-form': function () { closeOverlay(); openPage({ kind: 'form' }); },
    'close-form': function () {
      var p = state.page;
      if (p && p.providerId != null) openPage({ kind: 'provider', providerId: p.providerId });
      else openPage({ kind: 'models' });
    },
    'set-think': function (el) { setThinking(el.getAttribute('data-think')); },
    'sync': function (el) { syncProvider(el.getAttribute('data-pid')); },
    'ask-disconnect': function (el) { askDisconnect(el.getAttribute('data-pid')); },
    'confirm-disconnect': function () { doDisconnect(); },
    'retry': function (el) { retryMessage(el.getAttribute('data-mid')); },
    'reload-all': function () { reloadAll(); },
    'reload-providers': function () { reloadProviders(); },
    'focus-composer': function () { q('#ta').focus(); },
    'remove-image': function (el) { removePending(Number(el.getAttribute('data-i'))); }
  };

  function onClick(e) {
    var el = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!el || el.disabled) return;
    var fn = ACTS[el.getAttribute('data-act')];
    if (!fn) return;
    e.preventDefault();
    fn(el);
  }

  function onKey(e) {
    if (e.key === 'Escape' && state.overlay) {
      e.preventDefault();
      closeOverlay();
    }
  }

  function onToggle(e) {
    var d = e.target;
    if (!d || d.tagName !== 'DETAILS') return;
    var mid = d.getAttribute('data-mid');
    for (var i = 0; i < state.messages.length; i++) {
      if (String(state.messages[i].id) === String(mid)) { state.messages[i]._open = d.open; return; }
    }
  }

  function bindEvents() {
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);

    var ta = q('#ta');
    ta.addEventListener('input', function () { autosize(); syncSend(); });
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !state.sending) {
        e.preventDefault();
        submitMessage();
      }
    });
    q('#composer').addEventListener('submit', function (e) {
      e.preventDefault();
      submitMessage();
    });

    q('#btn-attach').addEventListener('click', function () { pickFile('file-attach'); });
    q('#btn-camera').addEventListener('click', function () { pickFile('file-camera'); });
    q('#file-attach').addEventListener('change', function (e) { onFiles(e.target.files); });
    q('#file-camera').addEventListener('change', function (e) { onFiles(e.target.files); });

    var stream = q('#stream');
    stream.addEventListener('scroll', function () {
      state.stick = (stream.scrollHeight - stream.scrollTop - stream.clientHeight) < 80;
    });
    stream.addEventListener('toggle', onToggle, true);
  }

  /* ── 启动 ─────────────────────────────────────────── */
  async function boot() {
    await loadSprite();
    hydrateIcons();
    bindEvents();
    autosize();
    render();

    await Promise.all([loadProviders(), loadConversation(), loadSettings(true)]);
    render();

    if (state.settings && state.settings.provider_id != null) {
      await loadModelsFor(state.settings.provider_id);
      render();
    }
    await loadMessages();
    render();
  }

  boot();
})();