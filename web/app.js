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
    review: null,            // {task, groups} 复核中的一页
    captureQueue: [],        // 待复核的 task id 队列
    capturePending: [],      // 处理中/待复核的任务（角标用）
    bank: null,              // {items,total,subject,q,grade,difficulty,kp}
    bankSolvedTimer: 0,      // 解析轮询计时器
    depositTimer: 0,         // 自动沉淀轮询
    kpPick: null,            // 知识点选择/筛选弹层的数据
    map: null,               // 知识地图：{subject,module,chapter,data,loading,error,selected,q,ver}
    mapCy: null,             // cytoscape 实例
    mapKey: '',              // 当前图对应的 subject|module|chapter|ver
    mapHtmlKey: '',          // 已渲染 HTML 的 key（避免弹层重开时丢图）
    theme: 'system',         // system | light | dark（本地偏好，index.html 已先应用）
    profile: null,           // {agent_name,user_name,gender,grade,completed}
    profileLoaded: false,
    skills: null,            // 技能注册表（GET /skills）
    skill: '',               // 当前选中的技能 id（跟着输入框走）
    preview: null,           // 右侧预览的产物
    heroSubject: '',         // 新对话页选中的学科
    editArtifact: null,      // 正在基于哪份资料继续改
    lib: { items: [], total: 0, kind: '', q: '', error: '' }, // 资料库
    question: null,          // 当前打开的题目详情（整页）
    conversations: [],       // 对话列表
    convId: '',              // 当前对话 id
    convSubject: '全部',
    convTitle: '',
    convFilter: '',          // 列表按学科筛选
    week: null,              // 本周统计
    editQuestion: null,      // 正在编辑的题目
    qpanel: null,            // {id, data} 右侧题目面板
    pendingQuestions: [],    // 已选好、要随下一条消息发出的题目
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
  /* Material Symbols：Lucide 名 → M3 图标名（全部动态图标都走 ic()，改这一处即可） */
  var MS_ICON = {
    'circle-dot': 'forum', 'book-open-text': 'menu_book', 'book': 'menu_book',
    'map': 'account_tree', 'clock': 'history', 'zap': 'bolt', 'settings': 'settings',
    'chevron-left': 'chevron_left', 'chevron-right': 'chevron_right', 'chevron-down': 'expand_more',
    'sparkles': 'auto_awesome', 'plus': 'add', 'arrow-up': 'arrow_upward', 'x': 'close',
    'check': 'check', 'camera': 'photo_camera', 'image': 'image', 'search': 'search',
    'more-horizontal': 'more_horiz', 'refresh-cw': 'refresh', 'panel-left': 'left_panel_close',
    'sun': 'light_mode', 'bell': 'notifications', 'atom': 'science', 'flask-conical': 'science',
    'languages': 'translate', 'leaf': 'biotech', 'landmark': 'balance', 'globe': 'public',
    'scale': 'balance', 'sigma': 'functions', 'key': 'key', 'database': 'database',
    'cpu': 'memory', 'plug': 'cloud', 'external-link': 'open_in_new', 'alert-circle': 'error',
    'message-square': 'chat_bubble', 'mic': 'mic', 'minus': 'remove', 'scan': 'document_scanner',
    'notebook': 'menu_book', 'palette': 'palette'
  };
  function msIcon(name) { return MS_ICON[name] || name || 'forum'; }
  function ic(name, cls) {
    return '<span class="ic msym' + (cls ? ' ' + cls : '') + '" aria-hidden="true">' + msIcon(name) + '</span>';
  }
  /* 把 index.html 里写死的 <svg class="ic"><use ...> 换成 Material Symbols；
     rail 的 7 个目的地按新稿换成语义更准的图标。 */
  function upgradeIcons() {
    var railIcon = {
      'rail-chat': 'forum', 'rail-bank': 'library_books', 'rail-library': 'folder_open',
      'rail-map': 'account_tree', 'rail-memories': 'history', 'rail-week': 'monitoring',
      'rail-settings': 'settings'
    };
    qa('svg.ic').forEach(function (svg) {
      var use = svg.querySelector('use');
      if (!use) return;
      var name = use.getAttribute('data-i') || (use.getAttribute('href') || '').replace('#i-', '');
      var it = svg.closest('.rail .it');
      if (it && railIcon[it.id]) name = railIcon[it.id];
      var extra = (svg.getAttribute('class') || '').replace(/\bic\b/g, '').replace(/\s+/g, ' ').trim();
      var span = document.createElement('span');
      span.className = 'ic msym' + (extra ? ' ' + extra : '');
      if (svg.id) span.id = svg.id;
      span.setAttribute('aria-hidden', 'true');
      span.textContent = msIcon(name);
      svg.replaceWith(span);
    });
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
      var data = await api('/messages?limit=100' + (state.convId ? ('&conversation_id=' + encodeURIComponent(state.convId)) : ''));
      var items = data && Array.isArray(data.items) ? data.items : [];
      // 首屏加载慢于发送时，保留尚在流式中的本地占位消息（id 前缀 tmp-）
      var local = state.messages.filter(function (m) {
        return String(m.id).indexOf('tmp-') === 0;
      });
      var rows = items.map(normalizeMessage);
      if (local.length) {
        // 发送中的本地占位消息与刚落库的消息可能同时存在：按角色+正文去重
        var seen = {};
        rows.forEach(function (r) { seen[r.role + '|' + String(r.content_md || '').trim()] = true; });
        local = local.filter(function (l) {
          var k = l.role + '|' + String(l.content_md || '').trim();
          if (l.role === 'user' && seen[k]) return false;
          if (l.role === 'assistant' && l.status === 'done' && seen[k]) return false;
          return true;
        });
        state.messages = rows.concat(local);
      } else {
        state.messages = rows;
      }
    setTimeout(function () { typesetMath(q('#stream')); }, 60);
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
      questions: Array.isArray(m.questions) ? m.questions : [],
      tools: Array.isArray(m.tools) ? m.tools : [],
      sources: Array.isArray(m.sources) ? m.sources : [],
      remembered: Array.isArray(m.remembered) ? m.remembered : [],
      parts: Array.isArray(m.parts) ? m.parts : [],
      deposits: Array.isArray(m.deposits) ? m.deposits : [],
      skill: m.skill || '',
      artifact_id: m.artifact_id || '',
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

  // 现在是对话列表 + 单条对话，不再有「今天」首页
  function isToday() { return false; }

  function todayLabel(name) { return name === '全部' ? '今天' : name; }

  async function loadToday() {
    try { state.today = await api('/overview/today'); }
    catch (e) { state.today = { total: 0, items: [] }; }
  }

  function todayHtml() {
    var t = state.today || { total: 0, items: [] };
    var d = new Date();
    var date = (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日';
    var active = (t.items || []).filter(function (x) { return x.count > 0; });
    var lead = active.length
      ? '今天 ' + date + '。你在 ' + active.length + ' 个科目里聊了 ' + t.total + ' 条。'
      : '今天 ' + date + '。还没开始，从哪一科都行。';
    var cards = active.map(function (it) {
      return '<button type="button" class="tcard" data-act="switch-subject" data-subject="' + esc(it.subject) + '">' +
        '<span class="ti">' + ic(SUBJECT_ICON[it.subject] || 'circle-dot', 'md') + '</span>' +
        '<span class="tb"><span class="tn">' + esc(it.subject) + '</span>' +
        '<span class="tt">' + esc(it.last_text || '') + '</span></span>' +
        '<span class="tr"><span class="tc">' + numWrap(it.count) + '</span>' +
        ic('chevron-right', 'sm chev') + '</span></button>';
    }).join('');
    var empty = active.length ? '' :
      '<div class="empty">' + ic('sun') + '<div class="t">今天还没开始</div>' +
      '<button type="button" class="btn" data-act="switch-subject" data-subject="物理">从物理开始</button></div>';
    return '<div class="col"><div class="today-page">' +
      '<div class="theader"><div class="tgreet">' + esc(lead) + '</div></div>' +
      (cards ? '<div class="tlist">' + cards + '</div>' : empty) +
      '</div></div>';
  }

  /* ── 采集（M1.4）：拍照上传 → 复核 → 确认入库 ─────────── */

  function currentSubjectName() {
    return (state.subjects && state.subjects.current) || '全部';
  }

  /* ── 可复用拍题组件：图片 / 题目 两模式 ─────────────── */

  function openCapture(intent) {
    var bank = bankState();
    var subj = intent === 'bank'
      ? (bank.subject || (currentSubjectName() !== '全部' ? currentSubjectName() : '数学'))
      : currentSubjectName();
    setOverlay({
      kind: 'capture',
      intent: intent === 'bank' ? 'bank' : 'chat',
      subject: subj,
      step: 'pick',
      taskId: null,
      task: null,
      groups: [],
      selected: {},
      preview: '',
      startedAt: 0,
      correct: true,
      error: ''
    });
  }


  async function captureFile(file) {
    var o = state.overlay;
    if (!o || o.kind !== 'capture' || !file) return;

    // 立刻进「扫描」动画：本地预览 + 至少显示 2.4 秒，避免闪一下
    o.step = 'scanning';
    o.startedAt = Date.now();
    o.error = '';
    o.preview = URL.createObjectURL(file);
    renderOverlay();

    var fd = new FormData();
    fd.append('file', file);
    fd.append('subject', o.subject || currentSubjectName());
    fd.append('correct', o.correct === false ? 'false' : 'true');
    try {
      var t = await api('/capture/pages', { method: 'POST', form: fd });
      o.taskId = t.task_id;
      await capturePoll(t.task_id);
      var wait = 2400 - (Date.now() - o.startedAt);
      if (wait > 0) await new Promise(function (r) { setTimeout(r, wait); });
      o.step = 'select';
      renderOverlay();
    } catch (e) {
      o.step = 'failed';
      o.error = e.message;
      renderOverlay();
    }
  }

  async function capturePoll(taskId) {
    var o = state.overlay;
    var deadline = Date.now() + 180000;
    while (o && o.kind === 'capture' && o.taskId === taskId) {
      var t;
      try {
        t = await api('/capture/tasks/' + encodeURIComponent(taskId));
      } catch (e) {
        o.step = 'failed';
        o.error = e.message;
        renderOverlay();
        return;
      }
      o.task = t;
      if (t.status === 'review') {
        var full = await api('/capture/tasks/' + encodeURIComponent(taskId) + '?full=true');
        o.task = full;
        o.groups = (full.groups && full.groups.groups) || [];
        o.selected = {};
        flatQuestions(o.groups).forEach(function (f, i) { o.selected[i] = true; });
        return;
      }
      if (t.status === 'failed') {
        o.step = 'failed';
        o.error = t.error || '';
        renderOverlay();
        return;
      }
      if (Date.now() > deadline) {
        o.step = 'failed';
        o.error = '处理超过 3 分钟，可能卡住了';
        renderOverlay();
        return;
      }
      await new Promise(function (r) { setTimeout(r, 1200); });
    }
  }

  function captureToggle(i) {
    var o = state.overlay;
    if (!o || o.kind !== 'capture') return;
    var n = Number(i);
    o.selected[n] = !o.selected[n];
    renderOverlay();
  }

  async function captureCommit() {
    var o = state.overlay;
    if (!o || o.kind !== 'capture') return;
    var flat = flatQuestions(o.groups);
    var chosen = flat.filter(function (f, i) { return o.selected[i]; });
    if (!chosen.length) { toast('先选至少一道题'); return; }

    var groups = chosen.map(function (f) {
      var g = o.groups[f.g];
      return {
        group_id: g.group_id,
        section: g.section,
        shared_stem: g.shared_stem,
        shared_pages: g.shared_pages,
        questions: [f.item]
      };
    });
    try {
      var res = await api('/capture/tasks/' + encodeURIComponent(o.taskId) + '/confirm', { method: 'POST', json: { groups: groups } });
      if (o.intent === 'bank') {
        state.overlay = null;
        var made = (res.ids || []).length;
        toast(made ? '收进题库 ' + made + ' 题 · 生成解析中' : '这些题题库里已有');
        if (state.page && state.page.kind === 'bank') {
          await loadBank();
          pollBankSolve();
        } else {
          openBank();
        }
        return;
      }
      chosen.forEach(function (f, k) {
        var q = f.item;
        state.pendingQuestions.push({
          id: (res.ids || [])[k] || '',
          number: q.number || String(k + 1),
          stem: q.stem || '',
          options: q.options || [],
          type: q.type || 'short',
          subject: currentSubjectName()
        });
      });
      state.overlay = null;
      render();
      toast('加入对话 ' + chosen.length + ' 题');
    } catch (e) {
      toast('加入失败：' + e.message);
    }
  }

  function captureSheetHtml() {
    var o = state.overlay;
    if (!o || o.kind !== 'capture') return '';
    var isBank = o.intent === 'bank';
    var title = isBank ? '收进题库' : '添加';

    var body = '';
    if (o.step === 'pick') {
      var subs = isBank
        ? '<div class="slabel">学科</div><div class="bankchips capsub">' + SUBJECTS.map(function (s) {
            var on = (o.subject || '') === s;
            return '<span class="fchip' + (on ? ' on' : '') + '" role="button" tabindex="0" data-act="cap-subject" data-subject="' + esc(s) + '">' + s + '</span>';
          }).join('') + '</div>'
        : '';
      body = '<div class="capmenu">' +
        '<button type="button" class="caprow" data-act="cap-camera">' + ic('camera') +
          '<span>相机</span><span class="sp"></span><span class="caparr">›</span></button>' +
        '<button type="button" class="caprow" data-act="cap-album">' + ic('image') +
          '<span>相册</span><span class="sp"></span><span class="caparr">›</span></button>' +
        (isBank ? '' :
          '<button type="button" class="caprow" data-act="open-picker">' + ic('book-open-text') +
          '<span>题库</span><span class="sp"></span><span class="caparr">›</span></button>') +
        '<button type="button" class="caprow" data-act="cap-correct" role="switch" aria-checked="' +
          (o.correct === false ? 'false' : 'true') + '">' + ic('sparkles') +
          '<span>自动矫正</span><span class="sp"></span><span class="sw' +
          (o.correct === false ? '' : ' on') + '"></span></button>' +
        '</div>' + subs;
    } else if (o.step === 'scanning') {
      var t = o.task || {};
      var stageText = t.status === 'queued' ? '排队中'
        : t.status === 'parsing' ? '识别文字'
        : t.status === 'extracting' ? '整理题目'
        : '扫描中';
      body = '<div class="scanwrap"><div class="scancanvas">' +
        '<img src="' + esc(o.preview || '') + '" alt="">' +
        '<div class="scanmask"><div class="scanbeam"></div></div>' +
        '<div class="scanhud"><span class="rsp">' + esc(stageText) + '</span>' +
        '<span class="rsec num">' + Math.round((Date.now() - (o.startedAt || Date.now())) / 1000) + ' 秒</span></div>' +
        '</div></div>';
    } else if (o.step === 'select') {
      var flat = flatQuestions(o.groups);
      var boxes = flat.map(function (f, i) {
        var b = f.item.bbox || [];
        if (b.length < 4) return '';
        var on = !!o.selected[i];
        return '<button type="button" class="capbox' + (on ? ' on' : '') + '" data-act="cap-toggle" data-i="' + i + '"' +
          ' style="left:' + (b[0] / 10) + '%;top:' + (b[1] / 10) + '%;width:' + ((b[2] - b[0]) / 10) + '%;height:' + ((b[3] - b[1]) / 10) + '%">' +
          (on ? '<span class="capchk">' + ic('check', 'sm') + '</span>' : '') + '</button>';
      }).join('');
      body = '<div class="scanwrap"><div class="scancanvas">' +
        '<img src="' + esc(o.preview || ('/api/v1/capture/page/' + o.taskId)) + '" alt="">' +
        boxes +
        '</div></div>' +
        (flat.length ? '<div class="revhint">点框选题目，再点取消</div>'
                     : '<div class="revhint">没切出题目，换一张试试</div>');
    } else {
      body = '<div class="revhint">解析失败：' + esc(o.error || '不知道原因') + '</div>' +
        '<div class="capmenu"><button type="button" class="caprow" data-act="cap-retry">' + ic('refresh-cw') +
        '<span>再试一次</span><span class="sp"></span><span class="caparr">›</span></button></div>';
    }

    var foot = '';
    if (o.step === 'select' && flatQuestions(o.groups).length) {
      var n = Object.keys(o.selected).filter(function (k) { return o.selected[k]; }).length;
      foot = '<div class="sheet-foot"><div class="btnbar full">' +
        '<button type="button" class="btn" data-act="close-sheet">取消</button>' +
        '<button type="button" class="btn p" data-act="cap-add"' + (n ? '' : ' disabled') + '>' +
        (n ? (isBank ? '收进题库（' + n + ' 题）' : '完成（' + n + ' 题）') : (isBank ? '收进题库' : '完成')) + '</button>' +
        '</div></div>';
    }

    return '<div class="scrim" data-act="close-sheet"></div>' +
      '<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="cap-ttl" tabindex="-1">' +
      '<div class="grab"></div>' +
      '<div class="shd"><div class="ttl" id="cap-ttl">' + title + '</div>' +
      '<button type="button" class="hit" data-act="close-sheet" aria-label="关闭">' + ic('x') + '</button></div>' +
      '<div class="sheet-body">' + body + '</div>' + foot +
      '<input type="file" id="cap-camera" accept="image/*" capture="user" hidden>' +
      '<input type="file" id="cap-file" accept="image/*" hidden>' +
      '</div>';
  }

  function qaCardHtml(q, i, removable) {
    var tags = '<span class="tag">' + esc(q.type === 'choice' ? '选择题' : q.type === 'blank' ? '填空题' : '题目') + '</span>' +
      (q.subject ? '<span class="tag">' + esc(q.subject) + '</span>' : '');
    return '<div class="qattach qpreview">' +
      '<div class="stem clamp2">' + stemHtml(q.stem || '') + '</div>' +
      '<div class="tags">' + tags + '</div>' +
      '<div class="qfoot">' +
        (q.id ? '<button type="button" class="qmore" data-act="open-question" data-id="' + esc(q.id) + '">查看详情 ›</button>'
              : '<span></span>') +
        '<span class="sp"></span>' +
        (removable ? '<button type="button" class="rmd" data-act="drop-question" data-i="' + i + '" aria-label="移除">' +
          ic('x', 'sm') + '</button>' : '') +
      '</div>' +
      '</div>';
  }

  function renderQchips() {
    var host = q('#qchips');
    if (!host) return;
    var list = state.pendingQuestions || [];
    if (!list.length) { host.hidden = true; host.innerHTML = ''; return; }
    host.hidden = false;
    if (list.length >= 2 && list.length <= 4) {
      host.innerHTML = '<div class="qgrid2">' + list.map(function (q, i) {
        return qaCardHtml(q, i, true);
      }).join('') + '</div>';
      typesetMath(host);
      return;
    }
    if (list.length > 4) {
      // 多题：缩成一张堆叠卡，点开浮窗看全部 / 删除
      host.innerHTML = '<button type="button" class="qstacksum" data-act="open-qrefs">' +
        '<span class="qss-l"><span class="qss-n">共 ' + list.length + ' 题</span>' +
        '<span class="qss-s">' + esc(list[0].stem || '').slice(0, 24) + '…</span></span>' +
        '<span class="qss-go">查看 ›</span></button>';
      return;
    }
    host.innerHTML = list.map(function (q, i) { return qaCardHtml(q, i, true); }).join('');
    typesetMath(host);
  }

  function openQrefs(list, removable) {
    setOverlay({ kind: 'qrefs', items: list || [], removable: !!removable });
  }

  function qrefsSheetHtml() {
    var o = state.overlay;
    if (!o || o.kind !== 'qrefs') return '';
    var rows = (o.items || []).map(function (q, i) {
      return '<div class="qrefrow">' +
        '<button type="button" class="qrefmain" data-act="qref-open" data-i="' + i + '">' +
          '<span class="qrefmeta">' + esc(q.subject || '') + ' · ' +
            (q.type === 'choice' ? '选择题' : q.type === 'blank' ? '填空题' : '题目') + '</span>' +
          '<span class="qrefstem">' + stemHtml(q.stem || '') + '</span>' +
        '</button>' +
        (o.removable
          ? '<button type="button" class="rmd" data-act="qref-del" data-i="' + i + '" aria-label="移除">' + ic('x', 'sm') + '</button>'
          : '') +
      '</div>';
    }).join('');
    return '<div class="scrim" data-act="close-sheet"></div>' +
      '<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="qr-ttl" tabindex="-1">' +
      '<div class="grab"></div>' +
      '<div class="shd"><div class="ttl" id="qr-ttl">引用的题目（' + (o.items || []).length + '）</div>' +
      '<button type="button" class="hit" data-act="close-sheet" aria-label="关闭">' + ic('x') + '</button></div>' +
      '<div class="sheet-body">' + (rows || '<div class="empty"><div class="t">没有题目</div></div>') + '</div>' +
      '</div>';
  }

  async function loadCapturePending() {
    try {
      var r = await api('/capture/tasks?limit=50');
      state.capturePending = (r.items || []).filter(function (t) {
        return ['queued', 'parsing', 'extracting', 'review'].indexOf(t.status) >= 0;
      });
    } catch (e) {
      state.capturePending = [];
    }
  }


  async function onCaptureFiles(files) {
    if (!files || !files.length) return;
    toast('上传中…');
    var ids = [];
    for (var i = 0; i < files.length; i++) {
      var fd = new FormData();
      fd.append('file', files[i]);
      fd.append('subject', currentSubjectName());
      fd.append('page_no', String(i + 1));
      try {
        var r = await api('/capture/pages', { method: 'POST', form: fd });
        ids.push(r.task_id);
      } catch (e) {
        toast('上传失败：' + e.message);
      }
    }
    if (!ids.length) return;
    state.captureQueue = ids;
    await loadCapturePending();
    await openReview(ids[0]);
  }

  /* ── 题库（P-题库）：列表 / 筛选 / 详情 ───────────── */

  /* ── 对话列表（ChatGPT 式）────────────────────────── */

  async function loadConversations() {
    try {
      var params = state.convFilter ? ('?subject=' + encodeURIComponent(state.convFilter)) : '';
      var r = await api('/conversations' + params);
      state.conversations = r.items || [];
    } catch (e) {
      state.conversations = [];
    }
    render();
  }

  async function maybeAutoTitle() {
    if (!state.convId) return;
    try {
      var r = await api('/conversations/' + encodeURIComponent(state.convId) + '/autotitle', { method: 'POST' });
      if (r && r.title && r.title !== state.convTitle) {
        state.convTitle = r.title;
        await loadConversations();
        render();
      }
    } catch (e) { /* 起名失败不影响对话 */ }
  }

  function openConversations() {
    state.convId = '';
    state.convTitle = '';
    state.messages = [];
    if (!state.heroSubject) state.heroSubject = (state.subjects && state.subjects.current) || '全部';
    state.convSubject = state.heroSubject;
    openPage(null);
    loadConversations();
  }

  function convGroupDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var now = new Date();
    if (d.toDateString() === now.toDateString()) return '今天';
    var y = new Date(now.getTime() - 86400000);
    if (d.toDateString() === y.toDateString()) return '昨天';
    return (d.getMonth() + 1) + '/' + d.getDate();
  }

  function convsPageHtml() {
    var list = state.conversations || [];
    var nav = navbar('对话', list.length + ' 个', '', '', false);
    var subjects = ['', '语文', '数学', '英语', '物理', '化学', '生物', '政治', '历史', '地理'];
    var chips = subjects.map(function (x) {
      var on = (state.convFilter || '') === x;
      return '<span class="fchip' + (on ? ' on' : '') + '" role="button" tabindex="0" data-act="conv-filter" data-subject="' + esc(x) + '">' +
        (x || '全部') + '</span>';
    }).join('');

    var groups = [], byDay = {};
    list.forEach(function (c) {
      var k = convGroupDate(c.updated_at);
      if (!byDay[k]) { byDay[k] = []; groups.push(k); }
      byDay[k].push(c);
    });
    var rows = groups.map(function (k) {
      return '<div class="dhead">' + esc(k || '更早') + '</div>' +
        byDay[k].map(function (c) {
          return '<button type="button" class="convrow" data-act="open-conv" data-id="' + esc(c.id) + '">' +
            '<span class="convttl">' + esc(c.title || '新对话') + '</span>' +
            '<span class="convmeta"><span class="tag">' + esc(c.subject || '全部') + '</span>' +
            '<span class="convprev">' + esc(c.preview || '') + '</span></span>' +
            '</button>';
        }).join('');
    }).join('');

    if (!rows) {
      rows = '<div class="empty"><div class="t">还没有对话</div>' +
        '<div class="m">新建一个，选好科目就开始</div>' +
        '<div class="acts"><button type="button" class="btn" data-act="new-conv">新对话</button></div></div>';
    }

    return nav +
      '<div class="convbar">' +
        '<button type="button" class="btn p" data-act="new-conv">新对话</button>' +
        '<span class="sp"></span>' +
      '</div>' +
      '<div class="bankchips">' + chips + '</div>' +
      '<div class="settings convwrap">' + rows + '</div>';
  }

  function convsSideHtml() {
    var list = state.conversations || [];
    var subjects = ['', '语文', '数学', '英语', '物理', '化学', '生物', '政治', '历史', '地理'];
    var chips = subjects.map(function (x) {
      var on = (state.convFilter || '') === x;
      return '<span class="fchip sm' + (on ? ' on' : '') + '" role="button" tabindex="0" data-act="conv-filter" data-subject="' + esc(x) + '">' +
        (x || '全部') + '</span>';
    }).join('');

    var groups = [], byDay = {};
    list.forEach(function (c) {
      var k = convGroupDate(c.updated_at);
      if (!byDay[k]) { byDay[k] = []; groups.push(k); }
      byDay[k].push(c);
    });
    var rows = groups.map(function (k) {
      return '<div class="csday">' + esc(k || '更早') + '</div>' +
        byDay[k].map(function (c) {
          var on = c.id === state.convId;
          return '<button type="button" class="convrow' + (on ? ' on' : '') + '" data-act="open-conv" data-id="' + esc(c.id) + '">' +
            '<span class="convttl">' + esc(c.title || '新对话') + '</span>' +
            '<span class="convprev">' + esc(c.subject || '全部') + (c.preview ? ' · ' + esc(c.preview) : '') + '</span>' +
            '</button>';
        }).join('');
    }).join('');

    if (!rows) {
      rows = '<div class="empty sm"><div class="t">还没有对话</div><div class="m">新建一个，选好科目就开始</div></div>';
    }

    return '<div class="cshead"><div class="csbrand">对话</div>' +
        '<button type="button" class="csnew" data-act="new-conv">' + ic('plus', 'sm') + '<span>新对话</span></button></div>' +
      '<div class="csfilter">' + chips + '</div>' +
      '<div class="cslist">' + rows + '</div>';
  }

  function renderConvSide() {
    var host = q('#convside');
    if (!host) return;
    // 只有「对话」这一页有侧栏；题库/本周/记忆/设置都是独立一级页
    if (state.view !== 'chat') {
      host.hidden = true;
      return;
    }
    host.hidden = false;
    host.innerHTML = convsSideHtml();
  }

  function openNewChatSheet() {
    openConversations();
  }

  function newChatSheetHtml() {
    var subjects = ['语文', '数学', '英语', '物理', '化学', '生物', '政治', '历史', '地理'];
    var rows = subjects.map(function (x) {
      return '<button type="button" class="caprow" data-act="new-conv-subject" data-subject="' + esc(x) + '">' +
        ic('book', 'sm') + '<span>' + esc(x) + '</span><span class="sp"></span>' +
        ic('chevron-right', 'sm chev') + '</button>';
    }).join('');
    return '<div class="scrim" data-act="close-sheet"></div>' +
      '<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="nc-ttl" tabindex="-1">' +
      '<div class="grab"></div>' +
      '<div class="shd"><div class="ttl" id="nc-ttl">新对话</div>' +
      '<button type="button" class="hit" data-act="close-sheet" aria-label="关闭">' + ic('x') + '</button></div>' +
      '<div class="sheet-body"><div class="revhint" style="margin-bottom:8px">选一门科目</div>' +
      '<div class="capmenu">' + rows + '</div></div>' +
      '</div>';
  }

  async function newConversation(subject) {
    try {
      var r = await api('/conversations', { method: 'POST', json: { subject: subject } });
      state.convId = r.id;
      state.convSubject = subject;
      state.convTitle = '新对话';
      state.messages = [];
      state.overlay = null;
      openPage(null);
      await loadMessages();
      render();
    } catch (e) {
      toast('新建失败：' + e.message);
    }
  }

  async function openConversation(id) {
    var c = (state.conversations || []).filter(function (x) { return x.id === id; })[0];
    state.convId = id;
    state.convSubject = c ? c.subject : state.convSubject;
    state.heroSubject = state.convSubject;
    state.convTitle = c ? c.title : '';
    state.messages = [];
    openPage(null);
    await loadMessages();
    render();
  }

  /* ── 本周（近 7 天）──────────────────────────────── */

  async function openWeek() {
    openPage({ kind: 'week' });
    try { state.week = await api('/stats/week'); } catch (e) { state.week = null; }
    render();
  }

  function weekPageHtml() {
    var w = state.week;
    var nav = navbar('本周', '近 7 天', '', '', false);
    if (!w) {
      return nav + '<div class="settings">' + pageErrorState('加载失败', '拿不到统计', 'week-reload', 'rail-chat', '回对话') + '</div>';
    }
    var max = Math.max.apply(null, w.days.map(function (d) { return d.count; }).concat([1]));
    var bars = w.days.map(function (d) {
      var h = Math.round((d.count / max) * 72);
      return '<div class="wcol"><div class="wbar" style="height:' + Math.max(3, h) + 'px"></div>' +
        '<div class="wlb">' + esc(d.date.slice(5)) + '</div></div>';
    }).join('');

    var subs = (w.subjects || []).map(function (x) {
      var pct = w.total ? Math.round((x.count / w.total) * 100) : 0;
      return '<div class="wrow"><span class="wn">' + esc(x.subject) + '</span>' +
        '<span class="wtrack"><i style="width:' + pct + '%"></i></span>' +
        '<span class="wv">' + numWrap(x.count) + '</span></div>';
    }).join('');

    return nav +
      '<div class="settings weekwrap">' +
        '<div class="wsum">' +
          '<div class="wstat"><div class="n num">' + numWrap(w.total) + '</div><div class="l">消息</div></div>' +
          '<div class="wstat"><div class="n num">' + numWrap(w.active_days) + '</div><div class="l">活跃天</div></div>' +
          '<div class="wstat"><div class="n num">' + numWrap(w.streak) + '</div><div class="l">连续</div></div>' +
        '</div>' +
        '<div class="wchart">' + bars + '</div>' +
        (subs ? '<div class="wsubs">' + subs + '</div>' : '<div class="empty sm"><div class="t">这周还没开始</div><div class="m">随便问一题就算</div></div>') +
      '</div>';
  }

  /* ── 题目编辑（题库）────────────────────────────── */

  function openEditQuestion(q) {
    if (!q) return;
    setOverlay({
      kind: 'qedit',
      id: q.id,
      subject: q.subject || '',
      qtype: q.qtype || 'short',
      grade: q.grade || '',
      difficulty: Number(q.difficulty || 0),
      status: q.status || 'learning',
      error_type: q.error_type || '',
      stem: q.stem_md || '',
      answer: q.answer_md || '',
      solution: q.solution_md || '',
      options: (q.options || []).join('\n')
    });
  }

  function qeditSheetHtml() {
    var o = state.overlay;
    if (!o || o.kind !== 'qedit') return '';
    var gradeOpts = ['', '高一', '高二', '高三'].map(function (g) {
      return '<option value="' + esc(g) + '"' + (o.grade === g ? ' selected' : '') + '>' + (g || '未标') + '</option>';
    }).join('');
    var diffOpts = [0, 1, 2, 3, 4, 5].map(function (n) {
      return '<option value="' + n + '"' + (Number(o.difficulty) === n ? ' selected' : '') + '>' + (n ? n + ' · ' + diffLabel(n) : '未评') + '</option>';
    }).join('');
    var statusOpts = [['learning', '在学'], ['weak', '待解决'], ['mastered', '已掌握']].map(function (x) {
      return '<option value="' + x[0] + '"' + ((o.status || 'learning') === x[0] ? ' selected' : '') + '>' + x[1] + '</option>';
    }).join('');
    return '<div class="scrim" data-act="close-sheet"></div>' +
      '<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="qe-ttl" tabindex="-1">' +
      '<div class="grab"></div>' +
      '<div class="shd"><div class="ttl" id="qe-ttl">编辑题目</div>' +
      '<button type="button" class="hit" data-act="close-sheet" aria-label="关闭">' + ic('x') + '</button></div>' +
      '<div class="sheet-body">' +
        '<div class="slabel">题干</div>' +
        '<textarea class="fi rta" id="qe-stem" rows="4">' + escText(o.stem) + '</textarea>' +
        '<div class="slabel">选项（一行一个）</div>' +
        '<textarea class="fi rta" id="qe-opts" rows="3">' + escText(o.options) + '</textarea>' +
        '<div class="slabel">答案</div>' +
        '<textarea class="fi rta" id="qe-answer" rows="2">' + escText(o.answer) + '</textarea>' +
        '<div class="slabel">解析</div>' +
        '<textarea class="fi rta" id="qe-solution" rows="4">' + escText(o.solution) + '</textarea>' +
        '<div class="frow2">' +
          '<label class="ffield"><span class="slabel">年级</span><select class="fi" id="qe-grade">' + gradeOpts + '</select></label>' +
          '<label class="ffield"><span class="slabel">难度</span><select class="fi" id="qe-diff">' + diffOpts + '</select></label>' +
        '</div>' +
        '<div class="frow2">' +
          '<label class="ffield"><span class="slabel">状态</span><select class="fi" id="qe-status">' + statusOpts + '</select></label>' +
          '<label class="ffield"><span class="slabel">错因</span><input class="fi" id="qe-error" placeholder="概念 / 计算 / 审题…" value="' + esc(o.error_type || '') + '"></label>' +
        '</div>' +
      '</div>' +
      '<div class="sheet-foot"><div class="btnbar full">' +
        '<button type="button" class="btn" data-act="close-sheet">取消</button>' +
        '<button type="button" class="btn p" data-act="qedit-save">保存</button>' +
      '</div></div></div>';
  }

  async function saveEditQuestion() {
    var o = state.overlay;
    if (!o || o.kind !== 'qedit') return;
    var body = {
      stem: (q('#qe-stem') || {}).value || '',
      options: ((q('#qe-opts') || {}).value || '').split('\n').map(function (x) { return x.trim(); }).filter(Boolean),
      answer: (q('#qe-answer') || {}).value || '',
      solution: (q('#qe-solution') || {}).value || '',
      grade: (q('#qe-grade') || {}).value || '',
      difficulty: Number((q('#qe-diff') || {}).value || 0),
      status: (q('#qe-status') || {}).value || 'learning',
      error_type: (q('#qe-error') || {}).value || ''
    };
    try {
      var r = await api('/questions/' + encodeURIComponent(o.id), { method: 'PATCH', json: body });
      state.overlay = null;
      if (state.question && state.question.id === o.id) state.question = r;
      if (state.qpanel && state.qpanel.id === o.id) state.qpanel.data = r;
      await loadBank();
      render();
      toast('已保存');
    } catch (e) {
      toast('保存失败：' + e.message);
    }
  }

  var GRADES = ['高一', '高二', '高三'];
  var DIFFS = { 1: '易', 2: '较易', 3: '中等', 4: '较难', 5: '难' };
  var SUBJECTS = ['语文', '数学', '英语', '物理', '化学', '生物', '政治', '历史', '地理'];

  function diffLabel(n) { return DIFFS[Number(n)] || ''; }

  var Q_STATUS = { weak: '待解决', learning: '在学', mastered: '已掌握' };
  function qStatusLabel(s) { return Q_STATUS[s] || '在学'; }

  function bankState() {
    return state.bank || { items: [], total: 0, subject: '', q: '', grade: '', difficulty: 0, kp: '', kpName: '', status: '' };
  }

  function openBank() {
    openPage({ kind: 'bank' });
    loadBank();
  }

  function bankPatch(patch) {
    var b = bankState();
    state.bank = {
      items: b.items || [], total: b.total || 0, subject: b.subject || '', q: b.q || '',
      grade: b.grade || '', difficulty: b.difficulty || 0, kp: b.kp || '', kpName: b.kpName || '',
      status: b.status || '', error: ''
    };
    Object.keys(patch || {}).forEach(function (k) { state.bank[k] = patch[k]; });
    loadBank();
  }

  async function loadBank() {
    var b = bankState();
    try {
      var params = ['limit=100'];
      if (b.subject) params.push('subject=' + encodeURIComponent(b.subject));
      if (b.q) params.push('q=' + encodeURIComponent(b.q));
      if (b.grade) params.push('grade=' + encodeURIComponent(b.grade));
      if (b.difficulty) params.push('difficulty=' + Number(b.difficulty));
      if (b.kp) params.push('kp=' + encodeURIComponent(b.kp));
      if (b.status) params.push('status=' + encodeURIComponent(b.status));
      var r = await api('/questions?' + params.join('&'));
      state.bank = {
        items: r.items || [], total: r.total || 0, subject: b.subject, q: b.q,
        grade: b.grade, difficulty: b.difficulty, kp: b.kp, kpName: b.kpName, status: b.status
      };
    } catch (e) {
      state.bank = {
        items: [], total: 0, subject: b.subject, q: b.q, grade: b.grade,
        difficulty: b.difficulty, kp: b.kp, kpName: b.kpName, status: b.status, error: e.message
      };
    }
    render();
    pollBankSolve();
  }

  function bankFilter(subject) {
    bankPatch({ subject: subject });
  }

  function bankSearch() {
    var el = q('#bank-q');
    bankPatch({ q: (el && el.value || '').trim() });
  }

  function bankOpenFilter(field) {
    setOverlay({ kind: 'bankfilter', field: field });
  }

  function bankFilterPick(value) {
    var o = state.overlay;
    if (!o || o.kind !== 'bankfilter') return;
    if (o.field === 'grade') bankPatch({ grade: value || '' });
    else if (o.field === 'status') bankPatch({ status: value || '' });
    else bankPatch({ difficulty: Number(value) || 0 });
    closeOverlay();
  }

  function bankReset() {
    bankPatch({ subject: '', grade: '', difficulty: 0, kp: '', kpName: '', q: '', status: '' });
  }

  function bankHasPendingSolve() {
    var items = (state.bank && state.bank.items) || [];
    return items.some(function (x) { return x.solve_status === 'queued' || x.solve_status === 'running'; });
  }

  function pollBankSolve() {
    clearTimeout(state.bankSolvedTimer);
    if (!bankHasPendingSolve()) return;
    state.bankSolvedTimer = setTimeout(function () {
      if (state.page && state.page.kind === 'bank') loadBank();
    }, 2600);
  }

  function bankSolveMissing() {
    api('/questions/solve-missing?limit=20', { method: 'POST' })
      .then(function (r) {
        toast('补解析 ' + (r.queued || 0) + ' 题');
        loadBank();
      })
      .catch(function (e) { toast('补解析失败：' + e.message); });
  }

  /* ── 知识点选择 / 筛选 ───────────────────────────── */

  function openKpSheet(mode, opts) {
    opts = opts || {};
    var o = {
      kind: 'kpsel',
      mode: mode,                 // filter | edit
      subject: opts.subject || '',
      qid: opts.qid || '',
      q: '',
      items: [],
      loading: true,
      selected: opts.selected || {},
      pinned: opts.pinned || []
    };
    setOverlay(o);
    loadKpSheet('');
  }

  async function loadKpSheet(kw) {
    var o = state.overlay;
    if (!o || o.kind !== 'kpsel') return;
    o.loading = true;
    renderOverlay();
    try {
      var params = ['limit=60'];
      if (kw) params.push('q=' + encodeURIComponent(kw));
      if (o.subject && o.subject !== '全部') params.push('subject=' + encodeURIComponent(o.subject));
      var r = await api('/kp/search?' + params.join('&'));
      o.items = r.items || [];
    } catch (e) {
      o.items = [];
      o.error = e.message;
    }
    // 已选中的知识点不在搜索结果里时置顶（否则编辑时看不到自己选了啥）
    var have = {};
    (o.items || []).forEach(function (k) { have[k.id] = true; });
    (o.pinned || []).slice().reverse().forEach(function (k) {
      if (k && k.id && o.selected[k.id] && !have[k.id]) {
        o.items.unshift({ id: k.id, name: k.name, grade: k.grade || '', chapter: k.chapter || '' });
        have[k.id] = true;
      }
    });
    o.loading = false;
    if (state.overlay === o) renderOverlay();
  }

  function kpSheetSearch() {
    var el = q('#kp-q');
    var o = state.overlay;
    if (!o || o.kind !== 'kpsel') return;
    o.q = (el && el.value || '').trim();
    loadKpSheet(o.q);
  }

  async function kpSheetToggle(id) {
    var o = state.overlay;
    if (!o || o.kind !== 'kpsel' || !id) return;
    if (o.mode === 'filter') {
      var name = '';
      (o.items || []).forEach(function (k) { if (k.id === id) name = k.name; });
      closeOverlay();
      bankPatch({ kp: id, kpName: name });
      return;
    }
    var next = Object.assign({}, o.selected || {});
    if (next[id]) delete next[id];
    else next[id] = true;
    o.selected = next;
    try {
      var r = await api('/questions/' + encodeURIComponent(o.qid), {
        method: 'PATCH',
        json: { kps: Object.keys(next) }
      });
      if (state.question && state.question.id === o.qid) state.question = r;
      if (state.qpanel && state.qpanel.id === o.qid) state.qpanel.data = r;
      if (state.overlay === o) renderOverlay();
      render();
    } catch (e) {
      toast('保存失败：' + e.message);
    }
  }

  function bankFilterSheetHtml() {
    var o = state.overlay;
    if (!o || o.kind !== 'bankfilter') return '';
    var b = bankState();
    var field = o.field;
    var options;
    if (field === 'grade') {
      options = [{ v: '', t: '全部' }].concat(GRADES.map(function (g) { return { v: g, t: g }; }));
    } else if (field === 'status') {
      options = [
        { v: '', t: '全部' }, { v: 'weak', t: '待解决' }, { v: 'learning', t: '在学' },
        { v: 'mastered', t: '已掌握' }, { v: 'due', t: '待复习' }
      ];
    } else {
      options = [{ v: 0, t: '全部' }].concat([1, 2, 3, 4, 5].map(function (n) { return { v: n, t: diffLabel(n) }; }));
    }
    var cur = field === 'grade' ? (b.grade || '')
      : field === 'status' ? (b.status || '')
        : (Number(b.difficulty) || 0);
    var rows = options.map(function (op) {
      var on = String(op.v) === String(cur);
      return '<button type="button" class="caprow' + (on ? ' on' : '') + '" data-act="bank-filter-pick" data-v="' + esc(String(op.v)) + '">' +
        '<span>' + esc(op.t) + '</span><span class="sp"></span>' +
        (on ? '<span class="capchk">' + ic('check', 'sm') + '</span>' : '') + '</button>';
    }).join('');
    var title = field === 'grade' ? '年级' : field === 'status' ? '状态' : '难度';
    return '<div class="scrim" data-act="close-sheet"></div>' +
      '<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="bf-ttl" tabindex="-1">' +
      '<div class="grab"></div>' +
      '<div class="shd"><div class="ttl" id="bf-ttl">' + title + '</div>' +
      '<button type="button" class="hit" data-act="close-sheet" aria-label="关闭">' + ic('x') + '</button></div>' +
      '<div class="sheet-body"><div class="capmenu">' + rows + '</div></div>' +
      '</div>';
  }

  function kpSheetHtml() {
    var o = state.overlay;
    if (!o || o.kind !== 'kpsel') return '';
    var rows = (o.items || []).map(function (k) {
      var on = !!(o.selected || {})[k.id];
      return '<button type="button" class="kprow' + (on ? ' on' : '') + '" data-act="kp-toggle" data-id="' + esc(k.id) + '">' +
        '<span class="kpmain"><span class="kpname">' + esc(k.name) + '</span>' +
        '<span class="kpmeta">' + esc(k.grade || '') + (k.chapter ? ' · ' + esc(k.chapter) : '') + '</span></span>' +
        (on ? '<span class="capchk">' + ic('check', 'sm') + '</span>' : '') +
        '</button>';
    }).join('');
    var empty = o.loading ? '<div class="skel inmsg">' + skelRows(4) + '</div>'
      : (rows ? '' : '<div class="empty"><div class="t">没找到知识点</div><div class="d">换个词，或直接选不限制</div></div>');
    return '<div class="scrim" data-act="close-sheet"></div>' +
      '<div class="sheet kpsheet" role="dialog" aria-modal="true" aria-labelledby="kp-ttl" tabindex="-1">' +
      '<div class="grab"></div>' +
      '<div class="shd"><div class="ttl" id="kp-ttl">知识点</div>' +
      '<button type="button" class="hit" data-act="close-sheet" aria-label="关闭">' + ic('x') + '</button></div>' +
      '<div class="sheet-body">' +
        '<div class="pickbar"><input type="search" id="kp-q" class="fi" placeholder="搜知识点" value="' + esc(o.q || '') + '">' +
        '<button type="button" class="btn" data-act="kp-search">搜索</button></div>' +
        (o.mode === 'filter'
          ? '<button type="button" class="kprow' + (bankState().kp ? '' : ' on') + '" data-act="kp-clear"><span class="kpmain"><span class="kpname">不限制</span></span>' +
            (bankState().kp ? '' : '<span class="capchk">' + ic('check', 'sm') + '</span>') + '</button>'
          : '') +
        empty + rows +
      '</div></div>';
  }

  async function pollQuestionSolve(qid) {
    for (var i = 0; i < 40; i++) {
      await new Promise(function (r) { setTimeout(r, 2500); });
      if (!state.question || state.question.id !== qid) return;
      if (state.question.solve_status !== 'queued' && state.question.solve_status !== 'running') return;
      try {
        var r = await api('/questions/' + encodeURIComponent(qid));
        if (!state.question || state.question.id !== qid) return;
        state.question = r;
        render();
      } catch (e) { return; }
    }
  }

  function bankCardHtml(q, i) {
    var tags = '<span class="tag">' + esc(q.subject || '全部') + '</span>' +
      (q.grade ? '<span class="tag">' + esc(q.grade) + '</span>' : '') +
      (q.difficulty ? '<span class="tag">' + esc(diffLabel(q.difficulty)) + '</span>' : '');
    var state = q.status || 'learning';
    if (state === 'weak') tags += '<span class="tag stweak">待解决</span>';
    else if (state === 'mastered') tags += '<span class="tag stok">已掌握</span>';
    if (q.error_type) tags += '<span class="tag">' + esc(q.error_type) + '</span>';
    var due = q.next_due_at && new Date(q.next_due_at).getTime() <= Date.now() && state !== 'mastered';
    if (due) tags += '<span class="tag stdue">待复习</span>';
    var thumb = q.image_url
      ? '<img class="qthumb" src="' + esc(q.image_url) + '" alt="">'
      : '';
    var kps = (q.kps || []).slice(0, 2).map(function (k) {
      return '<span class="kptag">' + esc(k.name) + '</span>';
    }).join('');
    if ((q.kps || []).length > 2) kps += '<span class="kptag">+' + ((q.kps || []).length - 2) + '</span>';
    var pending = q.solve_status === 'queued' || q.solve_status === 'running';
    var foot = pending
      ? '<span class="qstate">解析中…</span>'
      : (q.solve_status === 'failed'
        ? '<span class="qstate fail">解析失败</span>'
        : (q.answer_md
          ? '<span class="qansline"><span class="k">答案</span>' + esc(String(q.answer_md).replace(/\s+/g, ' ').slice(0, 36)) + '</span>'
          : '<span class="qstate">待补解析</span>'));
    return '<button type="button" class="qattach qbank" data-act="open-question" data-id="' + esc(q.id) + '">' +
      '<div class="rowtop"><div class="tags">' + tags + '</div><span class="sp"></span>' + thumb + '</div>' +
      '<div class="stem clamp3">' + stemHtml(q.stem_md || '') + '</div>' +
      (kps ? '<div class="qkps">' + kps + '</div>' : '') +
      '<div class="qbankfoot">' + foot + '</div>' +
      '</button>';
  }

  function bankGroupDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var now = new Date();
    var sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    if (sameDay) return '今天';
    var y = new Date(now.getTime() - 86400000);
    if (d.getFullYear() === y.getFullYear() && d.getMonth() === y.getMonth() && d.getDate() === y.getDate()) return '昨天';
    return (d.getMonth() + 1) + '/' + d.getDate();
  }

  function bankPageHtml() {
    var b = bankState();
    var nav = navbar('题库', (b.total || 0) + ' 题', '', '', false);
    if (b.error) {
      return nav + '<div class="settings">' +
        pageErrorState('加载失败', b.error, 'bank-reload', 'rail-chat', '返回对话') + '</div>';
    }

    var subjects = [''].concat(SUBJECTS);
    var chips = subjects.map(function (s) {
      var on = (b.subject || '') === s;
      return '<span class="fchip' + (on ? ' on' : '') + '" role="button" tabindex="0" data-act="bank-filter" data-subject="' + esc(s) + '">' +
        (s || '全部') + (s ? '' : ' ' + (b.total || 0)) + '</span>';
    }).join('');

    var anyFilter = !!(b.grade || b.difficulty || b.kp || b.status);
    var missing = (b.items || []).filter(function (x) {
      return !(x.solution_md || '').trim() && x.solve_status !== 'queued' && x.solve_status !== 'running';
    }).length;
    var filters = '<div class="bankfilters">' +
      '<button type="button" class="fchip' + (b.status ? ' on' : '') + '" data-act="bank-open-filter" data-field="status">' +
        (b.status ? (b.status === 'due' ? '待复习' : qStatusLabel(b.status)) : '状态') + '</button>' +
      '<button type="button" class="fchip' + (b.grade ? ' on' : '') + '" data-act="bank-open-filter" data-field="grade">' +
        (b.grade || '年级') + '</button>' +
      '<button type="button" class="fchip' + (b.difficulty ? ' on' : '') + '" data-act="bank-open-filter" data-field="difficulty">' +
        (b.difficulty ? diffLabel(b.difficulty) : '难度') + '</button>' +
      '<button type="button" class="fchip' + (b.kp ? ' on' : '') + '" data-act="open-kp-filter">' +
        (b.kpName || '知识点') + '</button>' +
      (anyFilter ? '<button type="button" class="fchip clear" data-act="bank-reset">重置</button>' : '') +
      '<span class="sp"></span>' +
      (missing ? '<button type="button" class="fchip" data-act="bank-solve-missing">补解析 ' + missing + '</button>' : '') +
      '</div>';

    var groups = [];
    var byDay = {};
    (b.items || []).forEach(function (q) {
      var k = bankGroupDate(q.created_at);
      if (!byDay[k]) { byDay[k] = []; groups.push(k); }
      byDay[k].push(q);
    });
    var list = groups.map(function (k) {
      return '<div class="dhead">' + esc(k || '更早') + '</div>' +
        '<div class="bankgrid">' + byDay[k].map(bankCardHtml).join('') + '</div>';
    }).join('');

    if (!list) {
      list = '<div class="empty"><div class="t">' + (anyFilter || b.subject || b.q ? '没有符合条件的题' : '还没有题目') + '</div>' +
        '<div class="d">' + (anyFilter || b.subject || b.q ? '换个筛选，或重新拍一张' : '拍一张卷子，选几道题收进来') + '</div>' +
        '<div class="btnbar"><button type="button" class="btn" data-act="bank-capture">' + ic('camera') + '拍题</button></div></div>';
    }

    return nav +
      '<div class="bankbar">' +
        '<input type="search" id="bank-q" class="fi" placeholder="搜题干" value="' + esc(b.q || '') + '">' +
        '<button type="button" class="btn" data-act="bank-search">搜索</button>' +
        '<button type="button" class="btn p" data-act="bank-capture">' + ic('plus') + '拍题</button>' +
      '</div>' +
      '<div class="bankchips">' + chips + '</div>' +
      filters +
      '<div class="settings bankwrap">' + list + '</div>';
  }

  function qTypeLabel(t) {
    return t === 'choice' ? '选择题' : t === 'blank' ? '填空题' : t === 'essay' ? '解答题' : t === 'reading' ? '阅读题' : '题目';
  }

  function qMetaTags(r) {
    var out = '<span class="tag">' + esc(qTypeLabel(r.qtype)) + '</span>' +
      '<span class="tag">' + esc(r.subject || '全部') + '</span>';
    if (r.grade) out += '<span class="tag">' + esc(r.grade) + '</span>';
    if (r.difficulty) out += '<span class="tag">' + esc(diffLabel(r.difficulty)) + '</span>';
    if (r.status === 'weak') out += '<span class="tag stweak">待解决</span>';
    else if (r.status === 'mastered') out += '<span class="tag stok">已掌握</span>';
    if (r.error_type) out += '<span class="tag">' + esc(r.error_type) + '</span>';
    if (r.next_due_at && r.status !== 'mastered' && new Date(r.next_due_at).getTime() <= Date.now()) {
      out += '<span class="tag stdue">待复习</span>';
    }
    return out;
  }

  function qKpsHtml(r, editable) {
    var chips = (r.kps || []).map(function (k) {
      return '<button type="button" class="kpchip' + (k.primary ? ' main' : '') + '" data-act="kp-open-map" data-id="' +
        esc(k.id) + '" title="在地图里看">' + esc(k.name) + '</button>';
    }).join('');
    var act = editable
      ? '<button type="button" class="kpadd" data-act="edit-kps">' + ic((r.kps || []).length ? 'settings' : 'plus', 'sm') +
        ((r.kps || []).length ? '编辑' : '添加') + '</button>'
      : '';
    return '<div class="qsec"><div class="slabel">知识点</div><div class="qkpsrow">' +
      (chips || '<span class="qempty">还没打标签</span>') + act + '</div></div>';
  }

  function qSolveBlock(r) {
    var pending = r.solve_status === 'queued' || r.solve_status === 'running';
    var status = pending
      ? '<span class="qstate">生成中…</span>'
      : (r.solve_status === 'failed' ? '<span class="qstate fail">上次失败</span>' : '');
    var ans = (r.answer_md || '').trim();
    var sol = (r.solution_md || '').trim();
    return '<div class="qsec"><div class="slabel">答案' + status + '</div>' +
      (ans ? '<div class="qansbox">' + stemHtml(ans) + '</div>'
        : '<div class="qempty">' + (pending ? '生成中' : '暂无') + '</div>') +
      '</div>' +
      '<div class="qsec"><div class="slabel">解析</div>' +
      (sol ? '<div class="qsol">' + stemHtml(sol) + '</div>'
        : '<div class="qempty">' + (pending ? '生成中' : '暂无') + '</div>') +
      '</div>';
  }

  async function openQuestionDetail(id) {
    try {
      var r = await api('/questions/' + encodeURIComponent(id));
    } catch (e) {
      toast('打开失败：' + e.message);
      return;
    }
    state.question = r;
    openPage({ kind: 'question', id: id });
    if (r.solve_status === 'queued' || r.solve_status === 'running') pollQuestionSolve(id);
  }

  function questionPageHtml() {
    var r = state.question;
    if (!r) return navbar('题目详情', '', 'rail-bank', '返回', false);
    var sub = [r.subject, r.grade].filter(Boolean).join(' · ');
    var nav = navbar('题目详情', sub, 'rail-bank', '返回', false);
    var opts = (r.options || []).map(function (o) {
      return '<div class="qopt">' + stemHtml(o) + '</div>';
    }).join('');
    var img = r.image_url
      ? '<img class="qfull" src="' + esc(r.image_url) + '" alt="题目原图">'
      : '';
    return nav +
      '<div class="settings qdetail">' +
        '<div class="qattach detail">' +
          '<div class="tags">' + qMetaTags(r) + '</div>' +
          '<div class="stem">' + stemHtml(r.stem_md || '') + '</div>' +
          (opts ? '<div class="qopts">' + opts + '</div>' : '') +
        '</div>' +
        qKpsHtml(r, true) +
        qSolveBlock(r) +
        img +
        '<div class="btnbar full qacts">' +
          '<button type="button" class="btn" data-act="edit-question">编辑</button>' +
          '<button type="button" class="btn" data-act="regen-solve">重新生成解析</button>' +
          '<button type="button" class="btn p" data-act="question-quote">引用该题</button>' +
        '</div>' +
      '</div>';
  }

  async function regenSolve() {
    var r = state.question;
    if (!r) return;
    try {
      await api('/questions/' + encodeURIComponent(r.id) + '/solve?overwrite=true', { method: 'POST' });
      r.solve_status = 'queued';
      render();
      pollQuestionSolve(r.id);
      toast('正在重新生成');
    } catch (e) {
      toast('生成失败：' + e.message);
    }
  }

  async function openQuestionPanel(id) {
    try {
      var r = await api('/questions/' + encodeURIComponent(id));
    } catch (e) {
      toast('打开失败：' + e.message);
      return;
    }
    state.qpanel = { id: id, data: r };
    render();
  }

  function qpanelHtml() {
    var pnl = state.qpanel;
    if (!pnl || !pnl.data) return '';
    var r = pnl.data;
    var opts = (r.options || []).map(function (o) {
      return '<div class="qopt">' + stemHtml(o) + '</div>';
    }).join('');
    var img = r.image_url ? '<img class="qfull" src="' + esc(r.image_url) + '" alt="题目原图">' : '';
    return '<div class="qpanel-scrim" data-act="close-qpanel"></div>' +
      '<div class="qpanel-body" role="dialog" aria-modal="false" aria-label="题目">' +
        '<div class="qp-head">' +
          '<div class="tbox"><div class="ttl">题目</div><div class="sub">' + esc(r.subject || '') + '</div></div>' +
          '<button type="button" class="hit" data-act="close-qpanel" aria-label="关闭">' + ic('x') + '</button>' +
        '</div>' +
        '<div class="qp-scroll">' +
          '<div class="qattach detail">' +
            '<div class="tags">' + qMetaTags(r) + '</div>' +
            '<div class="stem">' + stemHtml(r.stem_md || '') + '</div>' +
            (opts ? '<div class="qopts">' + opts + '</div>' : '') +
          '</div>' +
          qKpsHtml(r, false) +
          qSolveBlock(r) +
          img +
        '</div>' +
        '<div class="qp-foot"><button type="button" class="btn p" data-act="qpanel-quote">引用该题</button></div>' +
      '</div>';
  }

  function renderQpanel() {
    var host = q('#qpanel');
    if (!host) return;
    if (!state.qpanel) {
      host.hidden = true;
      host.innerHTML = '';
      return;
    }
    host.hidden = false;
    host.innerHTML = qpanelHtml();
    typesetMath(host);
  }

  async function quoteQuestion(q) {
    if (!q) return;
    state.qpanel = null;
    var ref = {
      id: q.id,
      number: '',
      stem: q.stem_md || '',
      type: q.qtype || 'short',
      subject: q.subject || '全部',
      options: q.options || []
    };
    if (!state.pendingQuestions.some(function (x) { return x.id === ref.id; })) {
      state.pendingQuestions.push(ref);
    }
    // 当前对话科不同（或还没有对话）→ 新建一个该科目的对话
    if (!state.convId || (state.convSubject || '') !== ref.subject) {
      try {
        var r = await api('/conversations', { method: 'POST', json: { subject: ref.subject } });
        state.convId = r.id;
        state.convSubject = ref.subject;
        state.convTitle = '新对话';
        state.messages = [];
      } catch (e) { /* 建不了就留在当前对话 */ }
    }
    openPage(null);
    await loadMessages();
    render();
    toast('已引用 1 题');
  }

  /* ── 题库选择器（浮窗）：从当前学科挑题引用 ─────────── */

  async function openQuestionPicker() {
    setOverlay({ kind: 'qpicker', items: [], selected: {}, q: '', loading: true });
    renderOverlay();
    await loadPickerQuestions('');
  }

  async function loadPickerQuestions(kw) {
    var o = state.overlay;
    if (!o || o.kind !== 'qpicker') return;
    try {
      var params = ['limit=100'];
      if (kw) params.push('q=' + encodeURIComponent(kw));
      var subj = currentSubjectName();
      if (subj && subj !== '全部') params.push('subject=' + encodeURIComponent(subj));
      var r = await api('/questions?' + params.join('&'));
      o.items = r.items || [];
    } catch (e) {
      o.items = [];
      o.error = e.message;
    }
    o.loading = false;
    renderOverlay();
  }

  function pickerSearch() {
    var el = q('#qp-q');
    var kw = (el && el.value || '').trim();
    if (state.overlay && state.overlay.kind === 'qpicker') {
      state.overlay.q = kw;
      loadPickerQuestions(kw);
    }
  }

  function pickerToggle(id) {
    var o = state.overlay;
    if (!o || o.kind !== 'qpicker') return;
    o.selected[id] = !o.selected[id];
    renderOverlay();
  }

  function pickerApply() {
    var o = state.overlay;
    if (!o || o.kind !== 'qpicker') return;
    var n = 0;
    o.items.forEach(function (q) {
      if (!o.selected[q.id]) return;
      if (state.pendingQuestions.some(function (x) { return x.id === q.id; })) return;
      state.pendingQuestions.push({
        id: q.id,
        number: '',
        stem: q.stem_md || '',
        type: q.qtype || 'short',
        subject: q.subject || '',
        options: q.options || []
      });
      n++;
    });
    state.overlay = null;
    render();
    toast(n ? '已引用 ' + n + ' 题' : '没有选中题目');
  }

  function qpickerSheetHtml() {
    var o = state.overlay;
    if (!o || o.kind !== 'qpicker') return '';
    var items = o.items || [];
    var chosen = Object.keys(o.selected || {}).filter(function (k) { return o.selected[k]; }).length;
    var rows = items.map(function (q) {
      var on = !!o.selected[q.id];
      return '<button type="button" class="pickq' + (on ? ' on' : '') + '" data-act="picker-toggle" data-id="' + esc(q.id) + '">' +
        '<span class="chkbox">' + (on ? ic('check', 'sm') : '') + '</span>' +
        '<span class="pickb">' +
          '<span class="pickstem">' + stemHtml((q.stem_md || '').slice(0, 90)) + '</span>' +
          '<span class="pickmeta">' + esc(q.subject || '') + ' · ' +
            (q.qtype === 'choice' ? '选择题' : q.qtype === 'blank' ? '填空题' : '题目') + '</span>' +
        '</span></button>';
    }).join('');

    return '<div class="scrim" data-act="close-sheet"></div>' +
      '<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="qp-ttl" tabindex="-1">' +
      '<div class="grab"></div>' +
      '<div class="shd"><div class="ttl" id="qp-ttl">从题库选</div>' +
      '<button type="button" class="hit" data-act="close-sheet" aria-label="关闭">' + ic('x') + '</button></div>' +
      '<div class="sheet-body">' +
        '<div class="pickbar"><input type="search" id="qp-q" class="fi" placeholder="搜题干" value="' + esc(o.q || '') + '">' +
        '<button type="button" class="btn" data-act="picker-search">搜索</button></div>' +
        (o.loading ? '<div class="skel inmsg">' + skelRows(4) + '</div>' : '') +
        (rows || (o.loading ? '' : '<div class="empty"><div class="t">这个学科还没有题</div></div>')) +
      '</div>' +
      '<div class="sheet-foot"><div class="btnbar full">' +
        '<button type="button" class="btn" data-act="close-sheet">取消</button>' +
        '<button type="button" class="btn p" data-act="picker-apply"' + (chosen ? '' : ' disabled') + '>' +
        (chosen ? '引用（' + chosen + '）' : '引用') + '</button>' +
      '</div></div>' +
      '</div>';
  }

  var REVIEW_STAGES = {
    queued: '排队中',
    parsing: '识别文字',
    extracting: '整理题目',
    review: '待确认',
    done: '已入库',
    failed: '失败'
  };

  async function openReview(taskId) {
    // 立刻进复核页并显示处理进度（否则用户要对着空白等 20–30 秒）
    state.review = {
      task: { id: taskId, status: 'queued', page_no: 1, groups: {}, error: '' },
      groups: [],
      loading: true,
      startedAt: Date.now()
    };
    openPage({ kind: 'review', taskId: taskId });
    await pollTask(taskId);
  }

  async function pollTask(taskId) {
    var deadline = Date.now() + 180000;
    while (state.page && state.page.kind === 'review' && state.page.taskId === taskId) {
      var t;
      try {
        t = await api('/capture/tasks/' + encodeURIComponent(taskId));
      } catch (e) {
        if (state.review) state.review.error = e.message;
        break;
      }
      if (!state.review || state.review.task.id !== taskId) return;
      state.review.task = t;
      if (t.status === 'review' || t.status === 'done') {
        try {
          var full = await api('/capture/tasks/' + encodeURIComponent(taskId) + '?full=true');
          state.review.task = full;
          state.review.groups = JSON.parse(JSON.stringify((full.groups && full.groups.groups) || []));
          state.review.loading = false;
        } catch (e) {
          state.review.error = e.message;
        }
        render();
        return;
      }
      if (t.status === 'failed') {
        state.review.loading = false;
        render();
        return;
      }
      render();
      if (Date.now() > deadline) {
        state.review.error = '处理超过 3 分钟，可能卡住了';
        state.review.loading = false;
        render();
        return;
      }
      await new Promise(function (r) { setTimeout(r, 1200); });
    }
  }

  // 处理中每秒刷新一次「已用 N 秒」
  setInterval(function () {
    if (state.review && state.review.loading && state.page && state.page.kind === 'review') {
      var el = q('#rev-elapsed');
      if (el) el.textContent = Math.round((Date.now() - state.review.startedAt) / 1000) + ' 秒';
    }
  }, 1000);

  function flatQuestions(groups) {
    var out = [];
    (groups || []).forEach(function (g, gi) {
      (g.questions || []).forEach(function (q, qi) { out.push({ g: gi, q: qi, item: q }); });
    });
    return out;
  }

  function reviewPageHtml() {
    var r = state.review;
    if (!r) return navbar('采集校对', '', 'rail-chat', '返回', false) +
      '<div class="settings">' + pageErrorState('没有任务', '这一页不存在或已处理', 'rail-chat', 'rail-chat', '返回对话') + '</div>';
    var t = r.task;
    var waiting = r.loading || ['queued', 'parsing', 'extracting'].indexOf(t.status) >= 0;
    var nav = navbar('采集校对',
      waiting ? (REVIEW_STAGES[t.status] || '处理中') : ('第 ' + t.page_no + ' 页 · ' + flatQuestions(r.groups).length + ' 题'),
      'rail-chat', '返回', false);

    if (waiting) {
      var order = ['queued', 'parsing', 'extracting', 'review'];
      var curIdx = Math.max(0, order.indexOf(t.status));
      var chips = order.map(function (k, i) {
        var lab = k === 'review' ? '待确认' : REVIEW_STAGES[k];
        return '<span class="rst' + (i === curIdx ? ' on' : '') + (i < curIdx ? ' done' : '') + '">' + lab + '</span>';
      }).join('<span class="rarrow">›</span>');
      return nav + '<div class="revwait">' +
        '<div class="skel">' + skelRows(5) + '</div>' +
        '<div class="revstages">' + chips + '</div>' +
        '<div class="revstage"><span class="rsp">' + esc(REVIEW_STAGES[t.status] || '处理中') + '</span>' +
        '<span class="rsec num" id="rev-elapsed">' +
        Math.round((Date.now() - (r.startedAt || Date.now())) / 1000) + ' 秒</span></div>' +
        '<div class="revhint">识别一页一般 15–30 秒，可以先去做别的，回来还在</div>' +
        '</div>';
    }

    if (t.status === 'failed' || r.error) {
      return nav + '<div class="settings">' +
        pageErrorState('解析失败', r.error || t.error || '不知道原因', 'retry-capture', 'rail-chat', '返回对话') +
        '</div>';
    }

    var boxes = flatQuestions(r.groups).map(function (f, i) {
      var b = f.item.bbox || [];
      if (b.length < 4) return '';
      return '<span class="rbox" data-n="' + (i + 1) + '" style="left:' + (b[0] / 10) + '%;top:' + (b[1] / 10) +
        '%;width:' + ((b[2] - b[0]) / 10) + '%;height:' + ((b[3] - b[1]) / 10) + '%"></span>';
    }).join('');

    var cards = flatQuestions(r.groups).map(function (f, i) {
      var q = f.item;
      return '<div class="rcard" data-gi="' + f.g + '" data-qi="' + f.q + '">' +
        '<div class="rchead"><span class="rn">' + esc(q.number || String(i + 1)) + '</span>' +
        '<span class="rt">' + esc(q.type || 'short') + '</span>' +
        '<span class="sp"></span>' +
        '<button type="button" class="iconbtn" data-act="rev-del" data-gi="' + f.g + '" data-qi="' + f.q + '" aria-label="删除">' + ic('x', 'sm') + '</button></div>' +
        '<textarea class="fi rta revstem" rows="2" data-gi="' + f.g + '" data-qi="' + f.q + '">' + escText(q.stem || '') + '</textarea>' +
        ((q.options || []).length
          ? '<textarea class="fi rta revopts" rows="' + Math.max(2, q.options.length) + '" data-gi="' + f.g + '" data-qi="' + f.q + '">' +
            escText((q.options || []).join('\n')) + '</textarea>'
          : '') +
        '</div>';
    }).join('');

    var warn = ((t.groups && t.groups.warnings) || []).slice(0, 3).map(function (w) {
      return '<div class="rwarn">' + esc(w) + '</div>';
    }).join('');

    var queue = state.captureQueue.length;
    return nav +
      '<div class="rev">' +
        '<div class="revimg"><div class="revcanvas"><img alt="原页" src="/api/v1/capture/page/' +
          esc(t.id) + '">' + boxes + '</div></div>' +
        '<div class="revside">' +
          (warn ? '<div class="rwarns">' + warn + '</div>' : '') +
          '<div class="revlist">' + (cards || '<div class="empty"><div class="t">没有题目</div></div>') + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="revfoot"><div class="btnbar full">' +
        '<button type="button" class="btn" data-act="rail-chat">取消</button>' +
        (t.status === 'done'
          ? '<button type="button" class="btn" disabled>已入库</button>'
          : '<button type="button" class="btn p" data-act="confirm-capture">' +
            (queue > 1 ? '确认并下一张' : '确认入库') + '</button>') +
      '</div></div>';
  }

  async function confirmCapture() {
    var r = state.review;
    if (!r) return;
    var payload = { groups: r.groups };
    try {
      var res = await api('/capture/tasks/' + encodeURIComponent(r.task.id) + '/confirm', { method: 'POST', json: payload });
      toast('已入库 ' + res.created + ' 题');
    } catch (e) {
      toast('入库失败：' + e.message);
      return;
    }
    state.captureQueue = state.captureQueue.filter(function (id) { return id !== r.task.id; });
    state.review.loading = false;
    state.review = null;
    await loadCapturePending();
    if (state.captureQueue.length) await openReview(state.captureQueue[0]);
    else { openPage(null); await loadMessages(); render(); }
  }

  async function retryCapture() {
    var r = state.review;
    if (!r) return;
    try {
      await api('/capture/tasks/' + encodeURIComponent(r.task.id) + '/retry', { method: 'POST' });
      toast('重新解析中…');
      setTimeout(function () { openReview(r.task.id); }, 2500);
    } catch (e) {
      toast('重试失败：' + e.message);
    }
  }

  async function deleteReviewQuestion(gi, qi) {
    var r = state.review;
    if (!r) return;
    r.groups[gi].questions.splice(qi, 1);
    if (!r.groups[gi].questions.length) r.groups.splice(gi, 1);
    render();
  }

  function bindReviewInputs() {
    var host = q('#view-page');
    if (!host) return;
    host.addEventListener('input', function (e) {
      var el = e.target;
      if (!el.classList) return;
      var gi = Number(el.getAttribute('data-gi'));
      var qi = Number(el.getAttribute('data-qi'));
      var r = state.review;
      if (!r || !r.groups[gi] || !r.groups[gi].questions[qi]) return;
      var qq = r.groups[gi].questions[qi];
      if (el.classList.contains('revstem')) qq.stem = el.value;
      else if (el.classList.contains('revopts')) qq.options = el.value.split('\n').map(function (x) { return x.trim(); }).filter(Boolean);
    });
  }

  function renderSpaces() {
    var host = q('#spaces');
    if (!host) return;
    var su = state.subjects || { current: '全部', items: [] };
    var cur = su.current || '全部';
    var label = q('#top-subject');
    if (label) label.textContent = todayLabel(cur);
    var items = su.items && su.items.length ? su.items : [{ subject: cur, count: 0 }];
    host.innerHTML = '<div class="stitle">学习空间</div>' +
      items.map(function (it) {
        var on = it.subject === cur;
        return '<button type="button" class="space' + (on ? ' on' : '') + '" data-act="switch-subject" data-subject="' +
          esc(it.subject) + '"' + (on ? ' aria-current="true"' : '') + '>' +
          ic(SUBJECT_ICON[it.subject] || 'circle-dot', 'sm') +
          '<span class="n">' + esc(todayLabel(it.subject)) + '</span>' +
          (it.subject === '全部' ? '' : (it.count ? '<span class="c">' + numWrap(it.count) + '</span>' : '')) +
          '</button>';
      }).join('');
  }

  async function loadSubjects() {
    try {
      state.subjects = await api('/subjects');
      renderSpaces();
    renderQpanel();
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
    var wantSubject = '';
    if (location.hash.indexOf('#subject=') === 0) {
      wantSubject = decodeURIComponent(location.hash.slice(9));
    } else {
      try { wantSubject = localStorage.getItem('xm_subject') || ''; } catch (e) {}
    }
    if (wantSubject && wantSubject !== '全部') {
      try { await api('/subject', { method: 'PATCH', json: { subject: wantSubject } }); } catch (e) {}
    } else {
      await forceToday();
    }
    await Promise.all([loadProviders(), loadSettings(true), loadCatalog(), loadSubjects(), loadToday(), loadCapturePending(), loadConversations(), loadSkills()]);
    if (location.hash.indexOf('#c=') === 0) {
      await openConversation(decodeURIComponent(location.hash.slice(3)));
    } else {
      openConversations();
    }
    // 深链：#review=<taskId> 直接进复核页（也给验收截图用）
    if (location.hash.indexOf('#review=') === 0) {
      await loadMessages();
      await openReview(decodeURIComponent(location.hash.slice(8)));
      return;
    }
    if (location.hash === '#library') { openLibrary(); return; }
    if (location.hash === '#library') { openLibrary(); return; }
    if (location.hash === '#bank') { openBank(); return; }
    if (location.hash === '#map') { openMap(); return; }
    if (location.hash === '#bankcap') {
      await loadMessages();
      openBank();
      openCapture('bank');
      render();
      return;
    }
    if (location.hash === '#pick') { await loadMessages(); await openQuestionPicker(); return; }
    if (location.hash.indexOf('#qpanel=') === 0) { await loadMessages(); await openQuestionPanel(decodeURIComponent(location.hash.slice(8))); return; }
    if (location.hash.indexOf('#question=') === 0) {
      await loadMessages();
      await openQuestionDetail(decodeURIComponent(location.hash.slice(10)));
      return;
    }
    if (location.hash.indexOf('#capture') === 0) {
      await loadMessages();
      openCapture();
      var tid = location.hash.indexOf('#capture=') === 0 ? decodeURIComponent(location.hash.slice(8)) : '';
      if (tid) {
        try {
          var ct = await api('/capture/tasks/' + encodeURIComponent(tid) + '?full=true');
          state.overlay.task = ct;
          state.overlay.taskId = tid;
          state.overlay.groups = (ct.groups && ct.groups.groups) || [];
          state.overlay.selected = {};
          flatQuestions(state.overlay.groups).forEach(function (f, i) { state.overlay.selected[i] = true; });
          state.overlay.preview = '/api/v1/capture/page/' + tid;
          state.overlay.step = 'select';
        } catch (e) { /* 保持 pick */ }
      }
      render();
      return;
    }
    render();
    if (state.settings && state.settings.provider_id != null) {
      await loadModelsFor(state.settings.provider_id);
    }
    await loadMessages();
    render();
  }

  /* ── 渲染：外壳 / 顶栏 / 胶囊 / 思考 ───────────────── */
  function render() {
    renderSkillPill();
    renderSkillChips();
    renderSpaces();
    renderConvSide();
    renderQchips();
    renderQpanel();
    var sp = q('#spaces');
    if (sp) sp.hidden = state.view !== 'chat';
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
    var brand = q('#top-brand');
    var sub = q('#top-subject');
    var back = q('#top-back');
    var inChat = state.view === 'chat' && !!state.convId;
    if (back) back.hidden = true;
    document.body.classList.toggle('noconv', !inChat);
    var pill = q('#top-subj');
    if (brand) {
      brand.classList.toggle('chat', inChat);
      if (inChat) {
        brand.textContent = state.convTitle || '新对话';
        brand.title = state.convTitle || '';
      } else {
        brand.textContent = agentName();
      }
    }
    if (pill) pill.hidden = !inChat;
    if (sub) sub.textContent = inChat ? (state.convSubject || '全部') : '对话';
    var ticon = q('#top-subj-icon');
    if (ticon) {
      var iconName = (typeof SUBJECT_ICON !== 'undefined' && SUBJECT_ICON[state.convSubject]) || 'circle-dot';
      var msName = iconName === 'sun' ? 'apps' : msIcon(iconName);
      if (ticon.tagName === 'SPAN') ticon.textContent = msName;
      else {
        var tuse = ticon.querySelector('use');
        if (tuse) tuse.setAttribute('href', '#i-' + iconName);
      }
    }
  }

  // rail 只有「对话 / 设置」两格可点（其余仍是占位），按所在空间换 on
  function renderRail() {
    var chat = q('#rail-chat');
    var set = q('#rail-settings');
    var mem = q('#rail-memories');
    var kind = state.view === 'page' && state.page ? state.page.kind : '';
    var onBank = kind === 'bank' || kind === 'question';
    var onLib = kind === 'library';
    var onWeek = kind === 'week';
    var wk = q('#rail-week');
    if (wk) { wk.classList.toggle('on', onWeek); if (onWeek) wk.setAttribute('aria-current', 'page'); else wk.removeAttribute('aria-current'); }
    var onConvs = kind === 'convs';
    var onSettings = kind === 'settings';
    var onMem = kind === 'memories';
    var onMap = kind === 'map';
    var map = q('#rail-map');
    if (map) {
      map.classList.toggle('on', onMap);
      if (onMap) map.setAttribute('aria-current', 'page');
      else map.removeAttribute('aria-current');
    }
    var lib = q('#rail-library');
    if (lib) {
      lib.classList.toggle('on', onLib);
      if (onLib) lib.setAttribute('aria-current', 'page');
      else lib.removeAttribute('aria-current');
    }
    var bank = q('#rail-bank');
    if (bank) {
      bank.classList.toggle('on', onBank);
      if (onBank) bank.setAttribute('aria-current', 'page');
      else bank.removeAttribute('aria-current');
    }
    if (chat) {
      var chatOn = !onSettings && !onMem && !onBank && !onWeek && !onMap && !onLib;
      chat.classList.toggle('on', chatOn);
      if (chatOn) chat.setAttribute('aria-current', 'page');
      else chat.removeAttribute('aria-current');
    }
    if (set) {
      set.classList.toggle('on', onSettings);
      if (onSettings) set.setAttribute('aria-current', 'page');
      else set.removeAttribute('aria-current');
      if (mem) {
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
    var has = !!(ta && ta.value.trim()) || state.pending.length > 0 || state.pendingQuestions.length > 0;
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


  function heroSubjectName() {
    var list = ['全部'].concat(typeof SUBJECTS !== 'undefined' ? SUBJECTS : []);
    var s = state.heroSubject || (state.subjects && state.subjects.current) || '全部';
    if (list.indexOf(s) < 0) s = '全部';
    return s;
  }

  function heroHtml() {
    var subj = heroSubjectName();
    var icon = subj === '全部' ? 'apps' : ((typeof SUBJECT_ICON !== 'undefined' && SUBJECT_ICON[subj]) || 'circle-dot');
    var sug = [
      { icon: 'book-open-text', text: (subj === '全部' ? '讲讲' : '讲讲' + subj + '里') + '最常考的一个知识点' },
      { icon: 'clock', text: (subj === '全部' ? '这周' : subj + '这周') + '没弄懂的知识点，帮我梳理一下' },
      { icon: 'circle-dot', text: '考考我' + (subj === '全部' ? '' : '「' + subj + '」') + '，看看哪里没掌握' }
    ];
    return '<div class="hero">' +
      '<div class="hero-brand"><img src="logo.svg" alt=""><span>' + esc(agentName()) + ' · 学习空间</span></div>' +
      '<h1 class="hero-title">在 <button type="button" class="hero-subj" data-act="open-hero-subjects" aria-haspopup="dialog">' +
        '<span class="hsi">' + ic(icon) + '</span>' +
        '<span class="hs">' + esc(subj) + '</span>' +
        '<span class="hsp">学科空间</span>' +
        ic('chevron-down', 'sm hv') +
      '</button> 开始对话</h1>' +
      '<div class="hero-sugs">' + sug.map(function (x) {
        return '<button type="button" class="hero-sug" data-act="hero-send" data-text="' + esc(x.text) + '">' +
          ic(x.icon, 'sm') + '<span>' + esc(x.text) + '</span></button>';
      }).join('') + '</div>' +
      '</div>';
  }

  function openHeroSubjects() {
    setOverlay({ kind: 'herosub' });
  }

  function heroSubjectsSheetHtml() {
    var cur = heroSubjectName();
    var list = ['全部'].concat(typeof SUBJECTS !== 'undefined' ? SUBJECTS : []);
    var rows = list.map(function (s) {
      var on = s === cur;
      return '<button type="button" class="caprow' + (on ? ' on' : '') + '" data-act="hero-subject" data-subject="' + esc(s) + '">' +
        ic((typeof SUBJECT_ICON !== 'undefined' && SUBJECT_ICON[s]) || 'circle-dot', 'sm') +
        '<span>' + esc(s) + '</span><span class="sp"></span>' +
        (on ? '<span class="capchk">' + ic('check', 'sm') + '</span>' : '') + '</button>';
    }).join('');
    return '<div class="scrim" data-act="close-sheet"></div>' +
      '<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="hs-ttl" tabindex="-1">' +
      '<div class="grab"></div>' +
      '<div class="shd"><div class="ttl" id="hs-ttl">切换学科空间</div>' +
      '<button type="button" class="hit" data-act="close-sheet" aria-label="关闭">' + ic('x') + '</button></div>' +
      '<div class="sheet-body"><div class="capmenu">' + rows + '</div></div></div>';
  }

  function pickHeroSubject(name) {
    state.heroSubject = name || '全部';
    state.convSubject = state.heroSubject;
    state.overlay = null;
    render();
  }

  async function heroSend(text) {
    if (state.sending) return;
    var subj = heroSubjectName();
    state.heroSubject = subj;
    state.convSubject = subj;
    var ta = q('#ta');
    if (!ta) return;
    ta.value = text;
    autosize();
    syncSend();
    await submitMessage();
  }

  function renderStream(force) {
    var el = q('#stream');
    if (!state.convId) {
      document.body.classList.remove('today');
      document.body.classList.add('is-hero');
      el.innerHTML = '<div class="col">' + heroHtml() + '</div>';
      el.setAttribute('aria-busy', 'false');
      return;
    }
    document.body.classList.remove('is-hero');
    if (isToday()) {
      document.body.classList.add('today');
      el.innerHTML = todayHtml();
      el.setAttribute('aria-busy', 'false');
      return;
    }
    document.body.classList.remove('today');
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

  /* ── 检测卡 / 沉淀条 / 主动消息 ─────────────────── */

  function quizCardHtml(q) {
    if (!q || !q.id) return '';
    var answered = q.status === 'answered';
    var rm = /[A-F]/.exec(String(q.answer || '').toUpperCase());
    var rightLetter = rm ? rm[0] : '';
    var cm = /[A-F]/.exec(String(q.chosen || '').toUpperCase());
    var chosenLetter = cm ? cm[0] : '';
    var opts = (q.options || []).map(function (o, i) {
      var letter = String.fromCharCode(65 + i);
      var cls = '';
      if (answered) {
        if (letter === rightLetter) cls = ' right';
        else if (letter === chosenLetter) cls = ' wrong';
      }
      var text = String(o).replace(/^[A-F][.、．]\s*/, '');
      return '<button type="button" class="quizopt' + cls + '" data-act="quiz-pick" data-id="' + esc(q.id) +
        '" data-choice="' + letter + '"' + (answered ? ' disabled' : '') + '>' +
        '<span class="k">' + letter + '</span><span class="t">' + stemHtml(text) + '</span></button>';
    }).join('');
    var res = '';
    if (answered) {
      res = '<div class="quizres ' + (q.correct ? 'ok' : 'bad') + '">' +
        (q.correct ? '答对了' : '答错了，正确答案是 ' + esc(rightLetter || q.answer)) + '</div>' +
        (q.explanation ? '<div class="quizexp">' + stemHtml(q.explanation) + '</div>' : '') +
        '<div class="quizfoot"><button type="button" class="quizask" data-act="quiz-ask" data-id="' + esc(q.id) + '">让她讲</button></div>';
    }
    return '<div class="quizcard" data-quiz="' + esc(q.id) + '">' +
      '<div class="quizhd"><span class="tag">检测</span>' +
      ((q.kp_names || []).length ? '<span class="quizkp">' + esc(q.kp_names[0]) + '</span>' : '') +
      '</div>' +
      '<div class="quizstem">' + stemHtml(q.stem_md || '') + '</div>' +
      (opts ? '<div class="quizopts">' + opts + '</div>'
        : '<div class="quizhint">开放题：写在纸上，再让我看</div>') +
      res +
      '</div>';
  }

  function quizPartsHtml(m) {
    return (m.parts || []).filter(function (p) { return p && p.type === 'quiz' && p.quiz; })
      .map(function (p) { return quizCardHtml(p.quiz); }).join('');
  }

  function findQuizPart(id) {
    for (var i = 0; i < state.messages.length; i++) {
      var parts = state.messages[i].parts || [];
      for (var j = 0; j < parts.length; j++) {
        if (parts[j] && parts[j].type === 'quiz' && parts[j].quiz && parts[j].quiz.id === id) return parts[j];
      }
    }
    return null;
  }

  async function answerQuiz(id, choice) {
    try {
      var res = await api('/quizzes/' + encodeURIComponent(id) + '/answer', { method: 'POST', json: { chosen: choice } });
      var part = findQuizPart(id);
      if (part) part.quiz = res.quiz;
      renderStream(true);
      scrollToBottom(false);
    } catch (e) {
      toast('提交失败：' + e.message);
    }
  }

  function quizAsk(id) {
    var part = findQuizPart(id);
    var qz = part && part.quiz;
    if (!qz) return;
    var ta = q('#ta');
    if (!ta) return;
    var kp = (qz.kp_names || [])[0] || '这道题';
    ta.value = '「' + kp + '」我还是没太懂，换个讲法。';
    autosize();
    syncSend();
    ta.focus();
  }

  function nudgeHtml(m) {
    var p = (m.parts || []).filter(function (x) { return x && x.type === 'nudge'; })[0];
    if (!p) return '';
    var acts = (p.actions || []).map(function (a) {
      return '<button type="button" class="btn" data-act="nudge-act" data-kind="' + esc(a.act || '') +
        '" data-kp="' + esc(a.kp || '') + '">' + esc(a.label || '') + '</button>';
    }).join('');
    return '<div class="agbody nudgebody">' + renderMarkdown(m.content_md || '') + '</div>' +
      (acts ? '<div class="nudgeacts">' + acts + '</div>' : '');
  }

  async function nudgeAct(el) {
    var kind = el.getAttribute('data-kind');
    if (kind === 'bank-due') {
      bankPatch({ status: 'due', subject: '', grade: '', difficulty: 0, kp: '', kpName: '', q: '' });
      openBank();
      return;
    }
    if (kind === 'nudge-quiz') {
      var kp = el.getAttribute('data-kp') || '';
      try {
        var res = await api('/quizzes/auto', {
          method: 'POST',
          json: { conversation_id: state.convId || '', kp_id: kp, due: !kp }
        });
        if (res.conversation_id && res.conversation_id !== state.convId) {
          await openConversation(res.conversation_id);
        } else {
          await loadMessages();
          render();
        }
        toast('出了一道');
        setTimeout(function () { scrollToBottom(true); }, 120);
      } catch (e) {
        toast('出题失败：' + e.message);
      }
    }
  }

  function depositBarHtml(m) {
    var list = m.deposits || [];
    if (!list.length) return '';
    var active = list.filter(function (d) { return d.status === 'active'; });
    if (!active.length) return '<div class="depbar done">已撤销</div>';
    var d = active[active.length - 1];
    var bits = [];
    if (d.questions) bits.push('错题 ' + d.questions);
    if ((d.kps || []).length) bits.push('知识点 ' + d.kps.length);
    return '<div class="depbar">' + ic('book-open-text', 'sm') +
      '<span>已记：' + esc(bits.join(' · ')) + '</span><span class="sp"></span>' +
      '<button type="button" data-act="dep-undo" data-id="' + esc(d.id) + '" data-key="' + esc(m._key) + '">撤销</button>' +
      '</div>';
  }

  async function undoDeposit(id, key) {
    try {
      var res = await api('/deposits/' + encodeURIComponent(id) + '/undo', { method: 'POST' });
      var m = findMessageByKey(key);
      if (m) m.deposits = res.deposits || [];
      renderStream(true);
    } catch (e) {
      toast('撤销失败：' + e.message);
    }
  }

  function pollDeposit(messageId) {
    clearTimeout(state.depositTimer);
    var tries = 0;
    var tick = async function () {
      tries += 1;
      if (!state.convId) return;
      try {
        var r = await api('/messages?conversation_id=' + encodeURIComponent(state.convId) + '&limit=60');
        var found = (r.items || []).filter(function (x) { return x.id === messageId; })[0];
        var local = null;
        for (var i = 0; i < state.messages.length; i++) if (state.messages[i].id === messageId) local = state.messages[i];
        if (found && local && (found.deposits || []).length &&
          JSON.stringify(found.deposits) !== JSON.stringify(local.deposits || [])) {
          local.deposits = found.deposits;
          local.parts = found.parts || local.parts;
          renderStream(true);
          scrollToBottom(false);
          return;
        }
      } catch (e) { /* 下一轮再试 */ }
      if (tries < 3) state.depositTimer = setTimeout(tick, 5000);
    };
    state.depositTimer = setTimeout(tick, 4500);
  }

  async function checkNudge() {
    try {
      var r = await api('/nudges/check', { method: 'POST' });
      if (!r || !r.created) return;
      await loadConversations();
      if (state.convId && state.convId === r.conversation_id) {
        await loadMessages();
        render();
      } else {
        toast(agentName() + '给你留了句话');
      }
    } catch (e) { /* 主动消息失败不打扰 */ }
  }


  /* ── 技能：讲解网页 / PDF / 错题报告 ───────────────── */

  var ART_KINDS = {
    html: ['讲解网页', 'globe'],
    pdf: ['PDF', 'book-open-text'],
    png: ['知识卡片', 'image'],
    flashcards: ['记忆闪卡', 'book']
  };
  function artKindMeta(k) { return ART_KINDS[k] || ['资料', 'book']; }

  var TOOL_META = {
    memory_search: ['检索记忆', 'database'], memory_add: ['记住', 'database'],
    memory_update: ['修正记忆', 'database'], memory_delete: ['忘掉', 'database'],
    web_search: ['联网搜索', 'search'],
    question_search: ['查题库', 'book-open-text'],
    question_add: ['收进题库', 'book-open-text'],
    question_update: ['改题库', 'book-open-text'],
    quiz_create: ['出题检测', 'circle-dot'],
    make_webpage: ['生成讲解网页', 'globe'],
    make_pdf: ['生成 PDF', 'book-open-text'],
    file_list: ['看工作区', 'book-open-text'],
    file_read: ['读文件', 'book-open-text'],
    file_write: ['写文件', 'book'],
    file_edit: ['改文件', 'book'],
    publish: ['发布文件', 'globe'],
    make_card: ['生成知识卡片', 'image'],
    make_flashcards: ['生成记忆闪卡', 'book']
  };
  function toolMeta(name) { return TOOL_META[name] || [name, 'search']; }

  function skillById(id) {
    if (!id || !state.skills) return null;
    for (var i = 0; i < state.skills.length; i++) if (state.skills[i].id === id) return state.skills[i];
    return null;
  }

  async function loadSkills() {
    try {
      var r = await api('/skills');
      state.skills = r.items || [];
    } catch (e) {
      state.skills = [];
    }
    renderSkillPill();
    renderSkillChips();
  }

  function renderSkillPill() {
    var el = q('#skill-pill');
    var lab = q('#pill-skill');
    if (!el || !lab) return;
    var s = skillById(state.skill);
    lab.textContent = s ? s.name : '技能';
    el.classList.toggle('on', !!s);
    el.setAttribute('aria-label', s ? '技能：' + s.name : '选择技能');
  }

  function renderSkillChips() {
    var host = q('#skillchips');
    if (!host) return;
    var s = skillById(state.skill);
    var edit = state.editArtifact;
    if (!s && !edit) {
      host.hidden = true;
      host.innerHTML = '';
      return;
    }
    host.hidden = false;
    var html = '';
    if (edit) {
      html += '<span class="editchip">' + ic('book', 'sm') +
        '<span>基于：' + esc(edit.title || '资料') + '</span>' +
        '<button type="button" data-act="clear-edit" aria-label="取消基于资料">' + ic('x', 'sm') + '</button></span>';
    }
    if (s) {
      html += '<span class="skillchip">' + ic(s.icon || 'sparkles', 'sm') +
        '<span class="scn">' + esc(s.name) + '</span>' +
        '<button type="button" class="scx" data-act="clear-skill" aria-label="移除技能">' + ic('x', 'sm') + '</button></span>';
    }
    host.innerHTML = html;
  }

  function openSkillSheet() {
    setOverlay({ kind: 'skills' });
  }

  function skillSheetHtml() {
    var list = state.skills;
    var rows = '';
    if (list === null) {
      rows = '<div class="skel inmsg">' + skelRows(3) + '</div>';
    } else if (!list.length) {
      rows = '<div class="empty"><div class="t">没有可用的技能</div><div class="d">看看 agent/skills.json</div></div>';
    } else {
      rows = list.map(function (s) {
        var on = state.skill === s.id;
        return '<button type="button" class="skillrow' + (on ? ' on' : '') + '" data-act="pick-skill" data-id="' + esc(s.id) + '">' +
          '<span class="sic">' + ic(s.icon || 'sparkles') + '</span>' +
          '<span class="smain"><span class="sname">' + esc(s.name) + '</span>' +
          '<span class="sdesc">' + esc(s.desc || '') + '</span>' +
          ((s.tools || []).length ? '<span class="stools">工具：' + esc((s.tools || []).map(function (t) { return toolMeta(t)[0]; }).join(' · ')) + '</span>' : '') +
          '</span>' +
          (on ? '<span class="capchk">' + ic('check', 'sm') + '</span>' : '') +
          '</button>';
      }).join('') +
        '<button type="button" class="skillrow none" data-act="pick-skill" data-id=""><span class="smain"><span class="sname">不用技能</span></span>' +
        (state.skill ? '' : '<span class="capchk">' + ic('check', 'sm') + '</span>') + '</button>';
    }
    return '<div class="scrim" data-act="close-sheet"></div>' +
      '<div class="sheet skill-sheet" role="dialog" aria-modal="true" aria-labelledby="sk-ttl" tabindex="-1">' +
      '<div class="grab"></div>' +
      '<div class="shd"><div class="ttl" id="sk-ttl">技能</div>' +
      '<button type="button" class="hit" data-act="close-sheet" aria-label="关闭">' + ic('x') + '</button></div>' +
      '<div class="sheet-body"><div class="skilllist">' + rows + '</div></div>' +
      '</div>';
  }

  function pickSkill(id) {
    state.skill = id || '';
    closeOverlay();
    renderSkillPill();
    renderSkillChips();
  }

  function clearSkill() {
    state.skill = '';
    renderSkillPill();
    renderSkillChips();
  }

  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
  }

  function artifactPartsHtml(m) {
    return (m.parts || []).filter(function (p) { return p && p.type === 'artifact' && p.artifact; })
      .map(function (p) {
        var a = p.artifact;
        var km = artKindMeta(a.kind);
        var dl = a.url + (a.url.indexOf('?') >= 0 ? '&' : '?') + 'download=1';
        var thumb = a.kind === 'png'
          ? '<img class="athumb" src="' + esc(a.url) + '" alt="">'
          : '<span class="aic">' + ic(km[1]) + '</span>';
        return '<div class="artifactcard">' + thumb +
          '<span class="amain"><span class="atitle">' + esc(a.title || '产物') + '</span>' +
          '<span class="ameta">' + esc(km[0]) + ' · ' + esc(fmtBytes(a.bytes)) + '</span></span>' +
          '<button type="button" class="abtn" data-act="artifact-open" data-id="' + esc(a.id) + '">预览</button>' +
          '<a class="abtn ghost" href="' + esc(dl) + '">下载</a>' +
          '</div>';
      }).join('');
  }

  function skillUsedHtml(m) {
    var s = m.skill ? skillById(m.skill) : null;
    if (!s) return '';
    return '<div class="skillused">' + ic(s.icon || 'sparkles', 'sm') +
      '<span>技能 · ' + esc(s.name) + '</span></div>';
  }


  /* ── 资料库 ───────────────────────────────────────── */

  function libState() {
    return state.lib || { items: [], total: 0, kind: '', q: '', error: '' };
  }

  function openLibrary() {
    openPage({ kind: 'library' });
    loadLibrary();
  }

  async function loadLibrary() {
    var b = libState();
    try {
      var url = '/artifacts?limit=120' +
        (b.kind ? '&kind=' + encodeURIComponent(b.kind) : '') +
        (b.q ? '&q=' + encodeURIComponent(b.q) : '');
      var r = await api(url);
      state.lib = { items: r.items || [], total: r.total || 0, kind: b.kind, q: b.q, error: '' };
    } catch (e) {
      state.lib = { items: [], total: 0, kind: b.kind, q: b.q, error: e.message };
    }
    render();
  }

  function libKind(kind) {
    var b = libState();
    state.lib = { items: [], total: 0, kind: kind || '', q: b.q || '', error: '' };
    loadLibrary();
  }

  function libSearch() {
    var el = q('#lib-q');
    var b = libState();
    state.lib = { items: [], total: 0, kind: b.kind || '', q: (el && el.value || '').trim(), error: '' };
    loadLibrary();
  }

  function libCardHtml(a) {
    var k = artKindMeta(a.kind);
    var meta = [k[0]];
    if (a.subject) meta.push(a.subject);
    meta.push(bankGroupDate(a.created_at) || '');
    meta.push(fmtBytes(a.bytes));
    var thumb = a.kind === 'png'
      ? '<img class="lthumb" src="' + esc(a.url) + '" alt="">'
      : '<span class="lik">' + ic(k[1]) + '</span>';
    return '<div class="libcard" role="button" tabindex="0" data-act="artifact-open" data-id="' + esc(a.id) + '">' +
      thumb +
      '<span class="lmain"><span class="lt">' + esc(a.title || '资料') +
      (a.parent_id ? '<span class="ltag">改</span>' : '') + '</span>' +
      '<span class="lm">' + esc(meta.filter(Boolean).join(' · ')) + '</span></span>' +
      '<span class="lgo">预览' + ic('chevron-right', 'sm') + '</span>' +
      '<button type="button" class="libmore" data-act="artifact-menu" data-id="' + esc(a.id) + '" aria-label="更多操作">' +
      ic('more-horizontal', 'sm') + '</button></div>';
  }

  function libraryPageHtml() {
    var b = libState();
    var nav = navbar('资料', (b.total || 0) + ' 份', '', '', false);
    if (b.error) {
      return nav + '<div class="settings">' +
        pageErrorState('加载失败', b.error, 'library-reload', 'rail-chat', '返回对话') + '</div>';
    }
    var kinds = [['', '全部'], ['html', '网页'], ['pdf', 'PDF'], ['png', '卡片'], ['flashcards', '闪卡']];
    var chips = kinds.map(function (x) {
      var on = (b.kind || '') === x[0];
      return '<span class="fchip' + (on ? ' on' : '') + '" role="button" tabindex="0" data-act="library-kind" data-kind="' + esc(x[0]) + '">' +
        x[1] + '</span>';
    }).join('');

    var items = b.items || [];
    var groups = [];
    var byDay = {};
    items.forEach(function (a) {
      var d = bankGroupDate(a.created_at) || '更早';
      if (!byDay[d]) { byDay[d] = []; groups.push(d); }
      byDay[d].push(a);
    });
    var list = groups.map(function (d) {
      return '<div class="dhead">' + esc(d) + '</div>' +
        '<div class="libgrid">' + byDay[d].map(libCardHtml).join('') + '</div>';
    }).join('');
    if (!list) {
      list = '<div class="empty"><div class="t">' + (b.q ? '没有匹配的资料' : '还没有资料') + '</div>' +
        '<div class="d">' + (b.q ? '换个关键词，或者换个类型' : '在对话里选一个技能，让她做一份网页、PDF 或卡片') + '</div>' +
        '<div class="btnbar"><button type="button" class="btn p" data-act="rail-chat">去对话</button></div></div>';
    }
    return nav +
      '<div class="libsearch">' +
        '<input id="lib-q" class="fi" type="search" placeholder="搜标题、正文、知识点" value="' + esc(b.q || '') + '">' +
        '<button type="button" class="btn" data-act="lib-search">搜索</button>' +
      '</div>' +
      '<div class="bankchips libchips">' + chips + '</div>' +
      '<div class="settings bankwrap">' + list + '</div>';
  }

  /* ── 右侧资料预览 ─────────────────────────────────── */

  function findArtifact(id) {
    var items = (state.lib && state.lib.items) || [];
    for (var i = 0; i < items.length; i++) if (items[i].id === id) return items[i];
    for (var j = 0; j < state.messages.length; j++) {
      var parts = state.messages[j].parts || [];
      for (var k = 0; k < parts.length; k++) {
        if (parts[k] && parts[k].type === 'artifact' && parts[k].artifact && parts[k].artifact.id === id) {
          return parts[k].artifact;
        }
      }
    }
    return null;
  }

  function openArtifactPreview(a) {
    if (!a) return;
    state.preview = a;
    renderPreview();
  }

  async function openArtifactById(id) {
    var a = findArtifact(id);
    if (!a) {
      try {
        var r = await api('/artifacts?limit=200');
        state.lib = { items: r.items || [], total: r.total || 0, kind: libState().kind, error: '' };
        a = findArtifact(id);
      } catch (e) { /* 下面统一提示 */ }
    }
    if (!a) { toast('找不到这份资料'); return; }
    openArtifactPreview(a);
  }

  function closePreview() {
    state.preview = null;
    renderPreview();
  }

  function artifactDl(a) {
    return a.url + (a.url.indexOf('?') >= 0 ? '&' : '?') + 'download=1';
  }

  function openArtifactMenu(id) {
    var a = findArtifact(id);
    if (!a) { toast('找不到这份资料'); return; }
    setOverlay({ kind: 'artmenu', id: a.id, title: a.title || '资料' });
  }

  function artMenuSheetHtml() {
    var o = state.overlay;
    if (!o || o.kind !== 'artmenu') return '';
    var a = findArtifact(o.id);
    var dl = a ? artifactDl(a) : '';
    return '<div class="scrim" data-act="close-sheet"></div>' +
      '<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="am-ttl" tabindex="-1">' +
      '<div class="grab"></div>' +
      '<div class="shd"><div class="ttl" id="am-ttl">' + esc(o.title || '资料') + '</div>' +
      '<button type="button" class="hit" data-act="close-sheet" aria-label="关闭">' + ic('x') + '</button></div>' +
      '<div class="sheet-body"><div class="artlist">' +
        '<button type="button" class="caprow" data-act="artifact-rename-open" data-id="' + esc(o.id) + '">' +
          '<span class="rowmain">' + ic('settings', 'sm') + '重命名</span></button>' +
        (dl ? '<a class="caprow" href="' + esc(dl) + '"><span class="rowmain">' + ic('book-open-text', 'sm') + '下载</span></a>' : '') +
        '<button type="button" class="caprow" data-act="artifact-delete" data-id="' + esc(o.id) + '">' +
          '<span class="rowmain danger">' + ic('x', 'sm') + '删除</span></button>' +
      '</div></div></div>';
  }

  function artifactRenameSheetHtml() {
    var o = state.overlay;
    if (!o || o.kind !== 'artrename') return '';
    return '<div class="scrim" data-act="close-sheet"></div>' +
      '<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="ar-ttl" tabindex="-1">' +
      '<div class="grab"></div>' +
      '<div class="shd"><div class="ttl" id="ar-ttl">重命名</div>' +
      '<button type="button" class="hit" data-act="close-sheet" aria-label="关闭">' + ic('x') + '</button></div>' +
      '<div class="sheet-body"><div class="slabel">标题</div>' +
      '<input class="fi" id="art-title" maxlength="120" value="' + esc(o.value || '') + '">' +
      '</div><div class="sheet-foot"><div class="btnbar full">' +
      '<button type="button" class="btn" data-act="close-sheet">取消</button>' +
      '<button type="button" class="btn p" data-act="artifact-rename-save" data-id="' + esc(o.id) + '">保存</button>' +
      '</div></div></div>';
  }

  function openArtifactRename(id) {
    var a = findArtifact(id);
    if (!a) return;
    setOverlay({ kind: 'artrename', id: a.id, value: a.title || '' });
  }

  async function renameArtifact() {
    var o = state.overlay;
    if (!o || o.kind !== 'artrename') return;
    var title = ((q('#art-title') || {}).value || '').trim();
    if (!title) { toast('标题不能为空'); return; }
    try {
      var r = await api('/artifacts/' + encodeURIComponent(o.id), { method: 'PATCH', json: { title: title } });
      if (state.preview && state.preview.id === o.id) state.preview = r;
      closeOverlay();
      await loadLibrary();
      renderPreview();
      toast('已改名');
    } catch (e) {
      toast('改名失败：' + e.message);
    }
  }

  async function deleteArtifact(id) {
    var a = findArtifact(id);
    if (!a) return;
    if (!window.confirm('删除「' + (a.title || '这份资料') + '」？文件会一起删掉。')) return;
    try {
      await api('/artifacts/' + encodeURIComponent(id), { method: 'DELETE' });
      if (state.preview && state.preview.id === id) { state.preview = null; renderPreview(); }
      closeOverlay();
      await loadLibrary();
      toast('已删除');
    } catch (e) {
      toast('删除失败：' + e.message);
    }
  }

  async function continueArtifact(id) {
    var a = findArtifact(id);
    if (!a) return;
    state.editArtifact = a;
    if (a.skill) state.skill = a.skill;
    else if (a.kind === 'png') state.skill = 'card';
    else if (a.kind === 'flashcards') state.skill = 'flashcards';
    else if (a.kind === 'pdf') state.skill = 'pdf';
    else state.skill = 'webpage';
    closeOverlay();
    closePreview();
    if (a.conversation_id) await openConversation(a.conversation_id);
    else openPage(null);
    renderSkillPill();
    renderSkillChips();
    var ta = q('#ta');
    if (ta) { autosize(); syncSend(); ta.focus(); }
    toast('说你想怎么改');
  }

  function clearEditContext() {
    state.editArtifact = null;
    renderSkillChips();
  }

  function renderPreview() {
    var host = q('#previewpane');
    if (!host) return;
    var a = state.preview;
    if (!a) {
      host.hidden = true;
      host.innerHTML = '';
      document.body.classList.remove('preview-open');
      return;
    }
    var k = artKindMeta(a.kind);
    var dl = a.url + (a.url.indexOf('?') >= 0 ? '&' : '?') + 'download=1';
    var body;
    if (a.kind === 'png') {
      body = '<img class="pvimg" src="' + esc(a.url) + '" alt="' + esc(a.title || '知识卡片') + '">';
    } else if (a.kind === 'pdf') {
      body = '<object class="pvframe" data="' + esc(a.url) + '" type="application/pdf">' +
        '<div class="pvfallback">浏览器不能直接预览 PDF<br><a href="' + esc(a.url) + '" target="_blank" rel="noopener">新窗口打开</a></div></object>';
    } else {
      body = '<iframe class="pvframe" src="' + esc(a.url) + '" title="' + esc(a.title || '资料') + '" loading="lazy"></iframe>';
    }
    host.hidden = false;
    document.body.classList.add('preview-open');
    host.innerHTML = '<div class="pvhead"><div class="pvt">' + esc(a.title || '资料') + '</div>' +
      '<div class="pvmeta">' + (a.parent_title ? '改自 ' + esc(a.parent_title) + ' · ' : '') + esc(k[0]) + ' · ' + esc(fmtBytes(a.bytes)) + '</div>' +
      '<div class="sp"></div>' +
      '<button type="button" class="pvact" data-act="artifact-rename-open" data-id="' + esc(a.id) + '">改名</button>' +
      '<a class="pvact" href="' + esc(a.url) + '" target="_blank" rel="noopener">新窗口</a>' +
      '<a class="pvact" href="' + esc(dl) + '">下载</a>' +
      '<button type="button" class="pvx" data-act="close-preview" aria-label="关闭预览">' + ic('x') + '</button></div>' +
      '<div class="pvbody">' + body + '</div>';
  }

  function msgHtml(m) {
    if (m.role === 'user') {
      var imgs = (m.images || []).map(function (im) {
        return '<div class="thumb"><img src="' + esc(imgSrc(im.url || im.id)) + '" alt=""></div>';
      }).join('');
      var sk = m.skill ? skillById(m.skill) : null;
      var sktag = sk ? '<span class="skilltag">' + ic(sk.icon || 'sparkles', 'sm') + esc(sk.name) + '</span>' : '';
      var etag = m.artifact_id ? '<span class="edittag">' + ic('book', 'sm') + '基于资料</span>' : '';
      var textBody = (etag || '') + (sktag || '') + (m.content_md ? '<span class="utext">' + escText(m.content_md) + '</span>' : '');
      var text = textBody ? '<div class="utextwrap">' + textBody + '</div>' : '';
      var mqs = m.questions || [];
      var qs = mqs.length > 2
        ? '<button type="button" class="qstacksum msg" data-act="open-qrefs-msg" data-key="' + esc(m._key || '') + '">' +
            '<span class="qss-l"><span class="qss-n">共 ' + mqs.length + ' 题</span>' +
            '<span class="qss-s">' + esc((mqs[0].stem || '').slice(0, 22)) + '…</span></span>' +
            '<span class="qss-go">查看 ›</span></button>'
        : mqs.map(function (q, i) {
            return '<button type="button" class="qattach qpreview qmsgcard" data-act="open-question" data-id="' + esc(q.id || '') + '">' +
              '<div class="stem clamp2">' + stemHtml(q.stem || '') + '</div>' +
              '<div class="qfoot"><span class="tag">' + esc(q.type === 'choice' ? '选择题' : q.type === 'blank' ? '填空题' : '题目') + '</span></div>' +
              '</button>';
          }).join('');
      return '<div class="me"><div class="ubx">' +
        (qs ? '<div class="qstack">' + qs + '</div>' : '') +
        (imgs ? '<div class="ustack">' + imgs + '</div>' : '') + text + '</div></div>';
    }
    var inner = '';
    if (m.kind === 'nudge') {
      return '<div class="ag nudgeag" data-key="' + esc(m._key) + '">' + nudgeHtml(m) + '</div>';
    }
    if (m.skill) inner += skillUsedHtml(m);
    var useParts = !!(m.parts && m.parts.length && m.status !== 'streaming');
    if (useParts) {
      inner += thinkingGroupHtml(m);
      inner += partsAnswersHtml(m);
      inner += quizPartsHtml(m);
      inner += artifactPartsHtml(m);
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
    inner += depositBarHtml(m);
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
    var toolNames = [];
    var createNames = [];
    (m.parts || []).forEach(function (p) {
      if (!p || !p.type) return;
      if (p.type === 'reasoning') {
        ms += Number(p.ms) || 0;
        body.push('<div class="tstep"><div class="tstep-t">' +
          renderMarkdown(p.text || '') + '</div></div>');
      } else if (p.type === 'tool') {
        tools += 1;
        toolNames.push(p.name || '');
        if ((p.name || '').indexOf('make_') === 0 || p.name === 'quiz_create') createNames.push(p.name);
        var q = (p.queries && p.queries.length) ? '「' + p.queries.join('、') + '」' : '';
        var tl = toolMeta(p.name);
        var tname = tl[0];
        var ticon = tl[1];
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
    if (tools) {
      var cat = { question: 0, web: 0, memory: 0, file: 0, create: 0 };
      toolNames.forEach(function (n) {
        if (n.indexOf('question_') === 0) cat.question += 1;
        else if (n === 'web_search') cat.web += 1;
        else if (n.indexOf('memory_') === 0) cat.memory += 1;
        else if (n.indexOf('file_') === 0) cat.file += 1;
        else if (n === 'publish' || n.indexOf('make_') === 0 || n === 'quiz_create') cat.create += 1;
      });
      var bits = [];
      if (cat.question) bits.push('查题库 ' + cat.question + ' 次');
      if (cat.web) bits.push('搜索 ' + cat.web + ' 次');
      if (cat.memory) bits.push('查记忆 ' + cat.memory + ' 次');
      if (cat.file) bits.push('工作区 ' + cat.file + ' 次');
      if (cat.create) {
        var uniq = createNames.filter(function (v, i, a) { return a.indexOf(v) === i; });
        bits.push(uniq.length === 1 ? toolMeta(uniq[0])[0] : '生成 ' + cat.create + ' 次');
      }
      head.push(bits.join(' · '));
    }
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
    var qn = srcCount(m, 'question');
    if (!mem && !web && !qn) return '';
    var parts = [];
    if (qn) parts.push(ic('book-open-text', 'sm') + '题库 ' + numWrap(qn) + ' 题');
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
    var last = state.messages[state.messages.length - 1] === m;
    var canRetry = !!m.canRetry && last;
    var canResend = !canRetry && last && m.role === 'assistant';
    return '<div class="merr">' + ic('alert-circle') +
      '<span class="msg">' + esc(m.error || '') + '</span>' +
      (canRetry ? '<button type="button" class="btn" data-act="retry" data-key="' + esc(m._key) + '">重试</button>' : '') +
      (canResend ? '<button type="button" class="btn" data-act="resend-last">重新发送</button>' : '') +
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

var CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];

  // OCR 常输出 \textcircled{1} 与 $$…$$；卡片里统一成 ①②… 与行内 $…$
  function stemText(t) {
    var x = String(t || '');
    x = x.replace(/\\\\/g, '\\');
    x = x.replace(/\\textcircled\s*\{?\s*(\d)\s*\}?/g, function (_, d) {
      var ch = CIRCLED[Number(d) - 1] || ('(' + d + ')');
      return '\\text{' + ch + '}';
    });
    x = x.replace(/\\\(/g, '$').replace(/\\\)/g, '$');
    x = x.replace(/\\\[/g, '$').replace(/\\\]/g, '$');
    x = x.replace(/\$\$/g, '$');
    return x;
  }

  function stemHtml(t) {
    return escText(stemText(t));
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

  var SUBJECT_ICON = {
    '全部': 'sun', '语文': 'book-open-text', '数学': 'sigma', '英语': 'languages',
    '物理': 'atom', '化学': 'flask-conical', '生物': 'leaf', '政治': 'landmark',
    '历史': 'book', '地理': 'globe'
  };

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
        (it.subject === '全部' ? '' : (it.count ? '<span class="cnt">' + numWrap(it.count) + '</span>' : '')) +
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
    try { localStorage.setItem('xm_subject', name || '全部'); } catch (e) {}
    var old = (state.subjects && state.subjects.current) || '全部';
    if (name === old) { state.heroSubject = name; state.convSubject = name; state.overlay = null; render(); return; }
    var st = q('#stream');
    if (st) state.subjectScroll[old] = st.scrollTop;
    var r;
    try {
      r = await api('/subject', { method: 'PATCH', json: { subject: name } });
    } catch (e) {
      toast('切换失败：' + e.message);
      return;
    }
    state.overlay = null;
    state.heroSubject = name;
    state.convSubject = name;
    if (r) {
      state.conversation = {
        id: r.conversation_id, subject: name, message_count: r.message_count
      };
    }
    state.messages = [];
    state.liveMsg = null;
    state.msgState = 'loading';
    await Promise.all([loadSubjects(), loadMessages(), loadToday()]);
    render();
    var s2 = q('#stream');
    if (s2) s2.scrollTop = state.subjectScroll[name] || s2.scrollHeight;
  }

  function sourcesSheetHtml(o) {
    var m = findMessageByKey(o.key);
    var mem = m ? (m.sources || []).filter(function (s) { return s && s.type === 'memory'; }) : [];
    var web = m ? (m.sources || []).filter(function (s) { return s && s.type === 'web'; }) : [];
    var qs = m ? (m.sources || []).filter(function (s) { return s && s.type === 'question'; }) : [];
    var body = '';
    if (qs.length) {
      body += '<div class="slabel">题库 · ' + qs.length + '</div><div class="scard">' +
        qs.map(function (s) {
          return '<button type="button" class="srow srowq" data-act="qsrc-open" data-id="' + esc(s.id || '') + '">' +
            '<span class="md"><span class="n1">' + esc((s.title || '').slice(0, 60)) + '</span>' +
            '<span class="n2">' + esc(s.subject || '') + '</span></span>' +
            ic('chevron-right', 'sm chev') + '</button>';
        }).join('') + '</div>';
    }
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
      : kind === 'capture' ? captureSheetHtml()
      : kind === 'qpicker' ? qpickerSheetHtml()
      : kind === 'qrefs' ? qrefsSheetHtml()
      : kind === 'newchat' ? newChatSheetHtml()
      : kind === 'qedit' ? qeditSheetHtml()
      : kind === 'bankfilter' ? bankFilterSheetHtml()
      : kind === 'theme' ? themeSheetHtml()
      : kind === 'skills' ? skillSheetHtml()
      : kind === 'herosub' ? heroSubjectsSheetHtml()
      : kind === 'artmenu' ? artMenuSheetHtml()
      : kind === 'artrename' ? artifactRenameSheetHtml()
      : kind === 'kpsel' ? kpSheetHtml()
          : kind === 'provider-pick' ? providerPickSheetHtml()
            : kind === 'search-key' ? searchKeySheetHtml()
              : modelSheetHtml();
    typesetMath(host);
  }

  /* ── 渲染：模型管理 / provider 详情 / 表单 ─────────── */
  function navbar(title, sub, backAct, backLabel, closeIcon) {
    var btn = backAct
      ? '<button type="button" class="hit back" data-act="' + backAct + '" aria-label="' + esc(backLabel) + '">' +
        ic(closeIcon ? 'x' : 'chevron-left') + '</button>'
      : '';
    return '<div class="navbar' + (closeIcon ? ' flow' : '') + (backAct ? '' : ' l0') + '">' + btn +
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

  /* ── 主题：跟随系统 / 浅色 / 深色 ─────────────────── */

  function themeMode() {
    try {
      var t = localStorage.getItem('xm_theme');
      if (t === 'light' || t === 'dark' || t === 'system') return t;
    } catch (e) { /* 无痕模式 */ }
    return 'system';
  }

  function resolvedTheme(mode) {
    mode = mode || themeMode();
    if (mode === 'light' || mode === 'dark') return mode;
    try {
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch (e) {
      return 'light';
    }
  }

  function themeLabel(mode) {
    return mode === 'light' ? '浅色' : mode === 'dark' ? '深色' : '跟随系统';
  }

  function applyTheme(mode, persist) {
    mode = (mode === 'light' || mode === 'dark') ? mode : 'system';
    var root = document.documentElement;
    if (mode === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', mode);
    var dark = resolvedTheme(mode) === 'dark';
    root.style.colorScheme = dark ? 'dark' : 'light';
    if (persist) {
      try { localStorage.setItem('xm_theme', mode); } catch (e) { /* noop */ }
    }
    state.theme = mode;
    if (state.mapCy) {
      try { state.mapCy.style(mapStyle()); } catch (e) { /* noop */ }
    }
  }

  function themeSheetHtml() {
    var cur = themeMode();
    var opts = [['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']];
    var rows = opts.map(function (o) {
      var on = cur === o[0];
      return '<button type="button" class="caprow' + (on ? ' on' : '') + '" data-act="theme-pick" data-v="' + o[0] + '">' +
        '<span>' + o[1] + '</span><span class="sp"></span>' +
        (on ? '<span class="capchk">' + ic('check', 'sm') + '</span>' : '') + '</button>';
    }).join('');
    return '<div class="scrim" data-act="close-sheet"></div>' +
      '<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="th-ttl" tabindex="-1">' +
      '<div class="grab"></div>' +
      '<div class="shd"><div class="ttl" id="th-ttl">主题</div>' +
      '<button type="button" class="hit" data-act="close-sheet" aria-label="关闭">' + ic('x') + '</button></div>' +
      '<div class="sheet-body"><div class="capmenu">' + rows + '</div></div>' +
      '</div>';
  }

  function pickTheme(mode) {
    applyTheme(mode, true);
    closeOverlay();
    render();
  }

  function settingsPageHtml() {
    var nav = navbar('设置', '', 'goto-chat', '对话', false);
    var cur = settingModel();

    var themeGroup = groupHtml('外观',
      '<button type="button" class="srow" data-act="open-theme">' +
        '<span class="lead">' + ic('sun') + '</span>' +
        '<span class="md"><span class="n1">主题</span></span>' +
        '<span class="trail"><span class="val">' + esc(themeLabel(themeMode())) + '</span>' +
        ic('chevron-right', 'sm chev') + '</span></button>');

    var p = state.profile || {};
    var profileGroup = groupHtml('个人资料',
      '<button type="button" class="srow" data-act="open-profile">' +
        '<span class="lead">' + ic('person') + '</span>' +
        '<span class="md"><span class="n1">' + esc(agentName()) + '</span>' +
        '<span class="n2">' + esc(p.user_name ? ('你 · ' + p.user_name) : '还没填你的名字') + '</span></span>' +
        '<span class="trail">' + ic('chevron-right', 'sm chev') + '</span></button>');

    if (state.searchState === 'loading' && !state.search) {
      return nav + '<div class="det">' + profileGroup + themeGroup +
        '<div class="skel">' + skelRows(4) + '</div></div>';
    }
    if (state.searchState === 'error') {
      return nav + '<div class="det">' + profileGroup + themeGroup +
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
      profileGroup + themeGroup +
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

  /* ── 知识地图（P5）：一科一张网，按教材模块 / 章切 ───────── */

  var MAP_ORPHAN = '__orphan';
  var MAP_OVERVIEW = '__overview';

  function mapState() {
    if (!state.map) {
      state.map = {
        subject: '化学', module: '', chapter: '', data: null,
        loading: true, error: '', selected: '', focus: '', q: '', ver: 0
      };
    }
    return state.map;
  }

  function mapData() { return state.map && state.map.data; }

  function openMap() {
    var m = mapState();
    var subj = (state.subjects && state.subjects.current) || '化学';
    if (SUBJECTS.indexOf(subj) < 0) subj = '化学';
    if (m.subject !== subj || !m.data) {
      m.subject = subj; m.data = null; m.module = ''; m.chapter = ''; m.selected = '';
    }
    openPage({ kind: 'map' });
    loadMap();
  }

  async function loadMap() {
    var m = mapState();
    m.loading = true; m.error = ''; m.selected = ''; m.ver++;
    render();
    try {
      m.data = await api('/kp/graph?subject=' + encodeURIComponent(m.subject));
    } catch (e) {
      m.error = e.message;
      m.data = null;
    }
    m.loading = false;
    ensureMapScope();
    m.ver++;
    render();
    if (m.selected) loadMapQuestions(m.selected);
  }

  function mapModules() {
    var d = mapData() || {};
    var mods = (d.modules || []).filter(function (x) { return x.name; });
    var orphans = (d.nodes || []).filter(function (n) { return n.kind === 'point' && !n.parent; });
    if (orphans.length) mods = mods.concat([{ name: MAP_ORPHAN, points: orphans.length, chapters: 1 }]);
    return mods;
  }

  function mapModuleLabel(name) { return name === MAP_ORPHAN ? '其他' : name; }

  var MAP_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

  function mapChapterRank(name) {
    var m = /第([一二三四五六七八九十]+|[0-9]+)(章|单元|课)/.exec(String(name || ''));
    if (!m) return 999;
    if (/^[0-9]+$/.test(m[1])) return Number(m[1]);
    var s = m[1], n = 0;
    if (s.length === 1) return MAP_NUM[s] || 999;
    if (s[0] === '十') n = 10;
    else n = (MAP_NUM[s[0]] || 0) * 10;
    if (s.length > 1 && s[1] !== '十') n += MAP_NUM[s[1]] || 0;
    return n || 999;
  }

  function mapChapters() {
    var d = mapData() || {};
    var m = state.map;
    if (!m) return [];
    if (m.module === MAP_ORPHAN) {
      var ops = (d.nodes || []).filter(function (n) { return n.kind === 'point' && !n.parent; });
      return ops.length ? [{ id: MAP_ORPHAN, name: '其他知识点', module: '', points: ops.length }] : [];
    }
    var list = (d.nodes || []).filter(function (n) {
      return n.kind === 'chapter' && n.module === m.module;
    });
    list.sort(function (a, b) {
      return mapChapterRank(a.name) - mapChapterRank(b.name) || String(a.name).localeCompare(String(b.name));
    });
    return list;
  }

  function mapChapterById(id) {
    var list = mapChapters();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function mapPointsOf(chapterId) {
    var d = mapData() || {};
    return (d.nodes || []).filter(function (n) {
      if (n.kind !== 'point') return false;
      return chapterId === MAP_ORPHAN ? !n.parent : n.parent === chapterId;
    });
  }

  function mapPointById(id) {
    var d = mapData() || {};
    var list = d.nodes || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id && list[i].kind === 'point') return list[i];
    }
    return null;
  }

  function mapScopeOf(point) {
    if (!point) return null;
    if (!point.parent) return { module: MAP_ORPHAN, chapter: MAP_ORPHAN };
    return { module: point.module || '', chapter: point.parent };
  }

  function ensureMapScope() {
    var m = state.map;
    if (!m) return;
    var mods = mapModules();
    if (!mods.some(function (x) { return x.name === m.module; })) {
      m.module = mods.length ? mods[0].name : '';
      m.chapter = '';
      m.selected = '';
    }
    var chs = mapChapters();
    if (m.chapter === MAP_OVERVIEW && chs.length) return;
    if (!chs.some(function (c) { return c.id === m.chapter; })) {
      // 默认落在「有题的章」优先；都没题才看知识点多少（避免落在「绪言」）
      var best = null, bestScore = -1;
      chs.forEach(function (c) {
        var pts = mapPointsOf(c.id);
        var tagged = pts.filter(function (p) { return p.q_count; }).length;
        var score = tagged * 1000 + pts.length;
        if (score > bestScore) { best = c; bestScore = score; }
      });
      m.chapter = best ? best.id : (chs.length ? chs[0].id : '');
      m.selected = '';
    }
  }

  function mapSubtitle() {
    var m = state.map;
    if (!m) return '';
    var parts = [m.subject];
    if (m.module) parts.push(mapModuleLabel(m.module));
    if (m.chapter === MAP_OVERVIEW) parts.push('总览');
    else {
      var ch = mapChapterById(m.chapter);
      if (ch) parts.push(ch.name);
    }
    return parts.join(' · ');
  }

  function mapPageHtml() {
    var m = state.map;
    var nav = navbar('知识地图', mapSubtitle(), '', '', false);
    if (!m) return nav;
    if (m.loading && !m.data) {
      return nav + '<div class="settings"><div class="skel inmsg">' + skelRows(6) + '</div></div>';
    }
    if (m.error) {
      return nav + '<div class="settings">' +
        pageErrorState('知识点没加载出来', m.error, 'map-reload', 'rail-chat', '返回对话') + '</div>';
    }
    var d = mapData() || {};
    if (!(d.nodes || []).length) {
      return nav + '<div class="settings"><div class="empty"><div class="t">这一科还没有知识点</div>' +
        '<div class="d">先导入知识点树，再回来</div></div></div>';
    }

    var subjectChips = SUBJECTS.map(function (s) {
      return '<span class="fchip' + (m.subject === s ? ' on' : '') + '" role="button" tabindex="0"' +
        ' data-act="map-subject" data-subject="' + esc(s) + '">' + s + '</span>';
    }).join('');
    var modChips = mapModules().map(function (x) {
      return '<span class="fchip' + (m.module === x.name ? ' on' : '') + '" role="button" tabindex="0"' +
        ' data-act="map-module" data-module="' + esc(x.name) + '">' + esc(mapModuleLabel(x.name)) +
        ' <span class="mapn num">' + x.points + '</span></span>';
    }).join('');
    var chaps = mapChapters();
    var chapChips = '<span class="fchip' + (m.chapter === MAP_OVERVIEW ? ' on' : '') + '" role="button" tabindex="0"' +
      ' data-act="map-chapter" data-id="' + MAP_OVERVIEW + '">总览</span>' +
      chaps.map(function (c) {
        return '<span class="fchip' + (m.chapter === c.id ? ' on' : '') + '" role="button" tabindex="0"' +
          ' data-act="map-chapter" data-id="' + esc(c.id) + '">' + esc(c.name) + '</span>';
      }).join('');

    return nav +
      '<div class="mapbars">' +
        '<div class="bankchips mapchips">' + subjectChips + '</div>' +
        '<div class="bankchips mapchips">' + modChips + '</div>' +
        '<div class="maprow">' +
          '<div class="bankchips mapchaps">' + (chapChips || '<span class="mapempty">这一册还没有章节</span>') + '</div>' +
          '<div class="mapsearch">' +
            '<input type="search" id="map-q" class="fi" placeholder="搜知识点" value="' + esc(m.q || '') + '">' +
            '<button type="button" class="btn" data-act="map-search">搜索</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="mapwrap">' +
        '<div class="mapstage">' +
          '<div id="map-cy" class="mapcanvas" role="img" aria-label="知识点关系图"></div>' +
          '<div class="mapzooms">' +
            '<button type="button" class="hit" data-act="map-zoom-in" aria-label="放大">' + ic('plus') + '</button>' +
            '<button type="button" class="hit" data-act="map-zoom-out" aria-label="缩小">' + ic('minus') + '</button>' +
            '<button type="button" class="hit" data-act="map-zoom-fit" aria-label="适应">' + ic('scan') + '</button>' +
          '</div>' +
          '<div class="maplegend">' +
            '<span><i class="dot hasq"></i>有题</span>' +
            '<span><i class="dot"></i>未练</span>' +
            '<span class="ln">先修</span>' +
            '<span class="ln dash">相关</span>' +
          '</div>' +
        '</div>' +
        '<aside class="mapside" id="map-side">' + mapSideInner() + '</aside>' +
      '</div>' +
      '<div id="map-tip" class="maptip" hidden></div>';
  }

  function mapSideInner() {
    var m = state.map;
    if (!m) return '';
    if (m.chapter === MAP_OVERVIEW) {
      var chs = mapChapters();
      var pts = 0;
      chs.forEach(function (c) { pts += c.points || 0; });
      var chips = chs.map(function (c) {
        return '<button type="button" class="mapchip" data-act="map-chapter" data-id="' + esc(c.id) + '">' +
          esc(c.name) + ' <span class="mapn">' + (c.points || 0) + '</span></button>';
      }).join('');
      return '<div class="mapsidehead">' +
          '<div class="ttl">' + esc(mapModuleLabel(m.module)) + '</div>' +
          '<div class="sub">' + chs.length + ' 章 · ' + pts + ' 个知识点</div>' +
        '</div>' +
        '<div class="mapsec"><div class="slabel">章</div><div class="mapchips">' +
          (chips || '<span class="mapempty">这一册还没有章节</span>') + '</div></div>';
    }
    var sel = m.selected ? mapPointById(m.selected) : null;
    if (sel) return mapPointSideHtml(sel);
    var ch = mapChapterById(m.chapter);
    var pts2 = mapPointsOf(m.chapter);
    var tagged = pts2.filter(function (p) { return p.q_count; }).length;
    var chips2 = pts2.slice()
      .sort(function (a, b) {
        return (b.q_count || 0) - (a.q_count || 0) || String(a.name).localeCompare(String(b.name));
      })
      .map(function (p) {
        return '<button type="button" class="mapchip' + (p.q_count ? ' on' : '') + '" data-act="map-select" data-id="' +
          esc(p.id) + '">' + esc(p.name) + '</button>';
      }).join('');
    return '<div class="mapsidehead">' +
        '<div class="ttl">' + esc(ch ? ch.name : '知识点') + '</div>' +
        '<div class="sub">' + esc([m.module ? mapModuleLabel(m.module) : '', pts2.length + ' 个知识点',
          tagged + ' 个有题'].filter(Boolean).join(' · ')) + '</div>' +
      '</div>' +
      '<div class="mapsec"><div class="slabel">知识点</div>' +
        '<div class="mapchips">' + (chips2 || '<span class="mapempty">这一章还没有知识点</span>') + '</div>' +
      '</div>';
  }

  function mapPointSideHtml(p) {
    var d = mapData() || {};
    var pre = [], next = [];
    (d.edges || []).forEach(function (e) {
      if (e.target === p.id) pre.push(e.source);
      if (e.source === p.id) next.push(e.target);
    });
    function chip(id) {
      var n = mapPointById(id);
      if (!n) return '';
      return '<button type="button" class="mapchip' + (n.q_count ? ' on' : '') + '" data-act="map-select" data-id="' +
        esc(n.id) + '">' + esc(n.name) + '</button>';
    }
    var meta = [p.module, p.chapter, p.grade].filter(Boolean).join(' · ');
    return '<div class="mapsidehead">' +
        '<button type="button" class="mapbackchip" data-act="map-unselect">' + ic('chevron-left', 'sm') + '本章</button>' +
        '<div class="ttl">' + esc(p.name) + '</div>' +
        '<div class="sub">' + esc(meta) + '</div>' +
      '</div>' +
      '<div class="mapstats">' +
        '<div class="ms"><div class="n num">' + Number(p.q_count || 0) + '</div><div class="l">题库题目</div></div>' +
        '<div class="ms"><div class="n num">' + Number(pre.length + next.length) + '</div><div class="l">关联知识点</div></div>' +
        (p.difficulty ? '<div class="ms"><div class="n num">' + Number(p.difficulty).toFixed(2) + '</div><div class="l">知识点难度</div></div>' : '') +
      '</div>' +
      (pre.length ? '<div class="mapsec"><div class="slabel">先修</div><div class="mapchips">' + pre.map(chip).join('') + '</div></div>' : '') +
      (next.length ? '<div class="mapsec"><div class="slabel">后继</div><div class="mapchips">' + next.map(chip).join('') + '</div></div>' : '') +
      '<div class="mapsec"><div class="slabel">已收录题目</div><div id="map-qs" class="mapqs">' +
        '<div class="skel inmsg">' + skelRows(2) + '</div></div></div>' +
      '<div class="mapacts"><button type="button" class="btn" data-act="map-bank" data-id="' + esc(p.id) + '">在题库里看</button></div>';
  }

  async function loadMapQuestions(kpid) {
    var host = q('#map-qs');
    if (!host) return;
    try {
      var r = await api('/questions?kp=' + encodeURIComponent(kpid) + '&limit=3');
      if (!q('#map-qs') || (state.map && state.map.selected !== kpid)) return;
      var items = r.items || [];
      if (!items.length) { host.innerHTML = '<div class="mapempty">还没收录题目</div>'; return; }
      host.innerHTML = items.map(function (x) {
        return '<button type="button" class="mapq" data-act="map-open-q" data-id="' + esc(x.id) + '">' +
          '<span class="stem">' + stemHtml((x.stem_md || '').slice(0, 64)) + '</span>' +
          '<span class="a">' + (x.answer_md ? '答案 ' + esc(String(x.answer_md).slice(0, 24)) : '暂无答案') + '</span></button>';
      }).join('');
    } catch (e) {
      if (q('#map-qs')) q('#map-qs').innerHTML = '<div class="mapempty">题目没加载出来</div>';
    }
  }

  function mapRenderSide() {
    var host = q('#map-side');
    if (host) host.innerHTML = mapSideInner();
  }

  function mapElements() {
    var d = mapData() || {};
    var m = state.map;
    if (m.chapter === MAP_OVERVIEW) {
      var chs = mapChapters();
      var ids = {};
      chs.forEach(function (c) { ids[c.id] = true; });
      var els = chs.map(function (c) {
        return { data: { id: c.id, label: c.name, kind: 'chapter', n: c.points || 0 } };
      });
      var parentOf = {};
      (d.nodes || []).forEach(function (n) { if (n.kind === 'point') parentOf[n.id] = n.parent; });
      var agg = {};
      (d.edges || []).forEach(function (e) {
        var a = parentOf[e.source], b = parentOf[e.target];
        if (!a || !b || a === b || !ids[a] || !ids[b]) return;
        var k = a + '|' + b;
        agg[k] = agg[k] || { source: a, target: b, n: 0 };
        agg[k].n++;
      });
      Object.keys(agg).forEach(function (k) {
        els.push({ data: { id: 'agg-' + k, source: agg[k].source, target: agg[k].target, kind: 'agg', n: agg[k].n } });
      });
      return els;
    }
    var pts = mapPointsOf(m.chapter);
    var pointIds = {};
    pts.forEach(function (p) { pointIds[p.id] = true; });
    var out = [];
    var ch = mapChapterById(m.chapter);
    if (ch && m.chapter !== MAP_ORPHAN) {
      out.push({ data: { id: ch.id, label: ch.name, kind: 'chapter' } });
      pts.forEach(function (p) {
        out.push({ data: { id: 'sp-' + p.id, source: ch.id, target: p.id, kind: 'part' } });
      });
    }
    pts.forEach(function (p) {
      out.push({
        data: { id: p.id, label: p.name, kind: 'point', q: Number(p.q_count || 0) },
        classes: p.q_count ? 'hasq' : ''
      });
    });
    (d.edges || []).forEach(function (e) {
      if (pointIds[e.source] && pointIds[e.target]) {
        out.push({ data: { id: e.id, source: e.source, target: e.target, kind: e.type } });
      }
    });
    return out;
  }

  function mapStyle() {
    var cs = getComputedStyle(document.documentElement);
    var v = function (n) { return cs.getPropertyValue(n).trim(); };
    var paper = v('--paper'), card = v('--card'), line = v('--line');
    var ink2 = v('--ink2'), ink3 = v('--ink3');
    var clay = v('--clay'), claybg = v('--claybg'), clayline = v('--clayline');
    return [
      { selector: 'node[kind="chapter"]', style: {
        shape: 'round-rectangle', width: 196, height: 38, 'background-color': card,
        'border-width': 1.5, 'border-color': clayline, label: 'data(label)',
        'font-size': 13, 'font-family': v('--sans'), color: clay,
        'text-valign': 'center', 'text-halign': 'center',
        'text-wrap': 'ellipsis', 'text-max-width': '180px', 'min-zoomed-font-size': 0
      } },
      { selector: 'node[kind="point"]', style: {
        shape: 'ellipse', width: 24, height: 24, 'background-color': v('--fill2'),
        'border-width': 1.5, 'border-color': v('--outline'), label: 'data(label)',
        'font-size': 12, 'font-family': v('--sans'), color: ink2,
        'text-valign': 'bottom', 'text-margin-y': 3,
        'text-wrap': 'ellipsis', 'text-max-width': '120px', 'min-zoomed-font-size': 7,
        'text-outline-color': paper, 'text-outline-width': 2
      } },
      { selector: 'node[kind="point"].hasq', style: { 'background-color': claybg, 'border-color': clay } },
      { selector: 'node:selected', style: {
        'background-color': clay, 'border-color': clay, color: v('--ink'),
        'text-outline-width': 0, 'text-background-color': card, 'text-background-opacity': 0.95,
        'text-background-padding': 2, 'text-background-shape': 'round-rectangle', 'border-width': 3
      } },
      { selector: 'edge[kind="part"]', style: { width: 0.6, 'line-color': line, opacity: 0.5, 'curve-style': 'straight' } },
      { selector: 'edge[kind="agg"]', style: {
        width: 'mapData(n, 1, 8, 1.2, 3.2)',
        'line-color': ink3, 'target-arrow-color': ink3,
        'target-arrow-shape': 'triangle', 'arrow-scale': 0.7, 'curve-style': 'bezier'
      } },
      { selector: 'edge[kind="prerequisite"]', style: {
        width: 1.2, 'line-color': ink3, 'target-arrow-color': ink3,
        'target-arrow-shape': 'triangle', 'arrow-scale': 0.6, 'curve-style': 'bezier'
      } },
      { selector: 'edge[kind="leads-to"]', style: {
        width: 1, 'line-color': ink3, 'target-arrow-color': ink3,
        'target-arrow-shape': 'triangle', 'arrow-scale': 0.5,
        'curve-style': 'bezier', 'line-style': 'dashed'
      } },
      { selector: 'edge[kind="related"]', style: {
        width: 1, 'line-color': v('--line2'), 'curve-style': 'bezier', 'line-style': 'dotted'
      } }
    ];
  }

  function mapRelax(minDist) {
    var cy = state.mapCy;
    if (!cy) return;
    var nodes = cy.nodes().toArray();
    for (var it = 0; it < 120; it++) {
      var moved = false;
      for (var i = 0; i < nodes.length; i++) {
        for (var j = i + 1; j < nodes.length; j++) {
          var a = nodes[i].position(), b = nodes[j].position();
          var dx = b.x - a.x, dy = b.y - a.y;
          var d = Math.sqrt(dx * dx + dy * dy) || 0.01;
          var want = (nodes[i].data('kind') === 'chapter' || nodes[j].data('kind') === 'chapter') ? 150 : minDist;
          if (d < want) {
            var push = (want - d) / 2, ux = dx / d, uy = dy / d;
            nodes[i].position({ x: a.x - ux * push, y: a.y - uy * push });
            nodes[j].position({ x: b.x + ux * push, y: b.y + uy * push });
            moved = true;
          }
        }
      }
      if (!moved) break;
    }
  }

  function mapMount() {
    var host = q('#map-cy');
    var m = state.map;
    if (!host || !m || !m.data) return;
    var key = m.subject + '|' + m.module + '|' + m.chapter + '|' + m.ver;
    if (state.mapCy && state.mapKey === key && state.mapCy.container() === host) return;
    if (state.mapCy) {
      try { state.mapCy.destroy(); } catch (e) { /* noop */ }
      state.mapCy = null;
    }
    var els = mapElements();
    if (!els.length) return;
    if (!window.cytoscape) {
      host.innerHTML = '<div class="mapempty" style="padding:var(--q4)">图库没加载出来，刷新试试</div>';
      return;
    }
    var cy = window.cytoscape({
      container: host,
      elements: els,
      style: mapStyle(),
      wheelSensitivity: 0.2,
      minZoom: 0.15,
      maxZoom: 3,
      boxSelectionEnabled: false
    });
    state.mapCy = cy;
    window.__cy = cy;
    state.mapKey = key;
    if (m.selected) {
      var pre = cy.getElementById(m.selected);
      if (pre && !pre.empty()) pre.select();
    }
    var layout;
    if (m.chapter === MAP_OVERVIEW) {
      var W = cy.width(), H = cy.height();
      var ns = cy.nodes().toArray();
      var n = Math.max(1, ns.length);
      var Rx = Math.max(180, Math.min(W * 0.40, (n * 200) / (2 * Math.PI)));
      var Ry = Math.max(120, Math.min(H * 0.34, Rx * 0.62));
      ns.forEach(function (nd, i) {
        var a = -Math.PI / 2 + i * 2 * Math.PI / n;
        nd.position({ x: W / 2 + Math.cos(a) * Rx, y: H / 2 + Math.sin(a) * Ry });
      });
      cy.fit(undefined, 48);
      cy.resize();
    } else {
      layout = cy.layout({
        name: 'cose', animate: false, randomize: true, numIter: 700,
        nodeRepulsion: 42000, idealEdgeLength: 180, gravity: 0.08,
        nodeOverlap: 28, componentSpacing: 80, fit: false
      });
      layout.one('layoutstop', function () {
        mapRelax(112);
        cy.fit(undefined, 40);
        cy.resize();
        if (m.focus) {
          var want = m.focus;
          m.focus = '';
          mapCenter(want);
        }
      });
      layout.run();
    }
    cy.on('tap', 'node', function (ev) { mapSelect(ev.target.id()); });
    cy.on('tap', function (ev) { if (ev.target === cy) mapUnselect(); });
    cy.on('mouseover', 'node', function (ev) { mapTipShow(ev.target); });
    cy.on('mousemove', 'node', function (ev) { mapTipMove(ev); });
    cy.on('mouseout', 'node', function () { mapTipHide(); });
  }

  function mapTipShow(node) {
    var tip = q('#map-tip');
    if (!tip || !node) return;
    if (node.data('kind') === 'chapter') {
      tip.innerHTML = '<div class="t">' + esc(node.data('label')) + '</div>' +
        '<div class="m">' + (node.data('n') || 0) + ' 个知识点 · 点开看这一章</div>';
      tip.hidden = false;
      return;
    }
    var p = mapPointById(node.id());
    if (!p) { tip.hidden = true; return; }
    tip.innerHTML = '<div class="t">' + esc(p.name) + '</div>' +
      '<div class="m">' + esc([p.chapter, p.q_count ? p.q_count + ' 题' : '未练'].filter(Boolean).join(' · ')) + '</div>';
    tip.hidden = false;
  }

  function mapTipMove(ev) {
    var tip = q('#map-tip');
    if (!tip || tip.hidden) return;
    var oe = ev.originalEvent || {};
    var x = Number(oe.clientX || 0), y = Number(oe.clientY || 0);
    tip.style.left = Math.max(8, Math.min(window.innerWidth - 250, x + 14)) + 'px';
    tip.style.top = Math.max(8, Math.min(window.innerHeight - 90, y + 14)) + 'px';
  }

  function mapTipHide() {
    var tip = q('#map-tip');
    if (tip) tip.hidden = true;
  }

  function mapSelect(id) {
    var m = state.map;
    if (!m || !id) return;
    if (m.chapter === MAP_OVERVIEW) {
      var hit = null;
      mapChapters().some(function (c) { if (c.id === id) { hit = c; return true; } return false; });
      if (hit) mapChapter(id);
      return;
    }
    var p = mapPointById(id);
    if (!p) return;
    var scope = mapScopeOf(p);
    var switched = scope && (scope.module !== m.module || scope.chapter !== m.chapter);
    if (switched) {
      m.module = scope.module;
      m.chapter = scope.chapter;
      m.selected = id;
      m.focus = id;
      m.ver++;
      render();
      return;
    }
    m.selected = id;
    var cy = state.mapCy;
    if (cy) {
      cy.$(':selected').unselect();
      var el = cy.getElementById(id);
      if (el && !el.empty()) el.select();
    }
    mapRenderSide();
    loadMapQuestions(id);
    mapCenter(id);
  }

  function mapUnselect() {
    var m = state.map;
    if (!m) return;
    m.selected = '';
    if (state.mapCy) state.mapCy.$(':selected').unselect();
    mapRenderSide();
  }

  function mapCenter(id) {
    var cy = state.mapCy;
    if (!cy) return;
    var el = cy.getElementById(id);
    if (el && !el.empty()) {
      cy.animate({ center: { eles: el }, zoom: Math.max(cy.zoom(), 0.95) }, { duration: 240 });
    }
  }

  function mapSubject(s) {
    var m = mapState();
    if (!s || m.subject === s) return;
    m.subject = s;
    m.data = null; m.module = ''; m.chapter = ''; m.selected = ''; m.q = '';
    loadMap();
  }

  function mapModule(mod) {
    var m = mapState();
    if (m.module === mod) return;
    var keepOverview = m.chapter === MAP_OVERVIEW;
    m.module = mod;
    m.chapter = keepOverview ? MAP_OVERVIEW : '';
    m.selected = '';
    if (!keepOverview) ensureMapScope();
    m.ver++;
    render();
  }

  function mapChapter(id) {
    var m = mapState();
    if (!id || m.chapter === id) return;
    m.chapter = id;
    m.selected = '';
    m.ver++;
    render();
  }

  function mapSearch() {
    var m = state.map;
    if (!m) return;
    var el = q('#map-q');
    var kw = (el && el.value || '').trim();
    m.q = kw;
    if (!kw) return;
    var d = mapData() || {};
    var hit = null;
    (d.nodes || []).some(function (n) {
      if (n.kind === 'point' && String(n.name).indexOf(kw) >= 0) { hit = n; return true; }
      return false;
    });
    if (!hit) { toast('没找到「' + kw + '」'); return; }
    mapSelect(hit.id);
  }

  function mapZoom(factor) {
    var cy = state.mapCy;
    if (!cy) return;
    var level = Math.max(cy.minZoom(), Math.min(cy.maxZoom(), cy.zoom() * factor));
    cy.zoom({ level: level, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
  }

  function mapZoomFit() {
    var cy = state.mapCy;
    if (cy) cy.fit(undefined, 40);
  }

  async function openMapPoint(id) {
    if (!id) return;
    try {
      var kp = await api('/kp/' + encodeURIComponent(id));
      var m = mapState();
      m.subject = kp.subject || m.subject;
      m.data = null;
      m.module = kp.module || (kp.parent_id ? '' : MAP_ORPHAN);
      m.chapter = kp.parent_id || MAP_ORPHAN;
      m.selected = ''; m.focus = kp.id; m.q = '';
      state.qpanel = null;
      openPage({ kind: 'map' });
      await loadMap();
      m.selected = kp.id;
      m.focus = kp.id;
      m.ver++;
      render();
    } catch (e) {
      toast('打开地图失败：' + e.message);
    }
  }

  function mapOpenBank(kpid) {
    var p = mapPointById(kpid);
    state.bank = {
      items: [], total: 0, subject: '', q: '', grade: '', difficulty: 0,
      kp: kpid, kpName: p ? p.name : ''
    };
    openBank();
  }

  function renderPage() {
    var host = q('#view-page');
    var page = state.page;
    if (!page) {
      if (state.mapCy) { try { state.mapCy.destroy(); } catch (e) { /* noop */ } state.mapCy = null; }
      host.innerHTML = '';
      return;
    }
    if (page.kind !== 'map' && state.mapCy) {
      try { state.mapCy.destroy(); } catch (e) { /* noop */ }
      state.mapCy = null;
      state.mapKey = '';
    }
    // 地图页：HTML 没变就别重建（否则开个题目面板就把图和缩放弄丢了）
    var mapKey = (state.map && page.kind === 'map')
      ? state.map.subject + '|' + state.map.module + '|' + state.map.chapter + '|' + state.map.ver
      : '';
    if (page.kind === 'map' && mapKey && state.mapHtmlKey === mapKey && q('#map-cy', host)) {
      mapRenderSide();
      return;
    }
    var html = '';
    if (page.kind === 'models') html = modelsPageHtml();
    else if (page.kind === 'provider') {
      html = findProvider(page.providerId) ? providerPageHtml(page.providerId) : modelsPageHtml();
    } else if (page.kind === 'form') {
      html = formHtml(page);
    } else if (page.kind === 'settings') {
      html = settingsPageHtml();
    } else if (page.kind === 'review') {
      html = reviewPageHtml();
    } else if (page.kind === 'convs') {
      html = convsPageHtml();
    } else if (page.kind === 'week') {
      html = weekPageHtml();
    } else if (page.kind === 'bank') {
      html = bankPageHtml();
    } else if (page.kind === 'library') {
      html = libraryPageHtml();
    } else if (page.kind === 'question') {
      html = questionPageHtml();
    } else if (page.kind === 'map') {
      html = mapPageHtml();
    } else if (page.kind === 'memories') {
      html = memoriesPageHtml();
    }
    host.innerHTML = html;
    typesetMath(host);
    if (page.kind === 'map') {
      state.mapHtmlKey = mapKey;
      mapMount();
    }
    if (page.kind === 'form') {
      var form = q('#provider-form', host);
      if (form) form.addEventListener('submit', onProviderSubmit);
    }
    if (state.focusPending === 'page') {
      state.focusPending = '';
      var host2 = q('#view-page');
      if (host2) { host2.setAttribute('tabindex', '-1'); host2.focus({ preventScroll: true }); }
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
    var qs = state.pendingQuestions.slice();
    if (!text && !ready.length && !qs.length) return;
    if (state.pending.some(function (x) { return x.uploading; })) {
      toast('图片还在上传');
      return;
    }
    var imgs = ready.map(function (x) { return { id: x.id, url: imgSrc(x.url), mime: x.mime }; });
    var qids = qs.map(function (q) { return q.id; }).filter(Boolean);
    if (!state.convId) {
      try {
        var nrc = await api('/conversations', { method: 'POST', json: { subject: state.convSubject || '全部' } });
        state.convId = nrc.id;
        state.convTitle = (text || '新对话').slice(0, 30);
        state.messages = [];
      } catch (e) {
        toast('新建对话失败：' + e.message);
        return;
      }
    }
    ta.value = '';
    autosize();
    state.pending = [];
    state.pendingQuestions = [];
    renderThumbs();
    renderQchips();
    syncSend();
    await doSend(text, imgs.map(function (x) { return x.id; }), imgs, qs, qids);
    setTimeout(function () { typesetMath(q('#stream')); }, 60);
    setTimeout(maybeAutoTitle, 400);
  }

  async function doSend(text, imageIds, imgs, questions, questionIds) {
    var payload = {
      text: text, image_ids: imageIds || [], question_ids: questionIds || [],
      thinking: thinkValue(), conversation_id: state.convId || '', subject: state.convSubject || '全部',
      skill: state.skill || '',
      artifact_id: state.editArtifact ? state.editArtifact.id : ''
    };
    var userMsg = {
      id: 'tmp-u-' + Date.now(), _key: newKey('u'), role: 'user',
      kind: (imgs && imgs.length) ? 'image' : 'text',
      content_md: text, reasoning_md: '', images: imgs || [], questions: questions || [], status: 'done', error: '',
      skill: state.skill || '', artifact_id: state.editArtifact ? state.editArtifact.id : ''
    };
    var asst = {
      id: 'tmp-a-' + Date.now(), _key: newKey('a'), role: 'assistant', kind: 'text',
      content_md: '', reasoning_md: '', images: [], status: 'streaming', error: '', skill: state.skill || '',
      _payload: payload, _userMsg: userMsg
    };
    state.messages.push(userMsg, asst);
    if (state.editArtifact) { state.editArtifact = null; renderSkillChips(); }
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
          asst._hasQuiz = (asst.parts || []).some(function (p) { return p && p.type === 'quiz'; });
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
    } else if (!asst.content_md && !asst._hasQuiz) {
      asst.status = 'error';
      asst.error = '空回复';
      dropLive(asst);
    } else {
      asst.status = 'done';
    }

    if (asst._hasQuiz) {
      dropLive(asst);
      renderStream(true);
      scrollToBottom(false);
    } else if (asst._st) {
      asst._st.target = asst.content_md;
      asst._st.final = true;
      pumpReveal(asst);
    } else {
      renderStream(true);
    }
    if (sawDone && !srvErr && asst.id) pollDeposit(asst.id);
  }

  async function resendLast() {
    if (state.sending) return;
    var user = null;
    for (var i = state.messages.length - 1; i >= 0; i--) {
      if (state.messages[i].role === 'user') { user = state.messages[i]; break; }
    }
    if (!user || !(user.content_md || '').trim()) return;
    var ta = q('#ta');
    if (!ta) return;
    ta.value = user.content_md;
    autosize();
    syncSend();
    await submitMessage();
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
    'rail-chat': function () { openConversations(); },
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
    'back-convs': function () { openConversations(); },
    'new-conv': function () { openNewChatSheet(); },
    'new-conv-subject': function (el) { newConversation(el.getAttribute('data-subject')); },
    'open-conv': function (el) { openConversation(el.getAttribute('data-id')); },
    'conv-filter': function (el) { state.convFilter = el.getAttribute('data-subject') || ''; loadConversations(); },
    'rail-bank': function () { openBank(); },
    'rail-library': function () { openLibrary(); },
    'library-reload': function () { loadLibrary(); },
    'library-kind': function (el) { libKind(el.getAttribute('data-kind') || ''); },
    'lib-search': function () { libSearch(); },
    'artifact-menu': function (el) { openArtifactMenu(el.getAttribute('data-id') || ''); },
    'artifact-continue': function (el) { continueArtifact(el.getAttribute('data-id') || ''); },
    'artifact-rename-open': function (el) { openArtifactRename(el.getAttribute('data-id') || ''); },
    'artifact-rename-save': function () { renameArtifact(); },
    'artifact-delete': function (el) { deleteArtifact(el.getAttribute('data-id') || ''); },
    'clear-edit': function () { clearEditContext(); },
    'artifact-open': function (el) { openArtifactById(el.getAttribute('data-id') || ''); },
    'close-preview': function () { closePreview(); },
    'rail-map': function () { openMap(); },
    'rail-week': function () { openWeek(); },
    'week-reload': function () { openWeek(); },
    'open-theme': function () { setOverlay({ kind: 'theme' }); },
    'open-profile': function () { showOnboarding(true); },
    'open-skill-sheet': function () { openSkillSheet(); },
    'open-hero-subjects': function () { openHeroSubjects(); },
    'hero-subject': function (el) { pickHeroSubject(el.getAttribute('data-subject') || '全部'); },
    'hero-send': function (el) { heroSend(el.getAttribute('data-text') || ''); },
    'pick-skill': function (el) { pickSkill(el.getAttribute('data-id') || ''); },
    'clear-skill': function () { clearSkill(); },
    'theme-pick': function (el) { pickTheme(el.getAttribute('data-v') || 'system'); },
    'map-reload': function () { loadMap(); },
    'map-subject': function (el) { mapSubject(el.getAttribute('data-subject') || ''); },
    'map-module': function (el) { mapModule(el.getAttribute('data-module') || ''); },
    'map-chapter': function (el) { mapChapter(el.getAttribute('data-id') || ''); },
    'map-select': function (el) { mapSelect(el.getAttribute('data-id') || ''); },
    'map-unselect': function () { mapUnselect(); },
    'map-search': function () { mapSearch(); },
    'map-zoom-in': function () { mapZoom(1.25); },
    'map-zoom-out': function () { mapZoom(0.8); },
    'map-zoom-fit': function () { mapZoomFit(); },
    'map-bank': function (el) { mapOpenBank(el.getAttribute('data-id') || ''); },
    'map-open-q': function (el) { openQuestionPanel(el.getAttribute('data-id') || ''); },
    'quiz-pick': function (el) { answerQuiz(el.getAttribute('data-id') || '', el.getAttribute('data-choice') || ''); },
    'quiz-ask': function (el) { quizAsk(el.getAttribute('data-id') || ''); },
    'dep-undo': function (el) { undoDeposit(el.getAttribute('data-id') || '', el.getAttribute('data-key') || ''); },
    'nudge-act': function (el) { nudgeAct(el); },
    'kp-open-map': function (el) { openMapPoint(el.getAttribute('data-id') || ''); },
    'edit-question': function () { openEditQuestion(state.question); },
    'qedit-save': function () { saveEditQuestion(); },
    'open-question': function (el) {
      var id = el.getAttribute('data-id');
      if (!state.page) openQuestionPanel(id);
      else openQuestionDetail(id);
    },
    'close-qpanel': function () { state.qpanel = null; render(); },
    'qpanel-quote': function () {
      if (state.qpanel && state.qpanel.data) quoteQuestion(state.qpanel.data);
    },
    'bank-filter': function (el) { bankFilter(el.getAttribute('data-subject') || ''); },
    'bank-search': function () { bankSearch(); },
    'bank-reload': function () { loadBank(); },
    'bank-capture': function () { openCapture('bank'); },
    'bank-open-filter': function (el) { bankOpenFilter(el.getAttribute('data-field') || 'grade'); },
    'bank-filter-pick': function (el) { bankFilterPick(el.getAttribute('data-v')); },
    'bank-reset': function () { bankReset(); },
    'bank-solve-missing': function () { bankSolveMissing(); },
    'open-kp-filter': function () {
      var b = bankState();
      var sel = {};
      if (b.kp) sel[b.kp] = true;
      openKpSheet('filter', { subject: b.subject || currentSubjectName(), selected: sel });
    },
    'kp-search': function () { kpSheetSearch(); },
    'kp-toggle': function (el) { kpSheetToggle(el.getAttribute('data-id')); },
    'kp-clear': function () { closeOverlay(); bankPatch({ kp: '', kpName: '' }); },
    'edit-kps': function () {
      var r = state.question;
      if (!r) return;
      var sel = {};
      (r.kps || []).forEach(function (k) { sel[k.id] = true; });
      openKpSheet('edit', {
        subject: r.subject,
        qid: r.id,
        selected: sel,
        pinned: (r.kps || []).slice()
      });
    },
    'regen-solve': function () { regenSolve(); },
    'question-quote': function () { quoteQuestion(state.question); },
    'confirm-capture': function () { confirmCapture(); },
    'cap-camera': function () { var f = q('#cap-camera'); if (f) f.click(); },
    'cap-album': function () { var f = q('#cap-file'); if (f) f.click(); },
    'cap-correct': function () {
      var o = state.overlay;
      if (!o || o.kind !== 'capture') return;
      o.correct = o.correct === false;
      renderOverlay();
    },
    'open-picker': function () { state.overlay = null; openQuestionPicker(); },
    'cap-toggle': function (el) { captureToggle(el.getAttribute('data-i')); },
    'cap-subject': function (el) {
      var o = state.overlay;
      if (!o || o.kind !== 'capture') return;
      o.subject = el.getAttribute('data-subject') || '';
      renderOverlay();
    },
    'cap-add': function () { captureCommit(); },
    'open-qrefs': function () { openQrefs(state.pendingQuestions || [], true); },
    'qsrc-open': function (el) {
      var id = el.getAttribute('data-id');
      if (!id) return;
      state.overlay = null;
      openQuestionPanel(id);
    },
    'open-qrefs-msg': function (el) {
      var key = el.getAttribute('data-key');
      var m = (state.messages || []).filter(function (x) { return x._key === key; })[0];
      if (m) openQrefs(m.questions || [], false);
    },
    'qref-open': function (el) {
      var o = state.overlay;
      if (!o || o.kind !== 'qrefs') return;
      var q = (o.items || [])[Number(el.getAttribute('data-i'))];
      if (q && q.id) openQuestionPanel(q.id);
    },
    'qref-del': function (el) {
      var i = Number(el.getAttribute('data-i'));
      state.pendingQuestions.splice(i, 1);
      if (state.overlay && state.overlay.kind === 'qrefs') state.overlay.items = state.pendingQuestions.slice();
      renderOverlay();
      renderQchips();
      syncSend();
    },
    'picker-toggle': function (el) { pickerToggle(el.getAttribute('data-id')); },
    'picker-search': function () { pickerSearch(); },
    'picker-apply': function () { pickerApply(); },
    'cap-retry': function () { var o = state.overlay; if (o) { o.step = 'pick'; o.error = ''; renderOverlay(); } },
    'drop-question': function (el) { state.pendingQuestions.splice(Number(el.getAttribute('data-i')), 1); renderQchips(); syncSend(); },
    'open-capture': function () {
      if (state.capturePending && state.capturePending.length) openReview(state.capturePending[0].id);
      else toast('没有待处理的采集');
    },
    'retry-capture': function () { retryCapture(); },
    'rev-del': function (el) { deleteReviewQuestion(Number(el.getAttribute('data-gi')), Number(el.getAttribute('data-qi'))); },
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
    'resend-last': function () { resendLast(); },
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
      return;
    }
    if (e.key === 'Enter' && e.target && e.target.id === 'map-q') {
      e.preventDefault();
      mapSearch();
    }
    if (e.key === 'Enter' && e.target && e.target.id === 'lib-q') {
      e.preventDefault();
      libSearch();
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
    var mapResizeTimer = 0;
    window.addEventListener('resize', function () {
      clearTimeout(mapResizeTimer);
      mapResizeTimer = setTimeout(function () {
        if (state.mapCy) { state.mapCy.resize(); state.mapCy.fit(undefined, 40); }
      }, 180);
    });

    if (window.matchMedia) {
      var scheme = window.matchMedia('(prefers-color-scheme: dark)');
      var onScheme = function () {
        if (themeMode() === 'system') applyTheme('system', false);
      };
      if (scheme.addEventListener) scheme.addEventListener('change', onScheme);
      else if (scheme.addListener) scheme.addListener(onScheme);
    }

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

    q('#btn-attach').addEventListener('click', function () { openCapture(); });
    
    q('#file-attach').addEventListener('change', function (e) { onFiles(e.target.files); });

    var stream = q('#stream');
    stream.addEventListener('scroll', function () {
      state.stick = (stream.scrollHeight - stream.scrollTop - stream.clientHeight) < 80;
    updateToBottom();
    });
    stream.addEventListener('toggle', onToggle, true);
  }

  /* ── 个人资料 / 首次引导 ───────────────────────────── */
  var PROFILE_KEY = 'xm_profile';
  function agentName() { return (state.profile && state.profile.agent_name) || '小满'; }
  function localProfile() {
    try {
      var raw = localStorage.getItem(PROFILE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function applyProfile() {
    var name = agentName();
    document.title = name + ' · 学习空间';
    var brand = q('#top-brand');
    if (brand && state.view === 'chat' && !state.convId) brand.textContent = name;
    var heroBrand = q('.hero-brand span');
    if (heroBrand) heroBrand.textContent = name + ' · 学习空间';
  }
  async function loadProfile() {
    var local = localProfile();
    var server = null;
    try { server = await api('/profile'); } catch (e) { /* 旧服务器没有这个接口 */ }
    var pick = null;
    if (server && server.completed) pick = server;
    else if (local && local.completed) pick = local;
    else pick = server || local;
    state.profile = pick;
    state.profileLoaded = true;
    if (!pick || !pick.completed) {
      showOnboarding(false);
    } else {
      applyProfile();
      if (local && local.completed && (!server || !server.completed)) {
        try { await api('/profile', { method: 'PATCH', json: local }); } catch (e) {}
      }
    }
  }
  function showOnboarding(edit) {
    var p = state.profile || {};
    var box = q('#onboarding');
    if (!box) return;
    q('#ob-title').textContent = edit ? '个人资料' : '她叫什么，你叫什么？';
    q('#ob-agent').value = p.agent_name || '小满';
    q('#ob-user').value = p.user_name || '';
    q('#ob-grade').value = p.grade || '高一';
    var gender = p.gender === 'female' || p.gender === 'male' ? p.gender : 'other';
    qa('.ob-seg [data-gender]').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-gender') === gender);
      b.setAttribute('aria-pressed', b.classList.contains('on') ? 'true' : 'false');
    });
    box.dataset.edit = edit ? '1' : '0';
    box.hidden = false;
    setTimeout(function () { var a = q('#ob-agent'); if (a) a.focus(); }, 30);
  }
  function closeOnboarding() { var b = q('#onboarding'); if (b) b.hidden = true; }
  async function saveOnboarding() {
    var go = q('#ob-go');
    var agent = (q('#ob-agent').value || '').trim().slice(0, 12) || '小满';
    var user = (q('#ob-user').value || '').trim().slice(0, 20);
    var grade = q('#ob-grade').value || '高一';
    var g = q('.ob-seg [data-gender].on');
    var profile = {
      agent_name: agent,
      user_name: user,
      gender: g ? g.getAttribute('data-gender') : '',
      grade: grade,
      completed: true
    };
    if (go) { go.disabled = true; go.textContent = '保存中…'; }
    state.profile = profile;
    try { localStorage.setItem(PROFILE_KEY, JSON.stringify(profile)); } catch (e) {}
    try { await api('/profile', { method: 'PATCH', json: profile }); } catch (e) {}
    if (go) { go.disabled = false; go.textContent = '开始对话'; }
    closeOnboarding();
    applyProfile();
    render();
    var ta = q('#ta');
    if (ta) setTimeout(function () { ta.focus(); }, 80);
  }
  function bindOnboarding() {
    var box = q('#onboarding');
    if (!box) return;
    qa('.ob-seg [data-gender]').forEach(function (b) {
      b.addEventListener('click', function () {
        qa('.ob-seg [data-gender]').forEach(function (x) {
          x.classList.remove('on'); x.setAttribute('aria-pressed', 'false');
        });
        b.classList.add('on'); b.setAttribute('aria-pressed', 'true');
      });
    });
    q('#ob-go').addEventListener('click', saveOnboarding);
    q('#ob-user').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); saveOnboarding(); }
    });
  }

  /* ── 启动 ─────────────────────────────────────────── */
  async function forceToday() {
    try { await api('/subject', { method: 'PATCH', json: { subject: '全部' } }); } catch (e) { /* 忽略 */ }
  }

  async function boot() {
    applyTheme(themeMode(), false);
    await loadSprite();
    upgradeIcons();
    hydrateIcons();
    bindEvents();
    bindReviewInputs();
    bindOnboarding();
    await loadProfile();
    document.addEventListener('change', function (e) {
      var id = e.target && e.target.id;
      if (id === 'cap-camera' || id === 'cap-file') {
        var f = e.target.files && e.target.files[0];
        if (f) captureFile(f);
        e.target.value = '';
      }
    });
    autosize();
    render();

    var wantSubject = '';
    if (location.hash.indexOf('#subject=') === 0) {
      wantSubject = decodeURIComponent(location.hash.slice(9));
    } else {
      try { wantSubject = localStorage.getItem('xm_subject') || ''; } catch (e) {}
    }
    if (wantSubject && wantSubject !== '全部') {
      try { await api('/subject', { method: 'PATCH', json: { subject: wantSubject } }); } catch (e) {}
    } else {
      await forceToday();
    }
    await Promise.all([loadProviders(), loadSettings(true), loadCatalog(), loadSubjects(), loadToday(), loadCapturePending(), loadConversations(), loadSkills()]);
    if (location.hash.indexOf('#c=') === 0) {
      await openConversation(decodeURIComponent(location.hash.slice(3)));
    } else {
      openConversations();
    }
    // 深链：#review=<taskId> 直接进复核页（也给验收截图用）
    if (location.hash.indexOf('#review=') === 0) {
      await loadMessages();
      await openReview(decodeURIComponent(location.hash.slice(8)));
      return;
    }
    if (location.hash === '#library') { openLibrary(); return; }
    if (location.hash === '#bank') { openBank(); return; }
    if (location.hash === '#map') { openMap(); return; }
    if (location.hash === '#bankcap') {
      await loadMessages();
      openBank();
      openCapture('bank');
      render();
      return;
    }
    if (location.hash === '#pick') { await loadMessages(); await openQuestionPicker(); return; }
    if (location.hash.indexOf('#qpanel=') === 0) { await loadMessages(); await openQuestionPanel(decodeURIComponent(location.hash.slice(8))); return; }
    if (location.hash.indexOf('#question=') === 0) {
      await loadMessages();
      await openQuestionDetail(decodeURIComponent(location.hash.slice(10)));
      return;
    }
    if (location.hash.indexOf('#capture') === 0) {
      await loadMessages();
      openCapture();
      var tid = location.hash.indexOf('#capture=') === 0 ? decodeURIComponent(location.hash.slice(8)) : '';
      if (tid) {
        try {
          var ct = await api('/capture/tasks/' + encodeURIComponent(tid) + '?full=true');
          state.overlay.task = ct;
          state.overlay.taskId = tid;
          state.overlay.groups = (ct.groups && ct.groups.groups) || [];
          state.overlay.selected = {};
          flatQuestions(state.overlay.groups).forEach(function (f, i) { state.overlay.selected[i] = true; });
          state.overlay.preview = '/api/v1/capture/page/' + tid;
          state.overlay.step = 'select';
        } catch (e) { /* 保持 pick */ }
      }
      render();
      return;
    }
    render();

    if (state.settings && state.settings.provider_id != null) {
      await loadModelsFor(state.settings.provider_id);
      render();
    }
    await loadMessages();
    render();
    checkNudge();
  }

  boot();
})();
