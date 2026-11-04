import test from 'node:test';
import assert from 'node:assert/strict';
import { Budget } from '../../src/budget.js';
import { createAnswerer, createClarificationJudge, OPENAI_MODEL, JEV_MODEL } from '../../src/providers.js';
import { validateConfig } from '../../src/config.js';
import { Events } from 'discord.js';
import { createClient, wireClient } from '../../src/discord.js';
import { configuration, setup, message, json, epoch } from './fixtures.js';
function rig(mode, { malformed = false, ambiguous = false, judgeHook, scores, question = 'Which class do you play?', expectedAnswer = 'class' } = {}) {
  const config = configuration({ answerMode: 'chat', clarificationMode: mode, clarificationTtlMs: 300000,
    runForMs: 0, stopAfterReply: false, replyCooldownMs: 1000,
    budgets: { openai: { dailyUsd: 1, monthlyUsd: 10, maxRequestsPerDay: 50 }, jev: { dailyUsd: 0.05, monthlyUsd: 1, maxRequestsPerDay: 100 } } });
  let answers = 0, judges = 0; const budget = new Budget(config.budgets);
  const answer = createAnswerer({ answerMode: 'chat', clarificationMode: mode, budget, keyReader: async () => 'FAKE', fetchImpl: async (_url, options) => {
    answers++; const request = JSON.parse(options.body);
    if (mode !== 'off') assert.equal(request.text.format.type, 'json_schema'); else assert.equal(request.text, undefined);
    const envelope = answers === 1 ? { text: question, clarification: { question, expectedAnswer } } : { text: 'Warrior fixture answer.', clarification: null };
    const text = mode === 'off' ? 'Ordinary answer.' : malformed ? JSON.stringify({ text: 'Answer', clarification: { question: 'Phantom?', expectedAnswer: 'class' } }) : JSON.stringify(envelope);
    return json({ model: OPENAI_MODEL, status: 'completed', service_tier: 'default', usage: { input_tokens: 100, output_tokens: 40 },
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] });
  } });
  const clarify = createClarificationJudge({ budget, keyReader: async () => { assert.equal(budget.status().jev.count, 1); return 'FAKE'; }, fetchImpl: async (url, options) => {
    judges++; assert.equal(url, 'https://api.typesafe.ai/v1/systemone'); const request = JSON.parse(options.body);
    await judgeHook?.();
    return json({ model: JEV_MODEL, usage: { input_tokens: 200, output_tokens: 20 }, answers: Object.fromEntries(Object.keys(request.questions).map(key =>
      [key, { type: 'noul', noul: scores?.[key] ?? (['answersQuestion', 'sameConversation'].includes(key) || ambiguous && key === 'ambiguous' ? 0.99 : 0.01) }])) });
  } });
  const s = setup(config, { budget, answer, clarify }), send = s.bot.transport.send;
  s.bot.transport.send = async (...args) => ({ ...await send(...args), confirmedContent: true });
  return { ...s, config, budget, answer, clarify, get answers() { return answers; }, get judges() { return judges; } };
}

test('runtime two-question policy admits observed Warrior scores and rejects observed human-directed false accepts', async () => {
  for (const [scores, expected] of [[{ answersQuestion: .99, ambiguous: .07 }, 'replied'],
    [{ answersQuestion: .95, ambiguous: .20 }, 'clarification_abstain'], [{ answersQuestion: .97, ambiguous: .18 }, 'clarification_abstain']]) {
    const s = rig('assist', { scores }); await s.bot.onMessage(message()); s.advance(2000);
    assert.equal(await s.bot.onMessage(message({ id: '21', content: 'Warrior', mentionIds: [], timestamp: epoch + 2000 })), expected);
    assert.equal(s.judges, 1); assert.equal(s.answers, expected === 'replied' ? 2 : 1);
  }
});

test('accepted semantic follow-up still needs a fresh send permit; exhausted Jev budget never calls it', async () => {
  const stale = rig('assist'); await stale.bot.onMessage(message()); stale.advance(2000);
  stale.bot.transport.fresh = async () => false;
  assert.equal(await stale.bot.onMessage(message({ id: '21', content: 'warrior', mentionIds: [], timestamp: epoch + 2000 })), 'stale');
  assert.equal(stale.sent.length, 1);
  const capped = rig('assist'); await capped.bot.onMessage(message()); capped.advance(2000);
  assert.equal(capped.budget.reserve('jev', .05), true);
  assert.equal(await capped.bot.onMessage(message({ id: '21', content: 'warrior', mentionIds: [], timestamp: epoch + 2000 })), 'clarification_abstain');
  assert.equal(capped.judges, 0); assert.equal(capped.sent.length, 1);
});
test('assist uses actual structured Sol/Jev adapters for one scoped short follow-up, without duplicate calls', async () => {
  const s = rig('assist');
  assert.equal(await s.bot.onMessage(message({ content: '<@99> Help with my class' })), 'replied');
  assert.ok(s.sent[0].includes('Which class')); assert.ok(!s.sent[0].includes('expectedAnswer'));
  s.advance(2000);
  const m = message({ id: '21', content: 'warrior', mentionIds: [], timestamp: epoch + 2000 });
  assert.equal(await s.bot.onMessage(m), 'replied');
  assert.equal(s.answers, 2); assert.equal(s.judges, 1); assert.equal(s.budget.status().jev.count, 1);
  s.advance(2000); await s.bot.onMessage(m); assert.equal(s.answers, 2); assert.equal(s.judges, 1);
});
test('shadow judges but never answers the follow-up; off remains text-only with no Jev', async () => {
  for (const mode of ['shadow', 'off']) {
    const s = rig(mode); await s.bot.onMessage(message({ content: '<@99> Help with my class' })); s.advance(2000);
    const result = await s.bot.onMessage(message({ id: '21', content: 'warrior', mentionIds: [], timestamp: epoch + 2000 }));
    assert.equal(result, mode === 'shadow' ? 'clarification_shadow_would_answer' : 'quiet');
    assert.equal(s.answers, 1); assert.equal(s.sent.length, 1); assert.equal(s.judges, mode === 'shadow' ? 1 : 0);
  }
});
test('malformed metadata and ambiguous Jev fail closed', async () => {
  const bad = rig('assist', { malformed: true });
  assert.equal(await bad.bot.onMessage(message()), 'dependency_failure'); assert.equal(bad.sent.length, 0); assert.equal(bad.judges, 0);
  const s = rig('assist', { ambiguous: true }); await s.bot.onMessage(message()); s.advance(2000);
  assert.equal(await s.bot.onMessage(message({ id: '21', content: 'yes', mentionIds: [], timestamp: epoch + 2000 })), 'clarification_abstain');
  assert.equal(s.answers, 1); assert.equal(s.sent.length, 1);
});
test('edit and duplicate during actual judge work cannot create a second answer; wrong scope never classifies', async () => {
  let enter, release; const started = new Promise(resolve => { enter = resolve; });
  const s = rig('assist', { judgeHook: async () => { enter(); await new Promise(resolve => { release = resolve; }); } });
  await s.bot.onMessage(message()); s.advance(2000);
  const m = message({ id: '21', content: 'warrior', mentionIds: [], timestamp: epoch + 2000 });
  assert.equal(await s.bot.onMessage({ ...m, authorId: '11' }), 'quiet');
  assert.equal(await s.bot.onMessage({ ...m, channelId: '3' }), 'out_of_scope');
  const pending = s.bot.onMessage(m); await started;
  assert.equal(await s.bot.onMessage(m), 'busy'); s.bot.invalidate('2', '20'); release();
  assert.equal(await pending, 'clarification_abstain'); assert.equal(s.answers, 1); assert.equal(s.judges, 1);
});
test('configuration is off by default and scoped modes require chat and bounded TTL', () => {
  assert.doesNotThrow(() => validateConfig(configuration()));
  assert.throws(() => validateConfig(configuration({ clarificationMode: 'assist' })));
  assert.throws(() => validateConfig(configuration({ answerMode: 'chat', clarificationMode: 'ambient' })));
});
test('unconfirmed Discord content cannot arm a model clarification', async () => {
  const s = rig('assist'), send = s.bot.transport.send;
  s.bot.transport.send = async (...args) => ({ ...await send(...args), confirmedContent: false });
  assert.equal(await s.bot.onMessage(message()), 'replied'); s.advance(2000);
  assert.equal(await s.bot.onMessage(message({ id: '21', content: 'warrior', mentionIds: [], timestamp: epoch + 2000 })), 'quiet');
  assert.equal(s.judges, 0);
});
test('numeric answer to a model question remains a level, not an inferred item ID', async () => {
  for (const explicit of [false, true]) {
    const s = rig('assist', { question: 'What level are you?', expectedAnswer: 'number' });
    s.bot.config.foreverdbApproved = true; s.bot.lookup = async () => assert.fail('must not reinterpret level as item ID');
    await s.bot.onMessage(message({ content: '<@99> Which item suits my warrior?' })); s.advance(2000);
    const target = message({ id: '21', content: '60', mentionIds: [], timestamp: epoch + 2000,
      ...(explicit ? { replyToId: '101', replyAuthorId: '99' } : {}) });
    assert.equal(await s.bot.onMessage(target), 'replied'); assert.equal(s.judges, explicit ? 0 : 1); assert.equal(s.answers, 2);
  }
});
test('mention escaping is idempotent so the posted question still matches metadata', async () => {
  const s = rig('assist', { question: 'Want @zug to explain?', expectedAnswer: 'yes_no' });
  assert.equal(await s.bot.onMessage(message()), 'replied');
  assert.ok(s.sent[0].includes('@\u200bzug')); assert.ok(!s.sent[0].includes('@\u200b\u200bzug'));
  s.advance(2000);
  assert.equal(await s.bot.onMessage(message({ id: '21', content: 'yes', mentionIds: [], timestamp: epoch + 2000 })), 'replied');
  assert.equal(s.judges, 1); assert.equal(s.answers, 2);
});
test('pinned client events carry structured question and shadow classification through main-style dependencies', async () => {
  const s = rig('shadow'), client = createClient(); let now = Date.now(), resolve;
  client.user = { id: '99', bot: true }; client.application = { id: '100' }; const records = new Map(); let sends = 0;
  client.rest.get = async route => records.get(route.split('/').at(-1)) || [];
  client.rest.post = async (route, { body }) => {
    if (route.endsWith('/typing')) return;
    sends++; return { id: String(100 + sends), channel_id: '2', author: { id: '99' }, content: body.content };
  };
  const wired = wireClient(client, { config: s.config, budget: s.budget, answer: s.answer, clarify: s.clarify, now: () => now },
    { log: code => { if (code !== 'discord_ready') resolve?.(code); } });
  const emit = (id, content, mentions) => new Promise(done => {
    resolve = done; const author = { id: '10', bot: false };
    records.set(id, { id, channel_id: '2', author, content, edited_timestamp: null });
    client.emit(Events.MessageCreate, { id, guildId: '1', channelId: '2', author, content, createdTimestamp: now, editedTimestamp: null,
      mentions: { users: new Map(mentions.map(id => [id, {}])) } });
  });
  try {
    client.emit(Events.ClientReady);
    assert.equal(await emit('20', '<@99> Help with my class', ['99']), 'replied'); now += 2000;
    assert.equal(await emit('21', 'warrior', []), 'clarification_shadow_would_answer');
    assert.equal(sends, 1); assert.equal(s.answers, 1); assert.equal(s.judges, 1);
  } finally { wired.stop(); await client.destroy(); }
});
