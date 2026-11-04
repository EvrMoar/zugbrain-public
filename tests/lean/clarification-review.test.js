import test from 'node:test';
import assert from 'node:assert/strict';
import { admits, simplifiedCandidate, freshCases, nextClarificationPlan, diagnoseClarification, evaluationScores } from '../../tools/lean/clarification-review.js';
import { clarificationCases, clarificationCandidate } from '../../tools/lean/clarification-eval.js';
test('offline two-question ablation preserves wording/state/preflight but does not change runtime policy', () => {
  for (const item of freshCases) {
    const full = clarificationCandidate(item.input), reduced = simplifiedCandidate(item.input);
    assert.deepEqual(reduced.request.state, full.request.state);
    assert.deepEqual(Object.keys(reduced.request.questions), ['answersQuestion', 'ambiguous']);
    for (const key of Object.keys(reduced.request.questions)) assert.deepEqual(reduced.request.questions[key], full.request.questions[key]);
  }
  for (const item of clarificationCases.filter(row => !row.split)) assert.equal(simplifiedCandidate(item.input).route, item.expected);
  const warrior = { answersQuestion: 0.99, sameConversation: 0.98, directedElsewhere: 0.08, newTopic: 0.03, ambiguous: 0.07 };
  assert.equal(admits(warrior), false); assert.equal(admits(warrior, 'two_gate_experimental'), true);
  assert.equal(admits({ answersQuestion: 0.96, ambiguous: 0.71 }, 'two_gate_experimental'), false);
  for (const value of [null, {}, { answersQuestion: 1, ambiguous: NaN }, { answersQuestion: 1, ambiguous: -1 }]) assert.equal(admits(value, 'two_gate_experimental'), false);
});
test('new frozen holdout plan has balanced cases, bounded bodies and labels outside provider inputs', () => {
  const plan = nextClarificationPlan();
  assert.equal(plan.proposedRequests, 32); assert.equal(plan.liveCallsMade, 0); assert.equal(plan.runtimeThresholdsChanged, false);
  assert.equal(freshCases.filter(row => row.expected === 'candidate').length, 8);
  assert.ok(plan.reservedUpperUsd < 0.02 && plan.reservedUpperUsd > plan.acceptedUsageUpperEstimateUsd);
  for (const row of plan.requests) { assert.ok(row.bytes < 24000); assert.equal(row.request.expected, undefined); assert.equal(row.request.split, undefined); }
  assert.throws(() => diagnoseClarification([]));
});
test('evaluation-only parser validates actual two/five Noul shapes without inventing missing scores', () => {
  for (const variant of ['five_control', 'two_candidate']) {
    const row = nextClarificationPlan().requests.find(row => row.variant === variant);
    const response = { model: 'jev-1.14.0', usage: { input_tokens: 100, output_tokens: 20 },
      answers: Object.fromEntries(Object.keys(row.request.questions).map(key => [key, { type: 'noul', noul: 0.5 }])) };
    assert.deepEqual(Object.keys(evaluationScores(response, row.request)), Object.keys(response.answers).sort());
    for (const change of [{ model: 'wrong' }, { answers: {} }, { usage: { input_tokens: -1, output_tokens: 1 } }])
      assert.throws(() => evaluationScores({ ...response, ...change }, row.request), /invalid_eval_response/);
    response.answers.ambiguous.noul = Infinity;
    assert.throws(() => evaluationScores(response, row.request), /invalid_eval_response/);
  }
});
