import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, configuration, message, epoch } from './fixtures.js';
import { Conversation, providerContext } from '../../src/conversation.js';
import { BOUNDS } from '../../src/config.js';

test('direct mention and bot reply connect without Jev; synthetic grammar stays exact', async () => {
  for (const input of [message(), message({ content: 'connection test', mentionIds: [], replyToId: '19', replyAuthorId: '99' })]) {
    const s = setup(); assert.equal(await s.bot.onMessage(input), 'replied');
    assert.equal(s.calls.answer, 1); assert.equal(s.calls.decide, 0); assert.equal(s.calls.send, 1);
    assert.ok(s.sent[0].startsWith('Connection test — synthetic fixture'));
  }
  const s = setup();
  assert.equal(await s.bot.onMessage(message({ content: 'Tell me about Training Axe <@99>' })), 'synthetic_command_only');
  assert.equal(s.calls.answer, 0);
});
test('sourced mention anywhere works; source approval and data are required before completion', async () => {
  const config = configuration({ answerMode: 'sourced', foreverdbApproved: true });
  const s = setup(config);
  assert.equal(await s.bot.onMessage(message({ content: 'What is item 19019, <@99>?' })), 'replied');
  assert.equal(s.calls.lookup, 1); assert.equal(s.calls.answer, 1);
  assert.ok(s.sent[0].endsWith('Data: [ForeverDB](https://foreverdb.net)')); // Fake answer omitted any credit.
  for (const data of [null, {}, [], { id: 19019 }, { id: 12, name: 'Wrong' }]) {
    const bad = setup(config, { lookup: async () => ({ data, meta: {}, source: 'https://foreverdb.net/api/v1/items/19019', attribution: 'ForeverDB' }) });
    assert.equal(await bad.bot.onMessage(message({ content: '<@99> item 19019?' })), 'invalid_evidence');
    assert.equal(bad.calls.answer, 0); assert.equal(bad.calls.send, 0);
  }
  const unapproved = setup(configuration({ answerMode: 'sourced' }));
  await unapproved.bot.onMessage(message({ content: '<@99> item 19019?' }));
  assert.equal(unapproved.calls.answer, 0); assert.equal(unapproved.calls.lookup, 0);
});
test('wrong guild/channel/user, bots and webhooks are ignored before providers', async () => {
  for (const override of [{ guildId: '9' }, { channelId: '9' }, { authorId: '9' }, { bot: true }, { webhook: true }]) {
    const s = setup(); assert.equal(await s.bot.onMessage(message(override)), 'out_of_scope');
    assert.equal(Object.values(s.calls).reduce((a, b) => a + b), 0);
  }
});
test('human-directed questions, thanks and non-candidate chatter stay quiet', async () => {
  for (const override of [
    { content: '<@11> item 19019?', mentionIds: ['11'] },
    { content: 'what level?', mentionIds: [], replyToId: '12', replyAuthorId: '11' },
    { content: 'what level?', mentionIds: [], replyToId: '12' },
    { content: '<@99> thank you!' }, { content: 'nice weather today', mentionIds: [] },
  ]) {
    const s = setup(configuration({ answerMode: 'sourced', participation: 'assist', foreverdbApproved: true }));
    assert.equal(await s.bot.onMessage(message(override)), 'quiet'); assert.equal(s.calls.decide, 0); assert.equal(s.calls.answer, 0);
  }
});
test('room questions and no-question-mark follow-ups use optional Jev; shadow never answers them', async () => {
  const config = configuration({ answerMode: 'sourced', participation: 'assist', foreverdbApproved: true });
  const s = setup(config);
  assert.equal(await s.bot.onMessage(message({ content: 'Does anyone know item 19019?', mentionIds: [] })), 'replied');
  assert.equal(s.calls.decide, 1);
  s.advance(31000);
  assert.equal(await s.bot.onMessage(message({ id: '21', content: 'and for a warrior', mentionIds: [], timestamp: epoch + 31000 })), 'replied');
  assert.equal(s.calls.decide, 2);
  const shadow = setup({ ...config, participation: 'shadow' });
  assert.equal(await shadow.bot.onMessage(message({ content: 'item 19019?', mentionIds: [] })), 'shadow_would_answer');
  assert.equal(shadow.calls.answer, 0); assert.equal(shadow.calls.send, 0);
});
test('abstention, bad selected IDs, provider failures and late human answers fail silent', async () => {
  const config = configuration({ answerMode: 'sourced', participation: 'assist', foreverdbApproved: true });
  for (const decision of [{ allow: false, selectedIds: [] }, { allow: true, selectedIds: ['unknown'] }, { allow: true, selectedIds: ['m1', 'm1'] }]) {
    const s = setup(config, { decide: async () => decision });
    await s.bot.onMessage(message({ content: 'item 19019?', mentionIds: [] }));
    assert.equal(s.calls.answer, 0); assert.equal(s.calls.send, 0);
  }
  const failed = setup(config, { decide: async () => { throw Error('synthetic outage'); } });
  assert.equal(await failed.bot.onMessage(message({ content: 'item 19019?', mentionIds: [] })), 'dependency_failure');
  assert.equal(failed.calls.answer, 0);
  const stale = setup(configuration(), { transport: { fresh: async () => false, send: async () => assert.fail('must not send') } });
  assert.equal(await stale.bot.onMessage(message()), 'stale');
});
test('deduplication, cooldowns, one in-flight operation and edits prevent extra replies', async () => {
  const s = setup(); await s.bot.onMessage(message());
  assert.equal(await s.bot.onMessage(message({ id: '21' })), 'reply_cooldown');
  s.advance(31000); assert.equal(await s.bot.onMessage(message()), 'duplicate_or_ledger_unavailable');
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const busy = setup(configuration(), { answer: async (_input, signal) => { entered(); await new Promise(resolve => { release = resolve; }); signal.throwIfAborted(); return 'test'; } });
  const pending = busy.bot.onMessage(message()); await ready;
  assert.equal(await busy.bot.onMessage(message({ id: '21' })), 'busy');
  busy.bot.invalidate('2', '20'); release();
  assert.equal(await pending, 'cancelled'); assert.equal(busy.calls.send, 0);
});
test('interleaved contexts preserve speakers and reply links without borrowing another conversation', () => {
  const c = new Conversation({ now: () => epoch + 1000 });
  const rows = [message({ id: '1', content: '<@99> item 19019?' }),
    message({ id: '2', authorId: '11', content: 'item 123?', mentionIds: [] }),
    message({ id: '3', authorId: '99', bot: true, content: 'answer', replyToId: '1' }),
    message({ id: '4', content: 'and its level', mentionIds: [] })];
  rows.forEach(row => c.observe(row));
  assert.deepEqual(c.select(rows[3], '99').map(m => m.id), ['4']);
  const selected = c.select(rows[3], '99', [], true);
  assert.deepEqual(selected.map(m => m.id), ['1', '3', '4']);
  const { state } = providerContext(selected, rows[3], '99');
  assert.equal(state.messages[0].speaker, state.messages[2].speaker);
  assert.equal(state.messages[1].replyTo, state.messages[0].id);
  assert.ok(!JSON.stringify(state).includes('<@99>'));
  assert.throws(() => c.select(rows[3], '99', ['missing']), /invalid_context_selection/);
});
test('history, selected context, and provider input stay bounded and expire', () => {
  let now = epoch;
  const c = new Conversation({ now: () => now });
  for (let i = 0; i < 30; i++) c.observe(message({ id: String(i), content: 'a'.repeat(1200) }));
  const rows = c.recent('2'); assert.equal(rows.length, BOUNDS.messages);
  const target = rows.at(-1);
  const { state } = providerContext(rows, target, '99');
  assert.ok(state.messages.reduce((n, m) => n + m.text.length, 0) <= BOUNDS.contextChars);
  assert.ok(state.messages.some(m => m.id === state.target));
  now += BOUNDS.ageMs + 1; c.sweep(); assert.equal(c.recent('2').length, 0);
});
test('Jev new-conversation judgment cannot silently borrow the prior item', async () => {
  let seen = 0;
  const s = setup(configuration({ answerMode: 'sourced', participation: 'assist', foreverdbApproved: true }), {
    decide: async () => ({ allow: true, continuation: false, selectedIds: [] }),
    lookup: async () => { seen++; throw Error('must not borrow context'); },
  });
  s.bot.conversation.observe(message({ id: '1', content: '<@99> item 19019?' }));
  s.bot.conversation.observe(message({ id: '2', authorId: '99', bot: true, content: 'Earlier answer', replyToId: '1' }));
  assert.equal(await s.bot.onMessage(message({ id: '3', content: 'What about the new zone?', mentionIds: [] })), 'lookup_needed');
  assert.equal(seen, 0); assert.equal(s.calls.answer, 0);
});
