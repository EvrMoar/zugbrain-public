// Pure offline scoring for manually labelled conversation groups. No model/network access.
const validPolicies = policy => Number.isFinite(policy?.answerMin) && policy.answerMin >= 0 && policy.answerMin <= 1 &&
  Number.isFinite(policy?.ambiguityMax) && policy.ambiguityMax >= 0 && policy.ambiguityMax <= 1;
export function validateCalibrationRows(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 10000) throw new Error('invalid_calibration_rows');
  const ids = new Set(), groups = new Map();
  for (const row of rows) {
    if (typeof row.id !== 'string' || !/^[a-z0-9_-]{1,80}$/i.test(row.id) || ids.has(row.id) ||
        typeof row.conversationGroup !== 'string' || !/^[a-z0-9_-]{1,80}$/i.test(row.conversationGroup) ||
        !['development', 'validation', 'test'].includes(row.split) || !['candidate', 'abstain'].includes(row.expected) ||
        typeof row.error !== 'boolean') throw new Error('invalid_calibration_rows');
    if (groups.has(row.conversationGroup) && groups.get(row.conversationGroup) !== row.split) throw new Error('conversation_split_leak');
    groups.set(row.conversationGroup, row.split); ids.add(row.id);
    if (!row.error && ['answersQuestion', 'ambiguous'].some(key => !Number.isFinite(row.scores?.[key]) || row.scores[key] < 0 || row.scores[key] > 1))
      throw new Error('invalid_calibration_scores');
  }
  return rows;
}
export function scoreCalibration(rows, policy, split) {
  validateCalibrationRows(rows);
  if (!validPolicies(policy) || !['development', 'validation', 'test'].includes(split)) throw new Error('invalid_calibration_policy');
  let truePositive = 0, falsePositive = 0, falseNegative = 0, trueNegative = 0, errors = 0;
  const chosen = rows.filter(row => row.split === split);
  for (const row of chosen) {
    const accept = !row.error && row.scores.answersQuestion >= policy.answerMin && row.scores.ambiguous <= policy.ambiguityMax;
    if (row.error) errors++;
    if (row.expected === 'candidate') { if (accept) truePositive++; else falseNegative++; }
    else if (accept) falsePositive++; else trueNegative++;
  }
  const negatives = falsePositive + trueNegative, positives = truePositive + falseNegative;
  return { split, cases: chosen.length, groups: new Set(chosen.map(row => row.conversationGroup)).size,
    truePositive, falsePositive, falseNegative, trueNegative, errors,
    precision: truePositive + falsePositive ? truePositive / (truePositive + falsePositive) : null,
    recall: positives ? truePositive / positives : null,
    falsePositiveRate: negatives ? falsePositive / negatives : null,
    // Exact one-sided 95% zero-event binomial bound; independence is NOT established by this tool.
    zeroFalsePositiveUpper95AssumingIndependent: negatives && !falsePositive ? 1 - Math.pow(0.05, 1 / negatives) : null };
}
export function developmentGrid(rows) {
  validateCalibrationRows(rows);
  return [0.7, 0.8, 0.9, 0.95].flatMap(answerMin => [0.05, 0.10, 0.15, 0.20, 0.30].map(ambiguityMax => ({
    policy: { answerMin, ambiguityMax }, metrics: scoreCalibration(rows, { answerMin, ambiguityMax }, 'development'),
  })));
}
