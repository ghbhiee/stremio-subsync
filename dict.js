// Word / phrase lookup for the click-to-translate feature of the web UI. Youdao's public dictionary
// endpoint answers English words and phrases with phonetics and Chinese senses (fast, no key, reachable
// from China); the translation model (when configured) explains what the selection means in the sentence
// it was clicked in and translates free text the dictionary does not know.
'use strict';

const translate = require('./translate');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const YOUDAO = process.env.YOUDAO_DICT_URL || 'https://dict.youdao.com/jsonapi';
const MYMEMORY = process.env.MYMEMORY_URL || 'https://api.mymemory.translated.net/get';
const CACHE_MAX = 5000;
const cache = new Map();

const log = (...a) => console.log(new Date().toISOString(), '[dict]', ...a);

function remember(key, value) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, value);
  return value;
}

const asText = (v) => (Array.isArray(v) ? v.join('；') : typeof v === 'string' ? v : '');

const ydCache = new Map();
async function youdao(q) {
  const k = q.toLowerCase();
  if (ydCache.has(k)) return ydCache.get(k);
  const out = await youdaoFetch(q);
  if (ydCache.size >= CACHE_MAX) ydCache.delete(ydCache.keys().next().value);
  ydCache.set(k, out);
  return out;
}

async function youdaoFetch(q) {
  const res = await fetch(`${YOUDAO}?q=${encodeURIComponent(q)}&doctype=json`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`youdao HTTP ${res.status}`);
  const j = await res.json();
  const word = j.ec && Array.isArray(j.ec.word) ? j.ec.word[0] : null;
  const out = {};
  if (word) {
    out.phonetic = word.usphone || word.ukphone || word.phone || '';
    out.entries = (word.trs || []).map((t) => asText(t && t.tr && t.tr[0] && t.tr[0].l && t.tr[0].l.i)).filter(Boolean);
  }
  const web = j.web_trans && Array.isArray(j.web_trans['web-translation']) ? j.web_trans['web-translation'] : [];
  const same = web.find((w) => w && String(w.key || '').toLowerCase() === q.toLowerCase());
  if (same) out.web = (same.trans || []).map((t) => t && t.value).filter(Boolean).slice(0, 4);
  return out.entries && out.entries.length ? out : (out.web && out.web.length ? out : null);
}

async function mymemory(q) {
  const res = await fetch(`${MYMEMORY}?q=${encodeURIComponent(q)}&langpair=en|zh-CN`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`mymemory HTTP ${res.status}`);
  const j = await res.json();
  const text = j && j.responseData && j.responseData.translatedText;
  return text && text.toLowerCase() !== q.toLowerCase() ? text : null;
}

// What does `q` mean here? Optionally with the full sentence it was clicked in.
async function contextual(q, ctx) {
  const system = '你是英汉词典和字幕译者。只输出 JSON 对象 {"m":"<选中文字在这句话里的中文意思，口语、不超过 30 字>","s":"<整句的中文翻译>"}；没有句子时 s 留空。';
  const user = ctx ? `句子：${ctx}\n选中：${q}` : `选中：${q}`;
  const j = await translate.chatJson([{ role: 'system', content: system }, { role: 'user', content: user }]);
  const meaning = typeof j.m === 'string' ? j.m.trim() : '';
  const sentence = typeof j.s === 'string' ? j.s.trim() : '';
  return meaning || sentence ? { meaning, sentence } : null;
}

async function lookup(q, ctx) {
  const key = `${q.toLowerCase()}\n${ctx || ''}`;
  if (cache.has(key)) return cache.get(key);
  const out = { q, ctx: ctx || '', sources: [] };
  const words = q.split(/\s+/).length;
  const model = (why) => (translate.enabled() && why ? contextual(q, ctx).catch((e) => { log('context failed', e.message); return null; }) : Promise.resolve(null));
  // Words and short phrases go to the dictionary; the model explains the selection in its sentence and
  // handles anything the dictionary does not know.
  let [yd, ai] = await Promise.all([
    words <= 4 ? youdao(q).catch((e) => { log('youdao failed', e.message); return null; }) : Promise.resolve(null),
    model(ctx || words > 1),
  ]);
  if (!yd && !ai) ai = await model(true);
  if (yd) { Object.assign(out, yd); out.sources.push('youdao'); }
  if (ai) { out.context = ai; out.sources.push('ai'); }
  if (!yd && !ai) {
    const mm = await mymemory(q).catch((e) => { log('mymemory failed', e.message); return null; });
    if (mm) { out.entries = [mm]; out.sources.push('mymemory'); }
  }
  if (!out.sources.length) return out; // do not cache misses
  return remember(key, out);
}

module.exports = { lookup };
