/* 小满 · MD3 平板原型交互
   只做设计稿需要的状态切换：导航、新对话/会话、右栏、弹层、主题、输入。 */
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  var screens = $$('.xm-screen');
  var railLinks = $$('[data-nav]');
  var chatScreen = $('[data-screen="chat"]');
  var streamNew = $('#stream-new');
  var streamThread = $('#stream-thread');
  var chatTitle = $('#chat-title');
  var chatSub = $('#chat-sub');
  var detailPane = $('#detail-pane');

  /* ---------- 路由 ---------- */
  function routeName() {
    var raw = (location.hash || '').replace(/^#\/?/, '');
    return (raw.split('?')[0] || 'chat');
  }

  function showScreen(name) {
    screens.forEach(function (s) {
      s.hidden = s.dataset.screen !== name;
    });
    railLinks.forEach(function (a) {
      var on = a.dataset.nav === name;
      if (on) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    if (name !== 'chat') setDetail(false);
  }

  function setThread(on) {
    if (!streamNew || !streamThread) return;
    streamNew.hidden = on;
    streamThread.hidden = !on;
    chatTitle.textContent = on ? '连接体问题怎么拆' : '小满';
    chatSub.textContent = on ? '物理 · 6 条' : '全部学科 · 今天';
    var quote = document.querySelector('.xm-composer__top');
    if (quote) quote.hidden = !on;
    if (on) {
      var st = streamThread;
      requestAnimationFrame(function () { st.scrollTop = 0; });
    }
    $$('.xm-conv').forEach(function (c) { c.classList.remove('is-on'); });
    if (on) {
      var first = $('.xm-conv');
      if (first) first.classList.add('is-on');
    }
  }

  function setDetail(on) {
    if (!chatScreen) return;
    chatScreen.dataset.detail = on ? '1' : '0';
    if (detailPane) detailPane.hidden = !on;
  }

  function applyRoute() {
    var name = routeName();
    if (name === 'thread' || name === 'new' || name === 'detail') {
      showScreen('chat');
      setThread(name !== 'new');
      setDetail(name === 'detail');
      return;
    }
    if (name === 'subject') { showScreen('chat'); openDialog('dlg-subject'); return; }
    if (name === 'question') { showScreen('bank'); openDialog('sheet-question'); return; }
    if (name === 'modelsheet') { showScreen('chat'); openDialog('sheet-model'); return; }
    if (name === 'skill') { showScreen('chat'); openDialog('dlg-skill'); return; }
    if (name === 'review') {
      showScreen('week');
      openDialog('dlg-review');
      return;
    }
    if (name === 'capture') {
      showScreen('chat');
      openDialog('dlg-capture');
      return;
    }
    var known = ['chat', 'bank', 'library', 'map', 'memories', 'week', 'settings'];
    if (known.indexOf(name) < 0) name = 'chat';
    showScreen(name);
    if (name === 'chat') setThread(false);
  }

  window.addEventListener('hashchange', applyRoute);

  /* ---------- 弹层 ---------- */
  function openDialog(id) {
    var d = document.getElementById(id);
    if (!d) return;
    if (!d.open) {
      if (typeof d.showModal === 'function') d.showModal();
      else d.setAttribute('open', '');
    }
  }

  function closeDialog(el) {
    var d = el && el.closest ? el.closest('dialog') : null;
    if (d && d.open) d.close();
  }

  document.addEventListener('click', function (e) {
    var closer = e.target.closest('[data-close]');
    if (closer) { closeDialog(closer); return; }

    var el = e.target.closest('[data-action]');
    if (!el) return;
    var act = el.dataset.action;

    if (act === 'open-subject') { openDialog('dlg-subject'); return; }
    if (act === 'open-model') { openDialog('sheet-model'); return; }
    if (act === 'open-skill') { openDialog('dlg-skill'); return; }
    if (act === 'open-question') { closeDialog(el); openDialog('sheet-question'); return; }
    if (act === 'open-review') { closeDialog(el); openDialog('dlg-review'); return; }
    if (act === 'open-capture') { openDialog('dlg-capture'); return; }
    if (act === 'finish-capture') {
      closeDialog(el);
      location.hash = '#/bank';
      return;
    }
    if (act === 'open-detail') { setDetail(true); return; }
    if (act === 'close-detail') { setDetail(false); return; }
    if (act === 'open-thread') { location.hash = '#/thread'; return; }
    if (act === 'new-chat') { location.hash = '#/new'; return; }
    if (act === 'trace') {
      var open = el.getAttribute('aria-expanded') === 'true';
      el.setAttribute('aria-expanded', open ? 'false' : 'true');
      return;
    }
    if (act === 'toggle-theme') { applyTheme(document.body.classList.contains('dark') ? 'light' : 'dark'); return; }
  });

  /* 复习 / 拍题关闭后回到来源屏 */
  ['dlg-review', 'dlg-capture'].forEach(function (id) {
    var d = document.getElementById(id);
    if (!d) return;
    d.addEventListener('close', function () {
      var name = routeName();
      if (id === 'dlg-review' && name === 'review') location.hash = '#/week';
      if (id === 'dlg-capture' && name === 'capture') location.hash = '#/chat';
    });
  });

  /* ---------- 学科空间 ---------- */
  $$('#subject-grid .xm-opt').forEach(function (btn) {
    btn.addEventListener('click', function () {
      $$('#subject-grid .xm-opt').forEach(function (b) { b.classList.remove('is-on'); });
      btn.classList.add('is-on');
      var name = btn.dataset.subject;
      var icon = btn.dataset.icon;
      $$('.xm-space').forEach(function (chip) {
        var label = $('.xm-space__name', chip);
        if (label) label.textContent = name;
        var i = chip.querySelector('.material-symbols-outlined');
        if (i) i.textContent = icon;
      });
      var hn = $('#hero-name');
      if (hn) hn.textContent = name;
      var hi = $('#hero-icon');
      if (hi) hi.textContent = icon;
      closeDialog(btn);
    });
  });

  /* ---------- 主题 ---------- */
  function applyTheme(t) {
    document.body.classList.toggle('dark', t === 'dark');
    document.body.classList.toggle('light', t !== 'dark');
    document.documentElement.dataset.theme = t;
    var sw = $('#theme-switch');
    if (sw) sw.checked = t === 'dark';
    var btn = $('[data-action="toggle-theme"]');
    if (btn) btn.textContent = t === 'dark' ? 'light_mode' : 'dark_mode';
    try { localStorage.setItem('xm_md3_theme', t); } catch (e) {}
  }

  var themeSwitch = $('#theme-switch');
  if (themeSwitch) {
    themeSwitch.addEventListener('change', function () {
      applyTheme(themeSwitch.checked ? 'dark' : 'light');
    });
  }

  /* ---------- 输入 ---------- */
  var ta = $('#ta');
  if (ta) {
    var grow = function () {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 148) + 'px';
    };
    ta.addEventListener('input', grow);
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send();
      }
    });
  }

  function send() {
    if (!ta) return;
    var text = ta.value.trim();
    if (!text) return;
    if (routeName() !== 'thread') {
      showScreen('chat');
      setThread(true);
    }
    var col = $('#stream-thread .xm-col');
    if (!col) return;
    var msg = document.createElement('div');
    msg.className = 'xm-msg xm-msg--me';
    var bubble = document.createElement('div');
    bubble.className = 'xm-bubble';
    bubble.textContent = text;
    msg.appendChild(bubble);
    col.appendChild(msg);
    ta.value = '';
    ta.style.height = 'auto';
    var st = $('#stream-thread');
    requestAnimationFrame(function () { st.scrollTop = st.scrollHeight; });
  }

  var sendBtn = $('#send');
  if (sendBtn) sendBtn.addEventListener('click', send);

  /* 输入框初始焦点（桌面调试时直接可打字） */
  var autofocus = function () {
    if (window.matchMedia('(pointer:fine)').matches && ta && routeName() !== 'thread') {
      /* 不自动聚焦，避免打开页面就弹键盘；保留点击聚焦 */
    }
  };

  /* ---------- 模型 / 技能选择 ---------- */
  $$('.xm-model').forEach(function (row) {
    row.addEventListener('click', function () {
      var group = row.closest('.xm-group, .xm-sheet__group') || document;
      $$('.xm-model', group).forEach(function (r) { r.classList.remove('is-on'); });
      row.classList.add('is-on');
    });
  });

  /* ---------- 启动 ---------- */
  var forcedTheme = new URLSearchParams(location.search).get('theme');
  applyTheme(forcedTheme === 'dark' || forcedTheme === 'light'
    ? forcedTheme
    : (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'));
  applyRoute();
  autofocus();
})();
