import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Events } from 'discord.js';
import { validateConfig } from '../../src/config.js';
import { Budget } from '../../src/budget.js';
import { createClient, wireClient } from '../../src/discord.js';
import { createAnswerer, OPENAI_MODEL } from '../../src/providers.js';
import { createForeverDb } from '../../src/evidence.js';
import { configuration, json, message, setup } from './fixtures.js';

test('chat config permits continuous direct use without source approval or optional credentials', () => {
  const example = JSON.parse(readFileSync(new URL('../../config/chat.example.json', import.meta.url)));
  const config = validateConfig({ ...example, enabled: true, discord: configuration().discord });
  assert.equal(config.runForMs, 0); assert.equal(config.stopAfterReply, false); assert.equal(config.foreverdbApproved, false);
  assert.throws(() => validateConfig({ ...config, participation: 'assist' }), /invalid_configuration/);
});

test('approved explicit lookup in chat uses the actual read-only adapter and attributed evidence prompt', async () => {
  const config = configuration({ answerMode: 'chat', foreverdbApproved: true });
  const budget = new Budget(config.budgets);
  const requests = [];
  const lookup = createForeverDb({ live: true, approved: true, keyFile: 'fake-db',
    keyReader: async file => { assert.equal(file, 'fake-db'); return 'FAKE-DB'; },
    fetchImpl: async (url, options) => {
      requests.push('database');
      assert.equal(url, 'https://foreverdb.net/api/v1/items/19019');
      assert.equal(options.method, 'GET');
      return json({ data: { id: 19019, name: 'Fixture item', speculation: true, dataFromBuild: 'fixture-build' },
        meta: { build: 'fixture-build', client: 'fake-account-marker' } });
    } });
  const answer = createAnswerer({ answerMode: 'chat', budget, keyFile: 'fake-openai',
    keyReader: async file => { assert.equal(file, 'fake-openai'); return 'FAKE-OPENAI'; },
    fetchImpl: async (url, options) => {
      requests.push('answer'); assert.equal(url, 'https://api.openai.com/v1/responses');
      const body = JSON.parse(options.body), input = JSON.parse(body.input);
      assert.ok(body.instructions.includes('using only supplied evidence'));
      assert.ok(body.instructions.includes('Classic fallback'));
      assert.ok(body.instructions.includes('No forced jokes'));
      assert.equal(input.evidence.data.speculation, true);
      assert.equal(input.evidence.meta.client, undefined);
      assert.equal(input.evidence.meta.build, 'fixture-build');
      assert.deepEqual(body.tools, []);
      return json({ model: OPENAI_MODEL, service_tier: 'default', status: 'completed', usage: { input_tokens: 100, output_tokens: 10 },
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixture item. Data marked speculative.' }] }] });
    } });
  const s = setup(config, { budget, lookup, answer });
  assert.equal(await s.bot.onMessage(message({ content: '<@99> item 19019?' })), 'replied');
  assert.deepEqual(requests, ['database', 'answer']);
  assert.ok(s.sent[0].endsWith('Data: [ForeverDB](https://foreverdb.net)'));
  assert.ok(!s.sent[0].includes('No database lookup used'));
  assert.equal(s.calls.decide, 0);
});

test('chat never retrieves without approval or an unambiguous current numeric query', async () => {
  for (const [approved, content] of [[false, '<@99> item 19019?'], [true, '<@99> hello'], [true, '<@99> item 1 or item 2?']]) {
    const s = setup(configuration({ answerMode: 'chat', foreverdbApproved: approved }), {
      lookup: async () => assert.fail('must not fetch a database or read its key'),
    });
    assert.equal(await s.bot.onMessage(message({ content })), 'replied');
    assert.ok(!s.sent[0].includes('No database lookup used'));
    assert.equal(s.calls.answer, 1);
  }
});

test('chat does not turn missing or wrong database records into an unsourced answer', async () => {
  for (const data of [null, {}, [], { id: 19019 }, { id: 12, name: 'Wrong record' }]) {
    const s = setup(configuration({ answerMode: 'chat', foreverdbApproved: true }), {
      lookup: async () => ({ source: 'https://foreverdb.net/api/v1/items/19019', attribution: 'ForeverDB', meta: {}, data }),
    });
    assert.equal(await s.bot.onMessage(message({ content: '<@99> item 19019?' })), 'invalid_evidence');
    assert.equal(s.calls.answer, 0); assert.equal(s.calls.send, 0);
  }
});

test('persistent chat handles two real-client events through OpenAI adapter, without Jev or database', async () => {
  const config = configuration({ answerMode: 'chat', participation: 'direct', runForMs: 0, stopAfterReply: false,
    foreverdbApproved: false, replyCooldownMs: 1000,
    budgets: { openai: { dailyUsd: 1, monthlyUsd: 10, maxRequestsPerDay: 2 }, jev: { dailyUsd: 0.05, monthlyUsd: 1, maxRequestsPerDay: 1 } } });
  validateConfig(config);
  let time = Date.now(), apiCalls = 0, sends = 0, nextOutcome;
  const outcomes = [], requests = [], records = new Map();
  const client = createClient(); client.user = { id: '99', bot: true }; client.application = { id: '100' };
  const budget = new Budget(config.budgets, { now: () => time });
  const answer = createAnswerer({ answerMode: 'chat', budget, keyFile: 'fake-openai-only',
    keyReader: async filename => { assert.equal(filename, 'fake-openai-only'); return 'FAKE-TEST-VALUE'; },
    fetchImpl: async (url, options) => {
      apiCalls++; assert.equal(url, 'https://api.openai.com/v1/responses');
      const request = JSON.parse(options.body); requests.push(request);
      assert.ok(request.instructions.includes('No verified live game evidence'));
      assert.ok(request.instructions.includes('short, plain sentences'));
      assert.ok(request.instructions.includes('No forced jokes'));
      assert.ok(!request.instructions.includes('using only supplied evidence'));
      assert.deepEqual(request.tools, []); assert.equal(request.store, false);
      return json({ model: OPENAI_MODEL, service_tier: 'default', status: 'completed', usage: { input_tokens: 100, output_tokens: 10 },
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Zug is here to chat.' }] }] });
    } });
  client.rest.get = async route => route.endsWith('/messages') ? [] : records.get(route.split('/').at(-1));
  client.rest.post = async (route, { body }) => {
    if (route.endsWith('/typing')) return;
    sends++; assert.equal(body.content, 'Zug is here to chat.');
    const sent = { id: String(100 + sends), channel_id: '2', author: { id: '99', bot: true }, content: body.content };
    records.set(sent.id, sent); return sent;
  };
  const wired = wireClient(client, { config, now: () => time, budget, answer,
    decide: async () => assert.fail('chat must not use Jev'), lookup: async () => assert.fail('chat must not use ForeverDB') }, {
    log(code) { outcomes.push(code); if (nextOutcome && code !== 'discord_ready') { const done = nextOutcome; nextOutcome = undefined; done(code); } },
    onFatal: () => assert.fail('persistent chat should stay active'),
  });
  const emit = async (id, content, replyToId = null) => {
    const m = message({ id, content, timestamp: time, mentionIds: replyToId ? [] : ['99'] });
    records.set(id, { id, channel_id: '2', author: { id: '10', bot: false }, content, edited_timestamp: null });
    const done = new Promise(resolve => { nextOutcome = resolve; });
    client.emit(Events.MessageCreate, { id, guildId: '1', channelId: '2', author: { id: '10', bot: false }, content,
      createdTimestamp: m.timestamp, editedTimestamp: null, mentions: { users: new Map(m.mentionIds.map(i => [i, {}])) },
      reference: replyToId ? { messageId: replyToId, channelId: '2' } : null });
    return done;
  };
  try {
    client.emit(Events.ClientReady);
    assert.equal(await emit('20', '<@99> Hi, can we chat?'), 'replied');
    time += 1100;
    assert.equal(await emit('21', 'What did I just ask?', '101'), 'replied');
    assert.equal(apiCalls, 2); assert.equal(sends, 2); assert.ok(wired.assistant);
    const second = JSON.parse(requests[1].input);
    assert.ok(second.messages.some(m => m.speaker === 'zug'));
    assert.ok(second.messages.some(m => m.text.includes('can we chat')));
    assert.equal(second.evidence, undefined);
    time += 1100;
    assert.equal(await emit('22', '<@99> one more'), 'budget_exhausted');
    assert.equal(apiCalls, 2); assert.equal(sends, 2); // Existing request cap still applies.
    assert.equal(budget.status().jev, undefined);
  } finally { wired.stop(); await client.destroy(); }
});
