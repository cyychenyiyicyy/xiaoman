/* 小满 · web/app.js —— 无构建、原生 JS。契约：docs/21-MVP契约.md（字段名不改）。
   视图：chat（L0）/ models（L1 模型管理）/ provider（L1 详情）/ form（L1 添加-连接）
   弹层：模型弹层（按 provider 分组）/ 断开确认
   流：POST /chat 读 text/event-stream，按 meta / reasoning / text / done / error 渲染 */
(function () {
  'use strict';

  var API = '/api/v1';
  var THINK = ['off', 'med', 'high'];

  var state = {
    subjects: null,          // GET /subjects: {current, items}
    subjectScroll: {},       // 每个学科记住滚动位置（docs/11 §3.1）
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
    search: null,             // GET /settings/search: {enabled, provider, api_key_tail, max_results}
    searchState: 'loading',   // loading | ready | error
    searchError: '',
    searchTest: { state: 'idle', ok: false, latency: 0, error: '' },
    memorySetting: null,      // GET /settings/memory: {auto}
    memoryStats: null,        // GET /memories/stats: {total, active, used_last_7d}
    memories: null,           // GET /memories 的 items
    memoriesState: 'loading',
    memoriesError: '',
    messages: [],
    msgState: 'loading',     // loading | ready | error
    msgError: '',
    sending: false,
    liveMsg: null,           // 正在逐词揭示的 assistant 消息（null = 没有）
    catalog: null,           // GET /catalog 的 sources
    catalogState: 'loading', // loading | ready | error
    catalogError: '',
    lookup: {},              // catalog_id|model_key → 目录查到的元数据 / null
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
  var keySeq = 0;
  // 稳定 key：id 会被 meta 回填、消息列表会被重载，DOM 跟踪只能靠这个不变值
  function newKey(prefix) { keySeq += 1; return (prefix || 'k') + '-' + keySeq; }
  function fmtCtx(n) {
    var v = Number(n);
    if (!isFinite(v) || v <= 0) return '';
    if (v >= 1048576) {
      var mm = v / 1048576;
      return (Math.abs(mm - Math.round(mm)) < 0.05 ? String(Math.round(mm)) : mm.toFixed(1)) + 'M';
    }
    if (v >= 1024) return Math.round(v / 1024) + 'K';
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
      // 首屏加载慢于发送时，保留尚在流式中的本地占位消息（id 前缀 tmp-）
      var local = state.messages.filter(function (m) {
        return String(m.id).indexOf('tmp-') === 0;
      });
      state.messages = local.length ? items.map(normalizeMessage).concat(local) : items.map(normalizeMessage);
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
      _key: newKey('h'),
      role: m.role,
      kind: m.kind,
      content_md: m.content_md || '',
      reasoning_md: m.reasoning_md || '',
      images: Array.isArray(m.images) ? m.images : [],
      tools: Array.isArray(m.tools) ? m.tools : [],
      sources: Array.isArray(m.sources) ? m.sources : [],
      remembered: Array.isArray(m.remembered) ? m.remembered : [],
      parts: Array.isArray(m.parts) ? m.parts : [],
      thinking_ms: m.thinking_ms || 0,
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

  function findCatalog(cid) {
    return (state.catalog || []).filter(function (s) {
      return String(s.catalog_id) === String(cid);
    })[0] || null;
  }

  async function loadSubjects() {
    try {
      state.subjects = await api('/subjects');
      var cur = state.subjects && state.subjects.current;
      var el = q('#top-subject');
      if (el && cur) el.textContent = cur;
    } catch (e) {
      state.subjects = { current: '全部', items: [] };
    }
  }

  async function loadCatalog() {
    state.catalogState = 'loading';
    try {
      var r = await api('/catalog');
      var src = r && Array.isArray(r.sources) ? r.sources : (Array.isArray(r) ? r : []);
      state.catalog = src;
      state.catalogState = 'ready';
    } catch (e) {
      state.catalog = null;
      state.catalogState = 'error';
      state.catalogError = e.message;
    }
  }

  // 目录查元数据；404（目录未收录）返回 null
  async function lookupMeta(catalogId, modelKey) {
    var lk = catalogId + '|' + modelKey;
    if (Object.prototype.hasOwnProperty.call(state.lookup, lk)) return state.lookup[lk];
    var meta = null;
    try {
      var r = await api('/catalog/lookup?catalog_id=' + encodeURIComponent(catalogId) +
        '&model_key=' + encodeURIComponent(modelKey));
      meta = r && typeof r === 'object' ? r : null;
    } catch (e) {
      meta = null;
    }
    state.lookup[lk] = meta;
    return meta;
  }

  /* ── 设置：联网搜索 / 记忆（契约 §5.3）─────────────── */
  var SEARCH_PROVIDERS = [
    { id: 'deepseek', label: 'DeepSeek 原生' },
    { id: 'tavily', label: 'Tavily' },
    { id: 'bocha', label: '博查' }
  ];

  function searchProviderLabel(id) {
    for (var i = 0; i < SEARCH_PROVIDERS.length; i++) {
      if (SEARCH_PROVIDERS[i].id === id) return SEARCH_PROVIDERS[i].label;
    }
    return 'DeepSeek 原生';
  }

  function kindLabel(kind) {
    if (kind === 'fact') return '事实';
    if (kind === 'pref') return '偏好';
    return String(kind || '');
  }

  function domainOf(url) {
    if (!url) return '';
    try { return new URL(String(url)).hostname.replace(/^www\./, ''); }
    catch (e) { return String(url).replace(/^https?:\/\//, '').split('/')[0]; }
  }

  function fmtWhen(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso).slice(0, 16);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  async function loadSearchSettings() {
    state.searchState = 'loading';
    try {
      var r = await api('/settings/search');
      state.search = r && typeof r === 'object' ? r : {};
      state.searchState = 'ready';
    } catch (e) {
      state.searchState = 'error';
      state.searchError = e.message;
    }
  }

  async function loadMemorySettings() {
    try {
      var r = await api('/settings/memory');
      state.memorySetting = r && typeof r === 'object' ? r : { auto: true };
    } catch (e) {
      if (!state.memorySetting) state.memorySetting = { auto: true };
    }
  }

  async function loadMemoryStats() {
    try { state.memoryStats = await api('/memories/stats'); }
    catch (e) { state.memoryStats = null; }
  }

  async function loadMemories() {
    state.memoriesState = 'loading';
    try {
      var r = await api('/memories?limit=50');
      var items = r && Array.isArray(r.items) ? r.items : (Array.isArray(r) ? r : []);
      state.memories = items;
      state.memoriesState = 'ready';
    } catch (e) {
      state.memoriesState = 'error';
      state.memoriesError = e.message;
    }
  }

  async function openSettings() {
    openPage({ kind: 'settings' });
    await Promise.all([loadSearchSettings(), loadMemorySettings(), loadMemoryStats(), loadSubjects()]);
    if (state.page && state.page.kind === 'settings') render();
  }

  async function reloadAll() {
    state.models = {};
    state.modelsError = {};
    state.lookup = {};
    state.catalog = null;
    state.catalogState = 'loading';
    state.msgState = 'loading';
    await Promise.all([loadProviders(), loadConversation(), loadSettings(true), loadCatalog(), loadSubjects()]);
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
    renderRail();
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

  // rail 只有「对话 / 设置」两格可点（其余仍是占位），按所在空间换 on
  function renderRail() {
    var chat = q('#rail-chat');
    var set = q('#rail-settings');
    var mem = q('#rail-memories');
    var onSettings = !!(state.view === 'page' && state.page &&
      (state.page.kind === 'settings' || state.page.kind === 'memories'));
    if (chat) {
      chat.classList.toggle('on', !onSettings);
      if (onSettings) chat.removeAttribute('aria-current');
      else chat.setAttribute('aria-current', 'page');
    }
    if (set) {
      set.classList.toggle('on', onSettings);
      if (onSettings) set.setAttribute('aria-current', 'page');
      else set.removeAttribute('aria-current');
      if (mem) {
        var onMem = !!(state.view === 'page' && state.page && state.page.kind === 'memories');
        mem.classList.toggle('on', onMem);
        if (onMem) mem.setAttribute('aria-current', 'page');
        else mem.removeAttribute('aria-current');
      }
    }
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

  function updateToBottom() {
    var el = q('#stream');
    var btn = q('#to-bottom');
    if (!el || !btn) return;
    var away = el.scrollHeight - el.scrollTop - el.clientHeight;
    btn.hidden = !(away > 240) || state.msgState !== 'ready';
  }

  function scrollToBottom(smooth) {
    var el = q('#stream');
    if (!el) return;
    state.stick = true;
    if (smooth && el.scrollTo) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    else el.scrollTop = el.scrollHeight;
    updateToBottom();
  }

  function renderStream(force) {
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

    // 逐词揭示进行中：不重刷 DOM（重刷会打断 .sw 的 CSS 动画，这正是「突然跳出」的来源。类名用 .stream-word，.sw 是设计系统的开关，不能借）
    if (!force && state.liveMsg && el.querySelector('.sbody')) {
      if (state.stick) el.scrollTop = el.scrollHeight;
      return;
    }

    var streaming = state.messages.some(function (m) { return m.status === 'streaming'; });
    el.setAttribute('aria-live', streaming ? 'off' : 'polite');
    el.innerHTML = '<div class="col">' + state.messages.map(msgHtml).join('') + '</div>';
    if (state.liveMsg) repaintLive(state.liveMsg);
    typesetMath(el);
    updateToBottom();
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
    var useParts = !!(m.parts && m.parts.length && m.status !== 'streaming');
    if (useParts) {
      inner += thinkingGroupHtml(m);
      inner += partsAnswersHtml(m);
    } else {
      if (m.reasoning_md) inner += reasoningHtml(m);
      if (m._st) {
        inner += '<div class="agbody sbody"><div class="stable"></div>' +
          '<div class="live">' + caretHtml() + '</div></div>';
      } else if (m.content_md) {
        inner += '<div class="agbody">' + renderMarkdown(m.content_md) + '</div>';
      } else if (m.status === 'streaming') {
        inner += '<div class="skel inmsg">' + skelRows(2) + '</div>';
      }
    }
    if (!useParts) inner += statusRowHtml(m);
    inner += sourceLineHtml(m);
    if (m.error) inner += msgErrorHtml(m);
    return '<div class="ag" data-key="' + esc(m._key) + '">' + inner + '</div>';
  }

  /* ── 消息状态行（思考条下方）+ 末尾来源行（契约 §5.1 / §5.2）── */
  function numWrap(n) { return '<span class="num">' + Number(n) + '</span>'; }

  function searchTimes(m) {
    var n = Number(m._searchCount || 0);
    if (!n && Array.isArray(m.tools)) {
      m.tools.forEach(function (t) { if (t === 'web_search') n += 1; });
    }
    return n;
  }

  function stepSecs(ms) {
    var n = Math.max(1, Math.round((Number(ms) || 0) / 1000));
    return n + ' 秒';
  }

  // 一条消息 = 多个 part（参考 Vercel AI SDK 的 message parts / assistant-ui GroupedParts）
  function partsSplit(m) {
    var steps = [];
    var reasonCount = (m.parts || []).filter(function (x) { return x && x.type === 'reasoning'; }).length;
    var answers = [];
    (m.parts || []).forEach(function (p) {
      if (!p || !p.type) return;
      if (p.type === 'reasoning') {
        // 只有一段思考且没有分段耗时（非 DeepSeek 原生路径）时，用整轮的 thinking_ms 兜底
        var ms = p.ms || (reasonCount === 1 ? m.thinking_ms : 0);
        var lab = ms ? '思考 ' + stepSecs(ms) : '思考';
        steps.push('<details class="pstep">' +
          '<summary class="psum">' + ic('zap', 'sm') +
          '<span class="plab">' + esc(lab) + '</span>' +
          ic('chevron-down', 'sm pchev') + '</summary>' +
          '<div class="pbody">' + renderMarkdown(p.text || '') + '</div></details>');
      } else if (p.type === 'tool') {
        var q = (p.queries && p.queries.length) ? '「' + p.queries.join('、') + '」' : '';
        steps.push('<button type="button" class="pstep ptool" data-act="open-sources" data-key="' +
          esc(m._key) + '">' + ic('search', 'sm') +
          '<span class="plab">联网搜索</span>' +
          (q ? '<span class="pval">' + esc(q) + '</span>' : '') +
          (p.count ? '<span class="pcount">' + numWrap(p.count) + ' 条</span>' : '') +
          ic('chevron-right', 'sm pchev') + '</button>');
      } else if (p.type === 'text') {
        answers.push('<div class="agbody">' + renderMarkdown(p.text || '') + '</div>');
      }
    });
    return { steps: steps, answers: answers };
  }

  // 工具调用、搜索、记忆都收进同一个折叠块里，按时间线排列，样式统一
  function thinkingGroupHtml(m) {
    var body = [];
    var ms = 0;
    var tools = 0;
    (m.parts || []).forEach(function (p) {
      if (!p || !p.type) return;
      if (p.type === 'reasoning') {
        ms += Number(p.ms) || 0;
        body.push('<div class="tstep"><div class="tstep-t">' +
          renderMarkdown(p.text || '') + '</div></div>');
      } else if (p.type === 'tool') {
        tools += 1;
        var q = (p.queries && p.queries.length) ? '「' + p.queries.join('、') + '」' : '';
        var tname = p.name === 'memory_search' ? '检索记忆' : '联网搜索';
        var ticon = p.name === 'memory_search' ? 'database' : 'search';
        body.push('<button type="button" class="tstep tstep-tool" data-act="open-sources" data-key="' +
          esc(m._key) + '">' + ic(ticon, 'sm') +
          '<span class="tstep-l">' + tname + '</span>' +
          (q ? '<span class="tstep-q">' + esc(q) + '</span>' : '') +
          (p.count ? '<span class="tstep-n">' + numWrap(p.count) + ' 条</span>' : '') +
          ic('chevron-right', 'sm tstep-c') + '</button>');
      }
    });
    var rem = m.remembered || [];
    if (rem.length) {
      rem.forEach(function (r) {
        body.push('<div class="tstep tstep-mem">' + ic('database', 'sm') +
          '<span class="tstep-l">记住</span>' +
          '<span class="tstep-q">「' + esc(r.text || '') + '」</span></div>');
      });
    }
    // 整轮 thinking_ms 更可信（分段事件不一定每次都来）
    var totalMs = Number(m.thinking_ms) || ms;
    if (!body.length) return '';
    var head = [];
    head.push(totalMs ? '思考 ' + stepSecs(totalMs) : (tools ? '调用工具' : '记忆'));
    if (tools) head.push('搜索 ' + tools + ' 次');
    if (rem.length) head.push('记忆 +' + rem.length);
    return '<details class="tgroup">' +
      '<summary class="tgsum">' + ic('zap', 'sm') +
      '<span class="tglab">' + esc(head.join(' · ')) + '</span>' +
      ic('chevron-down', 'sm tgchev') + '</summary>' +
      '<div class="tgbody">' + body.join('') + '</div></details>';
  }

  function partsAnswersHtml(m) {
    return partsSplit(m).answers.join('');
  }

  function lastPart(m, type) {
    var arr = m && m.parts;
    if (!arr) return null;
    for (var i = arr.length - 1; i >= 0; i--) {
      if (arr[i] && arr[i].type === type) return arr[i];
    }
    return null;
  }

  function ensurePart(m, kind, extra) {
    if (!m.parts) m.parts = [];
    var p = { type: kind };
    if (extra) for (var k in extra) p[k] = extra[k];
    m.parts.push(p);
    return p;
  }

  function statusRowHtml(m) {
    var parts = [];
    // 秒数只在思考条那一行显示（同一数字不重复占两行）
    var mem = (m.remembered || []).length;
    if (mem > 0) {
      parts.push('<button type="button" class="tpill ro hit44" data-act="open-sources" data-key="' +
        esc(m._key) + '">' + ic('database', 'sm') + '记忆 +' + numWrap(mem) + '</button>');
    }
    var web = searchTimes(m);
    if (web > 0) {
      parts.push('<button type="button" class="tpill ro hit44" data-act="open-sources" data-key="' +
        esc(m._key) + '">' + ic('search', 'sm') + '搜索 ' + numWrap(web) + ' 次</button>');
    }
    if (!parts.length) return '';
    return '<div class="statusrow" data-status="1">' + parts.join('') + '</div>';
  }

  function srcCount(m, type) {
    return (m.sources || []).filter(function (s) { return s && s.type === type; }).length;
  }

  function sourceLineHtml(m) {
    var mem = srcCount(m, 'memory');
    var web = srcCount(m, 'web');
    if (!mem && !web) return '';
    var parts = [];
    if (mem) parts.push(ic('database', 'sm') + '根据 ' + numWrap(mem) + ' 条记忆');
    if (web) parts.push(ic('globe', 'sm') + '参考 ' + numWrap(web) + ' 个网页');
    return '<button type="button" class="srcline" data-act="open-sources" data-key="' + esc(m._key) + '">' +
      '<span class="srl">' + parts.join('<span class="dot">·</span>') + '</span>' +
      ic('chevron-right', 'sm chev') + '</button>';
  }

  function findMessageByKey(key) {
    for (var i = 0; i < state.messages.length; i++) {
      if (String(state.messages[i]._key) === String(key)) return state.messages[i];
    }
    return null;
  }

  // 只补状态行/来源行，不动正文（memory 事件在 done 之后到达）
  function patchMeta(m) {
    var root = msgRoot(m);
    if (!root) return;
    var row = root.querySelector('[data-status]');
    var rowHtml = statusRowHtml(m);
    if (row) {
      if (rowHtml) row.outerHTML = rowHtml;
      else if (row.parentNode) row.parentNode.removeChild(row);
    } else if (rowHtml) {
      var body = root.querySelector('.agbody');
      if (body) body.insertAdjacentHTML('beforebegin', rowHtml);
      else root.insertAdjacentHTML('beforeend', rowHtml);
    }
    var line = root.querySelector('.srcline');
    var lineHtml = sourceLineHtml(m);
    if (line) {
      if (lineHtml) line.outerHTML = lineHtml;
      else if (line.parentNode) line.parentNode.removeChild(line);
    } else if (lineHtml) {
      var body2 = root.querySelector('.agbody');
      if (body2) body2.insertAdjacentHTML('afterend', lineHtml);
      else root.insertAdjacentHTML('beforeend', lineHtml);
    }
  }

  function mergeWebSources(m, list) {
    m.sources = m.sources || [];
    var seen = {};
    m.sources.forEach(function (s) { if (s && s.url) seen[s.url] = 1; });
    list.forEach(function (s) {
      if (!s || typeof s !== 'object') return;
      var item = { type: 'web', title: s.title || '', url: s.url || '', site: s.site_name || s.site || '' };
      if (item.url && seen[item.url]) return;
      if (item.url) seen[item.url] = 1;
      m.sources.push(item);
    });
  }

  function mergeRemembered(m, list) {
    m.remembered = m.remembered || [];
    var seen = {};
    m.remembered.forEach(function (x) { seen[String(x.id)] = 1; });
    list.forEach(function (x) {
      if (!x || x.id == null) return;
      if (seen[String(x.id)]) return;
      seen[String(x.id)] = 1;
      m.remembered.push(x);
    });
  }

  function caretHtml() { return '<span class="caret" aria-hidden="true"></span>'; }

  var THINK_PEEK_CHARS = 96;

  function nowMs() { return (window.performance && performance.now) ? performance.now() : Date.now(); }

  function tailText(s, n) {
    var t = String(s || "").replace(/\s+/g, " ").trim();
    return t.length > n ? "…" + t.slice(-n) : t;
  }

  function thinkSecs(m) {
    if (m._thinkMs != null) return Math.max(1, Math.round(m._thinkMs / 1000));
    if (m.thinking_ms) return Math.max(1, Math.round(m.thinking_ms / 1000));
    if (m._thinkStart) return Math.max(1, Math.round((nowMs() - m._thinkStart) / 1000));
    return 0;
  }

  function thinkLabel(m) {
    var secs = thinkSecs(m);
    if (m.status === "streaming" && !m.content_md) return secs ? "思考中 · " + secs + " 秒" : "思考中";
    return secs ? "思考 " + secs + " 秒" : "思考";
  }

  // 折叠态就给出「最新思考尾巴」：不用展开也能看到实时（参考 CopilotKit / DeepSeek-Reasonix）
  function reasoningHtml(m) {
    var thinking = m.status === "streaming" && !m.content_md;
    var open = m._open === true;
    m._renderOpen = open;
    var peek = thinking && m.reasoning_md
      ? '<span class="rpeek">' + escText(tailText(m.reasoning_md, THINK_PEEK_CHARS)) + "</span>"
      : "";
    return '<details class="rbox" data-key="' + esc(m._key) + '"' + (open ? " open" : "") + ">" +
      '<summary class="rsum">' + ic("zap", "sm") +
      '<span class="rlabel">' + esc(thinkLabel(m)) + "</span>" + peek +
      ic("chevron-down", "sm rcar") + "</summary>" +
      '<div class="rbody">' + renderMarkdown(m.reasoning_md) + "</div></details>";
  }

  function msgErrorHtml(m) {
    var canRetry = !!m.canRetry && state.messages[state.messages.length - 1] === m;
    return '<div class="merr">' + ic('alert-circle') +
      '<span class="msg">' + esc(m.error || '') + '</span>' +
      (canRetry ? '<button type="button" class="btn" data-act="retry" data-key="' + esc(m._key) + '">重试</button>' : '') +
      '</div>';
  }

  /* ── 流式渐显：节奏队列 + 词级 span（DOM 稳定，不逐帧重刷）──
     55 字/秒 匀速揭示；积压每 40 字再 +25%，收尾时 ×1.6 追赶。 */
  var REVEAL_BASE = 55;
  var REVEAL_STEP = 40;
  var REVEAL_BOOST = 0.25;

  function msgRoot(m) {
    if (!m || !m._key) return null;
    return q('#stream .ag[data-key="' + m._key + '"]');
  }

function typesetMath(el) {
    if (!el || typeof window.renderMathInElement !== "function") return;
    try {
      window.renderMathInElement(el, {
        delimiters: [
          { left: "$$", right: "$$", display: true },
          { left: "\\[", right: "\\]", display: true },
          { left: "$", right: "$", display: false },
          { left: "\\(", right: "\\)", display: false }
        ],
        throwOnError: false,
        errorColor: "inherit",
        strict: false,
        ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code"],
        ignoredClasses: ["no-math"]
      });
    } catch (e) { /* 公式坏了就保持原文，不能阻塞渲染 */ }
  }

  function caretEl() {    var c = document.createElement('span');
    c.className = 'caret';
    c.setAttribute('aria-hidden', 'true');
    return c;
  }

  function liveEls(m) {
    var st = m && m._st;
    if (!st) return null;
    if (st.el && st.el.live && st.el.live.isConnected) return st.el;
    var root = msgRoot(m);
    if (!root) return null;
    var body = root.querySelector('.sbody');
    if (!body) return null;
    st.el = { body: body, stable: body.querySelector('.stable'), live: body.querySelector('.live') };
    return st.el;
  }

  function ensureLiveStructure(m) {
    var root = msgRoot(m);
    if (!root) return null;
    var body = root.querySelector('.sbody');
    if (!body) {
      var skel = root.querySelector('.skel');
      if (skel && skel.parentNode) skel.parentNode.removeChild(skel);
      body = document.createElement('div');
      body.className = 'agbody sbody';
      body.innerHTML = '<div class="stable"></div><div class="live no-math">' + caretHtml() + '</div>';
      root.appendChild(body);
    }
    var live = body.querySelector('.live');
    if (live && !live.querySelector('.caret')) live.appendChild(caretEl());
    return body;
  }

  function startLive(m) {
    if (!m._st) {
      m._st = { target: '', shown: 0, pending: '', committed: '', final: false, raf: 0, el: null };
    }
    if (state.liveMsg !== m) state.liveMsg = m;
    ensureLiveStructure(m);
    liveEls(m);
  }

  var CJK_CH = /[\u4e00-\u9fff\u3400-\u4dbf]/;
  var CJK_PUNCT = /[\u3000-\u303f\uff01-\uff20\uff3b-\uff40\uff5b-\uff65]/;

  // 中文逐字（每字一个 span），拉丁按连续段，空白直接放文本节点，标点挂到前一个 token
  function tokenizeLive(text) {
    var out = [];
    var re = /[A-Za-z0-9][A-Za-z0-9._’'+-]*|\s+|[\s\S]/g;
    var mm;
    while ((mm = re.exec(text))) {
      var tok = mm[0];
      if (/^\s+$/.test(tok)) { out.push({ t: tok, ws: true }); continue; }
      var single = tok.length === 1;
      var isCjk = single && CJK_CH.test(tok);
      var isWord = /^[A-Za-z0-9]/.test(tok);
      if (!isCjk && !isWord) {
        var prev = out.length ? out[out.length - 1] : null;
        if (prev && !prev.ws) { prev.t += tok; continue; }
      }
      out.push({ t: tok });
    }
    return out;
  }

  function appendLiveSpans(live, text) {
    var cs = live.querySelector('.caret');
    var frag = document.createDocumentFragment();
    var toks = tokenizeLive(text);
    for (var i = 0; i < toks.length; i++) {
      if (toks[i].ws) {
        frag.appendChild(document.createTextNode(toks[i].t));
      } else {
        var sp = document.createElement('span');
        sp.className = 'stream-word';
        sp.textContent = toks[i].t;
        frag.appendChild(sp);
      }
    }
    live.insertBefore(frag, cs || null);
  }

  function commitParagraph(m) {
    var st = m && m._st;
    if (!st) return;
    var idx = st.pending.lastIndexOf('\n\n');
    // display 公式（$$…$$）自成一块：闭合就立刻提交，避免尾巴里长时间显示 \frac 这种裸源码
    var dbl = st.pending.split('$$').length - 1;
    if (dbl > 0 && dbl % 2 === 0) {
      var closeAt = st.pending.lastIndexOf('$$') + 2;
      idx = Math.max(idx, closeAt);
    }
    if (idx < 0) return;
    st.committed += st.pending.slice(0, idx) + '\n\n';
    st.pending = st.pending.slice(idx + 2).replace(/^\n+/, '');
    var els = liveEls(m);
    if (!els) return;
    els.stable.innerHTML = renderMarkdown(st.committed);
    typesetMath(els.stable);
    els.live.textContent = '';
    els.live.appendChild(caretEl());
    if (st.pending) appendLiveSpans(els.live, st.pending);
  }

  function revealChars(m, amount) {
    var st = m && m._st;
    if (!st) return;
    var els = liveEls(m);
    if (!els) return;
    var want = Math.min(st.target.length, st.shown + Math.max(1, Math.floor(amount)));
    if (want <= st.shown) return;
    var chunk = st.target.slice(st.shown, want);
    // 不把 ASCII 词切成两半，否则同一个词会淡入两次
    if (want < st.target.length && /[A-Za-z0-9._’'+-]$/.test(chunk) &&
      /[A-Za-z0-9._’'+-]/.test(st.target.charAt(want))) {
      var tail = chunk.match(/[A-Za-z0-9._’'+-]+$/);
      if (tail && tail[0].length < chunk.length) chunk = chunk.slice(0, chunk.length - tail[0].length);
    }
    if (!chunk) return;
    st.shown += chunk.length;
    st.pending += chunk;
    appendLiveSpans(els.live, chunk);
    commitParagraph(m);
    var sc = q('#stream');
    if (sc && state.stick) sc.scrollTop = sc.scrollHeight;
  }

  function pumpReveal(m) {
    var st = m && m._st;
    if (!st || st.raf) return;
    var lastT = 0;
    function frame(now) {
      st.raf = 0;
      if (!m._st || m._st !== st) return;
      if (!lastT) lastT = now;
      var dt = Math.max(0, Math.min(now - lastT, 120));
      lastT = now;
      var backlog = st.target.length - st.shown;
      if (backlog > 0) {
        var rate = REVEAL_BASE * (1 + REVEAL_BOOST * Math.floor(backlog / REVEAL_STEP));
        if (st.final) rate *= 1.6;
        revealChars(m, rate * dt / 1000);
      }
      if (!m._st || m._st !== st) return;
      if (st.target.length > st.shown) st.raf = requestAnimationFrame(frame);
      else if (st.final) finalizeLive(m);
    }
    st.raf = requestAnimationFrame(frame);
  }

  function repaintLive(m) {
    var st = m && m._st;
    if (!st) return;
    var els = liveEls(m);
    if (!els) return;
    els.stable.innerHTML = st.committed ? renderMarkdown(st.committed) : '';
    typesetMath(els.stable);
    els.live.textContent = '';
    if (st.pending) {
      var sp = document.createElement('span');
      sp.className = 'stream-word';
      sp.textContent = st.pending;
      els.live.appendChild(sp);
    }
    els.live.appendChild(caretEl());
  }

  function dropLive(m) {
    if (!m) return;
    if (m._st && m._st.raf) cancelAnimationFrame(m._st.raf);
    m._st = null;
    if (state.liveMsg === m) state.liveMsg = null;
  }

  // 收尾：一次渲染完整 Markdown，去掉 streaming 标记与光标
  function finalizeLive(m) {
    dropLive(m);
    renderStream(true);
  }

  // 思考计时：思考中每 0.5 秒刷新一次标签（不用等下一个 delta）
  setInterval(function () {
    for (var ti = 0; ti < state.messages.length; ti++) {
      var tm = state.messages[ti];
      if (tm.status === "streaming" && !tm.content_md && tm._thinkStart) paintReasoning(tm);
    }
  }, 500);

  function paintReasoning(m) {
    var root = msgRoot(m);
    if (!root) return;
    var det = root.querySelector("details.rbox");
    if (!det) {
      root.insertAdjacentHTML("afterbegin", reasoningHtml(m));
      return;
    }
    var lab = det.querySelector(".rlabel");
    if (lab) lab.textContent = thinkLabel(m);
    var thinking = m.status === "streaming" && !m.content_md;
    var peek = det.querySelector(".rpeek");
    if (peek) {
      if (thinking && m.reasoning_md) {
        peek.textContent = tailText(m.reasoning_md, THINK_PEEK_CHARS);
        peek.hidden = false;
      } else {
        peek.hidden = true;
      }
    }
    if (det.hasAttribute("open")) {
      var body = det.querySelector(".rbody");
      if (body) body.innerHTML = renderMarkdown(m.reasoning_md);
    }
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
      '<div class="shd"><div class="ttl" id="cf-ttl">' + esc(o.title || '确认') + '</div>' +
      '<button type="button" class="hit" data-act="close-sheet" aria-label="关闭">' + ic('x') + '</button></div>' +
      '<div class="sheet-body"><div class="confirm-name">' + esc(o.text || '') + '</div></div>' +
      '<div class="sheet-foot"><div class="btnbar full">' +
      '<button type="button" class="btn" data-act="close-sheet">取消</button>' +
      '<button type="button" class="btn d" data-act="' + esc(o.act || 'close-sheet') + '">' +
      esc(o.actLabel || '确认') + '</button>' +
      '</div></div></div>';
  }

  /* ── 来源浮窗（§5.2）：上半记忆、下半网页 ─────────── */
  function memoryEditSheetHtml(o) {
    var m = o.id ? (state.memories || []).filter(function (x) { return String(x.id) === String(o.id); })[0] : null;
    var kind = (m && m.kind) || 'fact';
    var body =
      '<div class="field"><label class="flabel" for="mem-text">内容</label>' +
      '<textarea class="fi fta" id="mem-text" rows="3" placeholder="一句话，例如：她物理最怕电磁感应">' +
      esc(m ? m.text : '') + '</textarea></div>' +
      '<div class="field"><span class="flabel">类型</span><div class="seg">' +
      '<button type="button" class="tpill' + (kind === 'fact' ? ' on' : '') + '" data-act="pick-memory-kind" data-kind="fact">事实</button>' +
      '<button type="button" class="tpill' + (kind === 'pref' ? ' on' : '') + '" data-act="pick-memory-kind" data-kind="pref">偏好</button>' +
      '</div></div>' +
      '<div class="field"><label class="flabel" for="mem-subject">学科</label>' +
      '<input class="fi" id="mem-subject" type="text" autocomplete="off" value="' + esc(m ? m.subject || '' : '') +
      '" placeholder="可空"></div>';
    return '<div class="scrim" data-act="close-sheet"></div>' +
      '<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="mem-ttl" tabindex="-1">' +
      '<div class="grab"></div>' +
      '<div class="shd"><div class="ttl" id="mem-ttl">' + (m ? '记忆' : '添加记忆') + '</div>' +
      '<button type="button" class="hit" data-act="close-sheet" aria-label="关闭">' + ic('x') + '</button></div>' +
      '<div class="sheet-body">' + body + '</div>' +
      '<div class="sheet-foot"><div class="btnbar full">' +
      (m ? '<button type="button" class="btn danger" data-act="ask-delete-memory" data-id="' + esc(m.id) + '">删除</button>' : '') +
      '<button type="button" class="btn" data-act="close-sheet">取消</button>' +
      '<button type="button" class="btn p" data-act="save-memory" data-id="' + esc(m ? m.id : '') + '">保存</button>' +
      '</div></div></div>';
  }

  function subjectsSheetHtml(o) {
    var cur = (state.subjects && state.subjects.current) || '全部';
    var items = (state.subjects && state.subjects.items) || [];
    var rows = items.map(function (it) {
      var on = it.subject === cur;
      return '<button type="button" class="mrow' + (on ? ' on' : '') + '" data-act="switch-subject" data-subject="' +
        esc(it.subject) + '"><span class="nm">' + esc(it.subject) + '</span>' +
        (it.count ? '<span class="cnt">' + numWrap(it.count) + '</span>' : '') +
        (on ? '<span class="chk">' + ic('check', 'sm') + '</span>' : '<span class="chk"></span>') +
        '</button>';
    }).join('');
    return '<div class="scrim" data-act="close-sheet"></div>' +
      '<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="subj-ttl" tabindex="-1">' +
      '<div class="grab"></div>' +
      '<div class="shd"><div class="ttl" id="subj-ttl">学科</div>' +
      '<button type="button" class="hit" data-act="close-sheet" aria-label="关闭">' + ic('x') + '</button></div>' +
      '<div class="sheet-body"><div class="pgrp">' + rows + '</div></div>' +
      '</div></div>';
  }

  async function switchSubject(name) {
    var old = (state.subjects && state.subjects.current) || '全部';
    if (name === old) { state.overlay = null; render(); return; }
    var st = q('#stream');
    if (st) state.subjectScroll[old] = st.scrollTop;
    try {
      await api('/subject', { method: 'PATCH', json: { subject: name } });
    } catch (e) {
      toast('切换失败：' + e.message);
      return;
    }
    state.overlay = null;
    state.messages = [];
    state.liveMsg = null;
    state.msgState = 'loading';
    await Promise.all([loadSubjects(), loadMessages()]);
    render();
    var s2 = q('#stream');
    if (s2) s2.scrollTop = state.subjectScroll[name] || s2.scrollHeight;
  }

  function sourcesSheetHtml(o) {
    var m = findMessageByKey(o.key);
    var mem = m ? (m.sources || []).filter(function (s) { return s && s.type === 'memory'; }) : [];
    var web = m ? (m.sources || []).filter(function (s) { return s && s.type === 'web'; }) : [];
    var body = '';
    if (mem.length) {
      body += '<div class="slabel">记忆 · ' + mem.length + '</div><div class="scard">' +
        mem.map(function (s) {
          return '<div class="srow"><span class="md"><span class="n1">' +
            esc(s.text || s.title || '') + '</span></span>' +
            '<span class="trail"><span class="val">' + esc(kindLabel(s.kind)) + '</span></span></div>';
        }).join('') + '</div>';
    }
    if (web.length) {
      body += '<div class="slabel">网页 · ' + web.length + '</div><div class="scard">' +
        web.map(function (s) {
          var url = s.url || '#';
          return '<a class="srow weblink" href="' + esc(url) + '" target="_blank" rel="noreferrer">' +
            '<span class="md"><span class="n1">' + esc(s.title || url) + '</span>' +
            '<span class="n2 mono">' + esc(domainOf(url)) + '</span></span>' +
            '<span class="trail">' + ic('external-link', 'sm') + '</span></a>';
        }).join('') + '</div>';
    }
    if (!body) {
      body = '<div class="empty">' + ic('database') + '<div class="t">没有来源</div></div>';
    }
    return '<div class="scrim" data-act="close-sheet"></div>' +
      '<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="src-ttl" tabindex="-1">' +
      '<div class="grab"></div>' +
      '<div class="shd"><div class="ttl" id="src-ttl">来源</div>' +
      '<button type="button" class="hit" data-act="close-sheet" aria-label="关闭">' + ic('x') + '</button></div>' +
      '<div class="sheet-body">' + body + '</div></div>';
  }

  function providerPickSheetHtml() {
    var cur = (state.search && state.search.provider) || 'deepseek';
    var rows = SEARCH_PROVIDERS.map(function (p) {
      var on = p.id === cur;
      return '<button type="button" class="mrow' + (on ? ' on' : '') +
        '" data-act="set-search-provider" data-provider="' + p.id + '">' +
        '<span class="nm">' + esc(p.label) + '</span>' +
        '<span class="chk">' + (on ? ic('check', 'sm') : '') + '</span></button>';
    }).join('');
    return '<div class="scrim" data-act="close-sheet"></div>' +
      '<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="pp-ttl" tabindex="-1">' +
      '<div class="grab"></div>' +
      '<div class="shd"><div class="ttl" id="pp-ttl">提供方</div>' +
      '<button type="button" class="hit" data-act="close-sheet" aria-label="关闭">' + ic('x') + '</button></div>' +
      '<div class="sheet-body">' + rows + '</div></div>';
  }

  function searchKeySheetHtml() {
    var tail = state.search && state.search.api_key_tail;
    return '<div class="scrim" data-act="close-sheet"></div>' +
      '<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sk-ttl" tabindex="-1">' +
      '<div class="grab"></div>' +
      '<div class="shd"><div class="ttl" id="sk-ttl">API Key</div>' +
      '<button type="button" class="hit" data-act="close-sheet" aria-label="关闭">' + ic('x') + '</button></div>' +
      '<div class="sheet-body"><div class="field">' +
      '<label class="flabel" for="s-key">API Key</label>' +
      '<input class="fi" id="s-key" type="password" autocomplete="off" spellcheck="false" placeholder="' +
      (tail ? '保持不变' : 'sk-…') + '">' +
      '<div class="fmsg" data-msg="s_key"></div></div>' +
      (tail ? '<div class="src">当前 ' + esc(keyMask(tail)) + '</div>' : '') +
      '</div>' +
      '<div class="sheet-foot"><div class="btnbar full">' +
      '<button type="button" class="btn" data-act="close-sheet">取消</button>' +
      '<button type="button" class="btn p" data-act="save-search-key">保存</button>' +
      '</div></div></div>';
  }

  function modelDetailSheetHtml(o) {
    var m = findModel(o.pid, o.mid) || {};
    var src = m.meta_source || '';
    var meta = o.meta;                       // 目录结果：undefined=查询中 / null=未收录
    var pending = !src && meta === undefined;
    var body = '';

    if (pending) {
      body = '<div class="skel inmsg">' + skelRows(3) + '</div>';
    } else {
      var use;
      if (src === 'catalog' || src === 'manual') {
        use = {
          name: m.display_name || '', ctx: m.context_len || 0,
          images: !!m.supports_images, tools: !!m.supports_tools, reason: !!m.supports_thinking
        };
      } else if (meta) {
        use = {
          name: meta.name || '', ctx: meta.context || 0,
          images: !!meta.images, tools: !!meta.tools, reason: !!meta.reasoning
        };
      } else {
        use = { name: '', ctx: 0, images: false, tools: false, reason: false };
      }
      var source = src === 'manual' ? '手填' : (meta || src === 'catalog' ? 'models.dev' : '未收录，请手动填写');
      body =
        '<div class="field"><label class="flabel" for="m-name">显示名</label>' +
        '<input class="fi" id="m-name" name="display_name" type="text" autocomplete="off" ' +
        'spellcheck="false" value="' + esc(use.name) + '">' +
        '<div class="fmsg" data-msg="display_name"></div></div>' +
        '<div class="field"><label class="flabel" for="m-ctx">上下文长度</label>' +
        '<div class="kwrap"><input class="fi" id="m-ctx" name="context_k" type="text" inputmode="numeric" ' +
        'autocomplete="off" value="' + esc(use.ctx ? Math.round(use.ctx / 1024) : '') + '">' +
        '<span class="unit">K</span></div>' +
        '<div class="fmsg" data-msg="context_k"></div></div>' +
        '<div class="scard">' +
        switchRow('多模态', 'images', use.images) +
        switchRow('工具调用', 'tools', use.tools) +
        switchRow('思考', 'reasoning', use.reason) +
        '</div>' +
        '<div class="src">' + esc(source) + '</div>';
    }

    return '<div class="scrim" data-act="close-sheet"></div>' +
      '<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="md-ttl" tabindex="-1">' +
      '<div class="grab"></div>' +
      '<div class="shd"><div class="ttl" id="md-ttl">' + esc(m.model_key || '模型设置') + '</div>' +
      '<button type="button" class="hit" data-act="close-sheet" aria-label="关闭">' + ic('x') + '</button></div>' +
      '<div class="sheet-body">' + body + '</div>' +
      '<div class="sheet-foot"><div class="btnbar full">' +
      '<button type="button" class="btn" data-act="close-sheet">取消</button>' +
      (pending ? '' : '<button type="button" class="btn p" data-act="save-model" data-pid="' + esc(o.pid) +
        '" data-mid="' + esc(o.mid) + '">保存</button>') +
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
    var kind = state.overlay.kind;
    host.innerHTML = kind === 'confirm' ? confirmSheetHtml(state.overlay)
      : kind === 'model' ? modelDetailSheetHtml(state.overlay)
        : kind === 'sources' ? sourcesSheetHtml(state.overlay)
      : kind === 'memory' ? memoryEditSheetHtml(state.overlay)
      : kind === 'subjects' ? subjectsSheetHtml(state.overlay)
          : kind === 'provider-pick' ? providerPickSheetHtml()
            : kind === 'search-key' ? searchKeySheetHtml()
              : modelSheetHtml();
  }

  /* ── 渲染：模型管理 / provider 详情 / 表单 ─────────── */
  function navbar(title, sub, backAct, backLabel, closeIcon) {
    var btn = '<button type="button" class="hit back" data-act="' + backAct + '" aria-label="' + esc(backLabel) + '">' +
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

  function catalogRow(src) {
    return '<button type="button" class="srow" data-act="connect-catalog" data-cid="' + esc(src.catalog_id) + '">' +
      '<span class="lead">' + ic('globe') + '</span>' +
      '<span class="md"><span class="n1">' + esc(src.name) + '</span></span>' +
      '<span class="trail"><span class="val">连接</span>' + ic('chevron-right', 'sm chev') + '</span></button>';
  }

  function catalogGroupHtml() {
    var inner = '';
    if (state.catalogState === 'loading') {
      inner = '<div class="scard"><div class="skel inmsg">' + skelRows(2) + '</div></div>';
    } else if (state.catalogState === 'error') {
      inner = '<div class="scard"><button type="button" class="srow" data-act="reload-catalog">' +
        '<span class="lead">' + ic('alert-circle') + '</span>' +
        '<span class="md"><span class="n1">目录加载失败</span></span>' +
        '<span class="trail"><span class="val">重试</span></span></button></div>';
    } else {
      var open = (state.catalog || []).filter(function (s) { return !s.connected; });
      if (!open.length) {
        inner = '<div class="scard">' + voidRow('全部已连接') + '</div>';
      } else {
        var cn = open.filter(function (s) { return s.group === '国内'; });
        var ab = open.filter(function (s) { return s.group !== '国内'; });
        if (cn.length) {
          inner += '<div class="subhead">国内</div><div class="scard">' +
            cn.map(catalogRow).join('') + '</div>';
        }
        if (ab.length) {
          inner += '<div class="subhead">海外</div><div class="scard">' +
            ab.map(catalogRow).join('') + '</div>';
        }
      }
    }
    return '<div class="sgroup"><div class="slabel">内置平台</div>' + inner + '</div>';
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
    var loose = (state.providers || []).filter(function (p) {
      return !p.connected && !p.catalog_id;
    });
    var addRow = '<button type="button" class="srow" data-act="open-add-form">' +
      '<span class="lead">' + ic('plus') + '</span>' +
      '<span class="md"><span class="n1">添加 OpenAI 兼容端点</span></span>' +
      '<span class="trail">' + ic('chevron-right', 'sm chev') + '</span></button>';

    return nav + '<div class="settings">' +
      groupHtml('已连接', conn.length ? conn.map(providerRow).join('') : voidRow('还没有已连接的端点')) +
      catalogGroupHtml() +
      groupHtml('自定义', loose.map(providerRow).join('') + addRow) +
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
      return '<button type="button" class="mitem" data-act="model-settings" data-pid="' + esc(pid) +
        '" data-mid="' + esc(m.id) + '">' +
        '<span class="ck">' + (on ? ic('check', 'sm') : '') + '</span>' +
        '<span class="id mono">' + esc(m.model_key) + '</span>' +
        '<span class="ctx2">' + esc(fmtCtx(m.context_len)) + '</span>' +
        ic('chevron-right', 'sm chev') + '</button>';
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

  function formField(label, key, input, required) {
    return '<div class="field"><label class="flabel" for="f-' + key + '">' + label +
      (required ? '<em class="req" aria-hidden="true">*</em>' : '') + '</label>' + input +
      '<div class="fmsg" data-msg="' + key + '"></div></div>';
  }

  function switchRow(label, key, on) {
    return '<button type="button" class="srow swrow" role="switch" aria-checked="' + (on ? 'true' : 'false') + '"' +
      ' data-act="toggle-sw" data-sw="' + key + '">' +
      '<span class="md"><span class="n1">' + esc(label) + '</span></span>' +
      '<span class="trail"><span class="sw' + (on ? ' on' : '') + '"></span></span></button>';
  }

  function formHtml(page) {
    var p = page.providerId != null ? findProvider(page.providerId) : null;
    var src = page.catalogId ? findCatalog(page.catalogId) : null;
    var mode = p ? 'edit' : (src ? 'catalog' : 'custom');
    var nameVal = p ? p.name : (src ? src.name : '');
    var urlVal = p ? p.base_url : (src ? src.base_url : '');
    var title = p ? '编辑端点' : (src ? src.name : '添加端点');
    var nav = navbar(title, '', 'close-form', '关闭', true);

    var meta = '';
    if (mode === 'custom') {
      meta =
        formField('显示名', 'display_name',
          '<input class="fi" id="f-display_name" name="display_name" type="text" autocomplete="off" ' +
          'spellcheck="false" placeholder="DeepSeek V4">', true) +
        formField('上下文长度', 'context_k',
          '<div class="kwrap"><input class="fi" id="f-context_k" name="context_k" type="text" ' +
          'inputmode="numeric" autocomplete="off"><span class="unit">K</span></div>') +
        '<div class="scard">' +
        switchRow('多模态', 'images', false) +
        switchRow('工具调用', 'tools', false) +
        switchRow('思考', 'reasoning', false) +
        '</div>';
    }

    return nav + '<form class="formpane" id="provider-form" data-mode="' + mode +
      '" data-pid="' + esc(p ? p.id : '') + '" data-cid="' + esc(src ? src.catalog_id : '') + '" novalidate>' +
      '<div class="fields">' +
      '<div class="errbar" id="form-err" role="alert" hidden>' + ic('alert-circle') +
      '<span class="msg"></span></div>' +
      formField('名称', 'name',
        '<input class="fi" id="f-name" name="name" type="text" maxlength="80" autocomplete="off" ' +
        'spellcheck="false" value="' + esc(nameVal) + '">', true) +
      formField('端点', 'base_url',
        '<input class="fi" id="f-base_url" name="base_url" type="url" inputmode="url" autocomplete="off" ' +
        'spellcheck="false" placeholder="https://…" value="' + esc(urlVal) + '">', true) +
      formField('API Key', 'api_key',
        '<input class="fi" id="f-api_key" name="api_key" type="password" autocomplete="off" ' +
        'spellcheck="false" placeholder="' + (p ? '保持不变' : 'sk-…') + '">', !p) +
      meta +
      '</div>' +
      '<div class="btnbar full">' +
      '<button type="button" class="btn" data-act="close-form">取消</button>' +
      '<button type="submit" class="btn p" id="f-submit">保存</button>' +
      '</div></form>';
  }

  function settingSwitch(label, act, on) {
    return '<button type="button" class="srow swrow" role="switch" aria-checked="' + (on ? 'true' : 'false') +
      '" data-act="' + act + '">' +
      '<span class="md"><span class="n1">' + esc(label) + '</span></span>' +
      '<span class="trail"><span class="sw' + (on ? ' on' : '') + '"></span></span></button>';
  }

  function searchStepper(s) {
    var n = Number((s && s.max_results) || 5);
    return '<div class="srow"><span class="md"><span class="n1">结果条数</span></span>' +
      '<span class="trail"><span class="stepper c44">' +
      '<button type="button" class="b" data-act="results-dec" aria-label="减少"' +
      (n <= 1 ? ' disabled' : '') + '>' + ic('minus', 'sm') + '</button>' +
      '<span class="v num">' + n + '</span>' +
      '<button type="button" class="b" data-act="results-inc" aria-label="增加"' +
      (n >= 10 ? ' disabled' : '') + '>' + ic('plus', 'sm') + '</button>' +
      '</span></span></div>';
  }

  function settingsPageHtml() {
    var nav = navbar('设置', '', 'goto-chat', '对话', false);
    var cur = settingModel();

    if (state.searchState === 'loading' && !state.search) {
      return nav + '<div class="det"><div class="skel">' + skelRows(4) + '</div></div>';
    }
    if (state.searchState === 'error') {
      return nav + '<div class="det">' +
        pageErrorState('加载失败', state.searchError, 'reload-settings', 'goto-chat', '返回对话') + '</div>';
    }

    var s = state.search || {};
    var provider = s.provider || 'deepseek';
    var native = provider === 'deepseek';
    var test = state.searchTest || { state: 'idle' };
    var testVal = test.state === 'testing' ? '测试中'
      : (test.state === 'done' ? (test.ok ? Number(test.latency || 0) + 'ms' : '失败') : '');

    var keyRow = native ? '' :
      '<button type="button" class="srow" data-act="search-key">' +
      '<span class="md"><span class="n1">API Key</span></span>' +
      '<span class="trail"><span class="val mono">' +
      esc(s.api_key_tail ? keyMask(s.api_key_tail) : '未设置') + '</span>' +
      ic('chevron-right', 'sm chev') + '</span></button>';

    var searchCard =
      settingSwitch('联网搜索', 'toggle-search', !!s.enabled) +
      '<button type="button" class="srow" data-act="pick-search-provider">' +
      '<span class="md"><span class="n1">提供方</span></span>' +
      '<span class="trail"><span class="val">' + esc(searchProviderLabel(provider)) + '</span>' +
      ic('chevron-right', 'sm chev') + '</span></button>' +
      keyRow +
      searchStepper(s) +
      '<button type="button" class="srow" data-act="test-search">' +
      '<span class="lead">' + ic('plug') + '</span>' +
      '<span class="md"><span class="n1">测试</span></span>' +
      '<span class="trail"><span class="val mono">' + esc(testVal) + '</span></span></button>';


    return nav + '<div class="det">' +
      groupHtml('模型', '<button type="button" class="srow" data-act="open-models">' +
        '<span class="lead">' + ic('cpu') + '</span>' +
        '<span class="md"><span class="n1">当前模型</span></span>' +
        '<span class="trail"><span class="val">' + esc(cur ? cur.model_key : '未配置') + '</span>' +
        ic('chevron-right', 'sm chev') + '</span></button>') +
      groupHtml('联网搜索', searchCard) +
      '</div>';
  }

  function memoryRow(m) {
    var meta = [kindLabel(m.kind), m.subject || '', fmtWhen(m.created_at)];
    if (m.use_count) meta.push('用过 ' + m.use_count + ' 次');
    return '<button type="button" class="srow" data-act="edit-memory" data-id="' + esc(m.id) + '">' +
      '<span class="md"><span class="n1">' + esc(m.text || '') + '</span>' +
      '<span class="n2 mono">' + esc(meta.filter(Boolean).join(' · ')) + '</span></span>' +
      '<span class="trail">' + ic('chevron-right', 'sm chev') + '</span></button>';
  }

  function memoriesPageHtml() {
    var auto = !state.memorySetting || state.memorySetting.auto !== false;
    var list = state.memories || [];
    var total = state.memoryStats && state.memoryStats.total != null
      ? Number(state.memoryStats.total) : list.length;
    var nav = '<div class="navbar"><div class="tbox"><div class="ttl">记忆</div>' +
      '<div class="sub">' + numWrap(total) + ' 条</div></div></div>';
    var tools = '<div class="settings"><div class="sgroup flat"><div class="scard">' +
      '<button type="button" class="srow" data-act="new-memory">' +
      '<span class="lead">' + ic('plus') + '</span>' +
      '<span class="md"><span class="n1">添加记忆</span></span></button>' +
      '<div class="srow swrow" role="switch" aria-checked="' + (auto ? 'true' : 'false') + '">' +
      '<span class="lead">' + ic('sparkles') + '</span>' +
      '<span class="md"><span class="n1">自动记忆</span></span>' +
      '<span class="trail"><button type="button" class="sw' + (auto ? ' on' : '') +
      '" data-act="toggle-memory" aria-label="自动记忆"></button></span></div>' +
      '</div></div></div>';

    if (state.memoriesState === 'loading') {
      return nav + tools + '<div class="settings"><div class="skel">' + skelRows(4) + '</div></div>';
    }
    if (state.memoriesState === 'error') {
      return nav + tools + '<div class="settings">' +
        pageErrorState('加载失败', state.memoriesError, 'reload-memories', 'rail-chat', '返回对话') +
        '</div>';
    }
    if (!list.length) {
      return nav + tools + '<div class="settings"><div class="empty">' + ic('database') +
        '<div class="t">还没有记忆</div>' +
        '<button type="button" class="btn" data-act="new-memory">添加记忆</button></div></div>';
    }
    var prefs = list.filter(function (m) { return m.kind === 'pref'; });
    var facts = list.filter(function (m) { return m.kind !== 'pref'; });
    var html = nav + tools;
    if (prefs.length) html += '<div class="settings">' + groupHtml('关于她 · ' + prefs.length, prefs.map(memoryRow).join('')) + '</div>';
    if (facts.length) html += '<div class="settings">' + groupHtml('学习 · ' + facts.length, facts.map(memoryRow).join('')) + '</div>';
    return html;
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
    } else if (page.kind === 'settings') {
      html = settingsPageHtml();
    } else if (page.kind === 'memories') {
      html = memoriesPageHtml();
    }
    host.innerHTML = html;
    if (page.kind === 'form') {
      var form = q('#provider-form', host);
      if (form) form.addEventListener('submit', onProviderSubmit);
    }
    if (state.focusPending === 'page') {
      state.focusPending = '';
      var host = q('#view-page');
      if (host) { host.setAttribute('tabindex', '-1'); host.focus({ preventScroll: true }); }
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
    var needIds = state.providers.filter(function (p) {
      return p.connected && state.models[p.id] === undefined;
    }).map(function (p) { return p.id; });
    if (!needIds.length) return;
    Promise.all(needIds.map(loadModelsFor)).then(function () {
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

  function openModelDetails(pid, mid) {
    var m = findModel(pid, mid);
    var p = findProvider(pid);
    var need = !!(m && !m.meta_source && p && p.catalog_id);
    var o = { kind: 'model', pid: pid, mid: mid, meta: need ? undefined : null };
    setOverlay(o);
    if (!need) return;
    lookupMeta(p.catalog_id, m.model_key).then(function (meta) {
      if (state.overlay !== o) return;
      o.meta = meta || null;
      renderOverlay();
    });
  }

  function toggleSwitch(el) {
    var on = el.getAttribute('aria-checked') === 'true';
    el.setAttribute('aria-checked', on ? 'false' : 'true');
    var sw = el.querySelector('.sw');
    if (sw) sw.classList.toggle('on', !on);
  }

  function swState(key, root) {
    var el = q('[data-sw="' + key + '"]', root || document);
    return el ? el.getAttribute('aria-checked') === 'true' : false;
  }

  async function saveModelMeta(pid, mid) {
    var m = findModel(pid, mid);
    if (!m) return;
    var sheet = q('#overlay');
    var nameEl = q('#m-name', sheet);
    var ctxEl = q('#m-ctx', sheet);
    var name = (nameEl ? nameEl.value : '').trim();
    var ctxK = (ctxEl ? ctxEl.value : '').trim();
    clearMsgs(sheet || document);
    hideFormErr(sheet);
    if (ctxK && !/^\d+$/.test(ctxK)) {
      showMsg(sheet || document, 'context_k', '需数字');
      if (ctxEl) ctxEl.focus();
      return;
    }
    var payload = {
      display_name: name,
      context_len: ctxK ? Number(ctxK) * 1024 : (m.context_len || 0),
      supports_images: swState('images', sheet),
      supports_tools: swState('tools', sheet),
      supports_thinking: swState('reasoning', sheet)
    };
    var btn = q('[data-act="save-model"]', sheet);
    if (btn) {
      btn.disabled = true;
      btn.textContent = '保存中…';
    }
    try {
      await api('/models/' + encodeURIComponent(mid), { method: 'PATCH', json: payload });
      delete state.models[pid];
      state.lookup = {};
      await loadModelsFor(pid);
      closeOverlay();
      render();
      toast('已保存');
    } catch (e) {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '保存';
      }
      var body = q('.sheet-body', sheet);
      if (body) body.insertAdjacentHTML('afterbegin',
        '<div class="errbar" role="alert">' + ic('alert-circle') +
        '<span class="msg">' + esc('保存失败 · ' + e.message) + '</span></div>');
    }
  }

  // 自定义端点：表单手填的元数据落到该 provider 的第一个模型（sync 补不出时用）
  async function applyMetaDraft(pid, draft) {
    if (!draft) return;
    await loadModelsFor(pid);
    var list = state.models[pid] || [];
    if (!list.length) return;
    var body = {};
    if (draft.display_name) body.display_name = draft.display_name;
    if (draft.context_len) body.context_len = draft.context_len;
    if (draft.supports_images) body.supports_images = true;
    if (draft.supports_tools) body.supports_tools = true;
    if (draft.supports_thinking) body.supports_thinking = true;
    if (!Object.keys(body).length) return;
    try {
      await api('/models/' + encodeURIComponent(list[0].id), { method: 'PATCH', json: body });
      delete state.models[pid];
      await loadModelsFor(pid);
    } catch (e) { /* 元数据补写失败不阻断连接流程 */ }
  }

  async function reloadCatalog() {
    await loadCatalog();
    render();
  }

  /* ── 设置动作：联网搜索 / 记忆 ─────────────────────── */
  async function patchSearch(body) {
    var prev = state.search;
    state.search = Object.assign({}, state.search, body);
    render();
    try {
      var r = await api('/settings/search', { method: 'PATCH', json: body });
      if (r && typeof r === 'object') state.search = Object.assign({}, state.search, r);
    } catch (e) {
      state.search = prev;
      toast('未保存 · ' + e.message);
    }
    render();
  }

  function toggleSearchSwitch(el) {
    var on = el.getAttribute('aria-checked') === 'true';
    patchSearch({ enabled: !on });
  }

  function bumpResults(delta) {
    var n = Number((state.search && state.search.max_results) || 5);
    var next = Math.min(10, Math.max(1, n + delta));
    if (next === n) return;
    patchSearch({ max_results: next });
  }

  async function testSearch() {
    state.searchTest = { state: 'testing', ok: false, latency: 0, error: '' };
    render();
    try {
      var r = await api('/settings/search/test', { method: 'POST' });
      state.searchTest = {
        state: 'done',
        ok: !!(r && r.ok),
        latency: (r && r.latency_ms) || 0,
        error: (r && r.error) || ''
      };
      if (!state.searchTest.ok && state.searchTest.error) toast(state.searchTest.error);
    } catch (e) {
      state.searchTest = { state: 'done', ok: false, latency: 0, error: e.message };
      toast('测试失败 · ' + e.message);
    }
    render();
  }

  async function toggleMemorySwitch(el) {
    var on = el.getAttribute('aria-checked') === 'true';
    var prev = state.memorySetting;
    state.memorySetting = Object.assign({}, state.memorySetting, { auto: !on });
    render();
    try {
      var r = await api('/settings/memory', { method: 'PATCH', json: { auto: !on } });
      if (r && typeof r === 'object') state.memorySetting = Object.assign({}, state.memorySetting, r);
    } catch (e) {
      state.memorySetting = prev;
      toast('未保存 · ' + e.message);
    }
    render();
  }

  async function openMemories() {
    openPage({ kind: 'memories' });
    await Promise.all([loadMemories(), loadMemoryStats(), loadMemorySettings()]);
    if (state.page && state.page.kind === 'memories') render();
  }

  function openMemoryEdit(id) {
    setOverlay({ kind: 'memory', id: id || '' });
  }

  function pickMemoryKind(el) {
    var host = q('#overlay');
    if (!host) return;
    qa('#overlay .seg .tpill').forEach(function (b) {
      b.classList.toggle('on', b === el);
    });
  }

  async function saveMemory(id) {
    var host = q('#overlay');
    if (!host) return;
    var textEl = q('#mem-text', host);
    var subjEl = q('#mem-subject', host);
    var kindEl = q('#overlay .seg .tpill.on');
    var text = (textEl ? textEl.value : '').trim();
    if (!text) { toast('内容不能为空'); return; }
    var payload = {
      text: text,
      kind: kindEl ? kindEl.getAttribute('data-kind') : 'fact',
      subject: (subjEl ? subjEl.value : '').trim()
    };
    try {
      if (id) await api('/memories/' + encodeURIComponent(id), { method: 'PATCH', json: payload });
      else await api('/memories', { method: 'POST', json: payload });
      state.overlay = null;
      await Promise.all([loadMemories(), loadMemoryStats()]);
      render();
      toast(id ? '已保存' : '已添加');
    } catch (e) {
      toast('保存失败：' + e.message);
    }
  }

  function askDeleteMemory(id) {
    var m = (state.memories || []).filter(function (x) {
      return String(x.id) === String(id);
    })[0];
    setOverlay({
      kind: 'confirm', title: '删除记忆', text: m ? m.text : '',
      act: 'confirm-delete-memory', actLabel: '删除', id: id
    });
  }

  async function doDeleteMemory() {
    var o = state.overlay;
    if (!o || o.id == null) return;
    var id = o.id;
    closeOverlay();
    try {
      await api('/memories/' + encodeURIComponent(id), { method: 'DELETE' });
      await Promise.all([loadMemories(), loadMemoryStats(), loadMemorySettings()]);
      render();
      toast('已删除');
    } catch (e) {
      toast('未删除 · ' + e.message);
    }
  }

  async function saveSearchKey() {
    var host = q('#overlay');
    var input = q('#s-key', host);
    var v = input ? (input.value || '').trim() : '';
    if (!v) {
      var slot = q('[data-msg="s_key"]', host);
      if (slot) slot.textContent = '必填';
      if (input) input.focus();
      return;
    }
    var btn = q('[data-act="save-search-key"]', host);
    if (btn) {
      btn.disabled = true;
      btn.textContent = '保存中…';
    }
    try {
      await api('/settings/search', { method: 'PATCH', json: { api_key: v } });
      await loadSearchSettings();
      closeOverlay();
      render();
    } catch (e) {
      toast('未保存 · ' + e.message);
      if (btn) {
        btn.disabled = false;
        btn.textContent = '保存';
      }
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
      await loadCatalog();
      render();
      if (r && r.enriched > 0) toast('已从 models.dev 填充 ' + Number(r.enriched) + ' 个模型');
      else toast(r && r.total != null ? Number(r.total) + ' 个模型' : '已更新');
    } catch (e) {
      toast('更新失败 · ' + e.message);
    }
  }

  function askDisconnect(pid) {
    var p = findProvider(pid);
    setOverlay({
      kind: 'confirm', title: '断开', text: p ? p.name : '',
      act: 'confirm-disconnect', actLabel: '断开', pid: pid
    });
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
      id: 'tmp-u-' + Date.now(), _key: newKey('u'), role: 'user',
      kind: (imgs && imgs.length) ? 'image' : 'text',
      content_md: text, reasoning_md: '', images: imgs || [], status: 'done', error: ''
    };
    var asst = {
      id: 'tmp-a-' + Date.now(), _key: newKey('a'), role: 'assistant', kind: 'text',
      content_md: '', reasoning_md: '', images: [], status: 'streaming', error: '',
      _payload: payload, _userMsg: userMsg
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
      dropLive(asst);
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
          // 只回填 id：DOM 靠 _key 跟踪，不重刷（重刷会打断渐显）
        } else if (ev.type === 'part') {
          if (ev.kind === 'reasoning') {
            var rp = ensurePart(asst, 'reasoning', { text: '', ms: 0, _t0: nowMs() });
          } else if (ev.kind === 'tool') {
            ensurePart(asst, 'tool', { name: 'web_search', queries: ev.queries || [], count: 0 });
          } else if (ev.kind === 'text') {
            ensurePart(asst, 'text', { text: '' });
          }
        } else if (ev.type === 'part_end') {
          var pend = lastPart(asst, 'reasoning');
          if (pend && pend._t0) { pend.ms = nowMs() - pend._t0; pend._t0 = null; }
        } else if (ev.type === 'part_update') {
          var pt = lastPart(asst, 'tool');
          if (pt) pt.count = (pt.count || 0) + 1;
        } else if (ev.type === 'reasoning') {
          if (!asst._thinkStart) asst._thinkStart = nowMs();
          asst.reasoning_md += ev.delta || '';
          var rpart = lastPart(asst, 'reasoning');
          if (rpart) rpart.text = (rpart.text || '') + (ev.delta || '');
          paintReasoning(asst);
        } else if (ev.type === 'text') {
          if (asst._thinkStart && asst._thinkMs == null) asst._thinkMs = nowMs() - asst._thinkStart;
          asst.content_md += ev.delta || '';
          var tpart = lastPart(asst, 'text');
          if (tpart) tpart.text = (tpart.text || '') + (ev.delta || '');
          if (!asst._st) startLive(asst);
          if (asst._st) {
            asst._st.target = asst.content_md;
            pumpReveal(asst);
          }
        } else if (ev.type === 'tool') {
          var tname = ev.name || '';
          if (tname === 'web_search' || !tname) {
            var curCount = Number(asst._searchCount || 0);
            var evCount = Number(ev.count || 0);
            if (evCount > 0) asst._searchCount = Math.max(curCount, evCount);
            else if (ev.state === 'end') asst._searchCount = curCount + 1;
            if (Array.isArray(ev.sources) && ev.sources.length) mergeWebSources(asst, ev.sources);
            patchMeta(asst);
          }
        } else if (ev.type === 'memory') {
          if (Array.isArray(ev.items) && ev.items.length) {
            mergeRemembered(asst, ev.items);
            patchMeta(asst);
          }
        } else if (ev.type === 'done') {
          sawDone = true;
          asst.status = 'done';
          asst.usage = ev.usage || null;
          if (ev.thinking_ms) { asst.thinking_ms = ev.thinking_ms; asst._thinkMs = ev.thinking_ms; }
          if (ev.parts && ev.parts.length) asst.parts = ev.parts;
          if (Array.isArray(ev.tools)) asst.tools = ev.tools.slice();
          if (Array.isArray(ev.sources)) asst.sources = ev.sources.slice();
          if (Array.isArray(ev.remembered)) mergeRemembered(asst, ev.remembered);
          if (asst._searchCount == null && asst.tools.indexOf('web_search') >= 0) {
            asst._searchCount = asst.tools.filter(function (t) { return t === 'web_search'; }).length;
          }
          if (ev.message_id != null) asst.id = ev.message_id;
          if (asst._st) {
            asst._st.final = true;
            pumpReveal(asst);
          }
        } else if (ev.type === 'error') {
          srvErr = ev.message || ev.code || '流式错误';
        }
      }
    }

    if (srvErr) {
      asst.status = 'error';
      asst.error = srvErr;
      asst.canRetry = true;
      dropLive(asst);
    } else if (!sawDone) {
      asst.status = 'error';
      asst.error = '连接中断';
      asst.canRetry = true;
      dropLive(asst);
    } else if (!asst.content_md) {
      asst.status = 'error';
      asst.error = '空回复';
      dropLive(asst);
    } else {
      asst.status = 'done';
    }

    if (asst._st) {
      asst._st.target = asst.content_md;
      asst._st.final = true;
      pumpReveal(asst);
    } else {
      renderStream(true);
    }
  }

  async function retryMessage(key) {
    var idx = -1;
    for (var i = 0; i < state.messages.length; i++) {
      if (String(state.messages[i]._key) === String(key)) { idx = i; break; }
    }
    if (idx < 0 || idx !== state.messages.length - 1) return;
    var old = state.messages[idx];
    if (!old._payload) return;
    var userMsg = old._userMsg || state.messages[idx - 1] || null;
    dropLive(old);
    state.messages.splice(idx, 1);
    var fresh = {
      id: 'tmp-a-' + Date.now(), _key: newKey('a'), role: 'assistant', kind: 'text',
      content_md: '', reasoning_md: '', images: [], status: 'streaming', error: '',
      _payload: old._payload, _userMsg: userMsg
    };
    state.messages.push(fresh);
    state.sending = true;
    state.stick = true;
    renderStream(true);
    syncSend();
    try {
      await streamRequest(old._payload, userMsg || {}, fresh);
    } catch (e) {
      fresh.status = 'error';
      fresh.error = e.message;
      fresh.canRetry = true;
      dropLive(fresh);
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

  /* ── 表单提交 / 校验 ───────────────────────────────── */
  function showMsg(form, key, text) {
    var el = form.querySelector('[data-msg="' + key + '"]');
    if (el) el.textContent = text;
    var input = form.querySelector('#f-' + key) || form.querySelector('#m-' + (key === 'context_k' ? 'ctx' : key));
    if (input) {
      input.classList.add('err');
      input.setAttribute('aria-invalid', 'true');
    }
  }
  function clearMsgs(root) {
    qa('.fmsg', root).forEach(function (el) { el.textContent = ''; });
    qa('.fi', root).forEach(function (el) {
      el.classList.remove('err');
      el.removeAttribute('aria-invalid');
    });
    qa('.errbar', root).forEach(function (el) { el.hidden = true; });
  }
  function showFormErr(root, msg) {
    var bar = q('#form-err', root) || q('.errbar', root);
    if (!bar) return;
    bar.hidden = false;
    var t = bar.querySelector('.msg');
    if (t) t.textContent = msg;
  }
  function hideFormErr(root) {
    var bar = root ? q('#form-err', root) : null;
    if (bar) bar.hidden = true;
  }

  // 失焦即校验（不只在提交时）：端点 http(s)://、长度数字
  function onBlurValidate(e) {
    var el = e.target;
    if (!el || !el.id) return;
    if (el.id !== 'f-base_url' && el.id !== 'm-ctx' && el.id !== 'f-context_k') return;
    var box = el.closest('form, .sheet-body');
    if (!box) return;
    var v = (el.value || '').trim();
    var key = el.id === 'm-ctx' ? 'context_k' : el.id.slice(2);
    var msg = '';
    if (el.id === 'f-base_url') {
      if (!v) msg = '必填';
      else if (!/^https?:\/\//i.test(v)) msg = '需 http:// 或 https://';
    } else if (v && !/^\d+$/.test(v)) {
      msg = '需数字';
    }
    var slot = box.querySelector('[data-msg="' + key + '"]');
    if (slot) slot.textContent = msg;
    el.classList.toggle('err', !!msg);
    if (msg) el.setAttribute('aria-invalid', 'true');
    else el.removeAttribute('aria-invalid');
  }

  async function onProviderSubmit(e) {
    e.preventDefault();
    var form = e.currentTarget;
    var mode = form.getAttribute('data-mode') || 'custom';
    var pid = form.getAttribute('data-pid') || '';
    var cid = form.getAttribute('data-cid') || '';
    var name = ((form.querySelector('[name="name"]') || {}).value || '').trim();
    var baseUrl = ((form.querySelector('[name="base_url"]') || {}).value || '').trim();
    var key = ((form.querySelector('[name="api_key"]') || {}).value || '').trim();
    var dnEl = form.querySelector('[name="display_name"]');
    var ctxEl = form.querySelector('[name="context_k"]');
    var displayName = dnEl ? (dnEl.value || '').trim() : '';
    var ctxK = ctxEl ? (ctxEl.value || '').trim() : '';

    clearMsgs(form);
    hideFormErr(form);
    var bad = '';
    if (!name) { showMsg(form, 'name', '必填'); bad = bad || 'name'; }
    if (!baseUrl) {
      showMsg(form, 'base_url', '必填');
      bad = bad || 'base_url';
    } else if (!/^https?:\/\//i.test(baseUrl)) {
      showMsg(form, 'base_url', '需 http:// 或 https://');
      bad = bad || 'base_url';
    }
    if (mode !== 'edit' && !key) { showMsg(form, 'api_key', '必填'); bad = bad || 'api_key'; }
    if (mode === 'custom' && !displayName) { showMsg(form, 'display_name', '必填'); bad = bad || 'display_name'; }
    if (ctxK && !/^\d+$/.test(ctxK)) { showMsg(form, 'context_k', '需数字'); bad = bad || 'context_k'; }
    if (bad) {
      var el = form.querySelector('[name="' + bad + '"]');
      if (el) el.focus();
      return;
    }

    // 开关状态在离开表单前读走
    var draft = mode === 'custom' ? {
      display_name: displayName,
      context_len: ctxK ? Number(ctxK) * 1024 : 0,
      supports_images: swState('images', form),
      supports_tools: swState('tools', form),
      supports_thinking: swState('reasoning', form)
    } : null;

    var btn = q('#f-submit', form);
    if (btn) {
      btn.disabled = true;
      btn.textContent = '保存中…';
    }
    var newId = '';

    try {
      if (mode === 'edit') {
        var body = { name: name, base_url: baseUrl };
        if (key) body.api_key = key;
        await api('/providers/' + encodeURIComponent(pid), { method: 'PATCH', json: body });
        newId = pid;
      } else {
        var src = cid ? findCatalog(cid) : null;
        var payload = {
          name: name, base_url: baseUrl, api_key: key,
          api_style: src ? (src.api_style || 'openai') : 'openai'
        };
        if (cid) payload.catalog_id = cid;
        var created = await api('/providers', { method: 'POST', json: payload });
        newId = created && (created.id != null ? created.id : created.provider_id);
      }
    } catch (err) {
      showFormErr(form, '保存失败 · ' + err.message);
      if (btn) {
        btn.disabled = false;
        btn.textContent = '保存';
      }
      return;
    }

    await loadProviders();
    if (newId == null || newId === '') {
      openPage({ kind: 'models' });
      return;
    }
    delete state.models[newId];
    openPage({ kind: 'provider', providerId: newId });
    try {
      var r = await api('/providers/' + encodeURIComponent(newId) + '/sync-models', { method: 'POST' });
      await loadModelsFor(newId);
      if (mode === 'custom') await applyMetaDraft(newId, draft);
      await loadProviders();
      await loadCatalog();
      render();
      if (r && r.enriched > 0) {
        toast('已从 models.dev 填充 ' + Number(r.enriched) + ' 个模型');
      }
    } catch (err2) {
      toast('更新失败 · ' + err2.message);
      render();
    }
  }

  /* ── 事件 ─────────────────────────────────────────── */
  var ACTS = {
    'open-sheet': function () { openModelSheet(); },
    'close-sheet': function () { closeOverlay(); },
    'pick-model': function (el) { pickModel(el.getAttribute('data-pid'), el.getAttribute('data-mid')); },
    'connect': function (el) {
      closeOverlay();
      var pid = el.getAttribute('data-pid');
      var p = findProvider(pid);
      if (p && p.catalog_id && findCatalog(p.catalog_id)) openPage({ kind: 'form', catalogId: p.catalog_id });
      else openPage({ kind: 'form', providerId: pid });
    },
    'connect-catalog': function (el) { openPage({ kind: 'form', catalogId: el.getAttribute('data-cid') }); },
    'reload-catalog': function () { reloadCatalog(); },
    'rail-chat': function () { openPage(null); },
    'rail-settings': function () { openSettings(); },
    'back-settings': function () { openPage({ kind: 'settings' }); render(); },
    'reload-settings': function () { openSettings(); },
    'toggle-search': function (el) { toggleSearchSwitch(el); },
    'pick-search-provider': function () { setOverlay({ kind: 'provider-pick' }); },
    'set-search-provider': function (el) {
      patchSearch({ provider: el.getAttribute('data-provider') }).then(function () { closeOverlay(); });
    },
    'search-key': function () { setOverlay({ kind: 'search-key' }); },
    'save-search-key': function () { saveSearchKey(); },
    'results-dec': function () { bumpResults(-1); },
    'results-inc': function () { bumpResults(1); },
    'test-search': function () { testSearch(); },
    'toggle-memory': function (el) { toggleMemorySwitch(el); },
    'new-memory': function () { openMemoryEdit(''); },
    'edit-memory': function (el) { openMemoryEdit(el.getAttribute('data-id')); },
    'save-memory': function (el) { saveMemory(el.getAttribute('data-id')); },
    'pick-memory-kind': function (el) { pickMemoryKind(el); },
    'to-bottom': function () { scrollToBottom(true); },
    'open-subjects': function () { setOverlay({ kind: 'subjects' }); },
    'switch-subject': function (el) { switchSubject(el.getAttribute('data-subject')); },
    'open-memories': function () { openMemories(); },
    'rail-memories': function () { openMemories(); },
    'reload-memories': function () { loadMemories().then(function () { render(); }); },
    'ask-delete-memory': function (el) { askDeleteMemory(el.getAttribute('data-id')); },
    'confirm-delete-memory': function () { doDeleteMemory(); },
    'open-sources': function (el) {
      setOverlay({ kind: 'sources', key: el.getAttribute('data-key') });
    },
    'model-settings': function (el) {
      openModelDetails(el.getAttribute('data-pid'), el.getAttribute('data-mid'));
    },
    'toggle-sw': function (el) { toggleSwitch(el); },
    'save-model': function (el) {
      saveModelMeta(el.getAttribute('data-pid'), el.getAttribute('data-mid'));
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
    'retry': function (el) { retryMessage(el.getAttribute('data-key')); },
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
    var key = d.getAttribute('data-key');
    for (var i = 0; i < state.messages.length; i++) {
      var m = state.messages[i];
      if (String(m._key) !== String(key)) continue;
      // 重建 DOM 时带 open 属性也会触发 toggle：只记“用户按下”的差异
      if (m._renderOpen !== undefined && d.open === m._renderOpen) return;
      m._open = d.open;
      return;
    }
  }

  function bindEvents() {
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    document.addEventListener('blur', onBlurValidate, true);

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
    updateToBottom();
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

    await Promise.all([loadProviders(), loadConversation(), loadSettings(true), loadCatalog(), loadSubjects()]);
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






