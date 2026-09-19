// Loaded before stremio-web's bundle (deploy.sh puts the script tag in front of main.js).
// The player asks the browser once, while it loads, whether it can play HEVC. When it can (Chrome on a
// machine with an HEVC decoder), the streaming server passes HEVC video through instead of transcoding
// it, cutting segments at the source's own keyframes; most x265 releases use open GOPs, so a few frames
// are lost at every segment boundary and the picture skips every ten seconds or so. Safari answers "no"
// to the same question, gets H.264 in even four-second segments and plays smoothly. So answer "no" here
// as well, unless the viewer opted in to the passthrough (a checkbox in the bar above the subtitles menu;
// it takes effect after a reload, because the player asks only once).
(function () {
  'use strict';
  var proto = window.HTMLMediaElement && window.HTMLMediaElement.prototype;
  if (!proto || typeof proto.canPlayType !== 'function') return;
  var original = proto.canPlayType;
  var HEVC = /codecs\s*=\s*"?[^"]*\b(hev1|hvc1)\b/i;
  var direct = false, native = false;
  try { direct = localStorage.getItem('subsync.hevcDirect') === '1'; } catch (e) { /* storage unavailable */ }
  try { native = Boolean(original.call(document.createElement('video'), 'video/mp4; codecs="hev1.1.6.L150.B0"')); } catch (e) { /* no answer: leave it */ }
  window.__subsyncHevc = { native: native, direct: direct }; // read by subsync-ui.js to offer the checkbox
  if (direct || !native) return;
  proto.canPlayType = function (type) { return HEVC.test(String(type)) ? '' : original.apply(this, arguments); };
})();
