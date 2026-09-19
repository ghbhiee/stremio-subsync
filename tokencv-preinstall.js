// Install the addons this deployment expects into the Stremio profile, once per browser profile.
// Runs after stremio-web's core is ready (it exposes window.core). An addon the user removes later
// is not re-added (remembered in localStorage). Edit ADDONS / REPLACED to taste.
// The subsync addon is also kept up to date (a profile keeps the manifest it installed, so new resources
// such as "stream" would never reach it) and ahead of the torrent addons installed here: Stremio lists
// streams in the order the addons were installed, and the videos downloaded to the server belong on top.
(function () {
  'use strict';

  var SUBSYNC = '__SUBSYNC_MANIFEST__'; // filled in by deploy.sh
  var ADDONS = [
    SUBSYNC,
    'https://torrentio.strem.fun/manifest.json',
    'https://mediafusion.elfhosted.com/manifest.json'
  ].filter(function (u) { return /^https?:/.test(u); });
  // Replaced by the subsync addon, which serves the same subtitles already aligned.
  var REPLACED = ['https://opensubtitles-v3.strem.io/manifest.json'];
  var MARK = 'tokencv.preinstall.v1';

  function loadState() {
    try { return JSON.parse(localStorage.getItem(MARK) || '{}'); } catch (e) { return {}; }
  }
  function saveState(state) {
    try { localStorage.setItem(MARK, JSON.stringify(state)); } catch (e) { /* storage unavailable */ }
  }

  function whenCoreReady(callback, attempt) {
    attempt = attempt || 0;
    if (window.core && typeof window.core.getState === 'function' && typeof window.core.dispatch === 'function') {
      callback(window.core);
    } else if (attempt < 240) {
      setTimeout(function () { whenCoreReady(callback, attempt + 1); }, 500);
    }
  }

  function fetchManifest(url) {
    return fetch(url, { credentials: 'same-origin' }).then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); });
  }
  function addonsOf(core) {
    return Promise.resolve(core.getState('ctx')).then(function (ctx) { return (ctx && ctx.profile && ctx.profile.addons) || []; });
  }
  function ctxAction(core, action, args) { core.dispatch({ action: 'Ctx', args: { action: action, args: args } }); }

  // A newer manifest on the server replaces the installed copy in place.
  async function upgradeSubsync(core) {
    var mine = (await addonsOf(core)).filter(function (a) { return a.transportUrl === SUBSYNC; })[0];
    if (!mine) return;
    var latest = await fetchManifest(SUBSYNC);
    if (!latest || !latest.version || latest.version === (mine.manifest && mine.manifest.version)) return;
    ctxAction(core, 'UpgradeAddon', { manifest: latest, transportUrl: SUBSYNC, flags: mine.flags || { official: false, protected: false } });
    console.info('[preinstall] upgraded', latest.name, latest.version);
  }

  // Once: the torrent addons this script installed move behind the subsync addon (removed and installed
  // again, which appends them). Their manifests are fetched first; if one cannot be had, nothing moves.
  async function reorder(core, state) {
    if (state['order.v2']) return;
    var list = await addonsOf(core), urls = list.map(function (a) { return a.transportUrl; });
    var at = urls.indexOf(SUBSYNC);
    if (at === -1) return;
    var ahead = list.filter(function (a, i) { return i < at && a.transportUrl !== SUBSYNC && ADDONS.indexOf(a.transportUrl) !== -1 && !(a.flags && a.flags.protected); });
    if (ahead.length) {
      var manifests = await Promise.all(ahead.map(function (a) { return fetchManifest(a.transportUrl); }));
      ahead.forEach(function (a, i) {
        ctxAction(core, 'UninstallAddon', a);
        ctxAction(core, 'InstallAddon', { manifest: manifests[i], transportUrl: a.transportUrl, flags: a.flags || { official: false, protected: false } });
      });
      console.info('[preinstall] moved behind the subsync addon:', ahead.map(function (a) { return a.manifest && a.manifest.name; }).join(', '));
    }
    state['order.v2'] = 1;
  }

  whenCoreReady(async function (core) {
    var state = loadState();
    try {
      var ctx = await core.getState('ctx');
      var installed = (ctx && ctx.profile && ctx.profile.addons) || [];
      var urls = installed.map(function (a) { return a.transportUrl; });

      for (var i = 0; i < ADDONS.length; i++) {
        var url = ADDONS[i];
        if (urls.indexOf(url) !== -1) { state[url] = state[url] || 'present'; continue; }
        if (state[url]) continue;
        try {
          var manifest = await fetchManifest(url);
          ctxAction(core, 'InstallAddon', { manifest: manifest, transportUrl: url, flags: { official: false, protected: false } });
          state[url] = 'installed';
          console.info('[preinstall] installed', manifest.name);
        } catch (e) {
          console.warn('[preinstall] failed to install', url, e);
        }
      }

      for (var j = 0; j < REPLACED.length; j++) {
        var old = installed.filter(function (a) { return a.transportUrl === REPLACED[j]; })[0];
        var key = 'removed:' + REPLACED[j];
        if (old && !(old.flags && old.flags.protected) && !state[key]) {
          ctxAction(core, 'UninstallAddon', old);
          state[key] = 1;
          console.info('[preinstall] removed', old.manifest && old.manifest.name);
        }
      }

      if (/^https?:/.test(SUBSYNC)) {
        await upgradeSubsync(core).catch(function (e) { console.warn('[preinstall] upgrade failed', e); });
        await reorder(core, state).catch(function (e) { console.warn('[preinstall] reorder failed', e); });
      }
    } catch (e) {
      console.warn('[preinstall] error', e);
    }
    saveState(state);
  });
})();
