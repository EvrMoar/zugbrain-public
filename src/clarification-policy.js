// Code-owned policy. No probability grants permissions; normal send guards remain mandatory.
export const CLARIFICATION_POLICY = Object.freeze({ version: 'two-question-v1', answerMin: 0.95, ambiguityMax: 0.10 });
export function clarificationQuestions() {
  return {
    answersQuestion: { type: 'noul', instructions: 'Does state.targetMessage.text supply the information requested by state.clarification.question?',
      criteria: { true: 'A compatible answer or requested value, including a short class name or yes/no.',
        false: 'Unrelated or incompatible content, a quotation, or a new question instead of the requested answer.' } },
    ambiguous: { type: 'noul', instructions: 'Does supplied context leave state.targetMessage unclear about which question or person it answers?',
      criteria: { true: 'Multiple plausible questions/addressees, or insufficient context to interpret the answer.',
        false: 'One supported question/addressee, with compatible answer content.' } },
  };
}
export function clarificationAllows(scores) {
  return ['answersQuestion', 'ambiguous'].every(key => Number.isFinite(scores?.[key]) && scores[key] >= 0 && scores[key] <= 1) &&
    scores.answersQuestion >= CLARIFICATION_POLICY.answerMin && scores.ambiguous <= CLARIFICATION_POLICY.ambiguityMax;
}
