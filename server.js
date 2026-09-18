#!/usr/bin/env node
// Stremio subtitles addon: proxies OpenSubtitles v3 and, on request, aligns the candidate subtitles to the
// video that is actually being played (found in the local streaming engine), ranks them, merges Chinese
// and English into bilingual tracks and machine-translates the best English subtitle into Chinese.
// Listing subtitles never starts any work: alignment and translation run only through the action
// endpoint (used by the web UI script, subsync-ui.js) or when a client selects one of the "▶" entries.
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { align, cueMatch, speechFromRms, parseSrt, formatSrt } = require('./align');
const translate = require('./translate');
const dict = require('./dict');

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
// "▶" action entries (native clients) wait this long for a result before serving what is available.
const ACTION_WAIT_MS = Number(process.env.ACTION_WAIT_MS || 40000);
// Translation waits this long for a running alignment so it translates the best-aligned English subtitle.
const TRANSLATE_AFTER_ALIGN_MS = Number(process.env.TRANSLATE_AFTER_ALIGN_MS || 120000);
const GOOD_CUES = Number(process.env.GOOD_CUES || 0.55);   // cue-start match ratio vs embedded track
const GOOD_SPEECH = Number(process.env.GOOD_SPEECH || 0.6); // share of subtitle time on detected speech
const GOOD_CONSENSUS = Number(process.env.GOOD_CONSENSUS || 0.9); // agreement with the consensus subtitle
// A subtitle that merges or splits lines differently from the reference (every translation does) covers
// fewer reference cues although it is in sync: accept it when its own cues sit on reference cues.
const GOOD_SYNC = Number(process.env.GOOD_SYNC || 0.85);   // share of its cues that start on a reference cue
const MIN_COVER = Number(process.env.MIN_COVER || 0.45);   // ...while still covering this share of the reference
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
const MT_LANG = 'chi'; // Simplified Chinese variants are listed as "chi": one 中文 group in the player
// Traditional Chinese gets a group of its own, so that bilingual pairing (which takes the best-matching
// Chinese subtitle) never lands on a Traditional one. The player shows a language code it does not know
// as it is, so the "code" is simply the name to display.
const TRAD_LANG = process.env.TRAD_LANG || '繁体中文';
const TRAD_CODES = new Set(['zht', 'cht']);
const CHT = new Set(CHI); // same codes; bestEntry(job, CHT) means "Traditional entries only"
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

if (!TOKEN || !PUBLIC_BASE) {
  console.error('SUBSYNC_TOKEN and PUBLIC_BASE are required');
  process.exit(1);
}

const MANIFEST = {
  id: 'com.tokencv.subsync',
  version: '1.2.0',
  name: '字幕对齐',
  description: 'OpenSubtitles 字幕：按需对齐时间轴并排序，提供中英双语与 AI 翻译中文字幕（对齐和翻译都由用户触发）',
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

// The same file can sit in several torrents of the engine (a re-added stream, a REPACK of the same
// release); prefer an exact file-name match and, among those, the torrent that has downloaded the most.
async function findVideo(size, filename) {
  const stats = JSON.parse(await fetchText(`${ENGINE}/stats.json`, 5000));
  const base = (filename || '').split('/').pop();
  const hits = [];
  for (const [ih, t] of Object.entries(stats)) {
    if (!t || !Array.isArray(t.files)) continue;
    for (let i = 0; i < t.files.length; i++) {
      const f = t.files[i];
      if (size && Number(f.length) !== Number(size)) continue;
      const exact = !base || f.name.split('/').pop() === base;
      if (!exact && !size) continue;
      hits.push({ url: `${ENGINE}/${ih}/${i}`, name: f.name, length: Number(f.length), exact, downloaded: Number(t.downloaded) || 0, peers: Number(t.peers) || 0 });
    }
  }
  hits.sort((a, b) => Number(b.exact) - Number(a.exact) || b.downloaded - a.downloaded || b.peers - a.peers);
  return hits[0] || null;
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

// ---------- jobs (one per video file) ----------

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

// Simplified or Traditional? OpenSubtitles' language codes are not reliable (Traditional files are
// uploaded as "chi"), so once a file is on disk its text decides: count characters that exist in only
// one of the two scripts.
const TRAD_ONLY = '這個們來時說對會過還沒麼樣為與學點裡後現發實開關問題從應該讓嗎聽見覺愛處變體國長東車馬門間電話錢買賣讀寫';
const SIMP_ONLY = '这个们来时说对会过还没么样为与学点里后现发实开关问题从应该让吗听见觉爱处变体国长东车马门间电话钱买卖读写';
function isTraditionalText(text) {
  let trad = 0, simp = 0;
  for (const ch of text) { if (TRAD_ONLY.includes(ch)) trad++; else if (SIMP_ONLY.includes(ch)) simp++; }
  return trad + simp >= 20 ? trad > simp : null; // null: not enough evidence
}

function isTraditional(job, entry) {
  if (!CHI.has(entry.lang)) return false;
  const r = job.results[subKey(entry)];
  if (r && typeof r.trad === 'boolean') return r.trad;
  return TRAD_CODES.has(entry.lang);
}

function isGood(r) {
  const mode = r.refMode || '';
  const inSync = typeof r.rscore === 'number' && r.rscore >= GOOD_SYNC && r.score >= MIN_COVER;
  if (mode.startsWith('embedded')) return r.score >= GOOD_CUES || inSync;
  if (mode.startsWith('consensus')) return r.score >= GOOD_CONSENSUS || inSync;
  return r.score >= GOOD_SPEECH;
}

// In sync but only a small part of the dialogue (forced / foreign-parts-only subtitles).
function isPartial(r) {
  return typeof r.rscore === 'number' && r.rscore >= GOOD_SYNC && r.score < MIN_COVER;
}

function titleFor(job) {
  return (job.filename || job.id || '').replace(/\.[a-z0-9]{2,4}$/i, '');
}

async function saveResults(job) {
  await fsp.mkdir(job.dir, { recursive: true }).catch(() => {});
  await fsp.writeFile(path.join(job.dir, 'results.json'), JSON.stringify({ refMode: job.refMode, state: job.align.state, results: job.results }, null, 1)).catch(() => {});
}

// job.json lets subtitle, status and action requests survive a service restart (the player only asks
// for the list when the video is opened).
async function saveJobFile(job) {
  const data = { key: job.key, size: job.size, filename: job.filename, type: job.type, id: job.id, entries: job.entries || [], mtInfo: job.mtInfo || null, savedAt: new Date().toISOString() };
  const sig = sha1(JSON.stringify(data.entries) + JSON.stringify(data.mtInfo));
  if (job.savedSig === sig) return;
  job.savedSig = sig;
  await fsp.mkdir(job.dir, { recursive: true }).catch(() => {});
  await fsp.writeFile(path.join(job.dir, 'job.json'), JSON.stringify(data)).catch((e) => log('job.json write failed', e.message));
}

function getJob(videoKey, meta = {}) {
  let job = jobs.get(videoKey);
  if (job) { for (const [k, v] of Object.entries(meta)) if (v !== undefined && v !== null) job[k] = v; return job; }
  const dir = path.join(CACHE_DIR, sha1(videoKey));
  job = {
    key: videoKey, shortKey: sha1(videoKey).slice(0, 16), dir, results: {}, entries: [], mt: null, mtInfo: null,
    align: { state: 'idle', phase: '', done: 0, total: 0, startedAt: null, finishedAt: null, error: null },
    lastRun: 0,
  };
  for (const [k, v] of Object.entries(meta)) if (v !== undefined && v !== null) job[k] = v;
  jobs.set(videoKey, job);
  jobsByShortKey.set(job.shortKey, job);
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'results.json'), 'utf8'));
    Object.assign(job.results, saved.results || {});
    for (const r of Object.values(job.results)) if (r.status === 'pending') r.status = 'failed'; // interrupted run
    job.refMode = saved.refMode;
    if (saved.state === 'done' || (!saved.state && Object.values(job.results).some((r) => r.status === 'done'))) job.align.state = 'done';
    else if (saved.state === 'noref' || saved.state === 'novideo') job.align.state = saved.state;
  } catch (_) { /* fresh */ }
  backfillSync(job);
  for (const r of Object.values(job.results)) { // results cached before the script was recorded
    if (r.status !== 'done' || (r.cjk || 0) < 0.3 || typeof r.trad === 'boolean') continue;
    try { const t = isTraditionalText(fs.readFileSync(path.join(dir, `${r.key}.orig.srt`), 'utf8')); if (t !== null) r.trad = t; } catch (_) { /* file gone */ }
  }
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'job.json'), 'utf8'));
    if (!job.mtInfo && saved.mtInfo) job.mtInfo = saved.mtInfo;
    if (!job.entries.length && Array.isArray(saved.entries)) job.entries = saved.entries;
    for (const k of ['size', 'filename', 'type', 'id']) if (job[k] === undefined && saved[k] !== undefined) job[k] = saved[k];
  } catch (_) { /* no job file */ }
  return job;
}

// Results cached before `rscore` existed: with a consensus reference (a subtitle file on disk) it can be
// computed now, so videos aligned earlier lose their false "does not match" marks without a new run.
function backfillSync(job) {
  const m = /^consensus:(.+)$/.exec(job.refMode || '');
  if (!m || !Object.values(job.results).some((r) => r.status === 'done' && typeof r.rscore !== 'number')) return;
  try {
    const starts = (key) => {
      const blocks = parseSrt(fs.readFileSync(path.join(job.dir, `${key}.orig.srt`), 'utf8'));
      let times = null;
      try { times = JSON.parse(fs.readFileSync(path.join(job.dir, `${key}.times.json`), 'utf8')); } catch (_) { /* reference itself */ }
      return blocks.map((b, i) => (times && times.length === blocks.length ? times[i][0] : b.start)).sort((a, b) => a - b);
    };
    const ref = parseSrt(fs.readFileSync(path.join(job.dir, `${m[1]}.orig.srt`), 'utf8')).map((b) => b.start).sort((a, b) => a - b);
    if (ref.length < 20) return;
    for (const r of Object.values(job.results)) {
      if (r.status !== 'done' || typeof r.rscore === 'number') continue;
      try { const mine = starts(r.key); r.rscore = mine.length >= 5 ? cueMatch(mine, ref, 1, 0, 0.4) : 0; } catch (_) { /* file gone */ }
    }
  } catch (_) { /* reference file gone: keep the old verdicts */ }
}

async function jobByShortKey(shortKey) {
  if (jobsByShortKey.has(shortKey)) return jobsByShortKey.get(shortKey);
  if (!/^[0-9a-f]{16}$/.test(shortKey)) return null;
  const names = await fsp.readdir(CACHE_DIR).catch(() => []);
  const dirName = names.find((n) => n.length === 40 && n.startsWith(shortKey));
  if (!dirName) return null;
  const saved = await fsp.readFile(path.join(CACHE_DIR, dirName, 'job.json'), 'utf8').then(JSON.parse).catch(() => null);
  if (!saved || !saved.key) return null;
  return getJob(saved.key, { size: saved.size, filename: saved.filename, type: saved.type, id: saved.id });
}

// ---------- alignment ----------

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
    const trad = isTraditionalText(blocks.map((b) => b.text).join(''));
    if (trad !== null) r.trad = trad;
    Object.assign(r, {
      cjk: blocks.filter((b) => /[㐀-鿿]/.test(b.text)).length / blocks.length,
      status: 'done', refMode: job.refMode, score: res.score, rscore: res.rscore, origScore: res.origScore,
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

function needsWork(job) {
  return (job.entries || []).some((e) => ALIGN_LANGS.has(e.lang) && (job.results[subKey(e)] || {}).status !== 'done');
}

// Align every English and Chinese candidate of the video. Runs only when asked (action endpoint or a
// "▶" entry); the reference (embedded track of the first REF_SECONDS, or the consensus of the
// candidates) is built once per process and the results are cached on disk.
function startAlign(job) {
  if (job.alignPromise) return job.alignPromise;
  if (!needsWork(job)) { job.align.state = 'done'; return Promise.resolve(); }
  if (UNALIGNED.has(job.align.state) && Date.now() - job.lastRun < RETRY_AFTER_MS) return Promise.resolve();
  job.lastRun = Date.now();
  Object.assign(job.align, { state: 'running', phase: 'video', done: 0, total: 0, startedAt: Date.now(), finishedAt: null, error: null });
  job.alignPromise = (async () => {
    await fsp.mkdir(job.dir, { recursive: true });
    if (!job.ref) {
      const video = await findVideo(job.size, job.filename).catch((e) => { log('engine lookup failed', e.message); return null; });
      if (video) {
        job.videoUrl = video.url;
        job.align.phase = 'reference';
        await buildReference(job);
      }
      if (!job.ref) { job.align.phase = 'consensus'; await consensusReference(job, job.entries); }
      if (!job.ref) {
        job.align.state = video ? 'noref' : 'novideo';
        log(video ? 'no embedded subtitles and no consensus; timings left unchanged' : 'video not in engine and no consensus', job.key);
        return;
      }
      log('reference', job.key, job.refMode, `window=${Math.round(job.ref.windowEnd)}s`);
    }
    const todo = job.entries.filter((e) => ALIGN_LANGS.has(e.lang) && (job.results[subKey(e)] || {}).status !== 'done')
      .sort((a, b) => heuristic(job, b) - heuristic(job, a));
    job.align.phase = 'align';
    job.align.total = todo.length;
    for (const e of todo) { await alignOne(job, e); job.align.done++; }
    job.align.state = 'done';
    const best = bestEntry(job, ENG, { alignedOnly: true });
    log('aligned', titleFor(job), `${todo.length} subtitles`, best ? `best ${subKey(best)} ${Math.round(job.results[subKey(best)].score * 100)}%` : 'no good english subtitle');
  })().catch((e) => { job.align.state = 'failed'; job.align.error = String(e.message || e); log('job failed', job.key, job.align.error); })
    .finally(async () => { job.alignPromise = null; job.align.finishedAt = Date.now(); await saveResults(job); });
  return job.alignPromise;
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
  const chinese = langs === CHI || langs === CHT;
  // CHI = Simplified only (what bilingual pairs with English), CHT = Traditional only.
  const list = (job.entries || []).filter((e) => langs.has(e.lang) && (!chinese || isTraditional(job, e) === (langs === CHT)));
  const aligned = list.map((e) => ({ e, r: job.results[subKey(e)] }))
    .filter((x) => x.r && x.r.status === 'done' && isGood(x.r) && (!chinese || (x.r.cjk || 0) >= 0.3))
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

// Start (or join) the machine translation of the best English subtitle. It waits for a running alignment
// (up to TRANSLATE_AFTER_ALIGN_MS) so the translation lands on the best-aligned subtitle; a translation
// already on disk (mtInfo) is reused for the same source without any request.
function ensureTranslation(job, { force = false } = {}) {
  if (!translate.enabled()) return null;
  if (job.mt && !force && job.mt.state !== 'failed') return job.mt;
  const mt = job.mt = { state: 'waiting-align', source: null, entry: null, blocks: null, t: null, startedAt: Date.now(), error: null };
  mt.promise = (async () => {
    const cached = !force && job.mtInfo && (job.entries || []).find((e) => subKey(e) === job.mtInfo.source);
    if (!cached) {
      const until = Date.now() + TRANSLATE_AFTER_ALIGN_MS;
      while (job.alignPromise && Date.now() < until) await sleep(500);
    }
    const entry = cached || bestEntry(job, ENG);
    if (!entry) throw new Error('no english subtitle');
    mt.source = subKey(entry);
    mt.entry = entry;
    mt.state = 'running';
    mt.blocks = parseSrt(await fsp.readFile(await downloadOriginal(job, entry), 'utf8'));
    if (mt.blocks.length < 5) throw new Error('english subtitle has no cues');
    mt.t = translate.ensure(path.join(CACHE_DIR, 'translations'), mt.blocks, titleFor(job));
    await mt.t.promise;
    const translated = Object.keys(mt.t.texts).length;
    if (!translated) throw new Error(mt.t.error || 'nothing translated');
    mt.state = 'done';
    job.mtInfo = { source: mt.source, cues: mt.blocks.length, translated, at: new Date().toISOString() };
    await saveJobFile(job);
  })().catch((e) => { mt.state = 'failed'; mt.error = String(e.message || e); log('translation failed', titleFor(job), mt.error); });
  return mt;
}

// The translation used an English subtitle that alignment later showed to be a poor match while a good
// one exists: the web UI offers to translate again from the best one.
function translationStale(job) {
  const mt = job.mt;
  if (!mt || mt.state !== 'done' || job.align.state !== 'done') return false;
  const best = bestEntry(job, ENG, { alignedOnly: true });
  const r = job.results[mt.source];
  return Boolean(best && subKey(best) !== mt.source && !(r && r.status === 'done' && isGood(r)));
}

function translateStatus(job) {
  if (!translate.enabled()) return { enabled: false, state: 'off' };
  const mt = job.mt;
  if (!mt) {
    const info = job.mtInfo;
    return { enabled: true, state: info ? 'done' : 'idle', cached: Boolean(info), source: info ? info.source : null, done: info ? info.translated : 0, total: info ? info.cues : 0, coveredUntil: null, stale: false, error: null };
  }
  const texts = mt.t ? mt.t.texts : {};
  const total = mt.blocks ? mt.blocks.length : 0;
  let coveredUntil = null;
  if (mt.blocks) {
    let i = 0;
    while (i < total && texts[i]) i++;
    coveredUntil = i >= total ? null : Math.max(0, mt.blocks[i].start);
  }
  return { enabled: true, state: mt.state, cached: Boolean(job.mtInfo), source: mt.source, done: Object.keys(texts).length, total, coveredUntil, stale: translationStale(job), error: mt.error };
}

async function renderTranslated(job, bi) {
  const mt = job.mt;
  const entry = (mt && mt.entry) || bestEntry(job, ENG);
  const cues = await loadCues(job, entry);
  const zh = (mt && mt.t && mt.t.texts) || {};
  const out = cues.map((c, i) => {
    const en = c.text, cn = zh[i];
    return { ...c, text: bi ? (cn ? `${en}\n${cn}` : en) : (cn || en) };
  });
  log('serve', bi ? 'mt+bi' : 'mt', titleFor(job), `${Object.keys(zh).length}/${cues.length} translated`);
  return formatSrt(out.sort((a, b) => a.start - b.start));
}

// Attach the text of `other` cues to the `base` cues they overlap (>= 50 % of the shorter cue).
function mergeBilingual(base, other, { otherFirst = true } = {}) {
  const a = [...base].sort((x, y) => x.start - y.start), b = [...other].sort((x, y) => x.start - y.start);
  let j = 0;
  return a.map((c) => {
    while (j < b.length && b[j].end <= c.start) j++;
    const parts = [];
    for (let k = j; k < b.length && b[k].start < c.end; k++) {
      const overlap = Math.min(c.end, b[k].end) - Math.max(c.start, b[k].start);
      if (overlap >= 0.5 * Math.min(c.end - c.start, b[k].end - b[k].start)) parts.push(translate.cleanText(b[k].text));
    }
    const extra = [...new Set(parts)].join(' ');
    return { ...c, text: extra ? (otherFirst ? `${extra}\n${c.text}` : `${c.text}\n${extra}`) : c.text };
  });
}

// ---------- subtitle list ----------

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

function variantTag(entry) {
  return entry.lang === 'ze' ? '中英' : '';
}

// A listed label is never updated by the player, and a long status in front hides what the entry is. So
// the label is the entry's name (language, variant, release) and a warning follows only when alignment
// found a problem; nothing is said about subtitles that are fine or were never aligned. The web UI shows
// the warning on the second line of the entry instead.
function titleOf(job, entry) {
  const tags = [variantTag(entry), releaseTag(entry)].filter(Boolean);
  const name = !CHI.has(entry.lang) ? 'English' : isTraditional(job, entry) ? '繁体中文' : '中文';
  return `${name}${tags.length ? ` · ${tags.join(' · ')}` : ''}`;
}

function warningOf(job, entry) {
  const r = job.results[subKey(entry)];
  if (!r) return '';
  if (r.status === 'failed') return '✗ 对齐失败';
  if (r.status !== 'done' || isGood(r)) return '';
  if (isPartial(r)) return '⚠️ 只含部分对白';
  const pct = Math.round(Math.max(r.score || 0, r.rscore || 0) * 100);
  return (r.refMode || '').startsWith('consensus') ? `⚠️ 与多数字幕不一致 ${pct}%` : `⚠️ 与视频不匹配 ${pct}%`;
}

function labelFor(job, entry) {
  if (!ALIGN_LANGS.has(entry.lang)) return undefined;
  const warn = warningOf(job, entry);
  return warn ? `${titleOf(job, entry)} · ${warn}` : titleOf(job, entry);
}

function subUrl(job, name, query) {
  return `${PUBLIC_BASE}/${TOKEN}/sub/${job.shortKey}/${name}.srt${query ? `?${query}` : ''}`;
}

function rankScore(job, e, i) {
  const r = job.results[subKey(e)];
  return r && r.status === 'done' ? (isGood(r) ? 2000 : 1000) + (r.score || 0) * 100 : heuristic(job, e) - i * 0.01;
}

function buildList(job) {
  const entries = job.entries || [];
  const groups = new Map();
  for (const e of entries) {
    const lang = !CHI.has(e.lang) ? e.lang : isTraditional(job, e) ? TRAD_LANG : MT_LANG;
    if (!groups.has(lang)) groups.set(lang, []);
    groups.get(lang).push(e);
  }
  const hasEng = entries.some((e) => ENG.has(e.lang));
  const canTranslate = translate.enabled() && hasEng;
  // The AI tracks are listed only once they exist: an entry that shows English until someone generates
  // it is clutter. Without any Chinese entry the 中文 group simply is not there yet (the web UI bar and
  // the "▶" entry start the generation).
  if (canTranslate && job.mtInfo && !groups.has(MT_LANG)) groups.set(MT_LANG, []);
  const out = [];
  for (const [lang, list] of groups) {
    const managed = ENG.has(lang) || lang === MT_LANG || lang === TRAD_LANG;
    if (!managed) { for (const e of list) out.push({ id: `subsync-${subKey(e)}`, lang, url: e.url }); continue; }
    list.map((e, i) => ({ e, s: rankScore(job, e, i) })).sort((a, b) => b.s - a.s).forEach(({ e }) => {
      out.push({ id: `subsync-${subKey(e)}`, lang, url: subUrl(job, subKey(e)), label: labelFor(job, e) });
    });
    if (lang === MT_LANG) {
      // One bilingual entry per kind, never first: the best English with the best human Simplified Chinese,
      // and the AI translation once generated. The Traditional group has subtitles only.
      if (list.length && hasEng) out.push({ id: 'subsync-bi', lang, url: subUrl(job, 'bi'), label: '🀄 中英双语（人工字幕）' });
      if (canTranslate && job.mtInfo) {
        out.push({ id: 'subsync-mt', lang, url: subUrl(job, 'mt'), label: '🤖 AI 中文字幕' });
        out.push({ id: 'subsync-mt-bi', lang, url: subUrl(job, 'mt', 'bi=1'), label: '🤖 中英双语（AI 字幕）' });
      }
    }
    // Action entries for clients without the web UI. They sit at the end of the English list: never
    // first in a language, so the player's automatic selection cannot start work on its own.
    if (ENG.has(lang)) {
      out.push({ id: 'subsync-align', lang, url: subUrl(job, 'align'), label: '▶ 对齐全部字幕（选中即开始）' });
      if (canTranslate && !job.mtInfo) out.push({ id: 'subsync-mt-start', lang, url: subUrl(job, 'mt-start'), label: '▶ 生成 AI 中文字幕（选中即开始，同时对齐）' });
    }
  }
  return out;
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
  saveJobFile(job);
  send(res, 200, { subtitles: buildList(job), cacheMaxAge: 0 });
}

// ---------- subtitle files ----------

async function handleSub(res, shortKey, key, query) {
  const job = await jobByShortKey(shortKey);
  if (!job) return send(res, 404, 'unknown video');
  const bi = query.get('bi') === '1';
  const hasEng = (job.entries || []).some((e) => ENG.has(e.lang));
  if (key === 'align') { // "▶" entry: start alignment, serve the best English subtitle when done or after ACTION_WAIT_MS
    const entry = bestEntry(job, ENG) || bestEntry(job, CHI);
    if (!entry) return send(res, 404, 'nothing to align');
    beginText(res);
    await Promise.race([startAlign(job), sleep(ACTION_WAIT_MS)]);
    const best = ENG.has(entry.lang) ? bestEntry(job, ENG) : bestEntry(job, CHI);
    return res.end(formatSrt((await loadCues(job, best || entry)).sort((a, b) => a.start - b.start)));
  }
  if (key === 'mt-start' || key === 'mt') {
    if (!translate.enabled()) return send(res, 404, 'translation disabled');
    if (!hasEng) return send(res, 404, 'no english subtitle');
    beginText(res);
    if (key === 'mt-start') { // "▶" entry: start alignment and translation, wait a while for the result
      startAlign(job);
      const mt = ensureTranslation(job);
      await Promise.race([mt.promise, sleep(ACTION_WAIT_MS)]);
    } else if (!job.mt && job.mtInfo) { // translation on disk: load it (no API requests)
      await Promise.race([ensureTranslation(job).promise, sleep(15000)]);
    }
    return res.end(await renderTranslated(job, bi));
  }
  // "bi": the top English subtitle with the top human Chinese one underneath (each language's best after
  // alignment, its first-ranked entry before). `?bi=1` on a Chinese entry pairs that one instead.
  const entry = key === 'bi' ? bestEntry(job, CHI) : (job.entries || []).find((e) => subKey(e) === key);
  if (!entry) return send(res, 404, key === 'bi' ? 'no chinese subtitle' : 'unknown subtitle');
  beginText(res);
  let cues = await loadCues(job, entry);
  if ((bi || key === 'bi') && CHI.has(entry.lang)) {
    const en = bestEntry(job, ENG);
    if (en) cues = mergeBilingual(await loadCues(job, en), cues, { otherFirst: false });
  }
  res.end(formatSrt(cues.sort((a, b) => a.start - b.start)));
}

// ---------- status / actions (web UI) ----------

function statusOf(job) {
  const subs = {};
  for (const e of job.entries || []) {
    if (!ALIGN_LANGS.has(e.lang)) continue;
    const r = job.results[subKey(e)] || null;
    subs[subKey(e)] = {
      lang: !CHI.has(e.lang) ? 'eng' : isTraditional(job, e) ? 'cht' : MT_LANG,
      status: r ? r.status : 'none',
      score: r && r.status === 'done' ? Math.round(r.score * 100) / 100 : null,
      sync: r && r.status === 'done' && typeof r.rscore === 'number' ? Math.round(r.rscore * 100) / 100 : null,
      good: Boolean(r && r.status === 'done' && isGood(r)),
      title: titleOf(job, e),
      warn: warningOf(job, e),
      label: labelFor(job, e),
    };
  }
  const bestEn = bestEntry(job, ENG, { alignedOnly: true }), bestZh = bestEntry(job, CHI, { alignedOnly: true }), bestZht = bestEntry(job, CHT, { alignedOnly: true });
  return {
    ok: true, key: job.shortKey, title: titleFor(job),
    align: { ...job.align, refMode: job.refMode || null, running: Boolean(job.alignPromise) },
    translate: translateStatus(job),
    best: { en: bestEn ? subKey(bestEn) : null, zh: bestZh ? subKey(bestZh) : null, zht: bestZht ? subKey(bestZht) : null },
    tradLang: TRAD_LANG,
    hasHumanZh: (job.entries || []).some((e) => CHI.has(e.lang) && !isTraditional(job, e)),
    hasEng: (job.entries || []).some((e) => ENG.has(e.lang)),
    subs,
  };
}

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > limit) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function handleAction(req, res, shortKey) {
  const job = await jobByShortKey(shortKey);
  if (!job) return send(res, 404, { error: 'unknown video' });
  let body = {};
  try { body = JSON.parse((await readBody(req)) || '{}'); } catch (_) { return send(res, 400, { error: 'bad json' }); }
  const wantAlign = Boolean(body.align || body.translate || body.bilingual);
  const wantTranslate = Boolean(body.translate || body.bilingual);
  if (wantAlign) startAlign(job);
  if (wantTranslate) {
    if (!translate.enabled()) return send(res, 400, { error: 'translation disabled', ...statusOf(job) });
    ensureTranslation(job, { force: Boolean(body.force) });
  }
  log('action', titleFor(job), JSON.stringify(body));
  send(res, 200, statusOf(job));
}

// ---------- HTTP plumbing ----------

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
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'cache-control': 'no-store',
  });
  res.end(isText ? body : JSON.stringify(body));
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean);
    if (req.method === 'OPTIONS') return send(res, 204, '');
    if (parts[0] === 'health') return send(res, 200, { ok: true, version: MANIFEST.version, jobs: jobs.size, translation: translate.enabled() ? translate.MODEL : false });
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
    if (rest[0] === 'sub' && rest.length === 3) return await handleSub(res, rest[1], rest[2].replace(/\.srt$/, ''), url.searchParams);
    if (rest[0] === 'status' && rest.length === 2) {
      const job = await jobByShortKey(rest[1]);
      return job ? send(res, 200, statusOf(job)) : send(res, 404, { error: 'unknown video' });
    }
    if (rest[0] === 'action' && rest.length === 2 && req.method === 'POST') return await handleAction(req, res, rest[1]);
    if (rest[0] === 'dict') {
      const q = (url.searchParams.get('q') || '').trim().slice(0, 200);
      const ctx = (url.searchParams.get('ctx') || '').trim().slice(0, 600);
      if (!q) return send(res, 400, { error: 'q required' });
      return send(res, 200, await dict.lookup(q, ctx));
    }
    send(res, 404, 'not found');
  } catch (e) {
    log('request error', req.url.replace(TOKEN, '<token>'), e.message);
    if (!res.headersSent) send(res, 500, { error: 'internal error' });
    else res.end();
  }
}).listen(PORT, HOST, () => log(`subsync ${MANIFEST.version} listening on http://${HOST}:${PORT} (translation: ${translate.enabled() ? translate.MODEL : 'off'})`));
