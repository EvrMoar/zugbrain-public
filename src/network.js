import fs from 'node:fs/promises';

export class ProviderError extends Error {
  constructor(code) { super(code); this.name = 'ProviderError'; this.code = code; }
}
export async function readNamedKey(filename) {
  // Internal runtime helper only. Not exported by the plugin entry or a command.
  try {
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 8192) throw new Error();
    const key = (await fs.readFile(filename, 'utf8')).trim();
    if (!key || /[\r\n\0]/.test(key)) throw new Error();
    return key;
  } catch { throw new ProviderError('credential_unavailable'); }
}
export async function boundedJson(fetchImpl, url, options, maxBytes = 65536) {
  try {
    options.signal?.throwIfAborted();
    const response = await fetchImpl(url, { ...options, redirect: 'error' });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ProviderError(response.status === 429 ? 'rate_limited' : response.status === 401 || response.status === 403 ? 'unauthorized' : 'provider_failure');
    }
    if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); throw new ProviderError('response_too_large'); }
    const chunks = []; let size = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        options.signal?.throwIfAborted();
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > maxBytes) throw new ProviderError('response_too_large');
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (options.signal?.aborted) throw new ProviderError('cancelled');
    throw new ProviderError('invalid_or_unavailable_response');
  }
}
