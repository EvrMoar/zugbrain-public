import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { FOREVERDB_CREDIT, usesForeverDb } from './evidence.js';

export const NEWS_RETENTION_MS = 7 * 86400000;
const bulletinId = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}-(morning|evening)$/.test(value);
const domains = ['worldofwarcraft.blizzard.com', 'news.blizzard.com', 'us.forums.blizzard.com', 'eu.forums.blizzard.com',
  'foreverdb.net', 'warcraft.wiki.gg', 'wowhead.com', 'icy-veins.com', 'reddit.com', 'youtube.com', 'youtu.be'];
const fail = () => { throw new Error('invalid_news_bulletin'); };
const text = (value, limit) => typeof value === 'string' && value.trim() && value.length <= limit && !/[\u0000-\u001f]/.test(value);
const plain = value => value.replace(/[\[\]<>*_`~\\]/g, '').replace(/@/g, '@\u200b').replace(/https?:\/\/\S+/g, '[link omitted]');
export function newsUrl(value) {
  try {
    const url = new URL(value);
    if (typeof value !== 'string' || value.length > 350 || url.protocol !== 'https:' || url.username || url.password || url.port ||
        !domains.some(domain => url.hostname === domain || url.hostname.endsWith('.' + domain))) fail();
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (/^utm_/i.test(key)) url.searchParams.delete(key);
    return url.href;
  } catch { fail(); }
}
const fingerprint = url => createHash('sha256').update(url).digest('hex');

export function validateBulletin(input, now = Date.now(), { allowExpired = false } = {}) {
  if (!input || Object.keys(input).sort().join(',') !== 'generatedAt,id,items' || !bulletinId(input.id) ||
      typeof input.generatedAt !== 'string' || !Array.isArray(input.items) || input.items.length < 2 || input.items.length > 3) fail();
  const generatedAt = Date.parse(input.generatedAt), day = Date.parse(input.id.slice(0, 10) + 'T00:00:00Z');
  if (!Number.isFinite(generatedAt) || !Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== input.id.slice(0, 10) ||
      Math.abs(day - generatedAt) > 2 * 86400000 || generatedAt > now + 300000 || (!allowExpired && now - generatedAt >= NEWS_RETENTION_MS)) fail();
  const seen = new Set();
  const items = input.items.map(item => {
    if (!item || Object.keys(item).sort().join(',') !== 'edition,publishedAt,summary,title,url' || !text(item.title, 80) || !text(item.summary, 280) ||
        !['Forever', 'Retail', 'Classic', 'Vanilla', 'Mixed', 'Unverified'].includes(item.edition) || typeof item.publishedAt !== 'string') fail();
    const publishedAt = Date.parse(item.publishedAt), url = newsUrl(item.url);
    if (!Number.isFinite(publishedAt) || publishedAt > generatedAt + 300000 || generatedAt - publishedAt > NEWS_RETENTION_MS || seen.has(url)) fail();
    seen.add(url);
    return { title: item.title.trim(), summary: item.summary.trim(), edition: item.edition, publishedAt: new Date(publishedAt).toISOString(), url };
  });
  return { id: input.id, generatedAt: new Date(generatedAt).toISOString(), items };
}
export function renderBulletin(bulletin) {
  const parts = bulletin.items.map(item => {
    const host = new URL(item.url).hostname;
    const sourceKind = /(^|\.)(reddit\.com|youtube\.com|youtu\.be)$/.test(host) ? 'community discussion' :
      /^(worldofwarcraft|news)\.blizzard\.com$/.test(host) ? 'Blizzard' : 'reference';
    return `- [${plain(item.title)}](<${item.url}>) — ${plain(item.summary)} (${item.edition}; ${item.publishedAt.slice(0, 10)}; ${sourceKind})`;
  });
  const result = `WoW Forever news · ${bulletin.id}\n${parts.join('\n')}`;
  const attributed = result + (bulletin.items.some(item => usesForeverDb(item.url)) ? '\n' + FOREVERDB_CREDIT : '');
  if (attributed.length > 1900) fail();
  return attributed;
}

// No scheduler or provider is started by this module. A producer supplies a
// bounded bulletin; a separately authorized caller supplies the fixed-channel
// send function. Never accept a destination from generated content.
export class NewsDelivery {
  #active = false;
  constructor({ store, send, now = Date.now }) { Object.assign(this, { store, send, now }); }
  async deliver(input, signal) {
    if (this.#active) return 'busy';
    this.#active = true;
    try {
      const bulletin = validateBulletin(input, this.now());
      let state = this.store.load();
      if (!Array.isArray(state) || state.length > 64 || state.some(row => !bulletinId(row.id) || !Number.isFinite(row.expiresAt) ||
          !['pending', 'sent'].includes(row.status) || !Array.isArray(row.sources) || row.sources.length > 3 ||
          row.sources.some(hash => !/^[a-f0-9]{64}$/.test(hash)))) throw new Error('news_state_unavailable');
      state = state.filter(row => row.expiresAt > this.now());
      this.store.prune(this.now());
      if (state.some(row => row.id === bulletin.id)) return 'already_claimed'; // Includes uncertain prior sends.
      const used = new Set(state.flatMap(row => row.sources));
      bulletin.items = bulletin.items.filter(item => !used.has(fingerprint(item.url)));
      if (bulletin.items.length < 2) return 'no_new_items';
      const body = renderBulletin(bulletin);
      signal?.throwIfAborted();
      const row = { id: bulletin.id, expiresAt: Date.parse(bulletin.generatedAt) + NEWS_RETENTION_MS,
        status: 'pending', sources: bulletin.items.map(item => fingerprint(item.url)) };
      state.push(row);
      this.store.archive(bulletin);
      this.store.save(state); // Claim durably before the one send; no automatic retry.
      let result;
      try { result = await this.send(body, bulletin.id, signal); } catch { return 'delivery_uncertain'; }
      if (!result || typeof result.id !== 'string' || !/^\d{1,20}$/.test(result.id)) return 'delivery_uncertain';
      row.status = 'sent'; row.messageId = result.id;
      try { this.store.save(state); } catch { return 'delivery_uncertain'; }
      return 'sent';
    } finally { this.#active = false; }
  }
}

// Server-only storage; the Windows atomic-write restriction is not retried.
// Tests use a fresh Linux temp directory, never the owner's real state.
export function openNewsStore(directory) {
  if (process.platform !== 'linux') throw new Error('news_store_requires_linux');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) throw new Error('news_state_unavailable');
  const lockPath = path.join(directory, 'news.lock');
  const lock = fs.openSync(lockPath, 'wx', 0o600);
  const read = name => {
    const file = path.join(directory, name), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32768) throw new Error('news_state_unavailable');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  };
  const write = (name, value) => {
    const dest = path.join(directory, name);
    if (fs.existsSync(dest) && (!fs.lstatSync(dest).isFile() || fs.lstatSync(dest).isSymbolicLink())) throw new Error('news_state_unavailable');
    const tmp = path.join(directory, `news-${randomUUID()}.tmp`);
    const handle = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeFileSync(handle, JSON.stringify(value)); fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
    fs.renameSync(tmp, dest);
    const parent = fs.openSync(directory, 'r'); try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
  };
  let closed = false;
  const ensureOpen = () => { if (closed) throw new Error('news_store_closed'); };
  return {
    load() { ensureOpen(); return fs.existsSync(path.join(directory, 'delivery.json')) ? read('delivery.json') : []; },
    save(state) { ensureOpen(); write('delivery.json', state); },
    claimWindow(id, now) {
      ensureOpen(); if (!bulletinId(id) || !Number.isFinite(now)) fail();
      let attempts = fs.existsSync(path.join(directory, 'attempts.json')) ? read('attempts.json') : [];
      if (!Array.isArray(attempts) || attempts.length > 32 || attempts.some(row => !bulletinId(row.id) || !Number.isFinite(row.at))) throw new Error('news_state_unavailable');
      if (attempts.some(row => row.at > now + 300000)) throw new Error('news_clock_rollback');
      attempts = attempts.filter(row => now - row.at < NEWS_RETENTION_MS);
      if (attempts.some(row => row.id === id)) return false;
      attempts.push({ id, at: now }); write('attempts.json', attempts); return true;
    },
    archive(bulletin) { ensureOpen(); if (!bulletinId(bulletin.id)) fail(); write(`${bulletin.id}.json`, bulletin); },
    prune(now) {
      ensureOpen();
      for (const name of fs.readdirSync(directory)) if (/^\d{4}-\d{2}-\d{2}-(morning|evening)\.json$/.test(name)) {
        const bulletin = validateBulletin(read(name), now, { allowExpired: true });
        if (Date.parse(bulletin.generatedAt) + NEWS_RETENTION_MS <= now) fs.unlinkSync(path.join(directory, name));
      }
    },
    close() { if (!closed) { closed = true; fs.closeSync(lock); fs.unlinkSync(lockPath); } },
  };
}
