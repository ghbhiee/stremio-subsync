// Web UI for the 字幕对齐 (stremio-subsync) addon, injected into a self-hosted stremio-web.
// It attaches a bar above the player's subtitles menu ("generate AI Chinese subtitle" / download and
// "align" buttons, live progress, the sentence-pause switch with a legend of the keys) and shows notifications when the work finishes (the finished
// subtitle is then loaded without interrupting playback). It also keeps English first and Chinese
// second in the language list, maps A/S/D to previous / repeat / next sentence, E to play / pause and Q
// to "pause after every sentence", pauses while the mouse rests on the subtitle and shows a Chinese
// dictionary entry when an English word is clicked, for addon subtitles and for subtitle tracks embedded
// in the video alike. Words can be saved from that popup into a vocabulary book kept on the server (one
// per user); a button in the control bar opens it in a panel on the right. Everything is best-effort:
// if the player's internals cannot be found, the stock UI keeps working unchanged.
(function () {
  'use strict';

  var MANIFEST = '__SUBSYNC_MANIFEST__'; // filled in by deploy.sh
  if (!/^https?:/.test(MANIFEST)) return;
  var BASE = MANIFEST.replace(/\/manifest\.json$/, '');
  var SUB_RE = /\/sub\/([0-9a-f]{16})\/([^/?#]+)\.srt(?:\?([^#]*))?$/;
  var CHI = { chi: 1, zho: 1, zht: 1, zhs: 1, chs: 1, cht: 1, ze: 1, zh: 1 };
  var TRAD = '繁体中文'; // the addon lists Traditional Chinese as a language of its own, named like this
  var LS_BI = 'subsync.bilingual', LS_HOVER = 'subsync.hoverPause', LS_SP = 'subsync.sentencePause', LS_PROFILE = 'subsync.profile', LS_VOICE = 'subsync.voice';
  var POLL_MS = 2500;
  var SP_MARGIN = 120; // sentence pause stops this many ms before the cue ends, so its text stays on screen
  var ORIGIN = '字幕对齐';

  var st = {
    video: null, videoEl: null, subsEl: null, root: null,
    tracks: [], selectedId: null, selSig: null,
    time: null, paused: null, delay: 0, preview: [], streamSig: null,
    shortKey: null, status: null, statusAt: 0, pollTimer: null,
    live: {}, liveN: 0, alignEpoch: 0, mtEpoch: 0, mtPartial: false, mtPromptShown: false,
    pausedByHover: false, hovering: false, hoverTimer: null, popup: null, popupWord: null,
    menuObserver: null, videoObserver: null, bar: null, barKey: '', wantMt: false, wantBi: false, biApplied: false, internalSelect: false,
    embeddedId: null, embTrack: null, embEl: null,
    timeOffset: 0, spTimer: null, spDone: null, spWait: null, pausedBySentence: false, hoverSuppressed: false,
    meta: null, pendingSeek: null, vbtn: null, panel: null, panelOpen: false,
    vocab: { loaded: false, loading: null, words: {}, user: null, error: '' },
    embStyle: { size: 100, offset: 0, offsetMin: 0, color: 'rgb(255, 255, 255)', bg: 'rgba(0, 0, 0, 0)', outline: 'rgb(34, 34, 34)' },
  };
  var spOn = false; // "pause after every sentence", set from localStorage below
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
    return { shortKey: m[1], key: m[2], bi: /(^|&)bi=1(&|$)/.test(q), live: Boolean(st.live[track.id]), lang: track.lang, isZh: Boolean(CHI[track.lang]), isTrad: track.lang === TRAD };
  }
  function selectedTrack() {
    for (var i = 0; i < st.tracks.length; i++) if (st.tracks[i].id === st.selectedId) return st.tracks[i];
    return null;
  }
  spOn = pref(LS_SP, false);
  function fmtTime(sec) { sec = Math.max(0, Math.round(sec)); var m = Math.floor(sec / 60), s = sec % 60; return m + ':' + (s < 10 ? '0' : '') + s; }

  // ---------- styles ----------

  var css = [
    '.ss-bar{position:absolute;z-index:30;box-sizing:border-box;display:flex;flex-wrap:wrap;align-items:center;gap:.45rem 1.4rem;padding:.65rem 1.25rem;border-radius:var(--border-radius,.75rem);background:var(--modal-background-color,rgba(16,16,28,.95));backdrop-filter:blur(15px);box-shadow:0 .8rem 2rem rgba(0,0,0,.35);color:var(--primary-foreground-color,#fff);font-size:.95rem;line-height:1.4}',
    '.ss-cell{display:flex;align-items:center;gap:.5rem;white-space:nowrap}',
    // embedded tracks are drawn by this script (clickable words), so the browser's own cue rendering is hidden
    'video.ss-own-cues::cue{color:transparent!important;background:transparent!important;text-shadow:none!important;opacity:0!important}',
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
    '.ss-pop .ss-pw{display:flex;align-items:baseline;flex-wrap:wrap;gap:0 .2rem}',
    '.ss-say{cursor:pointer;margin-left:.4rem;font-size:1rem;font-weight:400;opacity:.8;align-self:center}.ss-say:hover{opacity:1}',
    '.ss-add{margin-left:auto;flex:none;align-self:center;cursor:pointer;padding:.15rem .55rem;border-radius:1rem;border:1px solid rgba(255,255,255,.4);background:transparent;color:inherit;font:inherit;font-size:.8rem;font-weight:400;white-space:nowrap}',
    '.ss-add:hover{background:rgba(255,255,255,.15)}.ss-add.on{border-color:transparent;background:var(--secondary-accent-color,#7b5bf5);color:#fff}',
    '.ss-vbtn svg{fill:currentColor}',
    '.ss-panel{position:absolute;z-index:46;top:0;right:0;bottom:0;width:26rem;max-width:92%;display:flex;flex-direction:column;background:var(--modal-background-color,rgba(16,16,28,.96));backdrop-filter:blur(15px);box-shadow:-.6rem 0 2rem rgba(0,0,0,.45);color:var(--primary-foreground-color,#fff);font-size:.95rem;line-height:1.45;text-align:left;text-shadow:none;border-radius:var(--border-radius,.75rem) 0 0 var(--border-radius,.75rem)}',
    '.ss-vh{flex:none;display:flex;align-items:center;gap:.6rem;padding:1rem 1.1rem .7rem}.ss-vh .ss-vt{font-size:1.2rem;font-weight:700}.ss-vh .ss-vx{margin-left:auto;cursor:pointer;font-size:1.4rem;line-height:1;opacity:.7;padding:0 .3rem}.ss-vh .ss-vx:hover{opacity:1}',
    '.ss-vtabs{flex:none;display:flex;gap:.4rem;padding:0 1.1rem .6rem}.ss-vtab{cursor:pointer;padding:.15rem .7rem;border-radius:1rem;background:rgba(255,255,255,.1);font-size:.85rem}.ss-vtab.on{background:var(--secondary-accent-color,#7b5bf5)}',
    '.ss-vl{flex:1;overflow-y:auto;padding:0 1.1rem 1.2rem;overscroll-behavior:contain}',
    '.ss-vi{position:relative;padding:.7rem 1.8rem .7rem 0;border-top:1px solid rgba(255,255,255,.12)}',
    '.ss-vi .ss-vw{font-size:1.1rem;font-weight:700}.ss-vi .ss-ph{margin-left:.5rem;opacity:.7;font-size:.9rem;font-weight:400}',
    '.ss-vi .ss-vd{position:absolute;top:.6rem;right:0;cursor:pointer;opacity:.45;font-size:1.1rem;padding:0 .3rem}.ss-vi .ss-vd:hover{opacity:1}',
    '.ss-vi .ss-vs{margin-top:.35rem;padding:.35rem .55rem;border-radius:.4rem;background:rgba(255,255,255,.07)}.ss-vi .ss-vs.go{cursor:pointer}.ss-vi .ss-vs.go:hover{background:rgba(255,255,255,.14)}',
    '.ss-vi .ss-vz{opacity:.75;font-size:.88rem}.ss-vi .ss-vm{margin-top:.3rem;opacity:.55;font-size:.8rem}',
    '.ss-keys{flex-wrap:wrap;gap:.3rem .5rem}.ss-key{display:flex;align-items:center;gap:.3rem;cursor:pointer;padding:.1rem .5rem .1rem .25rem;border-radius:1rem;background:rgba(255,255,255,.1);font-size:.85rem}.ss-key:hover{background:rgba(255,255,255,.22)}',
    '.ss-kbd{flex:none;padding:0 .4rem;border:1px solid rgba(255,255,255,.45);border-radius:.3rem;font-size:.8rem;line-height:1.35;opacity:.9}',
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
        if (sig !== st.streamSig) { st.streamSig = sig; resetVideo(); refreshMeta(); }
        break;
      }
      case 'time': {
        var before = st.time;
        st.time = typeof value === 'number' ? value : null;
        if (st.time !== null) {
          var ve = st.videoEl; // the element's clock is finer than the player's time events (about 4 a second)
          if (ve && isFinite(ve.currentTime)) st.timeOffset = st.time - ve.currentTime * 1000;
          if (before === null || Math.abs(st.time - before) > 1500) { st.spDone = null; st.spWait = null; applyPendingSeek(); } // loaded, or a seek
          if (!st.spTimer) armSentencePause();
        }
        break;
      }
      case 'paused': {
        if (value === false && st.pausedByHover) st.pausedByHover = false; // the user resumed by hand
        st.paused = value;
        if (value === false) { st.pausedBySentence = false; armSentencePause(); } else disarmSentencePause();
        break;
      }
      case 'extraSubtitlesDelay': st.delay = typeof value === 'number' ? value : 0; break;
      case 'extraSubtitlesPreview': st.preview = Array.isArray(value) ? value : []; break;
      case 'extraSubtitlesTracks': st.tracks = Array.isArray(value) ? value : []; onTracks(); break;
      case 'selectedExtraSubtitlesTrackId': if (value !== st.selectedId) { st.selectedId = value; onSelection(); } break;
      case 'selectedSubtitlesTrackId': st.embeddedId = value || null; onTextTrackChange(); renderBar(); break;
      case 'subtitlesSize': if (typeof value === 'number') { st.embStyle.size = value; renderEmbedded(); } break;
      case 'subtitlesOffset': if (typeof value === 'number') { st.embStyle.offset = value; renderEmbedded(); } break;
      case 'subtitlesOffsetMinimum': if (typeof value === 'number') { st.embStyle.offsetMin = value; renderEmbedded(); } break;
      case 'subtitlesTextColor': if (typeof value === 'string') { st.embStyle.color = value; renderEmbedded(); } break;
      case 'subtitlesBackgroundColor': if (typeof value === 'string') { st.embStyle.bg = value; renderEmbedded(); } break;
      case 'subtitlesOutlineColor': if (typeof value === 'string') { st.embStyle.outline = value; renderEmbedded(); } break;
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
      ['stream', 'time', 'paused', 'extraSubtitlesTracks', 'selectedExtraSubtitlesTrackId', 'extraSubtitlesDelay', 'extraSubtitlesPreview',
        'selectedSubtitlesTrackId', 'subtitlesSize', 'subtitlesOffset', 'subtitlesOffsetMinimum', 'subtitlesTextColor', 'subtitlesBackgroundColor', 'subtitlesOutlineColor']
        .forEach(function (p) { safeDispatch({ type: 'observeProp', propName: p }); });
    }
    watchSubtitlesElement();
    watchTextTracks();
    if (!st.menuObserver) {
      st.menuObserver = new MutationObserver(scheduleMenu);
      st.menuObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'], characterData: true });
    }
    scheduleMenu();
    return true;
  }

  function unbind() {
    if (st.embTrack) { try { st.embTrack.removeEventListener('cuechange', renderEmbedded); } catch (e) { /* gone */ } }
    if (st.embEl && st.embEl.parentNode) st.embEl.parentNode.removeChild(st.embEl);
    removeBar();
    closePanel();
    st.vbtn = null; st.hovering = false;
    st.video = null; st.videoEl = null; st.subsEl = null; st.embTrack = null; st.embEl = null; st.embeddedId = null;
    if (st.menuObserver) { st.menuObserver.disconnect(); st.menuObserver = null; }
    if (st.videoObserver) { st.videoObserver.disconnect(); st.videoObserver = null; }
    closePopup();
    resetVideo();
  }

  function resetVideo() {
    stopPolling();
    st.shortKey = null; st.status = null; st.statusAt = 0; st.live = {}; st.selSig = null;
    st.alignEpoch = 0; st.mtEpoch = 0; st.mtPartial = false; st.mtPromptShown = false; st.wantMt = false; st.wantBi = false; st.biApplied = false;
    st.preview = []; st.pausedByHover = false; st.barKey = '';
    disarmSentencePause(); st.spDone = null; st.spWait = null; st.pausedBySentence = false; st.meta = null;
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
      if (st.wantMt && translateReady(s)) { // the user asked for the AI subtitle while watching something else: switch to it
        st.wantMt = false;
        var cur = parseTrack(selectedTrack());
        if (!(cur && cur.key === 'mt' && cur.shortKey === st.shortKey && Boolean(cur.bi) === st.wantBi)) addLive('mt', st.wantBi, 'chi');
      }
    }
    renderBar();
    syncDisplay();
  }

  function onAlignFinished(s) {
    var a = s.align;
    if (a.state === 'done') {
      toast(s.best.en ? '字幕已对齐 ✅' : '对齐完成，但没有和视频匹配的英文字幕', s.best.en ? 'success' : 'error');
      // The subtitle being watched turned out not to match the video while another one does: switch.
      var t = selectedTrack(), p = parseTrack(t);
      if (p && p.shortKey === st.shortKey && p.key !== 'mt' && p.key !== 'bi' && p.key !== 'align' && p.key !== 'mt-start') {
        var info = s.subs[p.key], best = p.isTrad ? s.best.zht : p.isZh ? s.best.zh : s.best.en;
        if (info && !info.good && best && best !== p.key) {
          addLive(best, false, p.lang);
          toast('当前字幕与视频不匹配，已切换到最佳字幕：' + (s.subs[best] ? s.subs[best].title : best), 'info');
        }
      }
    } else if (a.state === 'noref') toast('无法对齐：视频没有内嵌字幕轨，候选字幕之间也不一致；时间轴保持原样', 'error', 9000);
    else if (a.state === 'novideo') toast('无法对齐：在播放引擎里找不到正在播放的文件', 'error', 9000);
    else if (a.state === 'failed') toast('对齐失败：' + (a.error || '未知错误'), 'error', 9000);
  }

  // ---------- keeping the displayed subtitle current ----------

  function okStatus() { return st.status && !st.status.missing ? st.status : null; }
  function isBilingual(p) { return Boolean(p && (p.key === 'bi' || p.bi)); }
  // What a track shows, whichever copy of it this is (the listed entry or a reloaded one).
  function identity(p) { return p.key + (p.bi ? '+bi' : ''); }
  function mine(t) { var p = parseTrack(t); return p && p.shortKey === st.shortKey ? p : null; }
  function newestTrack(idn) { // the latest copy of an entry: a reloaded one if any, else the listed one
    var best = null, bestN = -1;
    st.tracks.forEach(function (t) {
      var p = mine(t);
      if (!p || identity(p) !== idn) return;
      var n = st.live[t.id] ? st.live[t.id].n : 0;
      if (n > bestN) { bestN = n; best = t; }
    });
    return best;
  }
  function humanChinese() {
    var out = [];
    st.tracks.forEach(function (t) { var p = mine(t); if (p && !p.live && p.isZh && !p.bi && p.key !== 'mt' && p.key !== 'bi' && p.key !== 'mt-start') out.push({ t: t, p: p }); });
    return out;
  }
  function select(id) { // a selection made by this script, not by the viewer
    st.internalSelect = true;
    safeDispatch({ type: 'setProp', propName: 'selectedExtraSubtitlesTrackId', propValue: id });
    st.internalSelect = false;
  }

  function onTracks() {
    var sk = null;
    for (var i = 0; i < st.tracks.length && !sk; i++) { var p = parseTrack(st.tracks[i]); if (p && !p.live) sk = p.shortKey; }
    if (sk && sk !== st.shortKey) {
      resetVideo();
      st.shortKey = sk;
      fetchStatus().then(function (s) { if (busy(s)) startPolling(); });
    }
    scheduleMenu();
    syncDisplay();
  }

  function onSelection() {
    var byUser = !st.internalSelect;
    var t = selectedTrack(), p = mine(t);
    if (p) {
      if (!p.live) st.selSig = sigFor(p);
      if (p.isZh) {
        if (!st.biApplied) { // first Chinese track of this video: apply the remembered preference once
          st.biApplied = true;
          if (pref(LS_BI, false) && !isBilingual(p)) setTimeout(function () { bilingualOn(false); }, 0);
        } else if (byUser) setPref(LS_BI, isBilingual(p)); // picking an entry by hand sets the preference
      }
      if (isBilingual(p)) ensureAligned(); // bilingual pairs two subtitles: it needs aligned timings
    }
    renderBar();
    scheduleMenu();
    syncDisplay();
  }

  function ensureAligned() {
    var s = okStatus();
    if (s && s.align.state !== 'done' && !s.align.running) postAction({ align: true });
  }

  // Bilingual is one of two tracks: the best English with the best human Chinese ("bi"), or, when the
  // film has no human Chinese subtitle, the AI translation ("mt" with bi=1), generated on request.
  function bilingualOn(byUser) {
    var s = okStatus(), t;
    if (humanChinese().length) {
      t = newestTrack('bi');
      if (t) select(t.id); else addLive('bi', false, 'chi');
      ensureAligned();
      return;
    }
    if (translateReady(s)) {
      t = newestTrack('mt+bi');
      if (t) select(t.id); else addLive('mt', true, 'chi');
      ensureAligned();
      return;
    }
    if (!s || !s.translate.enabled || !s.hasEng) { if (byUser) toast('这部片没有中文字幕，也没有可翻译的英文字幕', 'error'); return; }
    if (!byUser) { if (!st.mtPromptShown) promptGenerate(); return; }
    st.wantMt = true; st.wantBi = true;
    var ts = s.translate.state;
    if (ts !== 'running' && ts !== 'waiting-align') postAction({ bilingual: true });
    toast('正在生成 AI 中文字幕并对齐，完成后自动切换为中英双语', 'info', 8000);
  }

  function sigFor(p) { return identity(p) + '|' + st.alignEpoch + '|' + (p.key === 'mt' ? st.mtEpoch : 0); }

  function translateReady(s) {
    return Boolean(s && !s.missing && s.translate.enabled && (s.translate.state === 'done' || (s.translate.state === 'running' && st.mtPartial)));
  }

  // The player fetches a subtitle once. When alignment or translation has moved on since the track on
  // screen was loaded, load a fresh copy of the same entry (the older copy is then hidden in the menu).
  var syncTimer = null;
  function syncDisplay() {
    if (syncTimer) return;
    syncTimer = setTimeout(function () { syncTimer = null; syncNow(); }, 50);
  }
  function syncNow() {
    var t = selectedTrack(), p = mine(t), s = okStatus();
    if (!p || p.key === 'align' || p.key === 'mt-start') return;
    var current = p.live ? st.live[t.id].sig : st.selSig, desired = sigFor(p);
    if (current === desired) return;
    var cur = (current || '').split('|'), des = desired.split('|'), useful = false;
    if (s) {
      if (cur[1] !== des[1]) { // an alignment finished since this copy was loaded
        if (p.key === 'bi') useful = s.align.state === 'done';
        else if (p.key === 'mt') useful = Boolean(s.translate.source && s.subs[s.translate.source] && s.subs[s.translate.source].status === 'done');
        else useful = Boolean(s.subs[p.key] && s.subs[p.key].status === 'done');
      }
      if (p.key === 'mt' && cur[2] !== des[2] && translateReady(s)) useful = true;
    }
    if (!useful) { if (p.live) st.live[t.id].sig = desired; else st.selSig = desired; return; }
    addLive(p.key, p.bi, t.lang);
  }

  // Name and second line of an entry: the second line carries a warning only when alignment found one.
  function describe(p) {
    var s = okStatus();
    if (p.key === 'bi') return { title: '🀄 中英双语（人工字幕）', note: '' };
    if (p.key === 'mt') return { title: p.bi ? '🤖 中英双语（AI 字幕）' : '🤖 AI 中文字幕', note: s && (s.translate.state === 'running' || s.translate.state === 'waiting-align') ? '生成中，后面的句子稍后补上' : '' };
    var info = s && s.subs[p.key];
    if (!info) return null;
    return { title: (p.bi ? '🀄 中英双语 · ' : '') + info.title, note: info.warn || '' };
  }

  function addLive(key, bi, lang) {
    if (!st.shortKey || !st.video) return;
    var n = ++st.liveN, id = 'subsync-live-' + n;
    var p = { key: key, bi: Boolean(bi) };
    var url = BASE + '/sub/' + st.shortKey + '/' + key + '.srt?' + (bi ? 'bi=1&' : '') + 'r=' + n;
    var d = describe(p) || { title: key, note: '' };
    st.live[id] = { key: key, bi: Boolean(bi), sig: sigFor(p), n: n };
    var track = { id: id, lang: lang || (key === 'mt' || key === 'bi' ? 'chi' : 'eng'), label: d.title, url: url, origin: d.note || ORIGIN, embedded: false };
    if (!safeDispatch({ type: 'command', commandName: 'addExtraSubtitlesTracks', commandArgs: { tracks: [track] } })) return;
    select(id);
  }

  function promptGenerate() {
    st.mtPromptShown = true;
    toast('这部片没有中文字幕。生成 AI 中文字幕后自动切换为中英双语（同时对齐）', 'info', 15000, { label: '生成', onClick: function () { st.wantMt = true; st.wantBi = true; postAction({ bilingual: true }); } });
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

  // ---------- subtitles menu: language order, tidy entries, and the bar attached above it ----------

  var menuScheduled = false;
  function scheduleMenu() { // setTimeout, not requestAnimationFrame: the latter stops in a background tab
    if (menuScheduled) return;
    menuScheduled = true;
    setTimeout(function () { menuScheduled = false; ensureVocabButton(); renderMenu(); }, 30);
  }
  window.addEventListener('resize', scheduleMenu);
  function findMenu() {
    var lang = document.querySelector('[data-lang]');
    if (!lang) return null;
    var list = lang.parentElement, menu = list && list.parentElement && list.parentElement.parentElement;
    if (!menu || menu.children.length < 2) return null;
    return { menu: menu, list: list, variants: menu.children[1] };
  }
  function removeBar() {
    if (st.bar && st.bar.parentNode) st.bar.parentNode.removeChild(st.bar);
    st.barKey = '';
  }
  function trackOfRow(row) { // the track a menu row stands for, from the row component's props
    var f = fiberOf(row), hops = 0;
    while (f && hops++ < 8) {
      if (f.memoizedProps && f.memoizedProps.track && typeof f.memoizedProps.track.id === 'string') return f.memoizedProps.track;
      f = f.return;
    }
    return null;
  }
  function setText(node, text) { // change React's own text node in place, so later updates by React still land
    if (!node) return;
    var tn = node.firstChild;
    if (tn && tn.nodeType === 3) { if (tn.nodeValue !== text) tn.nodeValue = text; } else if (node.textContent !== text) node.textContent = text;
  }

  // Each entry appears once: its newest copy. Older copies (the player cannot remove a track) and the "▶"
  // entries meant for clients without this script are hidden. The first line names the entry; a warning
  // from alignment goes on the second line, where the addon name normally is.
  function tidyRows(list) {
    var rows = [], newest = {}, i;
    for (i = 0; i < list.children.length; i++) {
      var row = list.children[i], track = trackOfRow(row), p = track ? mine(track) : null;
      var n = track && st.live[track.id] ? st.live[track.id].n : 0;
      rows.push({ row: row, track: track, p: p, n: n });
      if (p && p.key !== 'align' && p.key !== 'mt-start') { var idn = identity(p); if (!(idn in newest) || n > newest[idn]) newest[idn] = n; }
    }
    rows.forEach(function (r) {
      var hide = false;
      if (r.p) {
        if (r.p.key === 'align' || r.p.key === 'mt-start') hide = true;
        else if (r.n < newest[identity(r.p)] && r.track.id !== st.selectedId) hide = true;
      } else if (/^\s*▶/.test(r.row.textContent || '')) hide = true;
      var display = hide ? 'none' : '';
      if (r.row.style.display !== display) r.row.style.display = display;
      if (hide || !r.track) return;
      var info = r.row.firstElementChild, label = info && info.children[0], origin = info && info.children[1];
      var d = r.p ? describe(r.p) : null;
      if (d) { setText(label, d.title); setText(origin, d.note || ORIGIN); }
      else if (origin && /^(⚠️|✗|生成中)/.test(origin.textContent || '')) setText(origin, String(r.track.origin || '')); // a reused row still carrying our note
    });
  }

  function renderMenu() {
    var m = findMenu();
    if (!m) { removeBar(); return; }
    // English first, Chinese second (the player sorts languages by ISO code, which puts 中文 last).
    if (m.list.style.display !== 'flex') { m.list.style.display = 'flex'; m.list.style.flexDirection = 'column'; }
    for (var i = 0; i < m.list.children.length; i++) {
      var c = m.list.children[i], code = c.getAttribute('data-lang');
      var order = !code ? -4 : code === 'eng' ? -3 : code === 'zho' ? -2 : code === TRAD ? -1 : 0; // OFF, English, 中文, 繁体中文, the rest
      if (c.style.order !== String(order)) c.style.order = String(order);
      if (c.style.flexShrink !== '0') c.style.flexShrink = '0';
    }
    var vl = m.variants.children[m.variants.children.length - 1];
    if (vl && vl.children.length && vl.children[0].firstElementChild) tidyRows(vl);
    // The bar hangs above the menu, outside it, so the menu's own columns keep their room.
    if (!st.bar) {
      st.bar = el('div', 'ss-bar');
      st.bar.addEventListener('mousedown', function (e) { e.subtitlesMenuClosePrevented = true; }); // the player closes the menu on outside clicks
    }
    var root = st.root || document.body;
    if (st.bar.parentNode !== root) { root.appendChild(st.bar); st.barKey = ''; }
    var mr = m.menu.getBoundingClientRect(), rr = root.getBoundingClientRect();
    var left = Math.round(mr.left - rr.left) + 'px', width = Math.round(mr.width) + 'px', bottom = Math.round(rr.bottom - mr.top + 8) + 'px';
    if (st.bar.style.left !== left) st.bar.style.left = left;
    if (st.bar.style.width !== width) st.bar.style.width = width;
    if (st.bar.style.bottom !== bottom) st.bar.style.bottom = bottom;
    if (st.shortKey && Date.now() - st.statusAt > 5000 && !st.pollTimer) fetchStatus().then(function (s) { if (busy(s)) startPolling(); });
    renderBar();
  }

  function alignProgress(a) {
    if (a.phase === 'video') return '字幕对齐：查找视频…';
    if (a.phase === 'reference') return '字幕对齐：读取片头（需下载前 10 分钟）…';
    if (a.phase === 'consensus') return '字幕对齐：比对候选字幕…';
    return '字幕对齐中 ' + a.done + '/' + a.total;
  }

  function cell() { var c = el('div', 'ss-cell'); for (var i = 0; i < arguments.length; i++) if (arguments[i]) c.appendChild(arguments[i]); return c; }
  function button(label, onClick) { var b = el('button', 'ss-btn', label); b.addEventListener('click', onClick); return b; }

  // The bar says what can be done and what is in progress or went wrong; finished work is not announced.
  function renderBar() {
    var bar = st.bar;
    if (!bar || !bar.parentNode) return;
    var s = st.status, p = mine(selectedTrack());
    var biNow = isBilingual(p), hover = pref(LS_HOVER, true), sp = spOn, voiceOn = pref(LS_VOICE, true);
    var key = JSON.stringify([st.shortKey, !s ? null : s.missing ? 'missing' : [s.align.state, s.align.running, s.align.phase, s.align.done, s.align.total, s.align.error,
      s.translate.enabled, s.translate.state, s.translate.done, s.translate.total, s.translate.stale, s.translate.error, s.best, s.hasEng, s.hasHumanZh], biNow, hover, sp, voiceOn, st.selectedId, st.embeddedId, st.wantBi]);
    if (key === st.barKey) return; // nothing changed: leave the DOM alone (the menu observer would loop otherwise)
    st.barKey = key;
    bar.textContent = '';
    if (st.shortKey) {
      if (s && s.missing) bar.appendChild(cell(el('span', 'ss-muted', '服务已重启，请重新打开视频')));
      else if (s) {
        var ts = s.translate.state, a = s.align;
        if (s.translate.enabled && s.hasEng) {
          // the last entry picked by hand says whether this viewer reads Chinese alone or under the English
          if (ts === 'idle') bar.appendChild(cell(button('生成 AI 中文字幕', function () { st.wantMt = true; st.wantBi = pref(LS_BI, false); postAction({ translate: true }); })));
          else if (ts === 'waiting-align') bar.appendChild(cell(el('span', null, 'AI 中文字幕：等待对齐后开始…')));
          else if (ts === 'running') bar.appendChild(cell(el('span', null, 'AI 中文字幕生成中 ' + s.translate.done + '/' + s.translate.total)));
          else if (ts === 'failed') bar.appendChild(cell(el('span', null, 'AI 中文字幕失败：' + (s.translate.error || '')), button('重试', function () { st.wantMt = true; postAction({ translate: true }); })));
          else if (ts === 'done') {
            if (s.translate.stale) bar.appendChild(cell(el('span', null, 'AI 字幕的源字幕与视频不匹配'), button('用最佳英文重新生成', function () { st.wantMt = true; st.wantBi = isBilingual(mine(selectedTrack())); postAction({ translate: true, force: true }); })));
            var dl = button('下载中英字幕', downloadBilingual); dl.title = '保存为 .srt 文件：每句英文在上、AI 中文在下';
            bar.appendChild(cell(dl));
          }
        }
        if (a.running || a.state === 'running') bar.appendChild(cell(el('span', null, alignProgress(a))));
        else if (a.state === 'idle') bar.appendChild(cell(button('开始对齐', function () { postAction({ align: true }); })));
        else if (a.state === 'noref') bar.appendChild(cell(el('span', null, '无法对齐：视频无内嵌字幕，候选字幕也不一致'), button('重试', function () { postAction({ align: true }); })));
        else if (a.state === 'novideo') bar.appendChild(cell(el('span', null, '无法对齐：引擎里没有该视频'), button('重试', function () { postAction({ align: true }); })));
        else if (a.state === 'failed') bar.appendChild(cell(el('span', null, '对齐失败：' + (a.error || '')), button('重试', function () { postAction({ align: true }); })));
        else if (a.state === 'done' && p && p.key !== 'mt' && p.key !== 'bi' && s.subs[p.key] && !s.subs[p.key].good) {
          var best = p.isTrad ? s.best.zht : p.isZh ? s.best.zh : s.best.en;
          if (best && best !== p.key) bar.appendChild(cell(el('span', null, '当前字幕与视频不匹配'), button('切换到最佳', function () { addLive(best, false, p.lang); })));
        }
      }
    }
    // Sentence pause: whether it is on, and what every key does (the keys can be clicked too: tablets).
    var spSw = el('div', 'ss-sw' + (sp ? ' on' : ''));
    spSw.addEventListener('click', function () { setSentencePause(!spOn, false); });
    bar.appendChild(cell(spSw, el('span', 'ss-title', '逐句暂停：' + (sp ? '已开启' : '已关闭')), el('span', 'ss-muted', sp ? '每句播完自动停住' : '')));
    var keys = el('div', 'ss-cell ss-keys');
    [['Q', '开/关逐句暂停', function () { setSentencePause(!spOn, false); }], ['D', '下一句', function () { navigate(1); }], ['S', '重听本句', function () { navigate(0); }],
      ['A', '上一句', function () { navigate(-1); }], ['E', '播放/暂停', togglePlay]].forEach(function (k) {
      var b = el('span', 'ss-key'); b.appendChild(el('span', 'ss-kbd', k[0])); b.appendChild(document.createTextNode(k[1]));
      b.addEventListener('click', k[2]);
      keys.appendChild(b);
    });
    bar.appendChild(keys);
    function check(label, key, on) {
      var chk = el('label', 'ss-chk'), input = el('input');
      input.type = 'checkbox'; input.checked = on;
      input.addEventListener('change', function () { setPref(key, input.checked); renderBar(); });
      chk.appendChild(input); chk.appendChild(el('span', null, label));
      return chk;
    }
    bar.appendChild(check('悬停字幕暂停', LS_HOVER, hover));
    bar.appendChild(check('点词发音', LS_VOICE, voiceOn));
    bar.appendChild(el('span', 'ss-muted', '点单词查词，弹窗里「＋ 生词本」收藏'));
  }

  function downloadBilingual() { // the AI translation under the English lines, as a file (the server names it after the video)
    if (!st.shortKey) return;
    var a = el('a');
    a.href = BASE + '/sub/' + st.shortKey + '/mt.srt?bi=1&dl=1';
    a.setAttribute('download', '');
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { if (a.parentNode) a.parentNode.removeChild(a); }, 1000);
  }

  // ---------- A / S / D: previous sentence, repeat, next sentence ----------

  // Cue times (ms) of whatever subtitle is on screen: the addon/external track (the player publishes the
  // cues around the playhead) or, when none is selected, the embedded text track the browser is showing.
  function currentCues() {
    var seen = {}, out = [], i, c;
    if (st.selectedId) {
      for (i = 0; i < st.preview.length; i++) {
        c = st.preview[i];
        if (!c || typeof c.startTime !== 'number' || seen[c.startTime]) continue;
        seen[c.startTime] = 1; out.push({ startTime: c.startTime, endTime: c.endTime });
      }
      return { cues: out.sort(function (a, b) { return a.startTime - b.startTime; }), delay: st.delay || 0 };
    }
    var t = st.embTrack;
    if (t && t.mode === 'showing' && t.cues) {
      for (i = 0; i < t.cues.length; i++) {
        var start = Math.round(t.cues[i].startTime * 1000);
        if (seen[start]) continue;
        seen[start] = 1; out.push({ startTime: start, endTime: Math.round(t.cues[i].endTime * 1000) });
      }
    }
    return { cues: out.sort(function (a, b) { return a.startTime - b.startTime; }), delay: 0 };
  }
  function navigate(dir) {
    if (st.time === null) return;
    var cc = currentCues(), cues = cc.cues;
    if (!cues.length) return;
    var t = st.time - cc.delay, cur = -1, i;
    for (i = 0; i < cues.length; i++) { if (cues[i].startTime <= t + 150) cur = i; else break; }
    // Stopped at the end of a sentence: that sentence is the current one, however close the next one starts.
    if (st.pausedBySentence && st.spDone !== null) { for (i = 0; i < cues.length; i++) if (cues[i].startTime === st.spDone) { cur = i; break; } }
    var inGap = cur >= 0 && t > cues[cur].endTime + 300, target = null;
    if (dir > 0) target = cur + 1 < cues.length ? cues[cur + 1] : null;
    else if (dir === 0) target = cur >= 0 ? cues[cur] : cues[0];
    else target = cur < 0 ? cues[0] : (inGap || cur === 0) ? cues[cur] : cues[cur - 1];
    if (!target) return;
    st.spDone = null; st.spWait = null; // the sentence played next gets its pause, also when it is the same one again
    st.hoverSuppressed = true; // the mouse may still rest on the subtitle: a key press wins until it moves
    safeDispatch({ type: 'setProp', propName: 'time', propValue: Math.max(0, Math.round(target.startTime + cc.delay - 60)) });
    if (st.paused) { st.pausedByHover = false; safeDispatch({ type: 'setProp', propName: 'paused', propValue: false }); }
    badge(dir < 0 ? '◀ 上一句' : dir === 0 ? '↻ 重听本句' : '下一句 ▶');
  }
  function togglePlay() {
    if (typeof st.paused !== 'boolean') return;
    var resume = st.paused;
    st.pausedByHover = false;
    if (resume) st.hoverSuppressed = true;
    safeDispatch({ type: 'setProp', propName: 'paused', propValue: !resume });
    badge(resume ? '▶ 播放' : '⏸ 暂停');
  }
  // A / S / D need a subtitle on screen (without one the keys keep their stock meaning); E and Q are
  // not used by the player.
  function keyAction(e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || isInputFocused() || !st.video) return null;
    var code = e.code || ('Key' + String(e.key || '').toUpperCase());
    if (code === 'KeyE') return 'play';
    if (code === 'KeyQ') return 'sentence';
    if (code !== 'KeyA' && code !== 'KeyS' && code !== 'KeyD') return null;
    if (!currentCues().cues.length) return null; // no subtitle on screen: leave the player's own shortcuts alone
    return code === 'KeyA' ? -1 : code === 'KeyS' ? 0 : 1;
  }
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && (st.popup || st.panelOpen)) {
      if (st.popup) closePopup(); else closePanel();
      e.preventDefault(); e.stopImmediatePropagation();
      return;
    }
    var act = keyAction(e);
    if (act === null) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.repeat) return;
    if (act === 'play') togglePlay();
    else if (act === 'sentence') setSentencePause(!spOn, true);
    else navigate(act);
  }, true);
  window.addEventListener('keyup', function (e) { if (keyAction(e) !== null) e.stopImmediatePropagation(); }, true);

  // ---------- Q: pause after every sentence ----------
  // While it is on, playback stops just before each cue ends (its text stays on screen, so words can
  // still be looked up); D goes on to the next sentence, S repeats this one, A goes back, E just resumes.

  function setSentencePause(on, announce) {
    spOn = Boolean(on);
    setPref(LS_SP, spOn);
    st.spDone = null; st.spWait = null;
    if (on) armSentencePause(); else { disarmSentencePause(); st.pausedBySentence = false; }
    if (announce) badge(on ? '逐句暂停：开（D 下一句）' : '逐句暂停：关');
    renderBar();
  }
  function disarmSentencePause() { if (st.spTimer) { clearTimeout(st.spTimer); st.spTimer = null; } }
  function armSentencePause() { disarmSentencePause(); sentenceTick(); }
  function preciseTime() {
    var v = st.videoEl;
    return v && isFinite(v.currentTime) ? v.currentTime * 1000 + st.timeOffset : st.time;
  }
  function stopPoint(cues, i) { // where playback stops for cue i: before it ends and before the next one starts
    var end = cues[i].endTime;
    if (i + 1 < cues.length && cues[i + 1].startTime < end) end = cues[i + 1].startTime;
    return Math.max(end - SP_MARGIN, cues[i].startTime + 250);
  }
  function sentenceTick() { // setTimeout, not requestAnimationFrame: see scheduleMenu
    st.spTimer = null;
    if (!spOn || st.paused !== false || st.time === null || !st.video) return;
    var cc = currentCues(), cues = cc.cues;
    if (!cues.length) { st.spTimer = setTimeout(sentenceTick, 1000); return; }
    var t = preciseTime() - cc.delay, cur = -1;
    for (var i = 0; i < cues.length; i++) { if (cues[i].startTime <= t + 40) cur = i; else break; }
    var idx = cur;
    // Wait for the next sentence instead when this one already had its stop (the viewer resumed), or when
    // its stop point had passed before we started waiting for it: a jump with A/S/D lands just before the
    // next cue, a seek or switching on late lands anywhere.
    if (idx >= 0 && (cues[idx].startTime === st.spDone || (t > stopPoint(cues, idx) - 15 && st.spWait !== cues[idx].startTime))) idx = cur + 1;
    if (idx < 0) idx = 0;
    if (idx >= cues.length) { st.spTimer = setTimeout(sentenceTick, 1000); return; }
    var rate = st.videoEl && st.videoEl.playbackRate > 0 ? st.videoEl.playbackRate : 1;
    var wait = (stopPoint(cues, idx) - t) / rate;
    if (wait <= 15) {
      st.spDone = cues[idx].startTime; st.spWait = null;
      st.pausedBySentence = true; st.pausedByHover = false;
      safeDispatch({ type: 'setProp', propName: 'paused', propValue: true });
      return;
    }
    st.spWait = cues[idx].startTime;
    st.spTimer = setTimeout(sentenceTick, Math.min(wait, 500));
  }

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
      if (c !== st.videoEl && c.tagName === 'DIV' && !c.classList.contains('ss-emb') && c.style.position === 'absolute' && c.style.textAlign === 'center') { subs = c; break; }
    }
    if (subs && subs !== st.subsEl) {
      st.subsEl = subs;
      Array.prototype.forEach.call(subs.children, wrapWords);
      if (!subs.__ssWrap) {
        subs.__ssWrap = true;
        new MutationObserver(function (muts) {
          muts.forEach(function (mu) { Array.prototype.forEach.call(mu.addedNodes, function (n) { if (n.parentNode === subs) wrapWords(n); }); });
        }).observe(subs, { childList: true });
      }
      bindHover(subs);
    }
    if (!st.videoObserver) {
      st.videoObserver = new MutationObserver(function () { watchSubtitlesElement(); });
      st.videoObserver.observe(container, { childList: true });
    }
  }
  function bindHover(container) {
    if (container.__ssHover) return;
    container.__ssHover = true;
    container.addEventListener('mouseover', function (e) { if (cueNodeOf(e.target)) { st.hovering = true; hoverEnter(); } });
    container.addEventListener('mouseout', function (e) { if (cueNodeOf(e.target) && !cueNodeOf(e.relatedTarget)) { st.hovering = false; if (!inPopup(e.relatedTarget)) hoverLeave(); } });
    // After A/S/D/E the next sentence appears under a mouse that has not moved: that is not a hover.
    container.addEventListener('mousemove', function (e) { if (st.hoverSuppressed && cueNodeOf(e.target)) { st.hoverSuppressed = false; hoverEnter(); } });
  }
  // The element holding the cue blocks: the player's own (addon subtitles) or ours (embedded tracks).
  function containerOf(node) {
    if (!node) return null;
    if (st.subsEl && node !== st.subsEl && st.subsEl.contains(node)) return st.subsEl;
    if (st.embEl && node !== st.embEl && st.embEl.contains(node)) return st.embEl;
    return null;
  }
  function cueNodeOf(node) {
    var c = containerOf(node);
    if (!c) return null;
    while (node.parentNode !== c) node = node.parentNode;
    return node.tagName === 'BR' ? null : node;
  }

  // ---------- embedded (native) subtitle tracks ----------
  // The browser draws these itself (video::cue), so their words cannot be hovered or clicked. Hide that
  // rendering with CSS and draw the active cues in an element of our own, styled like the player's.

  function showingTrack() {
    var list = st.videoEl && st.videoEl.textTracks;
    if (!list) return null;
    for (var i = 0; i < list.length; i++) if (list[i].mode === 'showing') return list[i];
    return null;
  }
  function watchTextTracks() {
    var v = st.videoEl;
    if (!v || !v.textTracks || v.__ssTracks) { onTextTrackChange(); return; }
    v.__ssTracks = true;
    v.textTracks.addEventListener('change', onTextTrackChange);
    v.textTracks.addEventListener('addtrack', onTextTrackChange);
    v.addEventListener('webkitbeginfullscreen', onTextTrackChange);
    v.addEventListener('webkitendfullscreen', onTextTrackChange);
    onTextTrackChange();
  }
  function nativeFullscreen() { return Boolean(st.videoEl && st.videoEl.webkitDisplayingFullscreen); } // iPhone: only native cues are visible there
  function onTextTrackChange() {
    if (!st.videoEl) return;
    var t = showingTrack();
    if (t !== st.embTrack) {
      if (st.embTrack) { try { st.embTrack.removeEventListener('cuechange', renderEmbedded); } catch (e) { /* gone */ } }
      st.embTrack = t;
      if (t) t.addEventListener('cuechange', renderEmbedded);
    }
    st.videoEl.classList.toggle('ss-own-cues', Boolean(t) && !nativeFullscreen());
    renderEmbedded();
  }
  function renderEmbedded() {
    var container = st.videoEl && st.videoEl.parentElement, t = st.embTrack, host = st.embEl;
    if (!container) return;
    if (!t || t.mode !== 'showing' || nativeFullscreen()) { if (host) host.textContent = ''; return; }
    if (!host || host.parentNode !== container) {
      host = st.embEl = el('div', 'ss-emb');
      host.style.cssText = 'position:absolute;left:0;right:0;bottom:0;z-index:1;text-align:center';
      container.appendChild(host);
      bindHover(host);
    }
    var es = st.embStyle, o = es.outline;
    host.style.bottom = Math.max(es.offset, es.offsetMin) + '%';
    host.textContent = '';
    var cues = t.activeCues ? Array.prototype.slice.call(t.activeCues) : [];
    cues.forEach(function (cue) {
      var block = el('div');
      block.style.cssText = 'display:inline-block;padding:.2em;white-space:pre-wrap';
      block.style.fontSize = Math.floor(es.size / 25) + 'vmin';
      block.style.color = es.color;
      block.style.backgroundColor = es.bg;
      block.style.textShadow = ['-0.15rem -0.15rem', '0px -0.15rem', '0.15rem -0.15rem', '-0.15rem 0px', '0.15rem 0px', '-0.15rem 0.15rem', '0px 0.15rem', '0.15rem 0.15rem']
        .map(function (d) { return d + ' 0.15rem ' + o; }).join(', ');
      try { block.appendChild(cue.getCueAsHTML()); } catch (e) { block.textContent = String(cue.text || '').replace(/<[^>]+>/g, ''); }
      wrapWords(block);
      host.appendChild(block);
      host.appendChild(el('br'));
    });
  }
  function inPopup(node) { return Boolean(st.popup && node && st.popup.contains(node)); }
  function inPanel(node) { return Boolean(st.panel && node && st.panel.contains(node)); }
  function hoverEnter() {
    clearTimeout(st.hoverTimer);
    if (st.hoverSuppressed || !pref(LS_HOVER, true) || st.paused !== false) return;
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
  // The word read aloud: an mp3 through the addon server (it fetches and keeps Youdao's recording), or
  // the browser's own speech synthesis when that is not available.
  var voice = null;
  function speak(text) {
    text = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!text) return;
    try { if (voice) voice.pause(); } catch (e) { /* already gone */ }
    var a = voice = new Audio(BASE + '/tts?q=' + encodeURIComponent(text)), failed = false;
    var fallback = function () {
      if (failed || voice !== a) return;
      failed = true;
      try {
        var u = new SpeechSynthesisUtterance(text); u.lang = 'en-US';
        window.speechSynthesis.cancel(); window.speechSynthesis.speak(u);
      } catch (e) { /* no speech synthesis here */ }
    };
    a.addEventListener('error', fallback);
    var played = a.play();
    if (played && played.catch) played.catch(fallback);
  }
  function runAct(node, stop) { // elements of this script carry their click handler in __ssAct
    while (node && node !== stop) { if (typeof node.__ssAct === 'function') { node.__ssAct(node); return true; } node = node.parentNode; }
    return false;
  }

  function showPopup(anchor, q, ctx) {
    closePopup();
    clearTimeout(st.hoverTimer);
    var root = st.root || document.body;
    var pop = el('div', 'ss-pop');
    pop.addEventListener('mouseleave', function (e) { if (!cueNodeOf(e.relatedTarget)) closePopup(); });
    var head = el('div', 'ss-pw'), phon = el('span', 'ss-ph'), say = el('span', 'ss-say', '🔊'), add = el('span', 'ss-add');
    say.title = '再听一遍'; say.__ssAct = function () { speak(q); };
    head.appendChild(el('span', null, q)); head.appendChild(phon); head.appendChild(say); head.appendChild(add);
    if (pref(LS_VOICE, true)) speak(q);
    pop.appendChild(head);
    var body = el('div', 'ss-muted', '查询中…');
    pop.appendChild(body);
    root.appendChild(pop);
    st.popup = pop; st.popupWord = q;
    place(pop, anchor, root);
    // "＋" saves the word with what is known about it here: entry, sentence, film and position.
    var data = null, at = sentenceStart(), addedHere = false, canSave = /[A-Za-z]/.test(q) && q.length <= 80;
    if (!st.meta || !st.meta.title) refreshMeta();
    var entryOf = function () {
      var d = data || {}, c = d.context || {}, m = st.meta || {};
      return { word: q, phonetic: d.phonetic || '', entries: d.entries && d.entries.length ? d.entries.slice(0, 6) : (d.web && d.web.length ? [d.web.join('；')] : []),
        meaning: c.meaning || '', sentence: ctx || '', sentenceZh: c.sentence || '', title: m.title || (okStatus() ? okStatus().title : ''), time: typeof at === 'number' ? at : undefined, video: m.video || undefined };
    };
    var paintAdd = function (busyNow) {
      if (!canSave) { add.style.display = 'none'; return; }
      var has = inVocab(q);
      add.className = 'ss-add' + (has ? ' on' : '');
      add.textContent = busyNow ? '…' : has ? '✓ 已在生词本' : '＋ 生词本';
      add.title = has ? '点击从生词本移除' : '加入生词本';
    };
    add.__ssAct = function () {
      paintAdd(true);
      addedHere = !inVocab(q);
      (addedHere ? vocabAdd(entryOf()) : vocabRemove(q)).then(function () { if (st.popup === pop) paintAdd(false); });
    };
    paintAdd(false);
    ensureVocab().then(function () { if (st.popup === pop) paintAdd(false); });
    var fill = function (d) {
      if (st.popup !== pop) return;
      data = d;
      var saved = addedHere ? st.vocab.words[vkey(q)] : null; // saved before this answer arrived: complete the entry
      if (saved && d && ((!saved.meaning && d.context && d.context.meaning) || (!(saved.entries || []).length && d.entries && d.entries.length))) vocabAdd(entryOf(), true);
      body.textContent = '';
      phon.textContent = d && d.phonetic ? '/' + d.phonetic + '/' : '';
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
    if (ctx) { // the server adds the meaning in context when a translation model is configured
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

  // ---------- vocabulary book: kept on the server, one per user ----------
  // The server tells users apart by what the site's login gateway says (when configured) or else by a
  // random profile id kept in this browser; the id is sent either way, the server knows which one counts.

  function vkey(word) { return String(word || '').replace(/\s+/g, ' ').trim().slice(0, 80).toLowerCase(); }
  function inVocab(word) { return Boolean(st.vocab.words[vkey(word)]); }
  function profileId() {
    var id = null;
    try { id = localStorage.getItem(LS_PROFILE); } catch (e) { /* private mode */ }
    if (!id || !/^[A-Za-z0-9_-]{16,64}$/.test(id)) {
      var bytes = new Uint8Array(24), chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
      (window.crypto || window.msCrypto).getRandomValues(bytes);
      id = Array.prototype.map.call(bytes, function (b) { return chars[b & 63]; }).join('');
      try { localStorage.setItem(LS_PROFILE, id); } catch (e) { /* lasts for this page only */ }
    }
    return id;
  }
  function vocabFetch(method, query, body) {
    var opts = { method: method, cache: 'no-store', headers: { 'x-subsync-profile': profileId() } };
    if (body) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(BASE + '/vocab' + (query || ''), opts).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (j) {
        if (r.status === 401) throw new Error(j && j.mode === 'profile' ? '无法识别用户' : '登录已过期，请刷新页面重新登录'); // the login gateway answers 401 itself
        if (!r.ok || !j || !j.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
        return j;
      });
    });
  }
  function ensureVocab(force) {
    if (st.vocab.loading) return st.vocab.loading;
    if (st.vocab.loaded && !force) return Promise.resolve(st.vocab);
    st.vocab.loading = vocabFetch('GET').then(function (j) {
      var words = {};
      (j.words || []).forEach(function (w) { words[vkey(w.word)] = w; });
      st.vocab.words = words; st.vocab.user = j.user || null; st.vocab.loaded = true; st.vocab.error = '';
    }).catch(function (e) { st.vocab.error = e.message || '读取失败'; })
      .then(function () { st.vocab.loading = null; renderPanel(); return st.vocab; });
    return st.vocab.loading;
  }
  function vocabAdd(entry, quiet) {
    return vocabFetch('POST', '', entry).then(function (j) {
      st.vocab.words[vkey(j.item.word)] = j.item;
      if (!quiet) badge('已加入生词本：' + j.item.word);
      renderPanel();
    }).catch(function (e) { if (!quiet) toast('加入生词本失败：' + e.message, 'error'); });
  }
  function vocabRemove(word) {
    return vocabFetch('DELETE', '?word=' + encodeURIComponent(vkey(word))).then(function () {
      delete st.vocab.words[vkey(word)];
      renderPanel();
    }).catch(function (e) { toast('移除失败：' + e.message, 'error'); });
  }

  // What is playing, to note with a saved word and to find the way back to its sentence.
  function refreshMeta() {
    var core = window.core;
    if (!core || typeof core.getState !== 'function') return Promise.resolve(null);
    var href = location.hash;
    return Promise.resolve().then(function () { return core.getState('player'); }).then(function (p) {
      if (!p || location.hash !== href) return st.meta;
      var item = p.metaItem && p.metaItem.content ? p.metaItem.content : null;
      var sel = p.selected || {}, path = sel.streamRequest && sel.streamRequest.path ? sel.streamRequest.path : null;
      var title = item && item.name ? String(item.name) : '';
      var si = p.seriesInfo;
      if (title && si && typeof si.season === 'number' && typeof si.episode === 'number') title += ' S' + (si.season < 10 ? '0' : '') + si.season + 'E' + (si.episode < 10 ? '0' : '') + si.episode;
      var video = { id: path && path.id ? String(path.id) : '', type: path && path.type ? String(path.type) : (item && item.type) || '', metaId: item && item.id ? String(item.id) : '' };
      if (/^#\/player\//.test(href) && href.length <= 3000) video.href = href;
      st.meta = { title: title, video: video };
      renderPanel();
      return st.meta;
    }).catch(function () { return st.meta; });
  }
  function sentenceStart() { // player time (ms) at which the sentence on screen begins
    if (st.time === null) return null;
    var cc = currentCues(), t = st.time - cc.delay, hit = null;
    cc.cues.forEach(function (c) { if (c.startTime <= t + 150 && t <= c.endTime + 300) hit = c; });
    return hit ? hit.startTime + cc.delay : st.time;
  }
  function sameVideo(item) {
    var v = item && item.video, m = st.meta && st.meta.video;
    return Boolean(v && m && v.id && v.id === m.id);
  }
  function jumpTo(item) {
    if (typeof item.time !== 'number') return;
    if (sameVideo(item)) { seekSentence(item.time); return; }
    if (!(item.video && item.video.href)) { toast('这句话在另一部片里：' + (item.title || ''), 'info'); return; }
    st.pendingSeek = { href: item.video.href, time: item.time, at: Date.now() };
    closePanel();
    location.hash = item.video.href;
  }
  function seekSentence(ms) {
    st.spDone = null; st.hoverSuppressed = true;
    st.spWait = null;
    safeDispatch({ type: 'setProp', propName: 'time', propValue: Math.max(0, Math.round(ms - 60)) });
    if (st.paused) { st.pausedByHover = false; safeDispatch({ type: 'setProp', propName: 'paused', propValue: false }); }
  }
  function applyPendingSeek() { // the other video has loaded: go to the sentence the word came from
    var ps = st.pendingSeek;
    if (!ps) return;
    if (Date.now() - ps.at > 180000) { st.pendingSeek = null; return; }
    if (location.hash !== ps.href || st.time === null) return;
    st.pendingSeek = null;
    setTimeout(function () { seekSentence(ps.time); }, 0);
  }

  // The button sits with the player's own buttons (it copies their classes for the look); the panel is
  // an element of ours on the right edge of the player, like the player's episode drawer.
  var BOOK_ICON = 'M6 2h11a2 2 0 0 1 2 2v14a1 1 0 0 1-1 1H7a1 1 0 0 0 0 2h11a1 1 0 1 1 0 2H7a3 3 0 0 1-3-3V4a2 2 0 0 1 2-2zm3 4a1 1 0 0 0 0 2h6a1 1 0 1 0 0-2H9zm0 4a1 1 0 0 0 0 2h4a1 1 0 1 0 0-2H9z';
  function ensureVocabButton() {
    if (!st.video) return;
    var host = document.querySelector('[class*="control-bar-buttons-menu-container"]');
    if (!host) return;
    if (st.vbtn && st.vbtn.parentNode === host) return;
    var sample = null;
    for (var i = 0; i < host.children.length; i++) {
      var c = host.children[i];
      if (c === st.vbtn || !/control-bar-button/.test(String(c.className))) continue;
      if (!sample || /(^|\s)disabled(\s|$)/.test(String(sample.className))) sample = c;
    }
    if (!sample) return;
    var b = st.vbtn;
    if (!b) {
      b = st.vbtn = el('div');
      b.addEventListener('click', function (e) { e.stopPropagation(); togglePanel(); });
      b.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    }
    b.className = String(sample.className).split(/\s+/).filter(function (c) { return c && c !== 'disabled' && c !== 'active'; }).concat('ss-vbtn').join(' ');
    b.title = '生词本'; b.tabIndex = -1;
    b.textContent = '';
    var ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg'), path = document.createElementNS(ns, 'path');
    var sampleSvg = sample.querySelector('svg');
    if (sampleSvg && sampleSvg.getAttribute('class')) svg.setAttribute('class', sampleSvg.getAttribute('class')); else { svg.style.width = '1.8rem'; svg.style.height = '1.8rem'; }
    svg.setAttribute('viewBox', '0 0 24 24');
    path.setAttribute('d', BOOK_ICON); path.setAttribute('fill', 'currentColor');
    svg.appendChild(path); b.appendChild(svg);
    host.insertBefore(b, host.firstChild);
  }
  function togglePanel() { if (st.panelOpen) closePanel(); else openPanel(); }
  function closePanel() {
    st.panelOpen = false;
    if (st.panel && st.panel.parentNode) st.panel.parentNode.removeChild(st.panel);
  }
  function openPanel() {
    var root = st.root || document.body;
    if (!st.panel) {
      st.panel = el('div', 'ss-panel');
      st.panel.__onlyThis = false;
      st.panel.addEventListener('mousemove', function (e) { e.immersePrevented = true; }); // keep the controls from hiding under the mouse
      ['wheel', 'touchstart', 'touchmove', 'touchend', 'contextmenu'].forEach(function (t) { st.panel.addEventListener(t, function (e) { e.stopPropagation(); }, { passive: true }); });
    }
    if (st.panel.parentNode !== root) root.appendChild(st.panel);
    // Stay clear of the control bar: its buttons (this panel's own among them) remain usable.
    var cb = document.querySelector('[class*="control-bar-container"]'), rr = root.getBoundingClientRect();
    var gap = cb ? Math.round(rr.bottom - cb.getBoundingClientRect().top) : 0;
    st.panel.style.bottom = (gap > 0 && gap < rr.height / 2 ? gap : 0) + 'px';
    st.panelOpen = true;
    renderPanel();
    refreshMeta();
    ensureVocab(true);
  }
  function fmtDate(iso) { var m = /^\d{4}-(\d\d)-(\d\d)/.exec(String(iso || '')); return m ? m[1] + '-' + m[2] : ''; }
  function renderPanel() {
    var panel = st.panel;
    if (!panel || !st.panelOpen) return;
    var scroll = panel.querySelector('.ss-vl'), keep = scroll ? scroll.scrollTop : 0;
    var all = Object.keys(st.vocab.words).map(function (k) { return st.vocab.words[k]; })
      .sort(function (a, b) { return String(b.addedAt || '').localeCompare(String(a.addedAt || '')); });
    var here = all.filter(sameVideo), items = panel.__onlyThis ? here : all;
    panel.textContent = '';
    var head = el('div', 'ss-vh');
    head.appendChild(el('span', 'ss-vt', '生词本'));
    head.appendChild(el('span', 'ss-muted', all.length + ' 个' + (st.vocab.user && st.vocab.user.name ? ' · ' + st.vocab.user.name : '')));
    var x = el('span', 'ss-vx', '×'); x.title = '关闭（Esc）'; x.__ssAct = closePanel;
    head.appendChild(x);
    panel.appendChild(head);
    var tabs = el('div', 'ss-vtabs');
    [['全部 ' + all.length, false], ['本片 ' + here.length, true]].forEach(function (t) {
      var tab = el('span', 'ss-vtab' + (panel.__onlyThis === t[1] ? ' on' : ''), t[0]);
      tab.__ssAct = function () { panel.__onlyThis = t[1]; renderPanel(); };
      tabs.appendChild(tab);
    });
    panel.appendChild(tabs);
    var list = el('div', 'ss-vl');
    if (st.vocab.error) list.appendChild(el('div', 'ss-muted', '读取生词本失败：' + st.vocab.error));
    else if (!st.vocab.loaded) list.appendChild(el('div', 'ss-muted', '读取中…'));
    else if (!items.length) list.appendChild(el('div', 'ss-muted', panel.__onlyThis ? '这部片还没有生词。' : '还没有生词。点字幕里的单词，在弹出的释义里按「＋ 生词本」。'));
    items.forEach(function (w) {
      var it = el('div', 'ss-vi');
      var top = el('div'); top.appendChild(el('span', 'ss-vw', w.word));
      if (w.phonetic) top.appendChild(el('span', 'ss-ph', '/' + w.phonetic + '/'));
      it.appendChild(top);
      var del = el('span', 'ss-vd', '×'); del.title = '从生词本移除';
      del.__ssAct = function () { vocabRemove(w.word); };
      it.appendChild(del);
      (w.entries || []).slice(0, 4).forEach(function (t) { it.appendChild(el('div', 'ss-pe', t)); });
      if (w.meaning) { var m = el('div', 'ss-pe'); m.appendChild(el('span', 'ss-pl', '句中')); m.appendChild(document.createTextNode(w.meaning)); it.appendChild(m); }
      if (w.sentence) {
        var can = typeof w.time === 'number' && (sameVideo(w) || Boolean(w.video && w.video.href));
        var sen = el('div', 'ss-vs' + (can ? ' go' : ''));
        sen.appendChild(el('div', null, (can ? '▶ ' : '') + w.sentence));
        if (w.sentenceZh) sen.appendChild(el('div', 'ss-vz', w.sentenceZh));
        if (can) { sen.title = sameVideo(w) ? '跳到这句话' : '打开这部片并跳到这句话'; sen.__ssAct = function () { jumpTo(w); }; }
        it.appendChild(sen);
      }
      var metaLine = [w.title || '', typeof w.time === 'number' ? fmtTime(w.time / 1000) : '', fmtDate(w.addedAt)].filter(Boolean).join(' · ');
      if (metaLine) it.appendChild(el('div', 'ss-vm', metaLine));
      list.appendChild(it);
    });
    panel.appendChild(list);
    list.scrollTop = keep;
  }

  function wordTarget(e) {
    var n = e.target;
    return n && n.nodeType === 1 && n.classList && n.classList.contains('ss-w') && containerOf(n) ? n : null;
  }
  ['mousedown', 'mouseup', 'dblclick'].forEach(function (type) {
    window.addEventListener(type, function (e) {
      if (wordTarget(e) || inPopup(e.target) || inPanel(e.target)) e.stopImmediatePropagation();
      if (type === 'mouseup' && containerOf(e.target)) {
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
    if (inPopup(e.target)) { e.stopImmediatePropagation(); runAct(e.target, st.popup); return; }
    if (inPanel(e.target)) { e.stopImmediatePropagation(); runAct(e.target, st.panel); return; }
    if (st.popup) closePopup();
  }, true);
})();
