// Machine translation of subtitle cues into Simplified Chinese through an OpenAI-compatible chat API
// (DeepSeek by default). Work is split into timeline segments (20 min by default) translated in order;
// every finished segment is written to disk, so a subtitle is only ever paid for once.
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const API = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');
const KEY = process.env.DEEPSEEK_API_KEY || '';
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-flash';
const THINKING = process.env.DEEPSEEK_THINKING || 'disabled'; // reasoning makes this ~6x slower for no gain
const SEGMENT_SECONDS = Number(process.env.TRANSLATE_SEGMENT_SECONDS || 1200);
const BATCH = Number(process.env.TRANSLATE_BATCH || 80);
const CONCURRENCY = Number(process.env.TRANSLATE_CONCURRENCY || 4);
const MIN_SEGMENT_COVERAGE = 0.95; // below this a segment is not cached and gets retried next time

const SYSTEM = '你是专业的影视字幕译者。把输入 JSON 里 lines 的每一条英文字幕翻译成简体中文字幕：'
  + '口语、简洁、自然，符合中文观众习惯；人名、地名用通行译名，同一名字前后一致；'
  + '音效或说明性标注（如 [LAUGHS]）也译成中文并保留方括号；previous 只是上文参考，不要翻译它；'
  + '不要合并、拆分或遗漏条目，不要解释。只输出 JSON 对象 {"t": {"<编号>": "<译文>"}}，编号与 lines 一一对应。';

const log = (...a) => console.log(new Date().toISOString(), '[translate]', ...a);
const jobs = new Map(); // text key -> job

function enabled() { return Boolean(KEY); }

function cleanText(text) {
  return String(text || '').replace(/<[^>]+>/g, '').replace(/\{\\[^}]*\}/g, '').replace(/\s*\n\s*/g, ' ').trim();
}

function textKey(blocks) {
  return crypto.createHash('sha1').update(`${MODEL}\n${blocks.map((b) => cleanText(b.text)).join('\n')}`).digest('hex');
}

async function callModel(lines, title, previous) {
  const body = {
    model: MODEL,
    temperature: 1.0,
    response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: JSON.stringify({ title, previous, lines }) }],
  };
  if (THINKING) body.thinking = { type: THINKING };
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${API}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(90000),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`HTTP ${res.status} ${JSON.stringify(j).slice(0, 160)}`);
      return { out: JSON.parse(j.choices[0].message.content).t || {}, usage: j.usage || {} };
    } catch (e) {
      lastError = e;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw lastError;
}

async function translateRange(job, blocks, indexes, title) {
  const lines = {};
  indexes.forEach((k, n) => { lines[String(n + 1)] = cleanText(blocks[k].text) || '…'; });
  const previous = blocks.slice(Math.max(0, indexes[0] - 3), indexes[0]).map((b) => cleanText(b.text));
  const { out, usage } = await callModel(lines, title, previous);
  job.usage.prompt += usage.prompt_tokens || 0;
  job.usage.completion += usage.completion_tokens || 0;
  job.usage.requests += 1;
  const result = {};
  indexes.forEach((k, n) => {
    const v = out[String(n + 1)];
    if (typeof v === 'string' && v.trim()) result[k] = v.trim();
  });
  return result;
}

async function translateBatch(job, blocks, from, to, title) {
  const indexes = [];
  for (let k = from; k < to; k++) indexes.push(k);
  let result = {};
  try {
    result = await translateRange(job, blocks, indexes, title);
    const missing = indexes.filter((k) => !result[k]);
    if (missing.length && missing.length < indexes.length) Object.assign(result, await translateRange(job, blocks, missing, title));
  } catch (e) {
    job.error = String(e.message || e);
    log('batch failed', job.key.slice(0, 8), `${from}-${to}`, job.error);
  }
  return result;
}

async function runJob(job, blocks, title) {
  await fsp.mkdir(job.dir, { recursive: true });
  const segments = [];
  blocks.forEach((b, i) => {
    const n = Math.floor(Math.max(0, b.start) / SEGMENT_SECONDS);
    const last = segments[segments.length - 1];
    if (last && last.n === n) last.to = i + 1; else segments.push({ n, from: i, to: i + 1 });
  });
  const pending = [];
  for (const seg of segments) {
    const file = path.join(job.dir, `seg-${seg.n}.json`);
    if (fs.existsSync(file)) Object.assign(job.texts, JSON.parse(await fsp.readFile(file, 'utf8')));
    else pending.push(seg);
  }
  job.cachedSegments = segments.length - pending.length;
  const batches = [];
  for (const seg of pending) for (let i = seg.from; i < seg.to; i += BATCH) batches.push({ seg, from: i, to: Math.min(seg.to, i + BATCH) });
  const left = new Map(pending.map((seg) => [seg, batches.filter((b) => b.seg === seg).length]));
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const b = batches[next++];
      Object.assign(job.texts, await translateBatch(job, blocks, b.from, b.to, title));
      left.set(b.seg, left.get(b.seg) - 1);
      if (left.get(b.seg) === 0) {
        const seg = b.seg, texts = {};
        for (let k = seg.from; k < seg.to; k++) if (job.texts[k]) texts[k] = job.texts[k];
        if (Object.keys(texts).length >= (seg.to - seg.from) * MIN_SEGMENT_COVERAGE) {
          await fsp.writeFile(path.join(job.dir, `seg-${seg.n}.json`), JSON.stringify(texts));
        }
      }
    }
  };
  if (batches.length) {
    const t0 = Date.now();
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
    await fsp.writeFile(path.join(job.dir, 'meta.json'), JSON.stringify({
      model: MODEL, title, cues: blocks.length, translated: Object.keys(job.texts).length,
      seconds: Math.round((Date.now() - t0) / 1000), usage: job.usage, finishedAt: new Date().toISOString(),
    }, null, 1));
    log('done', job.key.slice(0, 8), title, `${Object.keys(job.texts).length}/${blocks.length} cues`, `${Math.round((Date.now() - t0) / 1000)}s`, `tokens in ${job.usage.prompt} out ${job.usage.completion}`);
  }
  job.done = true;
}

// Start (or join) the translation of these cues. Returns a job with a live `texts` map (cue index -> Chinese).
function ensure(baseDir, blocks, title) {
  const key = textKey(blocks);
  const existing = jobs.get(key);
  if (existing && (existing.done ? Object.keys(existing.texts).length >= blocks.length * MIN_SEGMENT_COVERAGE : true)) return existing;
  const job = { key, dir: path.join(baseDir, key), total: blocks.length, texts: {}, done: false, error: null, usage: { prompt: 0, completion: 0, requests: 0 } };
  job.promise = runJob(job, blocks, title).catch((e) => { job.error = String(e.message || e); job.done = true; log('job failed', key.slice(0, 8), job.error); });
  jobs.set(key, job);
  return job;
}

module.exports = { enabled, ensure, cleanText, MODEL };
