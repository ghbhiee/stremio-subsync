// Web UI for the 字幕对齐 (stremio-subsync) addon, injected into a self-hosted stremio-web.
// It adds to the player's subtitles menu: a bilingual switch and an "AI Chinese subtitle" button in the
// Chinese column, an "align" button in the English column, live progress, and notifications when the
// work finishes (the finished subtitle is then loaded without interrupting playback). It also keeps
// English first and Chinese second in the language list, maps A/S/D to previous / repeat / next
// sentence, pauses while the mouse rests on the subtitle and shows a Chinese dictionary entry when an
// English word is clicked. Everything is best-effort: if the player's internals cannot be found, the
// stock UI keeps working unchanged.
(function () {
  'use strict';

  var MANIFEST = '__SUBSYNC_MANIFEST__'; // filled in by deploy.sh
  if (!/^https?:/.test(MANIFEST)) return;
  var BASE = MANIFEST.replace(/\/manifest\.json$/, '');
  var SUB_RE = /\/sub\/([0-9a-f]{16})\/([^/?#]+)\.srt(?:\?([^#]*))?$/;
  var CHI = { chi: 1, zho: 1, zht: 1, zhs: 1, chs: 1, cht: 1, ze: 1, zh: 1 };
  var LS_BI = 'subsync.bilingual', LS_HOVER = 'subsync.hoverPause';
  var POLL_MS = 2500;
  var ORIGIN = '字幕对齐';

  var st = {
    video: null, videoEl: null, subsEl: null, root: null,
    tracks: [], selectedId: null, selSig: null,
    time: null, paused: null, delay: 0, preview: [], streamSig: null,
    shortKey: null, status: null, statusAt: 0, pollTimer: null,
    live: {}, liveN: 0, alignEpoch: 0, mtEpoch: 0, mtPartial: false, mtPromptShown: false,
    pausedByHover: false, hoverTimer: null, popup: null, popupWord: null,
    menuObserver: null, videoObserver: null,
  };
  var bound = typeof WeakSet === 'function' ? new WeakSet() : { has: function () { return false; }, add: function () {} };
  window.__subsync = st; // read-only debugging handle

  // ---------- small helpers ----------

  function pref(key, def) { try { var v = localStorage.getItem(key); return v === null ? def : v === '1'; } catch (e) { return def; } }
  function setPref(key, v) { try { localStorage.setItem(key, v ? '1' : '0'); } catch (e) { /* ignore */ } }
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function isInputFocused() {
    var a = document.activeElement;
    return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable);
  }
  function safeDispatch(action) {
    if (!st.video) return false;
    try { st.video.dispatch(action); return true; } catch (e) { console.warn('[subsync] dispatch failed', e); return false; }
  }
  function pluginUrl(track) { // the addon URL behind a track (the player normally fetches it through the engine)
    var u = track.fallbackUrl || track.url || '';
    if (u.indexOf(BASE) !== 0) {
      var m = /[?&]from=([^&]+)/.exec(u);
      if (m) { try { u = decodeURIComponent(m[1]); } catch (e) { u = ''; } }
    }
    return u.indexOf(BASE) === 0 ? u : null;
  }
  function parseTrack(track) {
    if (!track) return null;
    var u = pluginUrl(track);
    var m = u && SUB_RE.exec(u);
    if (!m) return null;
    var q = m[3] || '';
    return { shortKey: m[1], key: m[2], bi: /(^|&)bi=1(&|$)/.test(q), live: Boolean(st.live[track.id]), lang: track.lang, isZh: Boolean(CHI[track.lang]) };
  }
  function selectedTrack() {
    for (var i = 0; i < st.tracks.length; i++) if (st.tracks[i].id === st.selectedId) return st.tracks[i];
    return null;
  }
  function fmtTime(sec) { sec = Math.max(0, Math.round(sec)); var m = Math.floor(sec / 60), s = sec % 60; return m + ':' + (s < 10 ? '0' : '') + s; }

  // ---------- styles ----------

  var css = [
    '.ss-panel{margin:0 1rem .75rem;padding:.6rem .9rem;border-radius:var(--border-radius,.5rem);background:var(--overlay-color,rgba(255,255,255,.08));color:var(--primary-foreground-color,#fff);font-size:.95rem;line-height:1.45}',
    '.ss-row{display:flex;align-items:center;gap:.5rem;margin:.2rem 0;min-height:1.6rem}',
    '.ss-row .ss-txt{flex:1;min-width:0;overflow-wrap:anywhere}',
    '.ss-btn{flex:none;cursor:pointer;padding:.25rem .6rem;border-radius:.4rem;border:0;background:var(--secondary-accent-color,#7b5bf5);color:#fff;font:inherit;font-size:.85rem}',
    '.ss-btn:hover{filter:brightness(1.15)}.ss-btn[disabled]{opacity:.5;cursor:default}',
    '.ss-sw{position:relative;flex:none;width:2.4rem;height:1.3rem;border-radius:1rem;background:rgba(255,255,255,.25);cursor:pointer;transition:background .15s}',
    '.ss-sw::after{content:"";position:absolute;top:.15rem;left:.15rem;width:1rem;height:1rem;border-radius:50%;background:#fff;transition:left .15s}',
    '.ss-sw.on{background:var(--secondary-accent-color,#7b5bf5)}.ss-sw.on::after{left:1.25rem}',
    '.ss-muted{opacity:.7;font-size:.85rem}.ss-title{font-weight:700}',
    '.ss-chk{display:flex;align-items:center;gap:.4rem;cursor:pointer;opacity:.8;font-size:.85rem}.ss-chk input{margin:0}',
    '.ss-toasts{position:absolute;top:4.5rem;right:1.5rem;z-index:40;display:flex;flex-direction:column;gap:.5rem;pointer-events:none;max-width:26rem}',
    '.ss-toast{pointer-events:auto;display:flex;align-items:center;gap:.75rem;padding:.75rem 1rem;border-radius:.6rem;background:var(--modal-background-color,rgba(16,16,28,.92));color:var(--primary-foreground-color,#fff);box-shadow:0 .6rem 1.5rem rgba(0,0,0,.4);backdrop-filter:blur(12px);font-size:1rem;line-height:1.4;cursor:pointer}',
    '.ss-toast .ss-btn{font-size:.9rem}',
    '.ss-badge{position:absolute;left:50%;top:18%;transform:translateX(-50%);z-index:35;padding:.5rem 1.2rem;border-radius:2rem;background:rgba(0,0,0,.6);color:#fff;font-size:1.3rem;pointer-events:none;opacity:0;transition:opacity .15s}',
    '.ss-badge.show{opacity:1}',
    '.ss-w{cursor:pointer;border-radius:.2em;transition:background .1s}.ss-w:hover{background:rgba(255,255,255,.28)}',
    '.ss-pop{position:absolute;z-index:45;max-width:24rem;min-width:12rem;padding:.7rem .9rem;border-radius:.6rem;background:var(--modal-background-color,rgba(16,16,28,.95));color:var(--primary-foreground-color,#fff);box-shadow:0 .6rem 1.5rem rgba(0,0,0,.45);backdrop-filter:blur(12px);font-size:1rem;line-height:1.45;text-align:left;text-shadow:none;white-space:normal}',
    '.ss-pop .ss-pw{font-size:1.25rem;font-weight:700}.ss-pop .ss-ph{margin-left:.5rem;font-weight:400;opacity:.75;font-size:.95rem}',
    '.ss-pop .ss-pe{margin-top:.2rem}.ss-pop .ss-pc{margin-top:.4rem;padding-top:.4rem;border-top:1px solid rgba(255,255,255,.15)}',
    '.ss-pop .ss-pl{opacity:.6;font-size:.8rem;margin-right:.3rem}',
  ].join('\n');
  var styleEl = el('style'); styleEl.textContent = css; (document.head || document.documentElement).appendChild(styleEl);

  // ---------- finding the player's video object through React internals ----------

  function fiberOf(node) { for (var k in node) if (k.indexOf('__reactFiber$') === 0) return node[k]; return null; }
  function findVideoInstance(videoEl) {
    // The <video> element is created by stremio-video, not React: start from the first React-owned ancestor.
    var node = videoEl, hops = 0;
    while (node && !fiberOf(node) && hops++ < 5) node = node.parentElement;
    var f = node ? fiberOf(node) : null, depth = 0;
    while (f && depth++ < 80) {
      var h = f.memoizedState, n = 0;
      while (h && typeof h === 'object' && n++ < 120) {
        var v = h.memoizedState;
        if (v && typeof v === 'object' && v.current && typeof v.current.dispatch === 'function' && typeof v.current.on === 'function' && typeof v.current.destroy === 'function') return v.current;
        h = h.next;
      }
      f = f.return;
    }
    return null;
  }

  function onProp(name, value) {
    switch (name) {
      case 'stream': {
        var sig = value ? JSON.stringify(value).slice(0, 400) : '';
        if (sig !== st.streamSig) { st.streamSig = sig; resetVideo(); }
        break;
      }
      case 'time': st.time = typeof value === 'number' ? value : null; break;
      case 'paused': {
        if (value === false && st.pausedByHover) st.pausedByHover = false; // the user resumed by hand
        st.paused = value;
        break;
      }
      case 'extraSubtitlesDelay': st.delay = typeof value === 'number' ? value : 0; break;
      case 'extraSubtitlesPreview': st.preview = Array.isArray(value) ? value : []; break;
      case 'extraSubtitlesTracks': st.tracks = Array.isArray(value) ? value : []; onTracks(); break;
      case 'selectedExtraSubtitlesTrackId': if (value !== st.selectedId) { st.selectedId = value; onSelection(); } break;
    }
  }

  function bind(videoEl) {
    var inst = findVideoInstance(videoEl);
    if (!inst) return false;
    st.videoEl = videoEl;
    st.root = (videoEl.parentElement && videoEl.parentElement.parentElement && videoEl.parentElement.parentElement.parentElement) || document.body;
    if (st.video !== inst) {
      st.video = inst;
      if (!bound.has(inst)) {
        try { inst.on('propValue', onProp); inst.on('propChanged', onProp); } catch (e) { st.video = null; return false; }
        bound.add(inst);
      }
      ['stream', 'time', 'paused', 'extraSubtitlesTracks', 'selectedExtraSubtitlesTrackId', 'extraSubtitlesDelay', 'extraSubtitlesPreview']
        .forEach(function (p) { safeDispatch({ type: 'observeProp', propName: p }); });
    }
    watchSubtitlesElement();
    if (!st.menuObserver) {
      st.menuObserver = new MutationObserver(scheduleMenu);
      st.menuObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    }
    return true;
  }

  function unbind() {
    st.video = null; st.videoEl = null; st.subsEl = null;
    if (st.menuObserver) { st.menuObserver.disconnect(); st.menuObserver = null; }
    if (st.videoObserver) { st.videoObserver.disconnect(); st.videoObserver = null; }
    closePopup();
    resetVideo();
  }

  function resetVideo() {
    stopPolling();
    st.shortKey = null; st.status = null; st.statusAt = 0; st.live = {}; st.selSig = null;
    st.alignEpoch = 0; st.mtEpoch = 0; st.mtPartial = false; st.mtPromptShown = false;
    st.preview = []; st.pausedByHover = false;
    closePopup();
  }

  setInterval(function () {
    var v = document.querySelector('video');
    if (v && v !== st.videoEl) bind(v);
    else if (!v && st.videoEl) unbind();
    else if (v && st.videoEl && !document.contains(st.videoEl)) unbind();
  }, 1000);

  // ---------- server state ----------

  function fetchStatus() {
    if (!st.shortKey) return Promise.resolve(null);
    var key = st.shortKey;
    return fetch(BASE + '/status/' + key, { cache: 'no-store' }).then(function (r) {
      if (r.status === 404) return { missing: true };
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (s) { if (key === st.shortKey) applyStatus(s); return s; })
      .catch(function (e) { console.warn('[subsync] status failed', e); return null; });
  }

  function postAction(body) {
    if (!st.shortKey) return Promise.resolve(null);
    var key = st.shortKey;
    return fetch(BASE + '/action/' + key, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .then(function (s) { if (key === st.shortKey && s && s.ok) applyStatus(s); startPolling(); return s; })
      .catch(function (e) { toast('操作失败：' + e.message, 'error'); return null; });
  }

  function busy(s) {
    return Boolean(s && !s.missing && (s.align.running || s.translate.state === 'waiting-align' || s.translate.state === 'running'));
  }
  function startPolling() {
    stopPolling();
    st.pollTimer = setTimeout(function () {
      st.pollTimer = null;
      fetchStatus().then(function (s) { if (busy(s)) startPolling(); });
    }, POLL_MS);
  }
  function stopPolling() { if (st.pollTimer) { clearTimeout(st.pollTimer); st.pollTimer = null; } }

  function applyStatus(s) {
    var prev = st.status;
    st.status = s; st.statusAt = Date.now();
    if (s && !s.missing) {
      if (prev && !prev.missing) {
        var alignFinished = (prev.align.running && !s.align.running) || (prev.align.finishedAt !== s.align.finishedAt && !s.align.running && s.align.finishedAt);
        if (alignFinished) { st.alignEpoch++; onAlignFinished(s); }
        var wasWorking = prev.translate.state === 'waiting-align' || prev.translate.state === 'running';
        if (wasWorking && s.translate.state === 'done') { st.mtEpoch++; st.mtPartial = false; toast('AI 中文字幕已生成 ✅', 'success'); }
        else if (wasWorking && s.translate.state === 'failed') toast('AI 中文字幕生成失败：' + (s.translate.error || '未知错误'), 'error');
        else if (prev.translate.source !== s.translate.source) st.mtPartial = false;
      }
      if (s.translate.state === 'running' && !st.mtPartial && s.translate.coveredUntil !== null && st.time !== null
        && s.translate.coveredUntil > st.time / 1000 + 600 && s.translate.coveredUntil > 600) {
        st.mtPartial = true; st.mtEpoch++; // enough of the beginning is translated: show it now, the rest follows when done
      }
    }
    renderPanel();
    syncDisplay();
  }

  function onAlignFinished(s) {
    var a = s.align;
    if (a.state === 'done') {
      var bestKey = s.best.en, label = bestKey && s.subs[bestKey] ? s.subs[bestKey].label : null;
      toast('字幕已对齐 ✅' + (label ? ' · 最佳：' + label : ' · 没有和视频匹配的英文字幕'), 'success');
      // The subtitle being watched turned out not to match the video while another one does: switch.
      var t = selectedTrack(), p = parseTrack(t);
      if (p && p.shortKey === st.shortKey && p.key !== 'mt' && p.key !== 'align' && p.key !== 'mt-start') {
        var info = s.subs[p.key], best = p.isZh ? s.best.zh : s.best.en;
        if (info && !info.good && best && best !== p.key) {
          addLive(best, p.isZh && pref(LS_BI, false), p.lang);
          toast('当前字幕与视频不匹配，已切换到最佳字幕：' + (s.subs[best] ? s.subs[best].label : best), 'info');
        }
      }
    } else if (a.state === 'noref') toast('无法对齐：视频没有内嵌字幕轨，候选字幕之间也不一致；时间轴保持原样', 'error', 9000);
    else if (a.state === 'novideo') toast('无法对齐：在播放引擎里找不到正在播放的文件', 'error', 9000);
    else if (a.state === 'failed') toast('对齐失败：' + (a.error || '未知错误'), 'error', 9000);
  }

  // ---------- keeping the displayed subtitle current ----------

  function onTracks() {
    var sk = null;
    for (var i = 0; i < st.tracks.length && !sk; i++) { var p = parseTrack(st.tracks[i]); if (p && !p.live) sk = p.shortKey; }
    if (sk && sk !== st.shortKey) {
      resetVideo();
      st.shortKey = sk;
      fetchStatus().then(function (s) { if (busy(s)) startPolling(); });
    }
    syncDisplay();
  }

  function onSelection() {
    var t = selectedTrack(), p = parseTrack(t);
    if (p && !p.live) st.selSig = sigFor(p.key, p.bi);
    syncDisplay();
  }

  function sigFor(key, bi) { return key + '|' + (bi ? 1 : 0) + '|' + st.alignEpoch + '|' + (key === 'mt' ? st.mtEpoch : 0); }

  function translateReady(s) {
    return Boolean(s && !s.missing && s.translate.enabled && (s.translate.state === 'done' || (s.translate.state === 'running' && st.mtPartial)));
  }

  // Compare what is shown with what should be shown; load a fresh copy from the addon when they differ.
  var syncTimer = null;
  function syncDisplay() {
    if (syncTimer) return;
    syncTimer = setTimeout(function () { syncTimer = null; syncNow(); }, 50);
  }
  function syncNow() {
    var t = selectedTrack(), p = parseTrack(t), s = st.status;
    if (!p || p.shortKey !== st.shortKey || p.key === 'align' || p.key === 'mt-start') return;
    var wantBi = p.isZh && pref(LS_BI, false);
    var current = p.live ? st.live[t.id].sig : st.selSig;
    var desired = sigFor(p.key, wantBi);
    if (current === desired) return;
    var cur = (current || '').split('|'), des = desired.split('|');
    var useful = cur[1] !== des[1]; // bilingual on/off changed: always worth a reload
    if (!s || s.missing) {
      if (!useful) return;
    } else if (p.key === 'mt') {
      if (!translateReady(s)) { // nothing translated yet: an AI track would only show English
        if (wantBi && !st.mtPromptShown && s.translate.enabled && s.translate.state !== 'running' && s.translate.state !== 'waiting-align') promptGenerate();
        remember(t, p, desired);
        return;
      }
      useful = useful || cur[2] !== des[2] || cur[3] !== des[3];
    } else {
      var aligned = s.subs[p.key] && s.subs[p.key].status === 'done';
      var enAligned = s.best.en && s.subs[s.best.en] && s.subs[s.best.en].status === 'done';
      if (cur[2] !== des[2] && (aligned || (wantBi && enAligned))) useful = true;
    }
    if (!useful) { remember(t, p, desired); return; }
    addLive(p.key, wantBi, p.lang);
  }
  function remember(t, p, sig) { if (p.live) st.live[t.id].sig = sig; else st.selSig = sig; }

  function labelFor(key, bi) {
    var s = st.status && !st.status.missing ? st.status : null;
    if (key === 'mt') {
      var done = s && s.translate.state === 'done';
      return (bi ? '🤖 中英双语（AI 翻译）' : '🤖 AI 中文字幕') + (done ? ' ✅' : ' · 生成中');
    }
    var base = s && s.subs[key] && s.subs[key].label ? s.subs[key].label : key;
    return (bi ? '🀄 中英双语 · ' : '') + base;
  }

  function addLive(key, bi, lang) {
    if (!st.shortKey || !st.video) return;
    var id = 'subsync-live-' + (++st.liveN);
    var sig = sigFor(key, bi);
    var url = BASE + '/sub/' + st.shortKey + '/' + key + '.srt?' + (bi ? 'bi=1&' : '') + 'r=' + st.liveN;
    st.live[id] = { key: key, bi: bi, sig: sig };
    var track = { id: id, lang: lang || (key === 'mt' ? 'chi' : 'eng'), label: labelFor(key, bi), url: url, origin: ORIGIN, embedded: false };
    if (!safeDispatch({ type: 'command', commandName: 'addExtraSubtitlesTracks', commandArgs: { tracks: [track] } })) return;
    safeDispatch({ type: 'setProp', propName: 'selectedExtraSubtitlesTrackId', propValue: id });
  }

  function promptGenerate() {
    st.mtPromptShown = true;
    toast('还没有 AI 中文字幕。生成后自动切换为中英双语（同时对齐字幕）', 'info', 15000, { label: '生成', onClick: function () { postAction({ bilingual: true }); } });
  }

  // ---------- notifications ----------

  function toastHost() {
    var root = st.root || document.body;
    var host = root.querySelector(':scope > .ss-toasts');
    if (!host) { host = el('div', 'ss-toasts'); root.appendChild(host); }
    return host;
  }
  function toast(message, type, timeout, action) {
    var host = toastHost();
    var item = el('div', 'ss-toast ss-' + (type || 'info'));
    item.appendChild(el('span', 'ss-txt', message));
    if (action) {
      var b = el('button', 'ss-btn', action.label);
      b.addEventListener('click', function (e) { e.stopPropagation(); action.onClick(); remove(); });
      item.appendChild(b);
    }
    function remove() { if (item.parentNode) item.parentNode.removeChild(item); }
    item.addEventListener('click', remove);
    host.appendChild(item);
    setTimeout(remove, timeout || 6000);
  }

  var badgeTimer = null;
  function badge(text) {
    var root = st.root || document.body;
    var b = root.querySelector(':scope > .ss-badge');
    if (!b) { b = el('div', 'ss-badge'); root.appendChild(b); }
    b.textContent = text;
    b.classList.add('show');
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(function () { b.classList.remove('show'); }, 900);
  }

  // ---------- subtitles menu: language order, panel, hidden action entries ----------

  var menuScheduled = false;
  function scheduleMenu() { // setTimeout, not requestAnimationFrame: the latter stops in a background tab
    if (menuScheduled) return;
    menuScheduled = true;
    setTimeout(function () { menuScheduled = false; renderMenu(); }, 30);
  }
  function findMenu() {
    var lang = document.querySelector('[data-lang]');
    if (!lang) return null;
    var list = lang.parentElement, menu = list && list.parentElement && list.parentElement.parentElement;
    if (!menu || menu.children.length < 2) return null;
    return { menu: menu, list: list, variants: menu.children[1] };
  }
  function renderMenu() {
    var m = findMenu();
    if (!m) { if (st.panel && st.panel.parentNode) st.panel.parentNode.removeChild(st.panel); return; }
    // English first, Chinese second (the player sorts languages by ISO code, which puts 中文 last).
    if (m.list.style.display !== 'flex') { m.list.style.display = 'flex'; m.list.style.flexDirection = 'column'; }
    for (var i = 0; i < m.list.children.length; i++) {
      var c = m.list.children[i], code = c.getAttribute('data-lang');
      var order = !code ? -3 : code === 'eng' ? -2 : code === 'zho' ? -1 : 0;
      if (c.style.order !== String(order)) c.style.order = String(order);
      if (c.style.flexShrink !== '0') c.style.flexShrink = '0';
    }
    // The "▶" entries exist for clients without this UI; here the buttons below replace them.
    var vl = m.variants.children[m.variants.children.length - 1];
    if (vl && vl !== st.panel) {
      for (var j = 0; j < vl.children.length; j++) {
        var opt = vl.children[j];
        var hide = /^\s*▶/.test(opt.textContent || '');
        if (hide && opt.style.display !== 'none') opt.style.display = 'none';
      }
    }
    var selected = m.menu.querySelector('[data-lang].selected');
    var code2 = selected ? selected.getAttribute('data-lang') : null;
    if (code2 !== 'eng' && code2 !== 'zho') { if (st.panel && st.panel.parentNode) st.panel.parentNode.removeChild(st.panel); return; }
    if (!st.panel) st.panel = el('div', 'ss-panel');
    st.panel.setAttribute('data-ss-lang', code2);
    if (st.panel.parentNode !== m.variants) m.variants.insertBefore(st.panel, m.variants.children[1] || null);
    if (Date.now() - st.statusAt > 5000 && !st.pollTimer) fetchStatus().then(function (s) { if (busy(s)) startPolling(); });
    renderPanel();
  }

  function alignText(s) {
    var a = s.align;
    if (a.running || a.state === 'running') {
      if (a.phase === 'video') return '查找视频…';
      if (a.phase === 'reference') return '读取片头 10 分钟（需下载）…';
      if (a.phase === 'consensus') return '比对候选字幕…';
      return '对齐中 ' + a.done + '/' + a.total;
    }
    if (a.state === 'done') { var b = s.best.en && s.subs[s.best.en]; return '✅ 已对齐' + (b ? ' · 最佳：' + b.label : ' · 没有匹配的英文字幕'); }
    if (a.state === 'noref') return '无法对齐：无内嵌字幕，候选字幕也不一致';
    if (a.state === 'novideo') return '无法对齐：引擎里没有该视频';
    if (a.state === 'failed') return '对齐失败：' + (a.error || '');
    return '未对齐';
  }
  function translateText(s) {
    var t = s.translate;
    if (t.state === 'waiting-align') return '等待对齐后开始…';
    if (t.state === 'running') return '生成中 ' + t.done + '/' + t.total + (t.coveredUntil !== null ? '（已到 ' + fmtTime(t.coveredUntil) + '）' : '');
    if (t.state === 'done') return '✅ 已生成' + (t.stale ? ' · 源字幕与视频不匹配' : '');
    if (t.state === 'failed') return '失败：' + (t.error || '');
    return '未生成';
  }

  function renderPanel() {
    var panel = st.panel;
    if (!panel || !panel.parentNode) return;
    var lang = panel.getAttribute('data-ss-lang'), s = st.status;
    panel.textContent = '';
    if (!s) { panel.appendChild(el('div', 'ss-muted', '读取状态…')); return; }
    if (s.missing) { panel.appendChild(el('div', 'ss-muted', '服务已重启，请重新打开视频')); return; }
    var row, btn;
    if (lang === 'zho') {
      row = el('div', 'ss-row');
      var sw = el('div', 'ss-sw' + (pref(LS_BI, false) ? ' on' : ''));
      sw.addEventListener('click', function () {
        var on = !pref(LS_BI, false);
        setPref(LS_BI, on);
        sw.classList.toggle('on', on);
        if (on) {
          var p = parseTrack(selectedTrack());
          if (p && p.key === 'mt' && s.translate.enabled && s.translate.state !== 'done' && s.translate.state !== 'running' && s.translate.state !== 'waiting-align') postAction({ bilingual: true });
          else if (p && p.key !== 'mt' && s.align.state !== 'done' && !s.align.running) postAction({ align: true });
        }
        syncDisplay();
      });
      row.appendChild(sw);
      row.appendChild(el('span', 'ss-txt ss-title', '中英双语'));
      panel.appendChild(row);
      if (s.translate.enabled && s.hasEng) {
        row = el('div', 'ss-row');
        row.appendChild(el('span', 'ss-txt', 'AI 中文字幕 · ' + translateText(s)));
        if (s.translate.state === 'idle' || s.translate.state === 'failed') {
          btn = el('button', 'ss-btn', s.translate.state === 'failed' ? '重试' : '生成');
          btn.addEventListener('click', function () { postAction({ translate: true }); });
          row.appendChild(btn);
        } else if (s.translate.state === 'done' && s.translate.stale) {
          btn = el('button', 'ss-btn', '用最佳英文重新生成');
          btn.addEventListener('click', function () { postAction({ translate: true, force: true }); });
          row.appendChild(btn);
        }
        panel.appendChild(row);
      }
    }
    row = el('div', 'ss-row');
    row.appendChild(el('span', 'ss-txt', '字幕对齐 · ' + alignText(s)));
    if (!s.align.running && s.align.state !== 'done' && !(s.align.state === 'noref' || s.align.state === 'novideo')) {
      btn = el('button', 'ss-btn', s.align.state === 'failed' ? '重试' : '开始对齐');
      btn.addEventListener('click', function () { postAction({ align: true }); });
      row.appendChild(btn);
    } else if (s.align.state === 'done') {
      var best = lang === 'zho' ? s.best.zh : s.best.en, p2 = parseTrack(selectedTrack());
      if (best && (!p2 || p2.key !== best)) {
        btn = el('button', 'ss-btn', '切换到最佳');
        btn.addEventListener('click', function () { addLive(best, lang === 'zho' && pref(LS_BI, false), lang === 'zho' ? 'chi' : 'eng'); });
        row.appendChild(btn);
      }
    } else if (s.align.state === 'noref' || s.align.state === 'novideo') {
      btn = el('button', 'ss-btn', '重试');
      btn.addEventListener('click', function () { postAction({ align: true }); });
      row.appendChild(btn);
    }
    panel.appendChild(row);
    var chk = el('label', 'ss-chk');
    var input = el('input'); input.type = 'checkbox'; input.checked = pref(LS_HOVER, true);
    input.addEventListener('change', function () { setPref(LS_HOVER, input.checked); });
    chk.appendChild(input);
    chk.appendChild(el('span', null, '悬停字幕暂停 · 点单词查词 · A/S/D 上一句/重听/下一句'));
    panel.appendChild(chk);
  }

  // ---------- A / S / D: previous sentence, repeat, next sentence ----------

  function cueList() {
    var seen = {}, out = [];
    for (var i = 0; i < st.preview.length; i++) {
      var c = st.preview[i];
      if (!c || typeof c.startTime !== 'number' || seen[c.startTime]) continue;
      seen[c.startTime] = 1; out.push(c);
    }
    return out.sort(function (a, b) { return a.startTime - b.startTime; });
  }
  function navigate(dir) {
    if (st.time === null) return;
    var cues = cueList();
    if (!cues.length) return;
    var t = st.time - (st.delay || 0), cur = -1;
    for (var i = 0; i < cues.length; i++) { if (cues[i].startTime <= t + 150) cur = i; else break; }
    var inGap = cur >= 0 && t > cues[cur].endTime + 300, target = null;
    if (dir > 0) target = cur + 1 < cues.length ? cues[cur + 1] : null;
    else if (dir === 0) target = cur >= 0 ? cues[cur] : cues[0];
    else target = cur < 0 ? cues[0] : (inGap || cur === 0) ? cues[cur] : cues[cur - 1];
    if (!target) return;
    safeDispatch({ type: 'setProp', propName: 'time', propValue: Math.max(0, Math.round(target.startTime + (st.delay || 0) - 60)) });
    if (st.paused) { st.pausedByHover = false; safeDispatch({ type: 'setProp', propName: 'paused', propValue: false }); }
    badge(dir < 0 ? '◀ 上一句' : dir === 0 ? '↻ 重听本句' : '下一句 ▶');
  }
  function navKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || isInputFocused() || !st.video) return null;
    var code = e.code || ('Key' + String(e.key || '').toUpperCase());
    if (code !== 'KeyA' && code !== 'KeyS' && code !== 'KeyD') return null;
    if (!st.preview.length) return null; // no subtitle cues: leave the player's own shortcuts alone
    return code === 'KeyA' ? -1 : code === 'KeyS' ? 0 : 1;
  }
  window.addEventListener('keydown', function (e) {
    if (st.popup && e.key === 'Escape') { closePopup(); e.preventDefault(); e.stopImmediatePropagation(); return; }
    var dir = navKey(e);
    if (dir === null) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (!e.repeat) navigate(dir);
  }, true);
  window.addEventListener('keyup', function (e) { if (navKey(e) !== null) e.stopImmediatePropagation(); }, true);

  // ---------- subtitle text: hover to pause, click a word for its meaning ----------

  var WORD_RE = /[A-Za-z]+(?:['’-][A-Za-z]+)*/g;
  function wrapWords(node) {
    if (!node || node.nodeType !== 1 || node.getAttribute('data-ss-words')) return;
    node.setAttribute('data-ss-words', '1');
    var walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null), texts = [];
    while (walker.nextNode()) texts.push(walker.currentNode);
    texts.forEach(function (tn) {
      var text = tn.nodeValue;
      if (!/[A-Za-z]/.test(text)) return;
      var frag = document.createDocumentFragment(), last = 0, m;
      WORD_RE.lastIndex = 0;
      while ((m = WORD_RE.exec(text))) {
        if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        var span = el('span', 'ss-w', m[0]);
        frag.appendChild(span);
        last = m.index + m[0].length;
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      tn.parentNode.replaceChild(frag, tn);
    });
  }
  function watchSubtitlesElement() {
    var container = st.videoEl && st.videoEl.parentElement;
    if (!container) return;
    var subs = null;
    for (var i = 0; i < container.children.length; i++) {
      var c = container.children[i];
      if (c !== st.videoEl && c.tagName === 'DIV' && c.style.position === 'absolute' && c.style.textAlign === 'center') { subs = c; break; }
    }
    if (subs && subs !== st.subsEl) {
      st.subsEl = subs;
      Array.prototype.forEach.call(subs.children, wrapWords);
      if (!subs.__ssBound) {
        subs.__ssBound = true;
        new MutationObserver(function (muts) {
          muts.forEach(function (mu) { Array.prototype.forEach.call(mu.addedNodes, function (n) { if (n.parentNode === subs) wrapWords(n); }); });
        }).observe(subs, { childList: true });
        subs.addEventListener('mouseover', function (e) { if (cueNodeOf(e.target)) { st.hovering = true; hoverEnter(); } });
        subs.addEventListener('mouseout', function (e) { if (cueNodeOf(e.target) && !cueNodeOf(e.relatedTarget)) { st.hovering = false; if (!inPopup(e.relatedTarget)) hoverLeave(); } });
      }
    }
    if (!st.videoObserver) {
      st.videoObserver = new MutationObserver(function () { watchSubtitlesElement(); });
      st.videoObserver.observe(container, { childList: true });
    }
  }
  function cueNodeOf(node) {
    if (!node || !st.subsEl || node === st.subsEl || !st.subsEl.contains(node)) return null;
    while (node.parentNode !== st.subsEl) node = node.parentNode;
    return node.tagName === 'BR' ? null : node;
  }
  function inPopup(node) { return Boolean(st.popup && node && st.popup.contains(node)); }
  function hoverEnter() {
    clearTimeout(st.hoverTimer);
    if (!pref(LS_HOVER, true) || st.paused !== false) return;
    st.pausedByHover = true;
    safeDispatch({ type: 'setProp', propName: 'paused', propValue: true });
  }
  function hoverLeave() {
    clearTimeout(st.hoverTimer);
    st.hoverTimer = setTimeout(function () {
      if (st.popup || st.hovering) return; // keep the frame while the dictionary is open or the mouse is still on the text
      resumeAfterHover();
    }, 350);
  }
  function resumeAfterHover() {
    if (st.pausedByHover) {
      st.pausedByHover = false;
      if (st.paused) safeDispatch({ type: 'setProp', propName: 'paused', propValue: false });
    }
  }

  function sentenceOf(cueNode) {
    var lines = (cueNode ? cueNode.textContent : '').split('\n').filter(function (l) { return /[A-Za-z]{2,}/.test(l); });
    return lines.join(' ').replace(/\s+/g, ' ').trim().slice(0, 500);
  }

  function closePopup() {
    if (st.popup && st.popup.parentNode) st.popup.parentNode.removeChild(st.popup);
    st.popup = null; st.popupWord = null;
    if (st.videoEl) hoverLeave();
  }

  function showPopup(anchor, q, ctx) {
    closePopup();
    clearTimeout(st.hoverTimer);
    var root = st.root || document.body;
    var pop = el('div', 'ss-pop');
    pop.addEventListener('mouseleave', function (e) { if (!cueNodeOf(e.relatedTarget)) closePopup(); });
    var head = el('div', 'ss-pw', q);
    pop.appendChild(head);
    var body = el('div', 'ss-muted', '查询中…');
    pop.appendChild(body);
    root.appendChild(pop);
    st.popup = pop; st.popupWord = q;
    place(pop, anchor, root);
    var fill = function (d) {
      if (st.popup !== pop) return;
      body.textContent = '';
      head.textContent = q;
      if (d && d.phonetic) { var ph = el('span', 'ss-ph', '/' + d.phonetic + '/'); head.appendChild(ph); }
      var got = false;
      if (d && d.entries && d.entries.length) { d.entries.slice(0, 6).forEach(function (t) { body.appendChild(el('div', 'ss-pe', t)); }); got = true; }
      else if (d && d.web && d.web.length) { body.appendChild(el('div', 'ss-pe', d.web.join('；'))); got = true; }
      if (d && d.context && (d.context.meaning || d.context.sentence)) {
        var c = el('div', 'ss-pc');
        if (d.context.meaning) { var m1 = el('div'); m1.appendChild(el('span', 'ss-pl', '句中')); m1.appendChild(document.createTextNode(d.context.meaning)); c.appendChild(m1); }
        if (d.context.sentence) { var m2 = el('div'); m2.appendChild(el('span', 'ss-pl', '整句')); m2.appendChild(document.createTextNode(d.context.sentence)); c.appendChild(m2); }
        body.appendChild(c); got = true;
      }
      if (!got) body.appendChild(el('div', 'ss-muted', '没有查到'));
      place(pop, anchor, root);
    };
    var url = BASE + '/dict?q=' + encodeURIComponent(q);
    var first = fetch(url).then(function (r) { return r.json(); });
    first.then(fill).catch(function () { fill(null); });
    if (ctx && st.status && !st.status.missing && st.status.translate.enabled) {
      fetch(url + '&ctx=' + encodeURIComponent(ctx)).then(function (r) { return r.json(); }).then(function (d) {
        if (st.popup !== pop || !d || !d.context) return;
        first.then(function (d0) { fill(Object.assign({}, d0 || {}, { context: d.context })); }).catch(function () { fill(d); });
      }).catch(function () { /* dictionary entry alone is fine */ });
    }
  }
  function place(pop, anchor, root) {
    var r = anchor.getBoundingClientRect(), rr = root.getBoundingClientRect();
    var block = cueNodeOf(anchor), br = block ? block.getBoundingClientRect() : r;
    var w = pop.offsetWidth, h = pop.offsetHeight;
    var left = Math.max(8, Math.min(rr.width - w - 8, r.left - rr.left + r.width / 2 - w / 2));
    var top = br.top - rr.top - h - 10;
    if (top < 8) top = br.bottom - rr.top + 10;
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  }

  function wordTarget(e) {
    var n = e.target;
    return n && n.nodeType === 1 && n.classList && n.classList.contains('ss-w') && st.subsEl && st.subsEl.contains(n) ? n : null;
  }
  ['mousedown', 'mouseup', 'dblclick'].forEach(function (type) {
    window.addEventListener(type, function (e) {
      if (wordTarget(e) || inPopup(e.target)) e.stopImmediatePropagation();
      if (type === 'mouseup' && st.subsEl && st.subsEl.contains(e.target)) {
        var sel = window.getSelection ? String(window.getSelection()).replace(/\s+/g, ' ').trim() : '';
        if (sel && /\s/.test(sel) && sel.length <= 200) {
          e.stopImmediatePropagation();
          showPopup(e.target.nodeType === 1 ? e.target : e.target.parentNode, sel, sentenceOf(cueNodeOf(e.target)));
        }
      }
    }, true);
  });
  window.addEventListener('click', function (e) {
    var w = wordTarget(e);
    if (w) {
      e.preventDefault(); e.stopImmediatePropagation();
      var sel = window.getSelection ? String(window.getSelection()).trim() : '';
      if (sel && /\s/.test(sel)) return; // a phrase was just selected and looked up on mouseup
      showPopup(w, w.textContent, sentenceOf(cueNodeOf(w)));
      return;
    }
    if (inPopup(e.target)) { e.stopImmediatePropagation(); return; }
    if (st.popup) closePopup();
  }, true);
})();
