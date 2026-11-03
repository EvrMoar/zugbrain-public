import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

// Uncertain reservations remain charged. Successful search requests can settle
// down to validated uncached usage plus the fixed tool fee using an owned receipt.
// Single-process ledger. Exclusive lock prevents two instances sharing a budget.
export class Budget {
  #limits; #state; #save; #now; #unavailable = false; #receipts = new WeakMap();
  constructor(limits, { state = {}, save = () => {}, now = Date.now } = {}) {
    this.#limits = limits; this.#state = state; this.#save = save; this.#now = now;
  }
  reserve(provider, dollars) {
    if (this.#unavailable || !Number.isFinite(dollars) || dollars <= 0 || !this.#limits[provider]) return false;
    let date;
    try { date = new Date(this.#now()).toISOString(); } catch { return false; }
    const day = date.slice(0, 10), month = date.slice(0, 7);
    const old = this.#state[provider] || {};
    // Only forward periods reset allowance. A clock rollback cannot reopen a
    // day/month already charged, including after a ledger reopen.
    if ((old.day && day < old.day) || (old.month && month < old.month)) return false;
    const usedDay = old.day === day ? old.dayMicros : 0;
    const usedMonth = old.month === month ? old.monthMicros : 0;
    const count = old.day === day ? old.count : 0;
    const charge = Math.ceil(dollars * 1e6), limit = this.#limits[provider];
    if (![usedDay, usedMonth, count].every(n => Number.isSafeInteger(n) && n >= 0)) return false;
    if (usedDay + charge > Math.floor(limit.dailyUsd * 1e6) ||
        usedMonth + charge > Math.floor(limit.monthlyUsd * 1e6) || count >= limit.maxRequestsPerDay) return false;
    const next = { ...this.#state, [provider]: { day, month, dayMicros: usedDay + charge, monthMicros: usedMonth + charge, count: count + 1 } };
    try { this.#save(next); } catch { this.#unavailable = true; return false; }
    this.#state = next;
    return true;
  }
  status() { return structuredClone(this.#state); }
  close() { this.#unavailable = true; this.#receipts = new WeakMap(); }
  reserveTracked(provider, dollars) {
    if (!this.reserve(provider, dollars)) return null;
    const row = this.#state[provider], receipt = Object.freeze({});
    this.#receipts.set(receipt, { provider, day: row.day, month: row.month, micros: Math.ceil(dollars * 1e6) });
    return receipt; // Process-local: a crash leaves the durable full charge intact.
  }
  settle(receipt, dollars) {
    const reserved = this.#receipts.get(receipt);
    if (!reserved || this.#unavailable) return false;
    this.#receipts.delete(receipt); // Never credit one request twice, even after failure.
    const charge = Math.ceil(dollars * 1e6), row = this.#state[reserved.provider];
    if (!Number.isSafeInteger(charge) || charge < 0 || charge > reserved.micros) return false;
    // A rollover must never apply a prior request's credit to a new period.
    if (row.day !== reserved.day || row.month !== reserved.month) return false;
    const credit = reserved.micros - charge;
    if (row.dayMicros < credit || row.monthMicros < credit) return false;
    const next = { ...this.#state, [reserved.provider]: { ...row, dayMicros: row.dayMicros - credit, monthMicros: row.monthMicros - credit } };
    try { this.#save(next); } catch { this.#unavailable = true; return false; }
    this.#state = next; // Request count is retained. No persistent schema change.
    return true;
  }
  admitEvent(channelId, messageId, timestamp) {
    if (this.#unavailable) return false;
    const key = createHash('sha256').update(`${channelId}:${messageId}`).digest('hex');
    const recent = (this.#state.$seen || []).filter(e => this.#now() - e.timestamp <= 120000);
    if (recent.length >= 500 || recent.some(e => e.key === key)) return false;
    const next = { ...this.#state, $seen: [...recent, { key, timestamp }] };
    try { this.#save(next); } catch { this.#unavailable = true; return false; }
    this.#state = next; return true;
  }
}

export function openFileBudget(directory, limits, now = Date.now) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('Budget storage unavailable');
  const lock = path.join(directory, 'budget.lock');
  let handle;
  try { handle = fs.openSync(lock, 'wx', 0o600); } catch { throw new Error('Budget storage already in use or unavailable'); }
  const filename = path.join(directory, 'budget.json');
  try {
    let state = {};
    if (fs.existsSync(filename)) {
      const stat = fs.lstatSync(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 131072) throw new Error();
      state = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (!state || typeof state !== 'object' || Array.isArray(state) || Object.keys(state).some(k => !['openai', 'jev', '$seen'].includes(k))) throw new Error();
      if (state.$seen && (!Array.isArray(state.$seen) || state.$seen.length > 500 || state.$seen.some(e => !/^[a-f0-9]{64}$/.test(e?.key) || !Number.isSafeInteger(e?.timestamp)))) throw new Error();
      for (const [name, row] of Object.entries(state)) {
        if (name === '$seen') continue;
        if (!row || !/^\d{4}-\d{2}-\d{2}$/.test(row.day) || !/^\d{4}-\d{2}$/.test(row.month) || row.month !== row.day.slice(0, 7) ||
            ![row.dayMicros, row.monthMicros, row.count].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error();
      }
    }
    const save = next => {
      const temp = path.join(directory, `budget-${randomUUID()}.tmp`);
      let file;
      try {
        file = fs.openSync(temp, 'wx', 0o600);
        fs.writeFileSync(file, JSON.stringify(next)); fs.fsyncSync(file); fs.closeSync(file); file = undefined;
        fs.renameSync(temp, filename);
        // Linux needs the containing directory flushed to persist the rename.
        // If this fails after rename, the write is uncertain: Budget permanently
        // refuses further work in this instance instead of overwriting a charge.
        if (process.platform === 'linux') {
          const parent = fs.openSync(directory, 'r');
          try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
        }
      } finally {
        if (file !== undefined) fs.closeSync(file);
        if (fs.existsSync(temp)) fs.unlinkSync(temp);
      }
    };
    const budget = new Budget(limits, { state, save, now });
    return { budget, close() { budget.close(); if (handle !== undefined) { fs.closeSync(handle); handle = undefined; fs.unlinkSync(lock); } } };
  } catch {
    fs.closeSync(handle); fs.unlinkSync(lock); throw new Error('Budget storage invalid or unavailable');
  }
}

// Reused from the historical OpenClaw implementation. Rates last checked
// 2026-11-02: use the higher $5/M input bound, $10/M output, bytes as an upper
// token estimate, framing allowance and 2x margin. Recheck before live approval.
// Reservations remain charged even on failure; these are not provider invoices.
export const reserveOpenAi = (textBytes, outputTokens) => 2 * (((textBytes + 4096) * 5 + outputTokens * 10) / 1e6);
export const reserveJev = textBytes => 2 * (textBytes + 2048) * 0.042 / 1e6;

// 2026-11-03 official pricing: Sol $2/M input, $10/M output; web $0.01/call.
// One tool call, the documented 128k search context, original request/framing,
// and 2x margin. Reservations are retained after uncertain outcomes.
export const WEB_SEARCH_TOKENS = 128000;
export const reserveWebSearch = (textBytes, outputTokens = 512) =>
  2 * (((textBytes + 4096 + WEB_SEARCH_TOKENS) * 2 + outputTokens * 10) / 1e6 + 0.01);
export const searchUsageUsd = usage => (usage.input_tokens * 2 + usage.output_tokens * 10) / 1e6 + 0.01;
