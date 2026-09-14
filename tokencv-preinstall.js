// Install the addons this deployment expects into the Stremio profile, once per browser profile.
// Runs after stremio-web's core is ready (it exposes window.core). An addon the user removes later
// is not re-added (remembered in localStorage). Edit ADDONS / REPLACED to taste.
(function () {
  'use strict';

  var ADDONS = [
    'https://torrentio.strem.fun/manifest.json',
    'https://mediafusion.elfhosted.com/manifest.json',
    '__SUBSYNC_MANIFEST__'
  ];
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
          var res = await fetch(url, { credentials: 'same-origin' });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          var manifest = await res.json();
          core.dispatch({
            action: 'Ctx',
            args: { action: 'InstallAddon', args: { manifest: manifest, transportUrl: url, flags: { official: false, protected: false } } }
          });
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
          core.dispatch({ action: 'Ctx', args: { action: 'UninstallAddon', args: old } });
          state[key] = 1;
          console.info('[preinstall] removed', old.manifest && old.manifest.name);
        }
      }
    } catch (e) {
      console.warn('[preinstall] error', e);
    }
    saveState(state);
  });
})();
