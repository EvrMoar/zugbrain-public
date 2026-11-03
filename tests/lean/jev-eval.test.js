import test from 'node:test';
import assert from 'node:assert/strict';
import { cases, scoreEvaluation, runJevEvaluation } from '../../tools/lean/jev-eval.js';
import { createDecisionGate, JEV_MODEL, decisionQuestions } from '../../src/providers.js';
import { Budget, reserveJev } from '../../src/budget.js';
import { json } from './fixtures.js';
test('Jev evaluation scores interruptions, missed engagement, context selection and failure separately', () => {
  const rows = cases.map(item => ({ id: item.id, status: 'ok', ...item.expected, elapsedMs: 20, estimatedUsd: 0.001 }));
  rows[0].allow = false; rows[1].allow = true; rows[5].selectedIds = ['m1', 'm3']; rows[9].status = 'error';
  const result = scoreEvaluation(rows);
  assert.equal(result.falsePositive, 1); assert.equal(result.falseNegative, 2); assert.equal(result.failures, 1);
  assert.equal(result.contextPrecision, 0.75); assert.equal(result.contextRecall, 0.75);
  assert.equal(result.p95Ms, 20); assert.equal(result.potentialMainCallsAvoided, 7);
  assert.throws(() => scoreEvaluation(rows.slice(1)), /invalid_eval_results/);
  rows[4].selectedIds = ['invented']; assert.throws(() => scoreEvaluation(rows), /invalid_eval_results/);
});

test('evaluation runs the actual Jev wire adapter, records cost/latency and abstains on an error', async () => {
  let clock = 0, requests = 0;
  const budget = new Budget({ jev: { dailyUsd: 0.01, monthlyUsd: 0.01, maxRequestsPerDay: 10 } });
  const decide = createDecisionGate({ budget, keyReader: async () => 'FAKE-ONLY', fetchImpl: async (url, options) => {
    requests++; clock += 7; assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    const body = JSON.parse(options.body);
    const item = cases.find(item => JSON.stringify(item.state) === JSON.stringify(body.state)); assert.ok(item);
    if (item.id === 'follow-up') return new Response('fake unavailable', { status: 429 });
    const answers = Object.fromEntries(Object.keys(body.questions).map(key => [key, { type: 'noul', noul:
      key.startsWith('context_') ? (item.expected.selectedIds.includes(key.slice(8)) ? 0.99 : 0.01) :
      ['needsAnswer', 'addressedToZug', 'openToRoom', 'unresolved'].includes(key) && item.expected.allow ? 0.99 : 0.01 }]));
    return json({ model: JEV_MODEL, answers, usage: { input_tokens: 100, output_tokens: 20 } });
  } });
  const result = await runJevEvaluation({ decide, now: () => clock, usageUsd: () => (budget.status().jev?.dayMicros || 0) / 1e6 });
  assert.equal(requests, 10); assert.equal(result.falsePositive, 0); assert.equal(result.falseNegative, 1); assert.equal(result.failures, 1);
  assert.equal(result.p95Ms, 7); assert.ok(result.estimatedUsd > 0 && result.estimatedUsd < 0.01);
  const maximum = cases.reduce((sum, item) => sum + reserveJev(Buffer.byteLength(JSON.stringify({ model: JEV_MODEL, state: item.state, questions: decisionQuestions(item.state) }))), 0);
  assert.ok(maximum < 0.01); // Offline pricing of the ten-request proposal, not permission to run it.
});
