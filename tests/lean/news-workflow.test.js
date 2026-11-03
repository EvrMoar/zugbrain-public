import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import { Budget } from '../../src/budget.js';
import { createNewsProducer, parseNewsResearch, NEWS_DOMAINS } from '../../src/news-producer.js';
import { NewsScheduler, scheduledWindow } from '../../src/news-schedule.js';
import { createClient, createNewsSender } from '../../src/discord.js';
import { validateConfig } from '../../src/config.js';
import { OPENAI_MODEL } from '../../src/providers.js';
import { configuration, json } from './fixtures.js';

const now = Date.UTC(2026, 10, 3, 8);
const settings = { enabled: true, channelId: '2', timezone: 'UTC', morning: '08:00', evening: '19:00' };
test('example Chicago 7am/7pm schedule follows daylight saving and has no catch-up', () => {
  const chicago = { ...settings, timezone: 'America/Chicago', morning: '07:00', evening: '19:00' };
  for (const [utc, expected] of [['2026-11-03T13:00:00Z', '2026-11-03-morning'], ['2026-11-04T01:00:00Z', '2026-11-03-evening'],
    ['2026-07-03T12:00:00Z', '2026-07-03-morning'], ['2026-07-04T00:00:00Z', '2026-07-03-evening']]) {
    assert.equal(scheduledWindow(chicago, Date.parse(utc)).id, expected);
  }
  assert.equal(scheduledWindow(chicago, Date.parse('2026-11-03T13:01:00Z')), null);
});
const items = () => [
  { title: 'Synthetic major patch', summary: 'Fixture only: a player-facing patch change, not real news.', edition: 'Forever', publishedAt: new Date(now - 3600000).toISOString(), url: 'https://news.blizzard.com/article/fixture-patch', kind: 'patch' },
  { title: 'Synthetic blue post', summary: 'Fixture only: an official clarification affecting players.', edition: 'Forever', publishedAt: new Date(now - 3600000).toISOString(), url: 'https://us.forums.blizzard.com/en/wow/t/fixture/123', kind: 'blue_post' },
];
const output = data => [{ type: 'web_search_call', status: 'completed', action: { type: 'search', sources: data.map(item => ({ type: 'url', url: item.url })) } },
  { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ items: data }), annotations: [] }] }];
function memory() {
  let rows = []; const attempts = new Set(); let pruned = 0;
  return { load: () => structuredClone(rows), save: value => { rows = structuredClone(value); }, archive() {},
    prune() { pruned++; }, get pruned() { return pruned; }, claimWindow(id) { if (attempts.has(id)) return false; attempts.add(id); return true; } };
}

test('disabled schedule needs no times or access; enabled requires exact timezone/times and allowed channel', () => {
  assert.equal(scheduledWindow({ enabled: false }, now), null);
  assert.deepEqual(scheduledWindow(settings, now), { id: '2026-11-03-morning', now });
  assert.equal(scheduledWindow(settings, now + 60000), null); // No catch-up.
  assert.deepEqual(scheduledWindow({ ...settings, timezone: 'America/New_York', morning: '03:00' }, now), { id: '2026-11-03-morning', now });
  const config = configuration({ answerMode: 'chat', runForMs: 0, stopAfterReply: false, news: settings });
  assert.doesNotThrow(() => validateConfig(config));
  for (const change of [{ timezone: '' }, { timezone: 'not/a/timezone' }, { morning: '' }, { morning: '25:00' }, { evening: settings.morning }, { channelId: '999' }]) {
    assert.throws(() => validateConfig({ ...config, news: { ...settings, ...change } }), /news_configuration/);
  }
});

test('actual public producer and pinned Discord sender complete one scheduled flow; restart never repeats it', async () => {
  const config = configuration({ answerMode: 'chat', runForMs: 0, stopAfterReply: false, news: settings });
  const client = createClient(); client.user = { id: '99', bot: true }; client.application = { id: '100' };
  client.guilds._add({ id: '1', unavailable: true });
  client.channels._add({ id: '2', guild_id: '1', type: ChannelType.GuildText, name: 'fixture', permission_overwrites: [] });
  let requests = 0, sends = 0, ready = true;
  client.rest.post = async (route, { body }) => {
    sends++; assert.equal(route, '/channels/2/messages'); assert.deepEqual(body.allowed_mentions.parse, []);
    assert.equal(body.enforce_nonce, true); assert.ok(body.content.includes('](<https://'));
    return { id: '42', channel_id: '2', author: { id: '99' } };
  };
  const budget = new Budget({ openai: { dailyUsd: 1, monthlyUsd: 10, maxRequestsPerDay: 50 } });
  const produce = createNewsProducer({ budget, keyReader: async () => 'FAKE-ONLY', fetchImpl: async (url, options) => {
    requests++; assert.equal(url, 'https://api.openai.com/v1/responses'); const body = JSON.parse(options.body);
    assert.deepEqual(body.tools[0].filters.allowed_domains, NEWS_DOMAINS); assert.equal(body.max_tool_calls, 1);
    assert.equal(body.text.format.type, 'json_schema'); assert.ok(!options.body.includes('PRIVATE FIXTURE'));
    return json({ model: OPENAI_MODEL, status: 'completed', service_tier: 'default', usage: { input_tokens: 3000, output_tokens: 300 }, output: output(items()) });
  } });
  const store = memory(), send = createNewsSender(client, config, () => ready);
  const make = () => new NewsScheduler({ settings, store, produce, send, now: () => now, ready: () => ready });
  try {
    assert.equal(await make().tick(), 'news_sent'); assert.equal(budget.status().openai.dayMicros, 19000);
    assert.equal(await make().tick(), 'news_window_claimed'); assert.equal(requests, 1); assert.equal(sends, 1);
    ready = false; await assert.rejects(send('Fixture', '2026-11-03-evening'), /news_send_refused/);
  } finally { await client.destroy(); }
});

test('producer abstains on quiet windows and rejects uncited, wrong-edition, old or unsupported news', () => {
  assert.equal(parseNewsResearch(output([]), '2026-11-03-morning', now), null);
  for (const change of [rows => { rows[1].edition = 'Classic'; }, rows => { rows[0].kind = 'advertisement'; },
    rows => { rows[0].publishedAt = '2020-01-01'; }, rows => { rows[0].url = 'https://news.blizzard.com/'; },
    rows => { rows[0].url = 'https://www.wowhead.com/forever/search'; }, rows => { rows[0].url = 'https://www.reddit.com/r/example/comments/fixture'; }]) {
    const rows = items(); change(rows); assert.throws(() => parseNewsResearch(output(rows), '2026-11-03-morning', now));
  }
  const uncited = output(items()); uncited[0].action.sources = [];
  assert.throws(() => parseNewsResearch(uncited, '2026-11-03-morning', now), /invalid_news_research/);
});

test('scheduler prunes quiet windows and claims before producer failure; disabled never touches storage', async () => {
  const store = memory(); let calls = 0;
  const make = (s = settings, date = now) => new NewsScheduler({ settings: s, store, now: () => date,
    produce: async () => { calls++; throw Error('fake private provider error'); }, send: async () => assert.fail('no send') });
  assert.equal(await make({ enabled: false }).tick(), 'news_disabled'); assert.equal(store.pruned, 0);
  assert.equal(await make(settings, now + 60000).tick(), 'news_idle'); assert.equal(store.pruned, 1);
  assert.equal(await make().tick(), 'news_failed'); assert.equal(await make().tick(), 'news_window_claimed'); assert.equal(calls, 1);
  const emptyStore = memory();
  const empty = new NewsScheduler({ settings, store: emptyStore, now: () => now, produce: async () => null, send: async () => assert.fail('no filler') });
  assert.equal(await empty.tick(), 'news_no_items'); assert.equal(await empty.tick(), 'news_window_claimed');
});

test('shutdown cancels scheduled research before a send; duplicate ticks are bounded', async () => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const scheduler = new NewsScheduler({ settings, store: memory(), now: () => now, send: async () => assert.fail('stopped'),
    produce: async (_window, signal) => { entered(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); signal.throwIfAborted(); } });
  const pending = scheduler.tick(); await started;
  assert.equal(await scheduler.tick(), 'news_busy'); await scheduler.stop(); assert.equal(await pending, 'news_cancelled');
});
