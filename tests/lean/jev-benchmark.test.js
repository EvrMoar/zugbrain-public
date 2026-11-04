import test from 'node:test';
import assert from 'node:assert/strict';
import { benchmarkCases, benchmarkPlan } from '../../tools/lean/jev-benchmark.js';
test('large synthetic plan keeps conversation groups together and includes bounded multi-speaker collisions', () => {
  const cases = benchmarkCases(), groups = new Map(), ids = new Set();
  assert.equal(cases.length, 576); assert.equal(cases.filter(row => row.expected === 'candidate').length, 288);
  for (const row of cases) {
    assert.ok(!ids.has(row.id)); ids.add(row.id);
    assert.ok(!groups.has(row.conversationGroup) || groups.get(row.conversationGroup) === row.split); groups.set(row.conversationGroup, row.split);
  }
  assert.equal(groups.size, 32);
  const collisions = cases.filter(row => row.id.endsWith('-collision'));
  assert.equal(collisions.length, 64); assert.ok(collisions.every(row => row.input.recent.length === 3));
  const plan = benchmarkPlan(); assert.equal(plan.requests, 1152); assert.equal(plan.liveCallsMade, 0);
  assert.ok(plan.reservedUpperUsd < 1); assert.ok(plan.rows.every(row => row.bytes <= 3000));
  const request = plan.rows.find(row => row.id.endsWith('-collision')).request;
  assert.equal(new Set(request.state.messages.map(row => row.speaker)).size, 4);
  assert.ok(request.state.messages.every(row => !Object.hasOwn(row, 'authorId')));
  for (const row of cases.filter(row => row.expected === 'abstain' && ['competing', 'interleaved-competing'].includes(row.family))) {
    assert.ok(row.input.recent[0].content.startsWith('<@10>,'));
    assert.ok(!/\bmy main\b/i.test(row.input.target.content));
  }
});
test('benchmark bodies are unique within each variant and do not carry labels or split hints', () => {
  const plan = benchmarkPlan();
  for (const variant of ['five_control', 'two_candidate']) {
    const rows = plan.rows.filter(row => row.variant === variant);
    assert.equal(new Set(rows.map(row => JSON.stringify(row.request))).size, rows.length);
    for (const row of rows) { assert.equal(row.request.expected, undefined); assert.equal(row.request.split, undefined); }
  }
});
