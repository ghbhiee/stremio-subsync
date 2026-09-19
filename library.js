// Server-side library: whole video files fetched ahead of time, so that later playback is served from
// this machine and no longer depends on the swarm.
// A download simply reads http://<engine>/<infoHash>/<fileIdx> from start to end: the streaming engine
// then fetches every piece in order (it verifies them as usual), and a viewer who plays the same torrent
// meanwhile shares those pieces, which is what makes "watch while it downloads" work without any code of
// our own. Each item lives in <dir>/<id>/ as item.json plus the video file ("<name>.part" until complete),
// so a restart of the service resumes where the file ends.
// When aria2c is installed it does the downloading instead (it connects to many more peers: on a torrent
// the engine fetched at 0.6 MB/s from 6 peers, aria2 reached 3.7 MiB/s from 75), and the engine is the
// fallback when aria2 is missing, keeps failing or stalls. Watching while aria2 downloads still goes
// through the engine, which then fetches its own copy of what is being watched.
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { pipeline } = require('stream');
const { execFile, spawn } = require('child_process');

// Public trackers added to the ones the stream came with: more peers for poorly seeded torrents.
const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce', 'udp://open.stealth.si:80/announce', 'udp://tracker.torrent.eu.org:451/announce',
  'udp://explodie.org:6969/announce', 'udp://exodus.desync.com:6969/announce', 'udp://open.demonii.com:1337/announce',
  'udp://tracker.dler.org:6969/announce', 'udp://tracker.qu.ax:6969/announce', 'udp://tracker-udp.gbitt.info:80/announce',
  'udp://opentracker.io:6969/announce', 'udp://tracker.tiny-vps.com:6969/announce', 'udp://tracker.0x7c0.com:6969/announce',
];
const VIDEO_EXT = /\.(mkv|mp4|m4v|avi|mov|webm|ts|m2ts|wmv|mpg|mpeg|flv)$/i;
const MIME = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska', webm: 'video/webm', avi: 'video/x-msvideo', ts: 'video/mp2t', m2ts: 'video/mp2t' };
const STALL_MS = 180000;      // no byte for this long: drop the request and ask the engine again
const METADATA_MS = 600000;   // how long to wait for the torrent's file list
const SAVE_EVERY_MS = 10000;
const ARIA_ATTEMPTS = 3;      // failed aria2 runs before the engine takes over
const ARIA_STALL_S = 600;     // aria2 gives up after this long without a byte (--bt-stop-timeout)
const ENGINE_HAS_IT = 0.9;    // the engine already holds this share of the file: copy it from there, skip aria2

let cfg = null;
const items = new Map();   // id -> item (what item.json holds)
const active = new Map();  // id -> { cancel(), samples: [[ms, bytes]], lastData, note }
let engineStatsCache = { at: 0, data: {} };
let ariaMissing = false;   // aria2c could not be started: do not try again until the service restarts
const children = new Set();

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sizeOf = (file) => fsp.stat(file).then((s) => s.size, () => 0);

function sanitizeName(name) {
  const base = String(name || '').split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f<>:"|?*]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
  return base.slice(0, 200) || 'video';
}
function text(v, max) { return typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max) : ''; }

function itemDir(it) { return path.join(cfg.dir, it.id); }
function filePath(it) { return path.join(itemDir(it), it.name); }
function partPath(it) { return `${filePath(it)}.part`; }

async function save(it) {
  const file = path.join(itemDir(it), 'item.json'), tmp = `${file}.tmp`;
  await fsp.mkdir(itemDir(it), { recursive: true, mode: 0o755 });
  await fsp.writeFile(tmp, JSON.stringify(it, null, 1), { mode: 0o644 });
  await fsp.rename(tmp, file);
}

// ---------- engine ----------

async function engineJson(pathname, { method = 'GET', body, timeout = 15000 } = {}) {
  const res = await fetch(`${cfg.engine}${pathname}`, {
    method, signal: AbortSignal.timeout(timeout),
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`engine HTTP ${res.status}`);
  return res.json();
}

function sourcesOf(it) {
  const list = [...(it.sources || []), ...cfg.trackers.map((t) => `tracker:${t}`), `dht:${it.infoHash}`];
  return [...new Set(list)];
}

// Make sure the engine has the torrent (with the extra trackers) and learn name and size of the file.
async function prepare(it, st) {
  const deadline = Date.now() + METADATA_MS;
  for (;;) {
    if (st.canceled) throw new Error('canceled');
    try {
      await engineJson(`/${it.infoHash}/create`, { method: 'POST', body: { torrent: { infoHash: it.infoHash }, peerSearch: { sources: sourcesOf(it), min: 40, max: 200 }, guessFileIdx: false } });
      const stats = await engineJson(`/${it.infoHash}/stats.json`);
      const files = Array.isArray(stats.files) ? stats.files : [];
      if (files.length) {
        if (it.fileIdx === null || !files[it.fileIdx]) { // no index given: the largest video file
          let best = -1;
          files.forEach((f, i) => { if (VIDEO_EXT.test(f.name) && (best < 0 || f.length > files[best].length)) best = i; });
          if (best < 0) throw Object.assign(new Error('种子里没有视频文件'), { fatal: true });
          it.fileIdx = best;
        }
        const f = files[it.fileIdx];
        return { name: sanitizeName(f.name), size: Number(f.length) };
      }
      st.note = '正在获取种子信息…';
    } catch (e) {
      if (e.fatal) throw e;
      st.note = `等待引擎：${e.message}`;
    }
    if (Date.now() > deadline) throw new Error('拿不到种子信息（没有可连接的做种者）');
    await sleep(5000);
  }
}

// One HTTP request for the rest of the file, appended to the .part file.
function pull(it, st, offset) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${cfg.engine}/${it.infoHash}/${it.fileIdx}`);
    const req = (url.protocol === 'https:' ? https : http).get(url, { headers: offset ? { range: `bytes=${offset}-` } : {} }, (res) => {
      if (res.statusCode !== (offset ? 206 : 200)) { res.resume(); return done(new Error(`engine HTTP ${res.statusCode}`)); }
      st.note = '';
      const out = fs.createWriteStream(partPath(it), { flags: offset ? 'r+' : 'w', start: offset, mode: 0o644 });
      res.on('data', (c) => { it.downloaded += c.length; st.lastData = Date.now(); });
      pipeline(res, out, (err) => done(err || null));
    });
    const watchdog = setInterval(() => { if (Date.now() - st.lastData > STALL_MS) req.destroy(new Error('长时间没有数据（做种者太少）')); }, 10000);
    st.cancel = () => { st.canceled = true; req.destroy(new Error('canceled')); };
    let settled = false;
    function done(err) { if (settled) return; settled = true; clearInterval(watchdog); if (err) reject(err); else resolve(); }
    req.on('error', done);
    st.lastData = Date.now();
  });
}

function probe(file) {
  return new Promise((resolve) => {
    execFile(cfg.ffprobe, ['-v', 'error', '-show_entries', 'format=format_name,duration:stream=codec_type,codec_name', '-of', 'json', file], { timeout: 60000 }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const d = JSON.parse(stdout), streams = d.streams || [];
        const video = (streams.find((s) => s.codec_type === 'video') || {}).codec_name || '';
        const audio = (streams.find((s) => s.codec_type === 'audio') || {}).codec_name || '';
        const container = (d.format && d.format.format_name) || '';
        // what every browser plays straight from a Range request; anything else goes through the engine
        const webReady = /mp4/.test(container) && video === 'h264' && ['aac', 'mp3'].includes(audio);
        resolve({ container, video, audio, duration: Number(d.format && d.format.duration) || 0, webReady });
      } catch (_) { resolve(null); }
    });
  });
}

// OpenSubtitles hash: size plus the 64-bit sums of the first and last 64 KiB. Subtitle addons key on it.
async function oshash(file, size) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(65536);
    let hash = BigInt(size);
    for (const pos of [0, Math.max(0, size - 65536)]) {
      const { bytesRead } = await fh.read(buf, 0, 65536, pos);
      for (let i = 0; i + 8 <= bytesRead; i += 8) hash = (hash + buf.readBigUInt64LE(i)) & 0xffffffffffffffffn;
    }
    return hash.toString(16).padStart(16, '0');
  } finally { await fh.close(); }
}

// ---------- aria2 ----------

// Just enough bencode to read the file list of a .torrent: strings stay Buffers (piece hashes are binary).
function bdecode(buf) {
  let pos = 0;
  function next() {
    const c = buf[pos];
    if (c === 0x69) { const end = buf.indexOf(0x65, pos); const n = Number(buf.toString('latin1', pos + 1, end)); pos = end + 1; return n; } // i...e
    if (c === 0x6c) { pos++; const list = []; while (buf[pos] !== 0x65) list.push(next()); pos++; return list; } // l...e
    if (c === 0x64) { pos++; const dict = {}; while (buf[pos] !== 0x65) { const k = next().toString('utf8'); dict[k] = next(); } pos++; return dict; } // d...e
    const colon = buf.indexOf(0x3a, pos), len = Number(buf.toString('latin1', pos, colon));
    if (colon < 0 || !Number.isInteger(len) || len < 0 || colon + 1 + len > buf.length) throw new Error('bad torrent file');
    pos = colon + 1 + len;
    return buf.subarray(colon + 1, pos);
  }
  return next();
}

function torrentFiles(buf) {
  const info = bdecode(buf).info || {};
  const str = (b) => (Buffer.isBuffer(b) ? b.toString('utf8') : '');
  if (Array.isArray(info.files)) return info.files.map((f) => ({ name: (f['path.utf-8'] || f.path || []).map(str).join('/'), length: Number(f.length) }));
  return [{ name: str(info['name.utf-8'] || info.name), length: Number(info.length) }];
}

function ariaDir(it) { return path.join(itemDir(it), 'aria'); }
function torrentPath(it) { return path.join(itemDir(it), `${it.infoHash}.torrent`); }

async function walk(dir) { // regular files below dir, with the bytes actually allocated (aria2 writes sparse files)
  const out = [];
  for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(full));
    else if (e.isFile() && !e.name.endsWith('.aria2')) { const s = await fsp.stat(full).catch(() => null); if (s) out.push({ file: full, size: s.size, allocated: s.blocks * 512 }); }
  }
  return out;
}

function runAria(args, st, onLine) { // resolves with the exit code; rejects when aria2c cannot be started
  return new Promise((resolve, reject) => {
    const child = spawn(cfg.aria2, ['--no-conf=true', '--enable-dht=true', `--dht-file-path=${path.join(cfg.dir, 'aria2-dht.dat')}`, '--seed-time=0', '--console-log-level=warn', ...args], { stdio: ['ignore', 'pipe', 'ignore'] });
    children.add(child);
    st.cancel = () => { st.canceled = true; child.kill('SIGTERM'); };
    let tail = '';
    child.stdout.on('data', (d) => { const lines = (tail + d).split(/\r?\n/); tail = lines.pop(); if (onLine) lines.forEach(onLine); });
    child.on('error', (e) => { children.delete(child); reject(e); });
    child.on('close', (code, signal) => { children.delete(child); resolve(signal ? 143 : code); });
  });
}

// Download with aria2: metadata first (so the file can be chosen and the quota checked), then the file.
// aria2's control file next to the data lets the same command continue after a restart.
async function downloadWithAria(it, st) {
  const trackers = sourcesOf(it).filter((x) => x.startsWith('tracker:')).map((x) => x.slice(8));
  await fsp.mkdir(itemDir(it), { recursive: true, mode: 0o755 });
  if (!(await sizeOf(torrentPath(it)))) {
    st.note = '正在获取种子信息…';
    const magnet = `magnet:?xt=urn:btih:${it.infoHash}${trackers.map((t) => `&tr=${encodeURIComponent(t)}`).join('')}`;
    const code = await runAria(['--bt-metadata-only=true', '--bt-save-metadata=true', `--dir=${itemDir(it)}`, `--bt-stop-timeout=${Math.round(METADATA_MS / 1000)}`, '--summary-interval=0', magnet], st);
    if (st.canceled) throw new Error('canceled');
    if (code !== 0 || !(await sizeOf(torrentPath(it)))) throw new Error('aria2 拿不到种子信息');
  }
  const files = torrentFiles(await fsp.readFile(torrentPath(it)));
  if (it.fileIdx === null || !files[it.fileIdx]) {
    let best = -1;
    files.forEach((f, i) => { if (VIDEO_EXT.test(f.name) && (best < 0 || f.length > files[best].length)) best = i; });
    if (best < 0) throw Object.assign(new Error('种子里没有视频文件'), { fatal: true });
    it.fileIdx = best;
  }
  it.name = sanitizeName(files[it.fileIdx].name);
  it.size = files[it.fileIdx].length;
  // The file aria2 is writing: by name, else the one holding the most data (neighbours of the selected file
  // get a few boundary pieces). Its length reaches the full size only when the last piece is written.
  const target = async () => (await walk(ariaDir(it))).sort((a, b) => Number(sanitizeName(b.file) === it.name) - Number(sanitizeName(a.file) === it.name) || b.allocated - a.allocated)[0] || null;
  const have = await target();
  const over = await quotaError(it.size, it.size - (have ? Math.min(it.size, have.allocated) : 0), it.id);
  if (over) throw Object.assign(new Error(over), { fatal: true });
  await save(it);

  st.note = '';
  const poll = setInterval(async () => { const f = await target(); if (f && !st.canceled) it.downloaded = Math.min(it.size, f.allocated); }, 2000);
  try {
    const code = await runAria([`--dir=${ariaDir(it)}`, `--select-file=${it.fileIdx + 1}`, '--file-allocation=none', '--bt-max-peers=120', '--bt-remove-unselected-file=true',
      '--max-overall-upload-limit=100K', `--bt-stop-timeout=${ARIA_STALL_S}`, '--summary-interval=3', ...(trackers.length ? [`--bt-tracker=${trackers.join(',')}`] : []), torrentPath(it)],
    st, (line) => { const m = /\bCN:(\d+)/.exec(line); if (m) st.peers = Number(m[1]); });
    if (st.canceled) throw new Error('canceled');
    if (code !== 0) throw new Error(code === 7 ? 'aria2 长时间没有数据' : `aria2 退出码 ${code}`);
  } finally { clearInterval(poll); }
  const f = await target();
  if (!f || f.size !== it.size || await sizeOf(`${f.file}.aria2`)) throw new Error('aria2 结束了但文件不完整');
  await fsp.rename(f.file, filePath(it));
  await cleanupAria(it);
}

async function cleanupAria(it) {
  await fsp.rm(ariaDir(it), { recursive: true, force: true }).catch(() => {});
  await fsp.rm(torrentPath(it), { force: true }).catch(() => {});
}

// Someone who has just watched a film has most of it in the engine's cache: reading it from there takes
// seconds, while aria2 would fetch the whole file from the swarm again. Only an active torrent counts (the
// list request does not make the engine load anything).
async function engineAlreadyHas(it) {
  if (it.fileIdx === null) return false;
  try {
    const all = await engineJson('/stats.json', { timeout: 4000 });
    if (!all || !all[it.infoHash]) return false;
    const stats = await engineJson(`/${it.infoHash}/${it.fileIdx}/stats.json`, { timeout: 4000 });
    return Number(stats && stats.streamProgress) >= ENGINE_HAS_IT;
  } catch (_) { return false; }
}

// ---------- queue ----------

async function quotaError(size, remaining, exceptId) { // quota counts whole files; the disk only has to take what is still missing
  let reserved = 0;
  for (const it of items.values()) if (it.id !== exceptId) reserved += it.size || it.downloaded || 0;
  if (reserved + size > cfg.maxBytes) return `片库配额不够：已占用 ${fmtSize(reserved)}，上限 ${fmtSize(cfg.maxBytes)}，这部片 ${fmtSize(size)}`;
  const free = await freeBytes();
  if (free !== null && free - remaining < cfg.minFree) return `磁盘空间不够：剩余 ${fmtSize(free)}，这部片还要 ${fmtSize(remaining)}`;
  return '';
}

async function freeBytes() {
  try { const s = await fsp.statfs(cfg.dir); return Number(s.bavail) * Number(s.bsize); } catch (_) { return null; }
}

function fmtSize(n) { return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`; }

async function downloadWithEngine(it, st) {
  let lastSave = 0, fails = 0;
  it.downloader = 'engine';
  const info = await prepare(it, st);
  if (it.name !== info.name) { // the name the viewer's player reported may differ from the torrent's
    const from = it.name ? partPath(it) : null;
    it.name = info.name;
    if (from && await sizeOf(from)) await fsp.rename(from, partPath(it)).catch(() => {});
  }
  it.size = info.size;
  const over = await quotaError(it.size, it.size - await sizeOf(partPath(it)), it.id);
  if (over) throw Object.assign(new Error(over), { fatal: true });
  const progress = setInterval(() => { if (Date.now() - lastSave > SAVE_EVERY_MS) { lastSave = Date.now(); save(it).catch(() => {}); } }, 2000);
  try {
    for (;;) {
      let offset = await sizeOf(partPath(it));
      if (offset > it.size) { await fsp.truncate(partPath(it), 0); offset = 0; }
      it.downloaded = offset;
      if (offset === it.size) break;
      try { await pull(it, st, offset); fails = 0; } catch (e) {
        if (st.canceled) throw e;
        fails++;
        st.note = `${e.message}，重试中`;
        cfg.log('library retry', it.name, e.message);
        await sleep(Math.min(60000, 5000 * fails));
        if (st.canceled) throw new Error('canceled');
        await engineJson(`/${it.infoHash}/create`, { method: 'POST', body: { torrent: { infoHash: it.infoHash }, peerSearch: { sources: sourcesOf(it), min: 40, max: 200 }, guessFileIdx: false } }).catch(() => {});
      }
    }
  } finally { clearInterval(progress); }
  await fsp.rename(partPath(it), filePath(it));
}

async function run(it) {
  const st = { canceled: false, cancel: () => { st.canceled = true; }, lastData: Date.now(), note: '', samples: [], peers: null };
  st.finished = new Promise((resolve) => { st.resolve = resolve; });
  active.set(it.id, st);
  const sampler = setInterval(() => { st.samples.push([Date.now(), it.downloaded]); if (st.samples.length > 8) st.samples.shift(); }, 2000);
  let lastSave = 0;
  try {
    it.state = 'downloading'; it.error = ''; it.startedAt = it.startedAt || new Date().toISOString();
    await save(it);
    let fetched = false;
    if (cfg.downloader !== 'engine' && it.downloader !== 'aria2' && it.downloader !== 'engine' && await engineAlreadyHas(it)) {
      cfg.log('library: the engine already has this file, copying from its cache', it.name || it.infoHash);
      it.downloader = 'engine';
    }
    if (cfg.downloader !== 'engine' && it.downloader !== 'engine' && !ariaMissing) {
      it.downloader = 'aria2';
      const progress = setInterval(() => { if (Date.now() - lastSave > SAVE_EVERY_MS && it.name) { lastSave = Date.now(); save(it).catch(() => {}); } }, 2000);
      try {
        for (let attempt = 1; !fetched; attempt++) {
          try { await downloadWithAria(it, st); fetched = true; } catch (e) {
            if (st.canceled || e.fatal) throw e;
            if (e.code === 'ENOENT' || e.code === 'EACCES') { ariaMissing = true; throw e; }
            cfg.log('library aria2 attempt failed', it.name || it.infoHash, e.message);
            if (attempt >= ARIA_ATTEMPTS) throw e;
            st.note = `${e.message}，重试中`;
            await sleep(cfg.ariaRetryMs * attempt);
            if (st.canceled) throw new Error('canceled');
          }
        }
      } catch (e) {
        if (st.canceled || e.fatal) throw e;
        cfg.log('library: aria2 gave up, the engine takes over', it.name || it.infoHash, e.message);
        await cleanupAria(it);
        it.downloader = 'engine'; it.downloaded = 0; st.peers = null; st.note = '';
      } finally { clearInterval(progress); }
    }
    if (!fetched) await downloadWithEngine(it, st);
    await fsp.chmod(filePath(it), 0o644).catch(() => {});
    it.probe = await probe(filePath(it));
    it.hash = await oshash(filePath(it), it.size).catch(() => '');
    it.state = 'done'; it.downloaded = it.size; it.finishedAt = new Date().toISOString();
    await save(it);
    cfg.log('library done', it.name, fmtSize(it.size));
  } catch (e) {
    if (!st.canceled) {
      it.state = 'failed'; it.error = e.message;
      await save(it).catch(() => {});
      cfg.log('library failed', it.name || it.infoHash, e.message);
    }
  } finally {
    clearInterval(sampler);
    active.delete(it.id);
    st.resolve();
    pump();
  }
}

function pump() {
  while (active.size < cfg.concurrency) {
    const next = [...items.values()].filter((i) => i.state === 'queued' && !active.has(i.id)).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];
    if (!next) return;
    run(next);
  }
}

// ---------- public API ----------

async function init(options) {
  cfg = {
    dir: options.dir, engine: options.engine, log: options.log || (() => {}), ffprobe: options.ffprobe || 'ffprobe',
    aria2: options.aria2 || 'aria2c', downloader: options.downloader === 'engine' ? 'engine' : 'auto', ariaRetryMs: options.ariaRetryMs || 5000,
    maxBytes: options.maxBytes, minFree: options.minFree, concurrency: Math.max(1, options.concurrency || 1),
    publicBase: (options.publicBase || '').replace(/\/$/, ''), fallbackBase: options.fallbackBase.replace(/\/$/, ''),
    trackers: options.trackers && options.trackers.length ? options.trackers : DEFAULT_TRACKERS,
  };
  await fsp.mkdir(cfg.dir, { recursive: true, mode: 0o755 });
  await fsp.chmod(cfg.dir, 0o755).catch(() => {});
  for (const name of await fsp.readdir(cfg.dir).catch(() => [])) {
    try {
      const it = JSON.parse(await fsp.readFile(path.join(cfg.dir, name, 'item.json'), 'utf8'));
      if (it.id !== name) continue;
      if (it.state === 'downloading') it.state = 'queued'; // the service was restarted mid-download
      if (it.state !== 'done' && it.downloader !== 'aria2') it.downloaded = it.name ? await sizeOf(partPath(it)) : 0;
      items.set(it.id, it);
    } catch (_) { /* not an item directory */ }
  }
  // An aria2c left behind would keep writing while the restarted service starts another on the same files.
  process.on('exit', () => { for (const c of children) c.kill('SIGTERM'); });
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(0));
  cfg.log(`library: ${items.size} items in ${cfg.dir}, quota ${fmtSize(cfg.maxBytes)}, downloader ${cfg.downloader === 'engine' ? 'engine' : `${cfg.aria2}, else engine`}`);
  pump();
}

function validate(spec) {
  const infoHash = String(spec.infoHash || '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(infoHash)) return { error: 'infoHash 无效' };
  const fileIdx = spec.fileIdx === null || spec.fileIdx === undefined ? null : Number(spec.fileIdx);
  if (fileIdx !== null && !(Number.isInteger(fileIdx) && fileIdx >= 0 && fileIdx < 100000)) return { error: 'fileIdx 无效' };
  const sources = (Array.isArray(spec.sources) ? spec.sources : []).filter((s) => typeof s === 'string' && s.length <= 300
    && /^(tracker:(udp|https?|wss?):\/\/[^\s"'<>]+|dht:[0-9a-f]{40})$/i.test(s)).slice(0, 60);
  const type = spec.type === 'series' ? 'series' : 'movie';
  const idOk = (v) => (typeof v === 'string' && /^[\w:.-]{1,100}$/.test(v) ? v : '');
  const poster = typeof spec.poster === 'string' && /^https:\/\/[^\s"'<>]{1,500}$/.test(spec.poster) ? spec.poster : '';
  const size = Number(spec.size) > 0 && Number(spec.size) < 1e13 ? Math.round(Number(spec.size)) : 0;
  return { infoHash, fileIdx, sources, type, metaId: idOk(spec.metaId), videoId: idOk(spec.videoId), poster, size,
    name: spec.filename ? sanitizeName(spec.filename) : '', title: text(spec.title, 300) };
}

async function add(spec) {
  const v = validate(spec || {});
  if (v.error) return v;
  const id = sha1(`${v.infoHash}|${v.fileIdx === null ? '' : v.fileIdx}`).slice(0, 16);
  let it = items.get(id);
  if (it) {
    if (it.state === 'failed') { it.state = 'queued'; it.error = ''; await save(it); pump(); }
    return { item: publicItem(it), existed: true };
  }
  if (v.size) { const over = await quotaError(v.size, v.size, id); if (over) return { error: over }; }
  it = { id, infoHash: v.infoHash, fileIdx: v.fileIdx, name: v.name, size: v.size, title: v.title, type: v.type, metaId: v.metaId, videoId: v.videoId,
    poster: v.poster, sources: v.sources, state: 'queued', downloaded: 0, error: '', createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, probe: null, hash: '' };
  items.set(id, it);
  await save(it);
  cfg.log('library add', it.title || it.name || it.infoHash);
  pump();
  return { item: publicItem(it) };
}

async function remove(id) {
  const it = items.get(id);
  if (!it) return { error: 'unknown item' };
  const st = active.get(id);
  items.delete(id);
  if (st) { st.cancel(); await Promise.race([st.finished, sleep(8000)]); } // aria2 writes its control file on the way out
  await fsp.rm(itemDir(it), { recursive: true, force: true });
  cfg.log('library remove', it.title || it.name);
  return { ok: true };
}

async function retry(id) {
  const it = items.get(id);
  if (!it) return { error: 'unknown item' };
  if (it.state === 'failed') { it.state = 'queued'; it.error = ''; await save(it); pump(); }
  return { item: publicItem(it) };
}

function fileUrl(it) {
  const tail = `${it.id}/${encodeURIComponent(it.name)}`;
  return cfg.publicBase ? `${cfg.publicBase}/${tail}` : `${cfg.fallbackBase}/${tail}`;
}

function publicItem(it) {
  const st = active.get(it.id);
  let speed = 0;
  if (st && st.samples.length >= 2) {
    const a = st.samples[0], b = st.samples[st.samples.length - 1];
    if (b[0] > a[0]) speed = Math.max(0, Math.round((b[1] - a[1]) * 1000 / (b[0] - a[0])));
  }
  const es = engineStatsCache.data[it.infoHash];
  return {
    id: it.id, infoHash: it.infoHash, fileIdx: it.fileIdx, name: it.name, title: it.title, type: it.type, metaId: it.metaId, videoId: it.videoId, poster: it.poster,
    state: it.state, size: it.size, downloaded: it.downloaded, error: it.error, note: st ? st.note : '', speed,
    eta: speed > 0 && it.size ? Math.round((it.size - it.downloaded) / speed) : null,
    peers: !st ? null : st.peers !== null ? st.peers : es ? Number(es.peers) || 0 : null, downloader: it.downloader || '',
    createdAt: it.createdAt, finishedAt: it.finishedAt, webReady: Boolean(it.probe && it.probe.webReady),
    url: it.state === 'done' ? fileUrl(it) : null,
  };
}

async function list() {
  if ([...active.keys()].some((id) => (items.get(id) || {}).downloader === 'engine') && Date.now() - engineStatsCache.at > 3000) {
    engineStatsCache = { at: Date.now(), data: await engineJson('/stats.json', { timeout: 4000 }).catch(() => ({})) };
  }
  const all = [...items.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  let used = 0;
  for (const it of all) used += it.state === 'done' ? it.size : it.downloaded || 0;
  return { items: all.map(publicItem), usage: { used, max: cfg.maxBytes, free: await freeBytes(), minFree: cfg.minFree } };
}

// Streams of one video for the addon's stream resource: the finished file first, and a download that is
// still running as a normal torrent stream (playing it shares the pieces with the download).
function streamsFor(videoId) {
  const out = [];
  for (const it of items.values()) {
    if (!it.videoId || it.videoId !== videoId) continue;
    if (it.state === 'done') {
      out.push({
        name: '已下载\n服务器本地', title: `${it.name}\n💾 ${fmtSize(it.size)} · 从服务器直接播放，不依赖种子`, url: fileUrl(it),
        behaviorHints: { filename: it.name, videoSize: it.size, ...(it.hash ? { videoHash: it.hash } : {}), ...(it.probe && it.probe.webReady ? {} : { notWebReady: true }), bingeGroup: 'subsync-library' },
      });
    } else if (it.state !== 'failed' && it.fileIdx !== null) {
      const pct = it.size ? Math.floor(it.downloaded * 100 / it.size) : 0;
      out.push({
        name: `下载中 ${pct}%\n可边下边播`, title: `${it.name || it.title}\n⏳ 服务器正在下载 ${fmtSize(it.downloaded)} / ${it.size ? fmtSize(it.size) : '?'}`,
        infoHash: it.infoHash, fileIdx: it.fileIdx, sources: sourcesOf(it),
        behaviorHints: { ...(it.name ? { filename: it.name } : {}), ...(it.size ? { videoSize: it.size } : {}), bingeGroup: 'subsync-library' },
      });
    }
  }
  return out;
}

function catalog(type) {
  const seen = new Set(), metas = [];
  const all = [...items.values()].filter((it) => it.state === 'done' && it.type === type && /^tt\d+$/.test(it.metaId)).sort((a, b) => String(b.finishedAt).localeCompare(String(a.finishedAt)));
  for (const it of all) {
    if (seen.has(it.metaId)) continue;
    seen.add(it.metaId);
    metas.push({ id: it.metaId, type, name: (it.title || it.name).replace(/ S\d+E\d+$/, ''), poster: it.poster || `https://images.metahub.space/poster/medium/${it.metaId}/img` });
  }
  return metas;
}

// A finished file by size and name: alignment reads it from disk when the engine no longer has the torrent.
function findFile(size, filename) {
  const base = String(filename || '').split('/').pop();
  for (const it of items.values()) {
    if (it.state !== 'done') continue;
    if (size && Number(size) !== it.size) continue;
    if (base && base !== it.name) { if (!size) continue; }
    if (!size && !base) continue;
    return { url: filePath(it), name: it.name, length: it.size, hash: it.hash, exact: base === it.name, library: true };
  }
  return null;
}

// Range-capable file serving, for setups without a web server in front of the library directory.
async function serveFile(req, res, id, name) {
  const it = items.get(id);
  const cors = { 'access-control-allow-origin': '*', 'accept-ranges': 'bytes' };
  if (!it || it.state !== 'done' || name !== it.name) { res.writeHead(404, cors); return res.end(); }
  const size = it.size, ext = (it.name.split('.').pop() || '').toLowerCase();
  const headers = { ...cors, 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'private, max-age=3600' };
  let start = 0, end = size - 1, code = 200;
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    if (m[1]) { start = Number(m[1]); if (m[2]) end = Math.min(end, Number(m[2])); } else start = Math.max(0, size - Number(m[2]));
    if (start > end || start >= size) { res.writeHead(416, { ...cors, 'content-range': `bytes */${size}` }); return res.end(); }
    code = 206; headers['content-range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['content-length'] = end - start + 1;
  res.writeHead(code, headers);
  if (req.method === 'HEAD') return res.end();
  pipeline(fs.createReadStream(filePath(it), { start, end }), res, () => {});
}

module.exports = { init, add, remove, retry, list, streamsFor, catalog, findFile, serveFile, _internal: { oshash, sanitizeName, validate, torrentFiles } };
