import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCalibrationRows, scoreCalibration, developmentGrid } from '../../tools/lean/jev-calibration.js';
const row = (id, expected, answer, ambiguity, changes = {}) => ({ id, conversationGroup: id, split: 'development', expected,
  error: false, scores: { answersQuestion: answer, ambiguous: ambiguity }, ...changes });
test('calibration counts false interruptions, missed answers and errors separately without using holdout for grid', () => {
  const rows = [row('hit', 'candidate', .99, .1), row('miss', 'candidate', .8, .1), row('interrupt', 'abstain', .99, .1),
    row('quiet', 'abstain', .2, .8), row('error', 'candidate', 0, 0, { error: true }),
    row('heldout', 'abstain', .99, .01, { split: 'test' })];
  const result = scoreCalibration(rows, { answerMin: .95, ambiguityMax: .2 }, 'development');
  assert.equal(result.truePositive, 1); assert.equal(result.falsePositive, 1); assert.equal(result.falseNegative, 2); assert.equal(result.errors, 1);
  assert.equal(result.precision, .5); assert.equal(result.recall, 1 / 3);
  assert.ok(developmentGrid(rows).every(item => item.metrics.split === 'development' && item.metrics.cases === 5));
  assert.equal(scoreCalibration(rows, { answerMin: .95, ambiguityMax: .2 }, 'test').falsePositive, 1);
});
test('split leakage, duplicate labels and malformed scores fail closed; zero errors is not certainty', () => {
  const one = row('a', 'abstain', .1, .9);
  assert.throws(() => validateCalibrationRows([one, { ...one }]));
  assert.throws(() => validateCalibrationRows([one, { ...one, id: 'b', split: 'test' }]), /split_leak/);
  assert.throws(() => validateCalibrationRows([{ ...one, scores: { answersQuestion: NaN, ambiguous: .2 } }]));
  const result = scoreCalibration([one], { answerMin: .95, ambiguityMax: .2 }, 'development');
  assert.ok(result.zeroFalsePositiveUpper95AssumingIndependent > .9);
});
