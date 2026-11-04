import test from 'node:test';
import assert from 'node:assert/strict';
import { parseClarificationEnvelope, prepareClarificationPrototype, evaluateClarificationPrototype } from '../../src/clarification-prototype.js';
import { configuration, message, epoch } from './fixtures.js';
import { JEV_MODEL } from '../../src/providers.js';
function fixture(answer = 'warrior', question = 'Which class do you play?', expectedAnswer = 'class') {
  const origin = message({ content: '<@99> Help with my class', timestamp: epoch });
  const prompt = message({ id: '101', authorId: '99', bot: true, content: question, timestamp: epoch + 1000, replyToId: origin.id });
  return { config: configuration(), botId: '99', origin, prompt, envelope: { text: question, clarification: { question, expectedAnswer } },
    target: message({ id: '21', content: answer, mentionIds: [], timestamp: epoch + 180000 }), recent: [], now: epoch + 180000 };
}
const good = request => ({ model: JEV_MODEL, answers: Object.fromEntries(Object.keys(request.questions).map(key => [key,
  { type: 'noul', noul: ['answersQuestion', 'sameConversation'].includes(key) ? 0.99 : 0.01 }])) });
test('clarification metadata must name a real final question; ordinary text/null does not open a scope', () => {
  assert.equal(parseClarificationEnvelope({ text: 'Warrior guide.', clarification: null }).clarification, null);
  for (const value of [{ text: 'Answer.', clarification: { question: 'Which class?', expectedAnswer: 'class' } },
    { text: 'Which class?', clarification: { question: 'Which class?', expectedAnswer: 'invented' } }]) assert.throws(() => parseClarificationEnvelope(value));
  const input = fixture(); input.envelope = { text: input.prompt.content, clarification: null };
  assert.equal(prepareClarificationPrototype(input).route, 'ignore');
});
test('short warrior and yes can answer their specific prompt without leaking identity or crossing scope', async () => {
  for (const input of [fixture(), fixture('yes', 'Do you want a written guide?', 'yes_no')]) {
    let claimed = false;
    const result = await evaluateClarificationPrototype(input, { stillCurrent: () => true, admit: cost => cost > 0, claim: () => !claimed && (claimed = true), judge: async request => {
      assert.equal(request.model, JEV_MODEL); assert.ok(request.state.messages.length <= 6);
      assert.ok(request.state.messages.some(row => row.speaker === 'zug')); return good(request);
    } });
    assert.equal(result.route, 'answer_candidate');
    for (const change of [{ authorId: '11' }, { channelId: '3' }, { guildId: 'other' }, { bot: true }, { webhook: true }, { replyToId: 'someone', replyAuthorId: '11' }]) {
      assert.equal(prepareClarificationPrototype({ ...input, target: { ...input.target, ...change } }).route, 'ignore');
    }
  }
});
test('cross-talk ambiguity, malformed decisions, timeouts and low confidence abstain; direct replies bypass judge', async () => {
  const input = fixture('yes', 'Do you want a written guide?', 'yes_no');
  input.recent = [message({ id: '30', authorId: '11', content: 'Dinner now?', mentionIds: [], timestamp: epoch + 179000 })];
  for (const key of ['ambiguous', 'directedElsewhere', 'newTopic', 'sameConversation', 'answersQuestion']) {
    const result = await evaluateClarificationPrototype(input, { stillCurrent: () => true, admit: () => true, claim: () => assert.fail('no claim'), judge: async request => {
      const value = good(request); value.answers[key].noul = ['sameConversation', 'answersQuestion'].includes(key) ? 0.5 : 0.99; return value;
    } }); assert.equal(result.route, 'abstain');
  }
  assert.equal((await evaluateClarificationPrototype(input, { judge: async () => { throw Error('fake timeout'); }, stillCurrent: () => true, admit: () => true, claim: () => false })).route, 'abstain');
  assert.equal((await evaluateClarificationPrototype(input, { judge: async () => ({}), stillCurrent: () => true, admit: () => true, claim: () => false })).route, 'abstain');
  const direct = { ...input, target: { ...input.target, replyToId: input.prompt.id, replyAuthorId: '99' } };
  assert.equal((await evaluateClarificationPrototype(direct, { judge: () => assert.fail('no Jev') })).route, 'direct');
  assert.equal(prepareClarificationPrototype({ ...input, now: epoch + 400000 }).route, 'ignore');
});
test('stale revision after edit or concurrent claim prevents two answer candidates', async () => {
  const input = fixture(); let current = true, claimed = false;
  const result = await evaluateClarificationPrototype(input, { stillCurrent: () => current, admit: () => true, claim: () => assert.fail('edited'), judge: async request => { current = false; return good(request); } });
  assert.equal(result.route, 'stale');
  let admitted = false, calls = 0;
  const opts = { stillCurrent: () => true, admit: () => !admitted && (admitted = true), judge: async request => { calls++; return good(request); }, claim: () => !claimed && (claimed = true) };
  const results = await Promise.all([evaluateClarificationPrototype(input, opts), evaluateClarificationPrototype(input, opts)]);
  assert.deepEqual(results.map(row => row.route).sort(), ['answer_candidate', 'not_admitted']); assert.equal(calls, 1);
});
