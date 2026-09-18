// Vocabulary book of the web UI (subsync-ui.js): words saved from the dictionary popup, one JSON file per
// user under <CACHE_DIR>/vocab/.
//
// Who is the user? The addon path carries one shared secret, so it cannot tell people apart. Two ways:
//  - VOCAB_USER_HEADER=<header name>: a reverse proxy that authenticates people (nginx auth_request,
//    Authelia, oauth2-proxy...) puts the user's id in this header. The proxy must overwrite whatever the
//    client sent. Requests without the header are refused, so nobody can read or write another book.
//  - otherwise the browser sends a random profile id it keeps in localStorage (X-Subsync-Profile). It is
//    unguessable, so books stay apart, but it is per browser and lost with the browser's site data.
// <CACHE_DIR>/vocab/aliases.json ({"<user id>": "<name>"}) lets several ids share one book, e.g. the
// phone and the laptop of the same person.
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const USER_HEADER = (process.env.VOCAB_USER_HEADER || '').trim().toLowerCase();
const NAME_HEADER = (process.env.VOCAB_NAME_HEADER || '').trim().toLowerCase(); // optional display name, percent-encoded
const MAX_WORDS = Number(process.env.VOCAB_MAX_WORDS || 5000);
const PROFILE_RE = /^[A-Za-z0-9_-]{16,64}$/;

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const str = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const mode = () => (USER_HEADER ? 'header' : 'profile');

function dirOf(cacheDir) { return path.join(cacheDir, 'vocab'); }

function aliases(cacheDir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dirOf(cacheDir), 'aliases.json'), 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch (_) { return {}; }
}

// The user behind a request, or null when it cannot be told (the caller answers 401).
function userOf(req, url, cacheDir) {
  let id = null, name = '';
  if (USER_HEADER) {
    const v = str(req.headers[USER_HEADER], 80);
    if (!v) return null;
    id = `p:${v}`;
    if (NAME_HEADER) { try { name = str(decodeURIComponent(String(req.headers[NAME_HEADER] || '')), 80); } catch (_) { /* not encoded */ } }
  } else {
    const v = String(req.headers['x-subsync-profile'] || url.searchParams.get('profile') || '').trim();
    if (!PROFILE_RE.test(v)) return null;
    id = `c:${v}`;
  }
  const alias = str(aliases(cacheDir)[id], 40);
  // `from` is the id this request had before the alias: words saved under it move into the shared book.
  return alias ? { id: `u:${alias}`, name: alias, verified: Boolean(USER_HEADER), from: id } : { id, name, verified: Boolean(USER_HEADER) };
}

function fileOf(cacheDir, user) { return path.join(dirOf(cacheDir), `${sha1(user.id).slice(0, 24)}.json`); }

async function read(cacheDir, user) {
  try {
    const j = JSON.parse(await fsp.readFile(fileOf(cacheDir, user), 'utf8'));
    return j && j.words && typeof j.words === 'object' ? j : { user: user.id, words: {} };
  } catch (_) { return { user: user.id, words: {} }; }
}

// The user's book. A device that was given an alias after it had saved words brings them along once.
async function load(cacheDir, user) {
  const book = await read(cacheDir, user);
  if (!user.from) return book;
  const old = { id: user.from }, oldFile = fileOf(cacheDir, old);
  if (!fs.existsSync(oldFile)) return book;
  const legacy = await read(cacheDir, old);
  for (const [k, v] of Object.entries(legacy.words)) if (!book.words[k]) book.words[k] = v;
  await save(cacheDir, user, book);
  await fsp.rename(oldFile, `${oldFile}.merged`).catch(() => {});
  return book;
}

async function save(cacheDir, user, book) {
  const file = fileOf(cacheDir, user), tmp = `${file}.${process.pid}.tmp`;
  await fsp.mkdir(dirOf(cacheDir), { recursive: true });
  book.user = user.id;
  book.updatedAt = new Date().toISOString();
  await fsp.writeFile(tmp, JSON.stringify(book, null, 1), { mode: 0o600 });
  await fsp.rename(tmp, file);
}

// Changes to one book run one after another (two tabs adding words at the same moment).
const queues = new Map();
function locked(key, fn) {
  const next = (queues.get(key) || Promise.resolve()).then(fn, fn);
  const tail = next.catch(() => {});
  queues.set(key, tail);
  tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return next;
}

const keyOf = (word) => str(word, 80).toLowerCase();

function clean(input) {
  const word = str(input.word, 80);
  if (!word || !/[A-Za-z]/.test(word)) return null;
  const item = { word };
  const phonetic = str(input.phonetic, 80); if (phonetic) item.phonetic = phonetic;
  const entries = (Array.isArray(input.entries) ? input.entries : []).map((e) => str(e, 200)).filter(Boolean).slice(0, 8);
  if (entries.length) item.entries = entries;
  for (const [k, max] of [['meaning', 200], ['sentence', 500], ['sentenceZh', 500], ['title', 200]]) { const v = str(input[k], max); if (v) item[k] = v; }
  if (typeof input.time === 'number' && isFinite(input.time) && input.time >= 0) item.time = Math.round(input.time);
  if (input.video && typeof input.video === 'object') {
    const video = {};
    for (const [k, max] of [['id', 120], ['type', 20], ['metaId', 120], ['href', 3000]]) { const v = str(input.video[k], max); if (v) video[k] = v; }
    if (Object.keys(video).length) item.video = video;
  }
  return item;
}

const sorted = (book) => Object.values(book.words).sort((a, b) => String(b.addedAt).localeCompare(String(a.addedAt)));

function list(cacheDir, user) { return locked(user.id, async () => sorted(await load(cacheDir, user))); }

// Add a word, or fill in what a second request knows about a word that is already there (the meaning in
// context arrives after the dictionary entry).
function add(cacheDir, user, input) {
  const item = clean(input || {});
  if (!item) return Promise.resolve({ error: 'word required' });
  return locked(user.id, async () => {
    const book = await load(cacheDir, user), key = keyOf(item.word), old = book.words[key];
    if (!old && Object.keys(book.words).length >= MAX_WORDS) return { error: `vocabulary is full (${MAX_WORDS} words)` };
    const now = new Date().toISOString();
    book.words[key] = old ? { ...old, ...item, word: old.word, addedAt: old.addedAt, updatedAt: now } : { ...item, addedAt: now };
    await save(cacheDir, user, book);
    return { item: book.words[key], count: Object.keys(book.words).length, created: !old };
  });
}

function remove(cacheDir, user, word) {
  const key = keyOf(word);
  if (!key) return Promise.resolve({ error: 'word required' });
  return locked(user.id, async () => {
    const book = await load(cacheDir, user), existed = Boolean(book.words[key]);
    if (existed) { delete book.words[key]; await save(cacheDir, user, book); }
    return { removed: existed, count: Object.keys(book.words).length };
  });
}

module.exports = { userOf, list, add, remove, mode, keyOf };
