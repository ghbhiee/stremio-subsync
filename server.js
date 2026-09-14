#!/usr/bin/env node
// Stremio subtitles addon: proxies OpenSubtitles v3, aligns every candidate subtitle to the video that is
// actually being played (found in the local streaming engine) and ranks them. Also offers bilingual
// (Chinese + English) and machine-translated Chinese tracks.
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { align, speechFromRms, parseSrt, formatSrt } = require('./align');
const translate = require('./translate');

const PORT = Number(process.env.PORT || 11480);
const HOST = process.env.HOST || '127.0.0.1';
const TOKEN = process.env.SUBSYNC_TOKEN || '';
const PUBLIC_BASE = (process.env.PUBLIC_BASE || '').replace(/\/$/, ''); // .../subsync (token appended)
const ENGINE = process.env.ENGINE_URL || 'http://127.0.0.1:11470';
const UPSTREAM = process.env.UPSTREAM_URL || 'https://opensubtitles-v3.strem.io';
const CACHE_DIR = process.env.CACHE_DIR || '/var/lib/stremio-subsync';
const FFMPEG = process.env.FFMPEG_BIN || '/usr/bin/ffmpeg';
const FFPROBE = process.env.FFPROBE_BIN || '/usr/bin/ffprobe';
const REF_SECONDS = Number(process.env.REF_SECONDS || 600);
const LIST_WAIT_MS = Number(process.env.LIST_WAIT_MS || 8000);
const SUB_WAIT_MS = Number(process.env.SUB_WAIT_MS || 40000);
const TRANSLATE_WAIT_MS = Number(process.env.TRANSLATE_WAIT_MS || 40000); // browser -> nginx /subtitles.vtt allows 60 s
const GOOD_CUES = Number(process.env.GOOD_CUES || 0.55);   // cue-start match ratio vs embedded track
const GOOD_SPEECH = Number(process.env.GOOD_SPEECH || 0.6); // share of subtitle time on detected speech
const GOOD_CONSENSUS = Number(process.env.GOOD_CONSENSUS || 0.9); // agreement with the consensus subtitle
const CONSENSUS_CANDIDATES = Number(process.env.CONSENSUS_CANDIDATES || 6);
const CONSENSUS_WINDOW = 1200; // seconds compared when picking the consensus subtitle
const RETRY_AFTER_MS = 60000;
const RMS_BIN = 0.05;
// Audio-only alignment (no embedded subtitle track) is experimental: an energy VAD misreads laugh tracks
// and music, and can shift an already-correct subtitle. Off by default; timings are then left unchanged.
const ALIGN_AUDIO = process.env.ALIGN_AUDIO === '1';
const ENG = new Set(['eng', 'en']);
const CHI = new Set(['chi', 'zho', 'zht', 'zhs', 'chs', 'cht', 'ze', 'zh']);
const ALIGN_LANGS = new Set((process.env.ALIGN_LANGS || [...ENG, ...CHI].join(',')).split(','));
const MT_LANG = process.env.MT_LANG || 'chi';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

if (!TOKEN || !PUBLIC_BASE) {
  console.error('SUBSYNC_TOKEN and PUBLIC_BASE are required');
  process.exit(1);
}

const MANIFEST = {
  id: 'com.tokencv.subsync',
  version: '1.1.0',
  name: '字幕对齐',
  description: 'OpenSubtitles 字幕：按正在播放的视频自动对齐时间轴并排序，提供中英双语与 AI 机翻中文字幕',
  resources: ['subtitles'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
};

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(bin, args, { timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('nice', ['-n', '10', bin, ...args], { timeout, maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; reject(err); } else resolve({ stdout, stderr });
    });
  });
}

async function fetchText(url, timeout = 20000) {
  const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

// ---------- video lookup / reference ----------

async function findVideo(size, filename) {
  const stats = JSON.parse(await fetchText(`${ENGINE}/stats.json`, 5000));
  const base = (filename || '').split('/').pop();
  let fallback = null;
  for (const [ih, t] of Object.entries(stats)) {
    if (!t || !Array.isArray(t.files)) continue;
    for (let i = 0; i < t.files.length; i++) {
      const f = t.files[i];
      if (size && Number(f.length) !== Number(size)) continue;
      const hit = { url: `${ENGINE}/${ih}/${i}`, name: f.name, length: Number(f.length) };
      if (!base || f.name.split('/').pop() === base) return hit;
      if (size) fallback = fallback || hit;
    }
  }
  return fallback;
}

// Stremio asks for subtitles first with only a file name, then again with videoSize/videoHash, and
// stremio-web keys addon subtitles by list position ("<addon>_<index>"), keeping the first one it saw.
// Different lists for the two requests therefore drop entries. Resolve size and hash of a file-name-only
// request through the engine so both requests get the same list.
const hashCache = new Map();
async function resolveVideoParams(params) {
  let size = params.get('videoSize'), hash = params.get('videoHash');
  const filename = params.get('filename') || '';
  if (size && hash) return { size, hash, filename };
  if (!filename) return null;
  const video = await findVideo(size, filename).catch(() => null);
  if (!video) return null;
  size = size || String(video.length);
  if (!hash) {
    if (!hashCache.has(video.url)) {
      const res = await fetchText(`${ENGINE}/opensubHash?videoUrl=${encodeURIComponent(video.url)}`, 20000).then(JSON.parse).catch(() => null);
      if (res && res.result && res.result.hash) hashCache.set(video.url, res.result.hash);
    }
    hash = hashCache.get(video.url);
  }
  return hash ? { size, hash, filename } : null;
}

async function buildReference(job) {
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-show_entries', 'stream=index,codec_type,codec_name,avg_frame_rate:stream_tags=language', '-of', 'json', job.videoUrl], { timeout: 90000 });
  const streams = JSON.parse(stdout).streams || [];
  const video = streams.find((s) => s.codec_type === 'video');
  if (video && /^\d+\/\d+$/.test(video.avg_frame_rate || '')) {
    const [n, d] = video.avg_frame_rate.split('/').map(Number);
    if (d) job.fps = n / d;
  }
  const subs = streams.filter((s) => s.codec_type === 'subtitle');
  const pick = subs.find((s) => (s.tags || {}).language === 'eng') || subs[0];
  if (pick) {
    const { stdout: pk } = await run(FFPROBE, ['-v', 'error', '-select_streams', String(pick.index), '-show_entries', 'packet=pts_time,duration_time', '-read_intervals', `%+${REF_SECONDS}`, '-of', 'csv=p=0', job.videoUrl], { timeout: 300000 });
    const cues = pk.split('\n').map((l) => l.split(',')).filter((p) => /^[\d.]+$/.test(p[0]))
      .map(([s, d]) => [Number(s), Number(s) + (/^[\d.]+$/.test(d || '') && Number(d) > 0 ? Number(d) : 2)])
      .sort((a, b) => a[0] - b[0]);
    if (cues.length >= 20) {
      job.refMode = `embedded:${pick.codec_name}:${(pick.tags || {}).language || '?'}`;
      job.ref = { cues, windowEnd: cues[cues.length - 1][1] };
      return;
    }
  }
  if (!ALIGN_AUDIO) { job.refMode = 'none'; job.ref = null; return; }
  const filter = `aresample=16000,highpass=f=200,lowpass=f=3400,asetnsamples=n=${Math.round(16000 * RMS_BIN)}:p=0,astats=metadata=1:reset=1,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=-`;
  const { stdout: meter } = await run(FFMPEG, ['-nostdin', '-v', 'error', '-t', String(REF_SECONDS), '-i', job.videoUrl, '-vn', '-sn', '-ac', '1', '-af', filter, '-f', 'null', '-'], { timeout: 600000 });
  const rms = [...meter.matchAll(/RMS_level=(-?[\d.]+|-inf)/g)].map((m) => (m[1] === '-inf' ? -120 : Number(m[1])));
  if (rms.length < 600) throw new Error(`audio reference too short (${rms.length} bins)`);
  job.refMode = 'audio';
  job.ref = { speech: speechFromRms(rms, RMS_BIN), windowEnd: rms.length * RMS_BIN };
}

// ---------- alignment jobs ----------

const jobs = new Map(); // videoKey -> job
const jobsByShortKey = new Map();
const UNALIGNED = new Set(['novideo', 'failed', 'noref']);

function subKey(entry) { return String(entry.url).split('/').pop().replace(/[^\w.-]/g, '') || sha1(entry.url).slice(0, 12); }

function releaseTag(entry) {
  const t = `${entry.releaseFormat || ''} ${entry.subtitleFileName || ''} ${entry.movieReleaseName || ''}`.toLowerCase();
  if (/blu-?ray|bdrip|brrip|\bbd\b/.test(t)) return 'BluRay';
  if (/web-?dl|webrip|\bweb\b|amzn|\bnf\b/.test(t)) return 'WEB';
  if (/hdtv/.test(t)) return 'HDTV';
  if (/dvd/.test(t)) return 'DVD';
  return '';
}

function heuristic(job, entry) {
  let score = 0;
  if (entry.m === 'h') score += 50;
  const vt = (job.filename || '').toLowerCase();
  const tag = releaseTag(entry).toLowerCase();
  if (tag && vt.includes(tag)) score += 20;
  if (job.fps && entry.fpsMilli && Math.abs(entry.fpsMilli / 1000 - job.fps) < 0.05) score += 10;
  if (entry.releaseGroup && vt.includes(String(entry.releaseGroup).toLowerCase())) score += 10;
  return score;
}

function isGood(r) {
  const mode = r.refMode || '';
  if (mode.startsWith('embedded')) return r.score >= GOOD_CUES;
  if (mode.startsWith('consensus')) return r.score >= GOOD_CONSENSUS;
  return r.score >= GOOD_SPEECH;
}

async function saveResults(job) {
  await fsp.writeFile(path.join(job.dir, 'results.json'), JSON.stringify({ refMode: job.refMode, results: job.results }, null, 1)).catch(() => {});
}

async function downloadOriginal(job, entry) {
  await fsp.mkdir(job.dir, { recursive: true });
  const orig = path.join(job.dir, `${subKey(entry)}.orig.srt`);
  if (!fs.existsSync(orig)) await fsp.writeFile(orig, await fetchText(entry.url, 30000));
  return orig;
}

async function alignOne(job, entry) {
  const key = subKey(entry);
  const r = job.results[key] = job.results[key] || { key, status: 'pending' };
  try {
    const blocks = parseSrt(await fsp.readFile(await downloadOriginal(job, entry), 'utf8'));
    if (blocks.length < 5) throw new Error('no cues');
    const res = align(blocks.map((b) => [b.start, b.end]), job.ref);
    // Timings in original cue order (piecewise shifts may reorder cues when re-sorted by time).
    await fsp.writeFile(path.join(job.dir, `${key}.times.json`), JSON.stringify(res.aligned));
    await fsp.writeFile(path.join(job.dir, `${key}.srt`), formatSrt(blocks.map((b, i) => ({ ...b, start: res.aligned[i][0], end: res.aligned[i][1] }))));
    Object.assign(r, {
      cjk: blocks.filter((b) => /[\u3400-\u9fff]/.test(b.text)).length / blocks.length,
      status: 'done', refMode: job.refMode, score: res.score, origScore: res.origScore,
      scale: res.scale, offset: res.offset, pieces: new Set(res.pieces.map((p) => p.offset.toFixed(1))).size,
    });
  } catch (e) {
    r.status = 'failed';
    r.error = String(e.message || e).slice(0, 200);
    log('align failed', job.key, key, r.error);
  }
  await saveResults(job);
  return r;
}

function getJob(videoKey, meta) {
  let job = jobs.get(videoKey);
  if (job) return job;
  const dir = path.join(CACHE_DIR, sha1(videoKey));
  job = { key: videoKey, dir, results: {}, status: 'pending', lastRun: 0, mt: {}, ...meta };
  jobs.set(videoKey, job);
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'results.json'), 'utf8'));
    Object.assign(job.results, saved.results || {});
    job.refMode = saved.refMode;
  } catch (_) { /* fresh */ }
  return job;
}

function needsWork(job, entries) {
  return entries.some((e) => ALIGN_LANGS.has(e.lang) && (job.results[subKey(e)] || {}).status !== 'done');
}

function runJob(job, entries) {
  if (job.promise) return job.promise;
  if (job.status === 'noref') return Promise.resolve();
  if (UNALIGNED.has(job.status) && Date.now() - job.lastRun < RETRY_AFTER_MS) return Promise.resolve();
  if (!needsWork(job, entries)) { job.status = 'done'; return Promise.resolve(); }
  job.lastRun = Date.now();
  job.status = 'running';
  job.promise = (async () => {
    await fsp.mkdir(job.dir, { recursive: true });
    if (!job.ref) {
      const video = await findVideo(job.size, job.filename).catch((e) => { log('engine lookup failed', e.message); return null; });
      if (video) {
        job.videoUrl = video.url;
        await buildReference(job);
      }
      if (!job.ref) await consensusReference(job, entries);
      if (!job.ref) {
        job.status = video ? 'noref' : 'novideo';
        log(video ? 'no embedded subtitles and no consensus; timings left unchanged' : 'video not in engine and no consensus', job.key);
        return;
      }
      log('reference', job.key, job.refMode, `window=${Math.round(job.ref.windowEnd)}s`);
    }
    const todo = entries.filter((e) => ALIGN_LANGS.has(e.lang) && (job.results[subKey(e)] || {}).status !== 'done')
      .sort((a, b) => heuristic(job, b) - heuristic(job, a));
    for (const e of todo) await alignOne(job, e);
    job.status = 'done';
  })().catch((e) => { job.status = 'failed'; job.error = String(e.message || e); log('job failed', job.key, job.error); })
    .finally(() => { job.promise = null; startTranslation(job); });
  return job.promise;
}

// Without an embedded track, use the subtitle that most other candidates agree with (after fitting scale
// and offset) as the reference. It needs at least two others agreeing >= GOOD_CONSENSUS, so a lone or
// split field gives no reference. This finds the common timeline, not proof that it matches the video.
async function consensusReference(job, entries) {
  let pool = entries.filter((e) => ENG.has(e.lang));
  if (pool.length < 3) pool = entries.filter((e) => ALIGN_LANGS.has(e.lang));
  pool = pool.map((e, i) => ({ e, s: heuristic(job, e) - i * 0.01 })).sort((a, b) => b.s - a.s).slice(0, CONSENSUS_CANDIDATES).map((x) => x.e);
  const subs = [];
  for (const e of pool) {
    try {
      const blocks = parseSrt(await fsp.readFile(await downloadOriginal(job, e), 'utf8'));
      if (blocks.length >= 20) subs.push({ e, cues: blocks.map((b) => [b.start, b.end]) });
    } catch (err) { log('consensus download failed', subKey(e), err.message); }
  }
  if (subs.length < 3) return;
  const early = (cues) => cues.filter((c) => c[0] < CONSENSUS_WINDOW);
  const agree = subs.map(() => []);
  for (let i = 0; i < subs.length; i++) {
    for (let j = i + 1; j < subs.length; j++) {
      const a = early(subs[i].cues), b = early(subs[j].cues);
      if (a.length < 10 || b.length < 10) { agree[i].push(0); agree[j].push(0); continue; }
      const v = Math.min(align(b, { cues: a, windowEnd: CONSENSUS_WINDOW }).score, align(a, { cues: b, windowEnd: CONSENSUS_WINDOW }).score);
      agree[i].push(v); agree[j].push(v);
    }
  }
  const best = subs.map((x, i) => ({ ...x, strong: agree[i].filter((v) => v >= GOOD_CONSENSUS).length, mean: agree[i].reduce((p, c) => p + c, 0) / agree[i].length }))
    .sort((a, b) => b.strong - a.strong || b.mean - a.mean)[0];
  if (best.strong < 2) return;
  job.refMode = `consensus:${subKey(best.e)}`;
  job.ref = { cues: best.cues, windowEnd: best.cues[best.cues.length - 1][1] };
}

// Best subtitle of a language: highest aligned score if alignment finished, else the heuristic favourite.
function bestEntry(job, langs, { alignedOnly = false } = {}) {
  const list = (job.entries || []).filter((e) => langs.has(e.lang));
  const aligned = list.map((e) => ({ e, r: job.results[subKey(e)] }))
    .filter((x) => x.r && x.r.status === 'done' && isGood(x.r) && (langs !== CHI || (x.r.cjk || 0) >= 0.3))
    .sort((a, b) => b.r.score - a.r.score);
  if (aligned.length) return aligned[0].e;
  if (alignedOnly || !list.length) return null;
  return list.map((e, i) => ({ e, s: heuristic(job, e) - i * 0.01 })).sort((a, b) => b.s - a.s)[0].e;
}

// Cue text in original order plus the timings to use (aligned when available).
async function loadCues(job, entry) {
  const blocks = parseSrt(await fsp.readFile(await downloadOriginal(job, entry), 'utf8'));
  const r = job.results[subKey(entry)];
  const timesFile = path.join(job.dir, `${subKey(entry)}.times.json`);
  if (r && r.status === 'done' && fs.existsSync(timesFile)) {
    const times = JSON.parse(await fsp.readFile(timesFile, 'utf8'));
    if (times.length === blocks.length) return blocks.map((b, i) => ({ text: b.text, start: times[i][0], end: times[i][1] }));
  }
  return blocks;
}

// ---------- translation / bilingual ----------

function titleFor(job) {
  return (job.filename || job.id || '').replace(/\.[a-z0-9]{2,4}$/i, '');
}

// Kick off (or join) machine translation of the current best English subtitle.
async function startTranslation(job) {
  if (!translate.enabled() || !job.entries) return null;
  const entry = bestEntry(job, ENG);
  if (!entry) return null;
  const key = subKey(entry);
  if (!job.mt[key]) {
    job.mt[key] = (async () => {
      const blocks = parseSrt(await fsp.readFile(await downloadOriginal(job, entry), 'utf8'));
      return translate.ensure(path.join(CACHE_DIR, 'translations'), blocks, titleFor(job));
    })().catch((e) => { log('translation start failed', e.message); delete job.mt[key]; return null; });
  }
  return job.mt[key];
}

async function translationState(job) {
  const entry = bestEntry(job, ENG);
  const p = entry && job.mt[subKey(entry)];
  if (!p) return 'idle';
  const t = await Promise.race([p, sleep(300).then(() => null)]);
  return t && t.done ? 'done' : 'running';
}

async function serveTranslated(res, job, variant) {
  if (!(job.entries || []).some((e) => ENG.has(e.lang))) return send(res, 404, 'no english subtitle');
  beginText(res);
  const deadline = Date.now() + TRANSLATE_WAIT_MS;
  // Give a running alignment a moment so the translation lands on the best-aligned English subtitle.
  while (job.promise && !bestEntry(job, ENG, { alignedOnly: true }) && Date.now() < deadline - 25000) await sleep(500);
  const entry = bestEntry(job, ENG);
  const t = await startTranslation(job);
  if (t && !t.done) await Promise.race([t.promise, sleep(Math.max(0, deadline - Date.now()))]);
  const cues = await loadCues(job, entry);
  const zh = (t && t.texts) || {};
  const out = cues.map((c, i) => {
    const en = c.text, cn = zh[i];
    return { ...c, text: variant === 'mt-zh' ? (cn || en) : (cn ? `${cn}\n${en}` : en) };
  });
  log('serve', variant, titleFor(job), `${Object.keys(zh).length}/${cues.length} translated`);
  res.end(formatSrt(out.sort((a, b) => a.start - b.start)));
}

async function serveHumanBilingual(res, job) {
  const en = bestEntry(job, ENG, { alignedOnly: true }), cn = bestEntry(job, CHI, { alignedOnly: true });
  if (!en || !cn) return send(res, 404, 'needs aligned english and chinese subtitles');
  beginText(res);
  const enCues = (await loadCues(job, en)).sort((a, b) => a.start - b.start);
  const cnCues = (await loadCues(job, cn)).sort((a, b) => a.start - b.start);
  let j = 0;
  const out = enCues.map((c) => {
    while (j < cnCues.length && cnCues[j].end <= c.start) j++;
    const parts = [];
    for (let k = j; k < cnCues.length && cnCues[k].start < c.end; k++) {
      const overlap = Math.min(c.end, cnCues[k].end) - Math.max(c.start, cnCues[k].start);
      if (overlap >= 0.5 * Math.min(c.end - c.start, cnCues[k].end - cnCues[k].start)) parts.push(translate.cleanText(cnCues[k].text));
    }
    return { ...c, text: parts.length ? `${[...new Set(parts)].join(' ')}\n${c.text}` : c.text };
  });
  res.end(formatSrt(out));
}

// ---------- HTTP ----------

const upstreamCache = new Map();

function canonicalExtra({ filename, size, hash }) {
  return `filename=${encodeURIComponent(filename)}&videoSize=${size}&videoHash=${hash}`;
}

async function upstreamList(type, id, extra) {
  const url = `${UPSTREAM}/subtitles/${type}/${encodeURIComponent(id)}${extra ? `/${extra}` : ''}.json`;
  const hit = upstreamCache.get(url);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.list;
  const list = (JSON.parse(await fetchText(url)).subtitles || []).filter((s) => s && s.url && s.lang);
  upstreamCache.set(url, { at: Date.now(), list });
  return list;
}

function labelFor(job, entry, rank) {
  if (!ALIGN_LANGS.has(entry.lang)) return undefined;
  const tag = releaseTag(entry);
  const suffix = tag ? ` · ${tag}` : '';
  if (job.status === 'noref' || job.status === 'novideo') return `未校验(无可用参考)${suffix}`;
  if (UNALIGNED.has(job.status)) return `未对齐${suffix}`;
  const r = job.results[subKey(entry)];
  if (!r || r.status === 'pending') return `⏳ 对齐中${suffix}`;
  if (r.status === 'failed') return `✗ 对齐失败${suffix}`;
  const pct = Math.round((r.score || 0) * 100);
  const notes = [];
  if (Math.abs(r.offset || 0) >= 0.5) notes.push(`原偏移${r.offset > 0 ? '+' : ''}${r.offset.toFixed(1)}s`);
  if (r.scale && Math.abs(r.scale - 1) > 0.01) notes.push('帧率校正');
  const note = notes.length ? ` · ${notes.join(' ')}` : '';
  const consensus = (r.refMode || '').startsWith('consensus');
  if (isGood(r)) return `${rank === 0 ? '✅ 最佳' : '✅ 已对齐'} ${pct}%${consensus ? ' · 多字幕共识' : ''}${note}${suffix}`;
  return consensus ? `⚠️ 与多数字幕不一致 ${pct}%${suffix}` : `⚠️ 不匹配 ${pct}%${suffix}`;
}

function subUrl(job, name) {
  return `${PUBLIC_BASE}/${TOKEN}/sub/${sha1(job.key).slice(0, 16)}/${name}.srt`;
}

function sortedResponse(job, entries) {
  const byLang = new Map();
  for (const e of entries) { if (!byLang.has(e.lang)) byLang.set(e.lang, []); byLang.get(e.lang).push(e); }
  const out = [];
  for (const [lang, list] of byLang) {
    const scored = list.map((e, i) => {
      const r = job.results[subKey(e)];
      const s = r && r.status === 'done' ? (isGood(r) ? 2000 : 1000) + (r.score || 0) * 100 : heuristic(job, e) - i * 0.01;
      return { e, s };
    }).sort((a, b) => b.s - a.s);
    scored.forEach(({ e }, rank) => {
      const aligned = ALIGN_LANGS.has(lang) && !UNALIGNED.has(job.status);
      const item = { id: `subsync-${subKey(e)}`, lang, url: aligned ? subUrl(job, subKey(e)) : e.url };
      const label = labelFor(job, e, rank);
      if (label) item.label = label;
      out.push(item);
    });
  }
  return out;
}

async function extraTracks(job, entries) {
  const items = [];
  if (bestEntry(job, ENG, { alignedOnly: true }) && bestEntry(job, CHI, { alignedOnly: true })) {
    items.push({ id: 'subsync-bilingual', lang: MT_LANG, url: subUrl(job, 'bilingual'), label: '🀄 中英双语 · 人工字幕合并' });
  }
  if (translate.enabled() && entries.some((e) => ENG.has(e.lang))) {
    const pending = (await translationState(job)) === 'done' ? '' : ' · 翻译中';
    items.push({ id: 'subsync-mt-bi', lang: MT_LANG, url: subUrl(job, 'mt-bi'), label: `🤖 中英双语 · AI 翻译${pending}` });
    items.push({ id: 'subsync-mt-zh', lang: MT_LANG, url: subUrl(job, 'mt-zh'), label: `🤖 中文 · AI 翻译${pending}` });
  }
  return items;
}

async function handleSubtitles(res, type, id, extra) {
  const params = new URLSearchParams(extra || '');
  let video = await resolveVideoParams(params);
  if (!video && params.get('videoSize') && params.get('videoHash')) {
    video = { size: params.get('videoSize'), hash: params.get('videoHash'), filename: params.get('filename') || '' };
  }
  // A partial request we cannot complete would give a shorter list than the follow-up request with the hash,
  // and stremio-web would then drop the first entries of the full list. Let the complete request fill it.
  if (!video) return send(res, 200, { subtitles: [], cacheMaxAge: 0 });
  const { size, filename, hash } = video;
  const entries = await upstreamList(type, id, canonicalExtra(video));
  const videoKey = `${hash}|${size}|${filename}`;
  const job = getJob(videoKey, { size, filename, type, id });
  job.entries = entries;
  jobsByShortKey.set(sha1(videoKey).slice(0, 16), job);
  const alignment = runJob(job, entries);
  if (!job.promise) startTranslation(job); // alignment already settled; otherwise it starts translation when done
  await Promise.race([alignment, sleep(LIST_WAIT_MS)]);
  const subtitles = [...await extraTracks(job, entries), ...sortedResponse(job, entries)];
  send(res, 200, { subtitles, cacheMaxAge: job.status === 'done' ? 3600 : 0 });
}

async function handleSub(res, shortKey, key) {
  const job = jobsByShortKey.get(shortKey);
  if (!job) return send(res, 404, 'unknown video');
  if (key === 'mt-bi' || key === 'mt-zh') return serveTranslated(res, job, key);
  if (key === 'bilingual') return serveHumanBilingual(res, job);
  const entry = (job.entries || []).find((e) => subKey(e) === key);
  if (!entry) return send(res, 404, 'unknown subtitle');
  beginText(res);
  const deadline = Date.now() + SUB_WAIT_MS;
  while (Date.now() < deadline) {
    const r = job.results[key];
    if ((r && r.status !== 'pending') || UNALIGNED.has(job.status)) break;
    if (!job.promise) runJob(job, job.entries);
    if (!job.promise) break;
    await sleep(500);
  }
  const aligned = path.join(job.dir, `${key}.srt`), orig = path.join(job.dir, `${key}.orig.srt`);
  const r = job.results[key];
  const file = r && r.status === 'done' && fs.existsSync(aligned) ? aligned : (fs.existsSync(orig) ? orig : null);
  res.end(file ? await fsp.readFile(file, 'utf8') : await fetchText(entry.url, 30000));
}

// The streaming engine fetches subtitle files with a 10 s timeout that is cleared once response headers
// arrive, so send them right away and deliver the body when alignment or translation is ready.
function beginText(res) {
  if (res.headersSent) return;
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
  res.flushHeaders();
}

function send(res, code, body, type) {
  const isText = typeof body === 'string';
  res.writeHead(code, {
    'content-type': type || (isText ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8'),
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
  });
  res.end(isText ? body : JSON.stringify(body));
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean);
    if (req.method === 'OPTIONS') return send(res, 204, '');
    if (parts[0] === 'health') return send(res, 200, { ok: true, jobs: jobs.size, translation: translate.enabled() ? translate.MODEL : false });
    if (parts[0] !== TOKEN) return send(res, 404, 'not found');
    const rest = parts.slice(1);
    if (rest[0] === 'manifest.json') return send(res, 200, MANIFEST);
    if (rest[0] === 'subtitles' && rest.length >= 3) {
      // Keep the extra args exactly as Stremio encoded them: they are forwarded upstream verbatim.
      const [rawId, ...rawExtra] = req.url.split('?')[0].split('/').slice(4);
      const id = decodeURIComponent(rawId.replace(/\.json$/, ''));
      const extra = rawExtra.join('/').replace(/\.json$/, '');
      return await handleSubtitles(res, rest[1], id, extra);
    }
    if (rest[0] === 'sub' && rest.length === 3) return await handleSub(res, rest[1], rest[2].replace(/\.srt$/, ''));
    send(res, 404, 'not found');
  } catch (e) {
    log('request error', req.url.replace(TOKEN, '<token>'), e.message);
    if (!res.headersSent) send(res, 500, { error: 'internal error' });
    else res.end();
  }
}).listen(PORT, HOST, () => log(`subsync listening on http://${HOST}:${PORT} (translation: ${translate.enabled() ? translate.MODEL : 'off'})`));
