import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnswerer, OPENAI_MODEL } from '../../src/providers.js';
import { requestedEditions } from '../../src/web.js';
import { validForeverDbEvidence } from '../../src/evidence.js';
import { Budget } from '../../src/budget.js';
import { configuration, json, message, setup } from './fixtures.js';

test('Forever is default; explicit Retail/Classic/Vanilla requests retain their edition', async () => {
  assert.deepEqual(requestedEditions('Which warrior talent?'), ['Forever']);
  assert.deepEqual(requestedEditions('Compare Forever with Vanilla and Classic'), ['Forever', 'Vanilla', 'Classic']);
  for (const edition of ['Retail', 'Classic', 'Vanilla']) {
    const s = setup(configuration({ answerMode: 'chat', foreverdbApproved: true }));
    assert.equal(await s.bot.onMessage(message({ content: `<@99> ${edition} item 19019?` })), 'replied');
    assert.equal(s.calls.lookup, 0); // Never silently use a Forever record for another edition.
  }
});

test('source version, fallback and uncertainty reach the actual provider prompt and sanitized usage only', async () => {
  const evidence = { source: 'https://foreverdb.net/api/v1/items/19019', attribution: 'ForeverDB',
    data: { id: 19019, name: 'Fixture', edition: 'Classic', speculation: true, seenInForever: false, betaEvent: true },
    meta: { build: 'fixture-classic', publishedAt: '2026-10-01', fallback: 'Classic' } };
  let request, usage;
  const answer = createAnswerer({ budget: new Budget(configuration().budgets), keyReader: async () => 'FAKE-ONLY', onUsage: row => { usage = row; },
    fetchImpl: async (_url, options) => { request = JSON.parse(options.body); return json({ model: OPENAI_MODEL, status: 'completed', service_tier: 'default',
      usage: { input_tokens: 90, output_tokens: 20 }, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Classic background. Forever applicability unconfirmed.' }] }] }); } });
  await answer({ question: 'Does this still apply in Forever?', evidence });
  assert.deepEqual(JSON.parse(request.input).evidence, evidence);
  for (const phrase of ['Forever is the default', 'Retail, Classic and Vanilla', 'never assert an old mechanic still applies', 'source edition, build, publication date', 'Classic fallback']) assert.ok(request.instructions.includes(phrase));
  assert.equal(validForeverDbEvidence({ ...evidence, meta: undefined }, { kind: 'item', id: 19019 }), false);
  assert.deepEqual(Object.keys(usage).sort(), ['elapsedMs', 'estimatedUsd', 'event', 'inputTokens', 'model', 'outputTokens', 'provider', 'reservedUsd', 'searchCalls'].sort());
  assert.ok(usage.reservedUsd > usage.estimatedUsd); assert.equal(usage.inputTokens, 90);
  assert.ok(!JSON.stringify(usage).includes('Fixture'));
});
