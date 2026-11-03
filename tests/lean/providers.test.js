import test from 'node:test';
import assert from 'node:assert/strict';
import { Budget } from '../../src/budget.js';
import { createAnswerer, createDecisionGate, decisionQuestions, parseDecision, OPENAI_MODEL, JEV_MODEL } from '../../src/providers.js';
import { configuration, json } from './fixtures.js';
const state = { target: 'm2', messages: [{ id: 'm1', speaker: 'p1', text: 'item 19019' }, { id: 'm2', speaker: 'p1', text: 'what level?', replyTo: 'm1' }] };
function decision(override = {}) {
  const answers = Object.fromEntries(Object.keys(decisionQuestions(state)).map(key => [key, { type: 'noul', noul: key === 'directedElsewhere' ? 0 : 1 }]));
  return { model: JEV_MODEL, answers, usage: { input_tokens: 100, output_tokens: 10 }, ...override };
}
const freshBudget = () => new Budget(configuration().budgets);
test('Jev uses pinned Noul contract with supplied IDs, independent judgments and conservative abstention', () => {
  const q = decisionQuestions(state);
  assert.ok(q.context_m1.instructions.includes('m1') && q.context_m1.instructions.includes('m2'));
  const result = parseDecision(decision(), q, state);
  assert.equal(result.allow, true); assert.deepEqual(result.selectedIds, ['m1']);
  for (const value of [0.5, 0.9]) {
    const data = decision(); data.answers.needsAnswer.noul = value;
    assert.equal(parseDecision(data, q, state).allow, false);
  }
  for (const value of [null, -1, 2, '1']) {
    const data = decision(); data.answers.needsAnswer.noul = value;
    assert.throws(() => parseDecision(data, q, state), /invalid_decision/);
  }
  const extra = decision(); extra.answers.inventedId = { type: 'noul', noul: 1 };
  assert.throws(() => parseDecision(extra, q, state), /invalid_decision/);
});
test('provider requests go to fixed hosts with no redirects, tools or retries; reserve before key read', async () => {
  const budget = freshBudget(); let openAiCalls = 0, jevCalls = 0;
  const keyReader = async () => { assert.ok(budget.status().openai || budget.status().jev); return 'FAKE-TEST-VALUE'; };
  const answer = createAnswerer({ budget, keyFile: 'fake-only', keyReader, fetchImpl: async (url, options) => {
    openAiCalls++; assert.equal(url, 'https://api.openai.com/v1/responses'); assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body); assert.equal(body.store, false); assert.deepEqual(body.tools, []); assert.equal(body.max_output_tokens, 512);
    return json({ model: OPENAI_MODEL, service_tier: 'default', status: 'completed', usage: { input_tokens: 100, output_tokens: 10 },
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Test answer' }] }] });
  } });
  assert.equal(await answer({ synthetic: true }), 'Test answer');
  const gate = createDecisionGate({ budget, keyFile: 'fake-only', keyReader, fetchImpl: async (url, options) => {
    jevCalls++; assert.equal(url, 'https://api.typesafe.ai/v1/systemone'); assert.equal(options.redirect, 'error');
    assert.equal(JSON.parse(options.body).model, JEV_MODEL); return json(decision());
  } });
  assert.equal((await gate(state)).allow, true);
  assert.equal(openAiCalls, 1); assert.equal(jevCalls, 1);
});
test('budget exhaustion prevents key access; 401/429/malformed responses never retry or expose errors', async () => {
  const blocked = createAnswerer({ budget: { reserve: () => false }, keyReader: async () => assert.fail('key read'), fetchImpl: async () => assert.fail('network') });
  await assert.rejects(blocked({}), /budget_exhausted/);
  for (const status of [401, 429, 500]) {
    let calls = 0;
    const gate = createDecisionGate({ budget: freshBudget(), keyReader: async () => 'FAKE-TEST-VALUE', fetchImpl: async () => { calls++; return new Response('untrusted server content', { status }); } });
    await assert.rejects(gate(state), error => ['unauthorized', 'rate_limited', 'provider_failure'].includes(error.code));
    assert.equal(calls, 1);
  }
  const bad = createAnswerer({ budget: freshBudget(), keyReader: async () => 'FAKE-TEST-VALUE', fetchImpl: async () => json({ model: 'wrong' }) });
  await assert.rejects(bad({}), /invalid_completion/);
});
test('cancellation prevents provider call and network errors become fixed codes', async () => {
  const controller = new AbortController(); controller.abort();
  const gate = createDecisionGate({ budget: freshBudget(), keyReader: async () => assert.fail('key read'), fetchImpl: async () => assert.fail('network') });
  await assert.rejects(gate(state, controller.signal));
  const failing = createAnswerer({ budget: freshBudget(), keyReader: async () => 'FAKE-TEST-VALUE', fetchImpl: async () => { throw Error('untrusted details'); } });
  await assert.rejects(failing({}), error => error.message === 'invalid_or_unavailable_response');
});
