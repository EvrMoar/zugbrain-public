import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NewsDelivery, validateBulletin, renderBulletin, openNewsStore, NEWS_RETENTION_MS } from '../../src/news.js';
const now = Date.UTC(2026, 10, 3, 12);
const fixture = () => ({ id: '2026-11-03-morning', generatedAt: new Date(now).toISOString(), items: [
  { title: 'Fixture patch', summary: 'Synthetic patch summary, not real news.', edition: 'Forever', publishedAt: new Date(now - 3600000).toISOString(), url: 'https://news.blizzard.com/article/fixture' },
  { title: 'Fixture discussion', summary: 'Synthetic community discussion, not verified mechanics.', edition: 'Classic', publishedAt: new Date(now - 3600000).toISOString(), url: 'https://www.reddit.com/r/example/comments/fixture' },
] });
function memory() {
  let saved = [];
  return { load: () => structuredClone(saved), save: rows => { saved = structuredClone(rows); }, archive() {}, prune() {} };
}
test('bulletin contract renders short cited text with edition/date/community labels and no destination', () => {
  const b = validateBulletin(fixture(), now), body = renderBulletin(b);
  assert.ok(body.includes('community discussion')); assert.ok(body.includes('Classic; 2026-11-03')); assert.ok(body.includes('](<https://'));
  assert.ok(!body.includes('Data: [ForeverDB]'));
  const sourced = fixture(); sourced.items[0].url = 'https://foreverdb.net/item/19019';
  assert.ok(renderBulletin(validateBulletin(sourced, now)).endsWith('Data: [ForeverDB](https://foreverdb.net)'));
  for (const change of [b => { b.channelId = 'other'; }, b => { b.items[0].url = 'http://localhost/'; }, b => { b.items[0].publishedAt = '2020-01-01'; },
    b => { b.items[1].url = b.items[0].url; }, b => { b.items[0].edition = 'Confirmed truth'; }]) {
    const bad = fixture(); change(bad); assert.throws(() => validateBulletin(bad, now), /invalid_news_bulletin/);
  }
});
test('one durable claim survives reopen, suppresses duplicate sources and never retries an uncertain send', async () => {
  const store = memory(); let sends = 0;
  const sender = () => new NewsDelivery({ store, now: () => now, send: async () => { sends++; return { id: '42' }; } });
  assert.equal(await sender().deliver(fixture()), 'sent');
  assert.equal(await sender().deliver(fixture()), 'already_claimed');
  assert.equal(await sender().deliver({ ...fixture(), id: '2026-11-03-evening' }), 'no_new_items');
  assert.equal(sends, 1);
  const uncertainStore = memory();
  const failed = new NewsDelivery({ store: uncertainStore, now: () => now, send: async () => { throw Error('fake unavailable'); } });
  assert.equal(await failed.deliver(fixture()), 'delivery_uncertain');
  assert.equal(await new NewsDelivery({ store: uncertainStore, now: () => now, send: async () => assert.fail('no retry') }).deliver(fixture()), 'already_claimed');
});
test('expired bulletins and failed durable claims cannot post', async () => {
  const store = memory(); store.save = () => { throw Error('fake storage failure'); };
  const sender = new NewsDelivery({ store, now: () => now, send: async () => assert.fail('must not send') });
  await assert.rejects(sender.deliver(fixture()), /fake storage failure/);
  const expired = new NewsDelivery({ store: memory(), now: () => now + NEWS_RETENTION_MS, send: async () => assert.fail('expired cannot send') });
  await assert.rejects(expired.deliver(fixture()), /invalid_news_bulletin/);
});
test('Linux news history is atomic, exclusive, reopenable and pruned after seven days', { skip: process.platform !== 'linux' }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zugbrain-news-test-'));
  let store;
  try {
    store = openNewsStore(directory); assert.throws(() => openNewsStore(directory));
    assert.equal(store.claimWindow('2026-11-03-morning', now), true);
    assert.equal(store.claimWindow('2026-11-03-morning', now), false);
    const sender = new NewsDelivery({ store, now: () => now, send: async () => ({ id: '42' }) });
    assert.equal(await sender.deliver(fixture()), 'sent'); store.close(); store = openNewsStore(directory);
    assert.equal(store.load()[0].status, 'sent');
    assert.equal(store.claimWindow('2026-11-03-morning', now), false);
    assert.throws(() => store.claimWindow('2026-11-03-evening', now - 3600000), /clock_rollback/);
    store.prune(now + NEWS_RETENTION_MS);
    assert.equal(fs.existsSync(path.join(directory, fixture().id + '.json')), false);
  } finally {
    store?.close();
    if (path.dirname(directory) === os.tmpdir() && path.basename(directory).startsWith('zugbrain-news-test-')) fs.rmSync(directory, { recursive: true });
  }
});
