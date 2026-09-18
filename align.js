// Subtitle timing alignment without external tools.
// Model: t_video = scale * t_subtitle + offset, with scale taken from common frame-rate conversions
// and offset searched in +-120 s. Two reference kinds:
//  - cue intervals from a subtitle track embedded in the video (exact timings), scored by cue-start matches
//  - a speech-activity signal derived from the audio, scored by cross-correlation (FFT)
// After the global fit, a piecewise pass lets the offset change between chunks (cut/extended editions).
'use strict';

const SCALES = [1, 25 / 23.976, 23.976 / 25, 24 / 23.976, 23.976 / 24, 25 / 24, 24 / 25];
const MAX_OFFSET = 120;
const BIN = 0.05; // seconds per bin for the speech signal

function lowerBound(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; }
  return lo;
}

// ---------- reference: embedded cues ----------

// Share of reference starts (in [from, to)) with a transformed subtitle start within tol.
function cueMatch(refStarts, subStarts, scale, offset, tol, from = -Infinity, to = Infinity) {
  let hits = 0, n = 0;
  for (const r of refStarts) {
    if (r < from || r >= to) continue;
    n++;
    const t = (r - offset) / scale, i = lowerBound(subStarts, t);
    const d = Math.min(i < subStarts.length ? Math.abs(subStarts[i] - t) : 99, i > 0 ? Math.abs(subStarts[i - 1] - t) : 99) * scale;
    if (d <= tol) hits++;
  }
  return n ? hits / n : 0;
}

function fitToCues(refStarts, subStarts) {
  let best = { scale: 1, offset: 0, score: 0 };
  for (const scale of SCALES) {
    for (let off = -MAX_OFFSET; off <= MAX_OFFSET; off += 0.25) {
      const score = cueMatch(refStarts, subStarts, scale, off, 0.5);
      if (score > best.score + 1e-9) best = { scale, offset: off, score };
    }
  }
  // Fine search. Exact timings give a plateau of equally good offsets (anything within the tolerance):
  // take its middle, not its first edge, or the result is biased by up to the tolerance.
  const fine = [];
  for (let off = best.offset - 0.5; off <= best.offset + 0.5; off += 0.02) fine.push([off, cueMatch(refStarts, subStarts, best.scale, off, 0.3)]);
  best.fine = Math.max(...fine.map((f) => f[1]));
  const top = fine.filter((f) => f[1] >= best.fine - 1e-9).map((f) => f[0]);
  let run = [top[0]], longest = run; // longest contiguous run of best offsets
  for (let i = 1; i < top.length; i++) {
    if (top[i] - top[i - 1] < 0.03) run.push(top[i]); else run = [top[i]];
    if (run.length > longest.length) longest = run;
  }
  best.fineOffset = longest[Math.floor(longest.length / 2)];
  best.offset = best.fineOffset;
  best.score = cueMatch(refStarts, subStarts, best.scale, best.offset, 0.4);
  delete best.fine; delete best.fineOffset;
  return best;
}

// ---------- reference: speech activity ----------

// rms: array of dBFS values, one per `binSec` seconds. Returns 0/1 speech bins at BIN resolution.
function speechFromRms(rms, binSec) {
  const vals = rms.filter((v) => Number.isFinite(v) && v > -90).sort((a, b) => a - b);
  if (!vals.length) return new Float64Array(0);
  const noise = vals[Math.floor(vals.length * 0.15)], loud = vals[Math.floor(vals.length * 0.9)];
  const thr = noise + (loud - noise) * 0.45;
  const n = Math.ceil((rms.length * binSec) / BIN), out = new Float64Array(n);
  for (let i = 0; i < rms.length; i++) {
    if (rms[i] >= thr) {
      const a = Math.floor((i * binSec) / BIN), b = Math.ceil(((i + 1) * binSec) / BIN);
      for (let k = a; k < b && k < n; k++) out[k] = 1;
    }
  }
  return out;
}

function fft(re, im, invert) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (2 * Math.PI / len) * (invert ? -1 : 1), wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ur = re[i + j], ui = im[i + j];
        const vr = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci;
        const vi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
        re[i + j] = ur + vr; im[i + j] = ui + vi;
        re[i + j + len / 2] = ur - vr; im[i + j + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
  if (invert) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

// Cross-correlation c[k] = sum_i a[i + k] * b[i] for k in [-maxLag, maxLag].
function xcorr(a, b, maxLag) {
  let n = 1;
  while (n < a.length + b.length + maxLag) n <<= 1;
  const ar = new Float64Array(n), ai = new Float64Array(n), br = new Float64Array(n), bi = new Float64Array(n);
  ar.set(a); br.set(b);
  fft(ar, ai, false); fft(br, bi, false);
  for (let i = 0; i < n; i++) { // a * conj(b)
    const r = ar[i] * br[i] + ai[i] * bi[i], im = ai[i] * br[i] - ar[i] * bi[i];
    ar[i] = r; ai[i] = im;
  }
  fft(ar, ai, true);
  const out = new Float64Array(2 * maxLag + 1);
  for (let k = -maxLag; k <= maxLag; k++) out[k + maxLag] = ar[(k + n) % n];
  return out;
}

function cueSignal(cues, scale, length) {
  const s = new Float64Array(length);
  for (const [a, b] of cues) {
    const i = Math.max(0, Math.floor((a * scale) / BIN)), j = Math.min(length, Math.ceil((b * scale) / BIN));
    for (let k = i; k < j; k++) s[k] = 1;
  }
  return s;
}

// Share of (transformed) subtitle time inside the reference window that lands on speech.
function speechScore(speech, cues, scale, offset, from = 0, to = Infinity) {
  let total = 0, hit = 0;
  for (const [a, b] of cues) {
    const s = a * scale + offset, e = b * scale + offset;
    if (e <= from || s >= to) continue;
    for (let t = Math.max(s, from); t < Math.min(e, to); t += BIN) {
      const k = Math.floor(t / BIN);
      if (k < 0 || k >= speech.length) continue;
      total++; hit += speech[k];
    }
  }
  return total ? hit / total : 0;
}

function fitToSpeech(speech, cues) {
  const maxLag = Math.round(MAX_OFFSET / BIN), win = speech.length * BIN;
  const centered = Float64Array.from(speech, (v) => v - 0.5);
  let best = { scale: 1, offset: 0, score: 0 };
  for (const scale of SCALES) {
    const sig = cueSignal(cues.filter((c) => c[0] * scale < win + MAX_OFFSET), scale, speech.length + maxLag);
    const c = xcorr(centered, sig, maxLag);
    let k = 0;
    for (let i = 1; i < c.length; i++) if (c[i] > c[k]) k = i;
    const offset = (k - maxLag) * BIN, score = speechScore(speech, cues, scale, offset, 0, win);
    if (score > best.score) best = { scale, offset, score };
  }
  return best;
}

// ---------- piecewise refinement ----------

// Split subtitle cues into chunks and let each chunk move within +-maxShift of the global fit when that
// clearly improves its local score. Chunks outside the reference window inherit the nearest chunk offset.
function refine(cues, fit, localScore, windowEnd, { chunk = 90, maxShift = 30, step = 0.1, gain = 0.15 } = {}) {
  const pieces = [];
  let start = 0;
  while (start < cues.length) {
    const t0 = cues[start][0] * fit.scale + fit.offset;
    let end = start;
    while (end < cues.length && cues[end][0] * fit.scale + fit.offset < t0 + chunk) end++;
    pieces.push({ from: start, to: end, offset: fit.offset });
    start = end;
  }
  for (const p of pieces) {
    const a = cues[p.from][0] * fit.scale + fit.offset, b = cues[p.to - 1][1] * fit.scale + fit.offset;
    if (a >= windowEnd) continue;
    const part = cues.slice(p.from, p.to);
    const base = localScore(part, fit.offset, a - 2, Math.min(b + 2, windowEnd));
    let bestOff = fit.offset, bestScore = base;
    for (let d = -maxShift; d <= maxShift; d += step) {
      const off = fit.offset + d;
      const s = localScore(part, off, a + d - 2, Math.min(b + d + 2, windowEnd));
      if (s > bestScore) { bestScore = s; bestOff = off; }
    }
    if (bestScore >= base + gain) p.offset = bestOff;
  }
  // Pieces beyond the reference window keep the offset of the last measured piece.
  let last = fit.offset;
  for (const p of pieces) {
    const a = cues[p.from][0] * fit.scale + fit.offset;
    if (a < windowEnd) last = p.offset; else p.offset = last;
  }
  return pieces;
}

// ---------- public API ----------

/**
 * @param {Array<[number, number]>} cues subtitle cue intervals (seconds, sorted)
 * @param {{cues?: Array<[number, number]>, speech?: Float64Array, windowEnd: number}} ref
 * @returns {{scale, offset, score, origScore, pieces, map: (t) => number}}
 */
function align(cues, ref) {
  const subStarts = cues.map((c) => c[0]);
  let fit, localScore, origScore;
  if (ref.cues) {
    const refStarts = ref.cues.map((c) => c[0]);
    fit = fitToCues(refStarts, subStarts);
    origScore = cueMatch(refStarts, subStarts, 1, 0, 0.4);
    localScore = (part, off, from, to) => cueMatch(refStarts, part.map((c) => c[0]), fit.scale, off, 0.4, from, to);
  } else {
    fit = fitToSpeech(ref.speech, cues);
    origScore = speechScore(ref.speech, cues, 1, 0, 0, ref.windowEnd);
    localScore = (part, off, from, to) => speechScore(ref.speech, part, fit.scale, off, from, to);
  }
  const pieces = refine(cues, fit, localScore, ref.windowEnd);
  const offsets = new Float64Array(cues.length);
  for (const p of pieces) for (let i = p.from; i < p.to; i++) offsets[i] = p.offset;
  const aligned = cues.map((c, i) => [c[0] * fit.scale + offsets[i], c[1] * fit.scale + offsets[i]]);
  const score = ref.cues
    ? cueMatch(ref.cues.map((c) => c[0]), aligned.map((c) => c[0]), 1, 0, 0.4)
    : speechScore(ref.speech, aligned, 1, 0, 0, ref.windowEnd);
  // `score` asks "does every reference cue have a counterpart?", which punishes a subtitle that merges
  // lines (most translations do) although it is perfectly in sync. `rscore` asks the reverse: what share
  // of this subtitle's own cues, inside the reference window, start where a reference cue starts.
  let rscore;
  if (ref.cues) {
    const refStarts = ref.cues.map((c) => c[0]).sort((a, b) => a - b);
    const mine = aligned.map((c) => c[0]).filter((t) => t >= refStarts[0] - 1 && t <= ref.windowEnd);
    rscore = mine.length >= 5 ? cueMatch(mine, refStarts, 1, 0, 0.4) : 0;
  }
  return { scale: fit.scale, offset: fit.offset, score, rscore, origScore, pieces: pieces.map((p) => ({ from: p.from, to: p.to, offset: p.offset })), aligned };
}

// ---------- SRT helpers ----------

function parseSrt(text) {
  const blocks = [];
  const re = /(\d+):(\d{2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d+):(\d{2}):(\d{2})[.,](\d{1,3})[^\n]*\n([\s\S]*?)(?=\n\s*\n|\n?$)/g;
  const sec = (h, m, s, ms) => Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms.padEnd(3, '0')) / 1000;
  let m;
  const norm = text.replace(/\r\n?/g, '\n');
  while ((m = re.exec(norm))) blocks.push({ start: sec(m[1], m[2], m[3], m[4]), end: sec(m[5], m[6], m[7], m[8]), text: m[9].trim() });
  return blocks.sort((a, b) => a.start - b.start);
}

function formatSrt(blocks) {
  const ts = (t) => {
    const ms = Math.max(0, Math.round(t * 1000));
    const h = Math.floor(ms / 3600000), mi = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60, r = ms % 1000;
    return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(r).padStart(3, '0')}`;
  };
  return blocks.map((b, i) => `${i + 1}\n${ts(b.start)} --> ${ts(b.end)}\n${b.text}\n`).join('\n');
}

module.exports = { align, cueMatch, speechFromRms, parseSrt, formatSrt, SCALES, BIN };
