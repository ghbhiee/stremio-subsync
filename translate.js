// Machine translation of subtitle cues into Simplified Chinese through an OpenAI-compatible chat API
// (DeepSeek by default). The whole subtitle is translated as one growing conversation, batch after batch
// in timeline order, so the model keeps names, terms and tone consistent and every request's history is
// a byte-identical prefix of the next one (served from the provider's context cache). Each finished
// 20-minute segment is written to disk together with its exact conversation turns, so a subtitle is only
// paid for once and an interrupted translation resumes with the same cached prefix.
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
const MAX_HISTORY_CHARS = Number(process.env.TRANSLATE_MAX_HISTORY_CHARS || 200000);
const MIN_SEGMENT_COVERAGE = 0.95; // below this a segment is not cached and gets retried next time
const CACHE_VERSION = 'ctx1';

const log = (...a) => console.log(new Date().toISOString(), '[translate]', ...a);
const jobs = new Map(); // text key -> job

function enabled() { return Boolean(KEY); }

function cleanText(text) {
  return String(text || '').replace(/<[^>]+>/g, '').replace(/\{\\[^}]*\}/g, '').replace(/\s*\n\s*/g, ' ').trim();
}

function textKey(blocks) {
  return crypto.createHash('sha1').update(`${CACHE_VERSION}\n${MODEL}\n${blocks.map((b) => cleanText(b.text)).join('\n')}`).digest('hex');
}

function systemPrompt(title) {
  return `你是专业的影视字幕译者，正在翻译《${title}》。用户会按时间顺序分多次发来英文字幕（JSON 里的 lines），请逐条翻译成简体中文字幕：`
    + '口语、简洁、自然，符合中文观众习惯；结合前面已经翻译过的内容，保持人名、称呼、术语和语气前后一致；'
    + '音效或说明性标注（如 [LAUGHS]）也译成中文并保留方括号；不要合并、拆分或遗漏条目，不要解释。'
    + '只输出 JSON 对象 {"t": {"<编号>": "<译文>"}}，编号与本次 lines 一一对应。';
}

async function chat(messages) {
  const body = { model: MODEL, temperature: 1.0, response_format: { type: 'json_object' }, messages };
  if (THINKING) body.thinking = { type: THINKING };
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${API}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`HTTP ${res.status} ${JSON.stringify(j).slice(0, 160)}`);
      const content = j.choices[0].message.content;
      return { content, out: JSON.parse(content).t || {}, usage: j.usage || {} };
    } catch (e) {
      lastError = e;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw lastError;
}

// Drop the oldest turns (never the system prompt) when the history grows past the cap.
function capHistory(messages) {
  let size = messages.reduce((n, m) => n + m.content.length, 0);
  while (size > MAX_HISTORY_CHARS && messages.length > 3) {
    size -= messages[1].content.length + messages[2].content.length;
    messages.splice(1, 2);
  }
}

// One conversation turn: send `lines` (cue index -> English), record the exchange, return index -> Chinese.
async function turn(job, messages, turns, indexes, blocks, part) {
  const lines = {};
  indexes.forEach((k, n) => { lines[String(n + 1)] = cleanText(blocks[k].text) || '…'; });
  const user = JSON.stringify({ part, lines });
  capHistory(messages);
  messages.push({ role: 'user', content: user });
  let reply;
  try {
    reply = await chat(messages);
  } catch (e) {
    messages.pop(); // keep the history a clean alternation so later prefixes still match the cache
    throw e;
  }
  messages.push({ role: 'assistant', content: reply.content });
  turns.push({ indexes, user, assistant: reply.content });
  const u = reply.usage;
  job.usage.requests += 1;
  job.usage.cacheHit += u.prompt_cache_hit_tokens || 0;
  job.usage.cacheMiss += u.prompt_cache_miss_tokens || Math.max(0, (u.prompt_tokens || 0) - (u.prompt_cache_hit_tokens || 0));
  job.usage.completion += u.completion_tokens || 0;
  const result = {};
  indexes.forEach((k, n) => {
    const v = reply.out[String(n + 1)];
    if (typeof v === 'string' && v.trim()) result[k] = v.trim();
  });
  return result;
}

function applyTurns(job, messages, turns) {
  for (const t of turns) {
    messages.push({ role: 'user', content: t.user }, { role: 'assistant', content: t.assistant });
    let out = {};
    try { out = JSON.parse(t.assistant).t || {}; } catch (_) { /* ignore broken turn */ }
    t.indexes.forEach((k, n) => { const v = out[String(n + 1)]; if (typeof v === 'string' && v.trim()) job.texts[k] = v.trim(); });
  }
}

async function runJob(job, blocks, title) {
  await fsp.mkdir(job.dir, { recursive: true });
  const segments = [];
  blocks.forEach((b, i) => {
    const n = Math.floor(Math.max(0, b.start) / SEGMENT_SECONDS);
    const last = segments[segments.length - 1];
    if (last && last.n === n) last.to = i + 1; else segments.push({ n, from: i, to: i + 1 });
  });
  const messages = [{ role: 'system', content: systemPrompt(title) }];
  const t0 = Date.now();
  let part = 0, fresh = 0;
  for (const seg of segments) {
    const file = path.join(job.dir, `seg-${seg.n}.json`);
    if (fs.existsSync(file)) { // cached: replay its exact turns so the next requests keep the same prefix
      const saved = JSON.parse(await fsp.readFile(file, 'utf8'));
      applyTurns(job, messages, saved.turns || []);
      part += (saved.turns || []).length;
      continue;
    }
    const turns = [];
    for (let i = seg.from; i < seg.to; i += BATCH) {
      const indexes = [];
      for (let k = i; k < Math.min(seg.to, i + BATCH); k++) indexes.push(k);
      try {
        Object.assign(job.texts, await turn(job, messages, turns, indexes, blocks, ++part));
        const missing = indexes.filter((k) => !job.texts[k]);
        if (missing.length && missing.length < indexes.length) Object.assign(job.texts, await turn(job, messages, turns, missing, blocks, ++part));
      } catch (e) {
        job.error = String(e.message || e);
        log('batch failed', job.key.slice(0, 8), `${indexes[0]}-${indexes[indexes.length - 1]}`, job.error);
      }
    }
    fresh++;
    let covered = 0;
    for (let k = seg.from; k < seg.to; k++) if (job.texts[k]) covered++;
    if (covered >= (seg.to - seg.from) * MIN_SEGMENT_COVERAGE) {
      await fsp.writeFile(file, JSON.stringify({ model: MODEL, from: seg.from, to: seg.to, turns }));
    }
  }
  if (fresh) {
    const u = job.usage;
    await fsp.writeFile(path.join(job.dir, 'meta.json'), JSON.stringify({
      model: MODEL, title, cues: blocks.length, translated: Object.keys(job.texts).length,
      seconds: Math.round((Date.now() - t0) / 1000), usage: u, finishedAt: new Date().toISOString(),
    }, null, 1));
    log('done', job.key.slice(0, 8), title, `${Object.keys(job.texts).length}/${blocks.length} cues`, `${Math.round((Date.now() - t0) / 1000)}s`,
      `requests ${u.requests}, input cache hit ${u.cacheHit} miss ${u.cacheMiss}, output ${u.completion}`);
  }
  job.done = true;
}

// Start (or join) the translation of these cues. Returns a job with a live `texts` map (cue index -> Chinese).
function ensure(baseDir, blocks, title) {
  const key = textKey(blocks);
  const existing = jobs.get(key);
  if (existing && (!existing.done || Object.keys(existing.texts).length >= blocks.length * MIN_SEGMENT_COVERAGE)) return existing;
  const job = {
    key, dir: path.join(baseDir, key), total: blocks.length, texts: {}, done: false, error: null,
    usage: { requests: 0, cacheHit: 0, cacheMiss: 0, completion: 0 },
  };
  job.promise = runJob(job, blocks, title).catch((e) => { job.error = String(e.message || e); job.done = true; log('job failed', key.slice(0, 8), job.error); });
  jobs.set(key, job);
  return job;
}

module.exports = { enabled, ensure, cleanText, MODEL };
