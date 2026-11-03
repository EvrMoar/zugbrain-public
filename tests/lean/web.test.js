import test from 'node:test';
import assert from 'node:assert/strict';
import { Budget, reserveWebSearch } from '../../src/budget.js';
import { createWebAnswerer, webQuery, renderWebAnswer, WEB_DOMAINS } from '../../src/web.js';
import { OPENAI_MODEL } from '../../src/providers.js';
import { configuration, json, message, setup } from './fixtures.js';
const output = () => [{ type: 'web_search_call', status: 'completed', action: { type: 'search' } },
  { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Verified fixture.', annotations: [
    { type: 'url_citation', start_index: 0, end_index: 17, url: 'https://news.blizzard.com/article/fixture', title: 'Fixture' },
  ] }] }];
const webConfig = () => configuration({ answerMode: 'chat', webSearchEnabled: true,
  budgets: { openai: { dailyUsd: 1, monthlyUsd: 10, maxRequestsPerDay: 50 }, jev: { dailyUsd: 0.05, monthlyUsd: 1, maxRequestsPerDay: 100 } } });

test('explicit public search uses one bounded native tool and reserves search charges before key access', async () => {
  const config = webConfig();
  const budget = new Budget(config.budgets); let calls = 0, request;
  const search = createWebAnswerer({ enabled: true, budget, keyReader: async () => {
    assert.equal(budget.status().openai.count, 1); assert.ok(budget.status().openai.dayMicros > 500000); return 'FAKE-ONLY';
  }, fetchImpl: async (url, options) => {
    calls++; assert.equal(url, 'https://api.openai.com/v1/responses'); assert.equal(options.redirect, 'error');
    request = JSON.parse(options.body);
    assert.equal(request.max_tool_calls, 1); assert.equal(request.tool_choice, 'required'); assert.equal(request.store, false);
    assert.deepEqual(request.tools[0].filters.allowed_domains, WEB_DOMAINS);
    assert.equal(budget.status().openai.dayMicros, Math.ceil(reserveWebSearch(Buffer.byteLength(options.body)) * 1e6));
    return json({ model: OPENAI_MODEL, status: 'completed', service_tier: 'default', usage: { input_tokens: 2000, output_tokens: 30 }, output: output() });
  } });
  const s = setup(config, { budget, search, answer: async () => assert.fail('search must not add a second completion') });
  s.bot.conversation.observe(message({ id: '19', content: 'PRIVATE FIXTURE CONTEXT', mentionIds: [] }));
  assert.equal(await s.bot.onMessage(message({ content: '<@99> search latest Forever patch notes' })), 'replied');
  assert.equal(calls, 1); assert.deepEqual(JSON.parse(request.input), { game: 'World of Warcraft', defaultEdition: 'Forever', requestedEditions: ['Forever'], publicQuery: 'latest Forever patch notes' });
  assert.ok(!request.input.includes('PRIVATE FIXTURE'));
  assert.ok(s.sent[0].includes('[1](<https://news.blizzard.com/article/fixture>)'));
  assert.equal(budget.status().openai.dayMicros, 14300);
  assert.equal(budget.status().openai.count, 1);
});

test('search is opt-in; bad queries, exhausted budget and cancellation never read a key', async () => {
  const never = async () => assert.fail('must not access key or network');
  const options = { budget: { reserveTracked: () => null }, keyReader: never, fetchImpl: never };
  await assert.rejects(createWebAnswerer(options)('item 19019'), /web_not_enabled/);
  const enabled = createWebAnswerer({ ...options, enabled: true });
  await assert.rejects(enabled('item 19019'), /budget_exhausted/);
  await assert.rejects(enabled('email a@example.com'), /invalid_web_query/);
  await assert.rejects(enabled('item 19019', AbortSignal.abort()));
  for (const content of ['search', 'search https://example.com', 'search user 111111111111111111', 'search ' + 'x'.repeat(401)]) assert.equal(webQuery(content), '');
  assert.equal(webQuery('normal game question?'), null);
});

test('web rendering rejects uncited, off-domain, malformed, excessive and extra-tool output', () => {
  const credited = output(); credited[1].content[0].annotations[0].url = 'https://foreverdb.net/item/19019';
  assert.ok(renderWebAnswer(credited).endsWith('Data: [ForeverDB](https://foreverdb.net)'));
  assert.ok(!renderWebAnswer(output()).includes('Data: [ForeverDB]'));
  for (const mutate of [
    rows => { rows[1].content[0].annotations = []; },
    rows => { rows[1].content[0].annotations[0].url = 'https://news.blizzard.com.evil.example/x'; },
    rows => { rows[1].content[0].annotations[0].end_index = 999; },
    rows => { rows[1].content[0].text = 'x'.repeat(1700); },
    rows => { rows.push({ type: 'web_search_call', status: 'completed' }); },
    rows => { rows.push({ type: 'function_call', name: 'unapproved' }); },
  ]) { const rows = output(); mutate(rows); assert.throws(() => renderWebAnswer(rows), /invalid_web/); }
});

test('search provider failure is charged once and never retries', async () => {
  let calls = 0;
  const budget = new Budget(webConfig().budgets);
  const search = createWebAnswerer({ enabled: true, budget, keyReader: async () => 'FAKE-ONLY',
    fetchImpl: async () => { calls++; return new Response('untrusted response', { status: 429 }); } });
  await assert.rejects(search('Forever item 19019'), /rate_limited/);
  assert.equal(calls, 1); assert.equal(budget.status().openai.count, 1);
});
