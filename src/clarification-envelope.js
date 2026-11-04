const expected = ['yes_no', 'class', 'number', 'entity', 'free_text'];
export const clarificationEnvelopeSchema = {
  type: 'object', additionalProperties: false, required: ['text', 'clarification'],
  properties: { text: { type: 'string' }, clarification: { anyOf: [{ type: 'null' }, {
    type: 'object', additionalProperties: false, required: ['question', 'expectedAnswer'],
    properties: { question: { type: 'string' }, expectedAnswer: { type: 'string', enum: expected } },
  }] } },
};
export function parseClarificationEnvelope(value) {
  const fail = () => { throw new Error('invalid_clarification_envelope'); };
  if (!value || Object.keys(value).sort().join(',') !== 'clarification,text' || typeof value.text !== 'string' ||
      !value.text.trim() || value.text.length > 1200) fail();
  const c = value.clarification;
  if (c !== null && (!c || Object.keys(c).sort().join(',') !== 'expectedAnswer,question' ||
      typeof c.question !== 'string' || !c.question.trim() || c.question.length > 300 || !c.question.endsWith('?') ||
      !expected.includes(c.expectedAnswer) || !value.text.trimEnd().endsWith(c.question) ||
      value.text.indexOf(c.question) !== value.text.lastIndexOf(c.question))) fail();
  return structuredClone(value);
}

