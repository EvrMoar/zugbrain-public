import test from 'node:test';
import assert from 'node:assert/strict';
import { clarificationCases, clarificationCandidate, clarificationComparisonPlan, variants } from '../../tools/lean/clarification-eval.js';
import { prepareClarificationPrototype } from '../../src/clarification-prototype.js';
test('offline candidate preserves baseline and supplies validated explicit context without forging replies', () => {
  const item = clarificationCases[0], before = structuredClone(item.input);
  assert.deepEqual(clarificationCandidate(item.input, 'baseline'), prepareClarificationPrototype(item.input));
  const candidate = clarificationCandidate(item.input);
  assert.deepEqual(item.input, before);
  assert.equal(candidate.request.state.clarification.asker, 'p1');
  assert.equal(candidate.request.state.clarification.sameAsker, true);
  assert.equal(candidate.request.state.clarification.question, 'Which class do you play?');
  assert.equal(candidate.request.state.targetMessage.text, 'Warrior.');
  assert.equal(candidate.request.state.targetMessage.replyTo, null);
  assert.deepEqual(Object.keys(candidate.request.questions).sort(), ['ambiguous', 'answersQuestion', 'directedElsewhere', 'newTopic', 'sameConversation']);
  assert.ok(Object.values(candidate.request.questions).every(q => q.type === 'noul' && q.criteria.true && q.criteria.false));
  const stateOnly = clarificationCandidate(item.input, 'explicit_state');
  assert.deepEqual(stateOnly.request.questions, prepareClarificationPrototype(item.input).request.questions);
});
test('scope, human-directed replies and stale cases never become judge candidates in any variant', () => {
  for (const item of clarificationCases.filter(row => !row.split)) for (const variant of variants)
    assert.equal(clarificationCandidate(item.input, variant).route, item.expected);
  assert.throws(() => clarificationCandidate(clarificationCases[0].input, 'invented'));
});
test('comparison freezes synthetic requests, splits and conservative cost bounds without evaluating a model', () => {
  const plan = clarificationComparisonPlan();
  assert.equal(plan.liveCallsMade, 0); assert.equal(plan.proposedRequests, 36);
  assert.equal(plan.requests.filter(row => row.split === 'holdout').length, 12);
  assert.equal(plan.requests.filter(row => row.expected === 'candidate').length, 18);
  assert.deepEqual(plan.thresholdsUnchanged, { positive: 0.95, negative: 0.05 });
  assert.ok(plan.reservedUpperUsd > plan.acceptedUsageUpperEstimateUsd && plan.reservedUpperUsd < 0.05);
  assert.ok(plan.requests.every(row => row.bytes < 24000 && JSON.stringify(row.request).includes('jev-1.14.0')));
});
