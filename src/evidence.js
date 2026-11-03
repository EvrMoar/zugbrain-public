import { boundedJson, ProviderError, readNamedKey } from './network.js';
export const FOREVERDB_CREDIT = 'Data: [ForeverDB](https://foreverdb.net)';
export function usesForeverDb(value) {
  try { const host = new URL(value).hostname; return host === 'foreverdb.net' || host.endsWith('.foreverdb.net'); } catch { return false; }
}
const kinds = Object.freeze({ item: 'items', spell: 'spells', quest: 'quests', vendor: 'vendors', dungeon: 'dungeons' });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sourceUrl = query => `https://foreverdb.net/api/v1/${kinds[query.kind]}/${query.id}`;
// Provisional detail-adapter contract, not a claimed complete vendor schema.
// Verify approved real fixtures before enabling sourced answers. Never turn a
// missing/error/list result into attributed evidence for a completion.
export function validForeverDbRecord(record, query) {
  return object(record) && Number.isInteger(record.id) && record.id === query.id &&
    typeof record.name === 'string' && record.name.trim().length > 0 && record.name.length <= 512 &&
    !Object.hasOwn(record, 'error');
}
export function validForeverDbEvidence(evidence, query) {
  return object(evidence) && evidence.source === sourceUrl(query) && object(evidence.meta) &&
    typeof evidence.attribution === 'string' && evidence.attribution.trim().length > 0 &&
    validForeverDbRecord(evidence.data, query);
}
export function lookupIntent(content) {
  // Explicit public game identifiers only in the first slice. No private message
  // is copied into a remote search query; natural-language retrieval is later work.
  const match = /\b(item|spell|quest|vendor|dungeon)\s+#?(\d{1,9})\b/i.exec(content);
  return match && Number(match[2]) > 0 ? { kind: match[1].toLowerCase(), id: Number(match[2]) } : null;
}
export function createForeverDb({ live = false, approved = false, keyFile, fetchImpl = fetch, keyReader = readNamedKey }) {
  let active = false; let last = 0;
  return async function lookup(query, signal) {
    if (!live || !approved) throw new ProviderError('foreverdb_not_ready');
    if (!query || !Object.hasOwn(kinds, query.kind) || !Number.isInteger(query.id) || query.id < 1 || query.id > 999999999 || Object.keys(query).length !== 2) throw new ProviderError('invalid_lookup');
    if (active || Date.now() - last < 1100) throw new ProviderError('lookup_throttled');
    active = true; last = Date.now();
    try {
      signal?.throwIfAborted();
      const key = await keyReader(keyFile);
      const url = sourceUrl(query);
      const data = await boundedJson(fetchImpl, url, { method: 'GET', headers: { 'X-API-Key': key }, signal }, 32768);
      if (!object(data) || Object.hasOwn(data, 'error') || !object(data.meta) || !validForeverDbRecord(data.data, query)) throw new ProviderError('invalid_evidence');
      // Keep original data/build/uncertainty fields together, never relabel Classic
      // fallback as confirmed Forever. The envelope is untrusted quoted evidence.
      const { client: _developerIdentity, ...publicMeta } = data.meta;
      return { source: url, attribution: FOREVERDB_CREDIT, data: data.data, meta: publicMeta };
    } finally { active = false; }
  };
}

