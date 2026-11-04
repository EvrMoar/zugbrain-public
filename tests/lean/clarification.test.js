import test from 'node:test';
import assert from 'node:assert/strict';
import { configuration, message, setup } from './fixtures.js';
import { validateConfig } from '../../src/config.js';
const config = () => configuration({ answerMode: 'sourced', foreverdbApproved: true, clarificationTtlMs: 300000, replyCooldownMs: 1000 });
async function start(overrides = {}) {
  const s = setup(config(), overrides);
  assert.equal(await s.bot.onMessage(message({ content: '<@99> Which item is this?' })), 'replied');
  s.advance(130000); return s;
}
test('five-minute clarification accepts a bare kind-specific ID after normal context expiry, without Jev', async () => {
  const s = await start();
  assert.equal(await s.bot.onMessage(message({ id: '21', content: '19019', mentionIds: [], timestamp: Date.UTC(2026,10,3) + 130000 })), 'replied');
  assert.equal(s.calls.lookup, 1); assert.equal(s.calls.answer, 1); assert.equal(s.calls.decide, 0);
  s.advance(1100);
  assert.equal(await s.bot.onMessage(message({ id: '21', content: '19019', mentionIds: [], timestamp: Date.UTC(2026,10,3) + 130000 })), 'quiet');
  assert.equal(s.calls.answer, 1);
});
test('clarification never crosses asker/channel, expires, and is cleared by unrelated talk or deletion', async () => {
  for (const scenario of ['other-user', 'other-channel', 'expiry', 'topic', 'delete', 'stop']) {
    const s = await start(); let m = message({ id: '21', content: '19019', mentionIds: [], timestamp: Date.UTC(2026,10,3) + 130000 });
    if (scenario === 'other-user') m.authorId = '11';
    if (scenario === 'other-channel') m.channelId = '3';
    if (scenario === 'expiry') { s.advance(180001); m.timestamp += 180001; }
    if (scenario === 'topic') await s.bot.onMessage({ ...m, id: '22', content: 'Dinner time' });
    if (scenario === 'delete') s.bot.invalidate('2', '20');
    if (scenario === 'stop') s.bot.stop();
    assert.ok(['quiet','out_of_scope'].includes(await s.bot.onMessage(m)), scenario); assert.equal(s.calls.lookup, 0);
  }
});
test('used clarification snapshot edit cancels pending answer; duplicate event cannot launch another', async () => {
  let enter, release;
  const started = new Promise(resolve => { enter = resolve; });
  const s = await start({ answer: async (_input, signal) => { enter(); await new Promise(resolve => { release = resolve; }); signal.throwIfAborted(); return 'Fixture'; } });
  const m = message({ id: '21', content: '19019', mentionIds: [], timestamp: Date.UTC(2026,10,3) + 130000 });
  const pending = s.bot.onMessage(m); await started;
  assert.equal(await s.bot.onMessage(m), 'busy'); s.bot.invalidate('2', '20'); release();
  assert.equal(await pending, 'cancelled'); assert.equal(s.sent.length, 1); assert.equal(s.calls.lookup, 1);
});
test('expiry is configurable and absent means disabled; explicit requests still work', async () => {
  for (const ttl of [-1, 900001, 0.5]) assert.throws(() => validateConfig({ ...config(), clarificationTtlMs: ttl }));
  const s = setup({ ...config(), clarificationTtlMs: 0 });
  await s.bot.onMessage(message({ content: '<@99> Which item?' })); s.advance(1100);
  assert.equal(await s.bot.onMessage(message({ id: '21', content: '19019', mentionIds: [] })), 'quiet');
  assert.equal(await s.bot.onMessage(message({ id: '22', content: '<@99> item 19019' })), 'replied');
});
test('duplicate original does not erase expectation; busy unrelated talk does', async () => {
  const s = setup(config());
  await s.bot.onMessage(message({ content: '<@99> Which item is this?' })); s.advance(1100);
  assert.equal(await s.bot.onMessage(message({ content: '<@99> Which item is this?' })), 'duplicate_or_ledger_unavailable');
  assert.equal(await s.bot.onMessage(message({ id: '21', content: '19019', mentionIds: [], timestamp: Date.UTC(2026,10,3) + 1100 })), 'replied');
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const busy = await start({ answer: async () => { entered(); await new Promise(resolve => { release = resolve; }); return 'Fixture'; } });
  const other = busy.bot.onMessage(message({ id: '30', authorId: '11', content: '<@99> item 12', timestamp: Date.UTC(2026,10,3) + 130000 })); await started;
  assert.equal(await busy.bot.onMessage(message({ id: '31', content: 'Dinner now', mentionIds: [], timestamp: Date.UTC(2026,10,3) + 130001 })), 'busy');
  release(); await other; busy.advance(1100);
  assert.equal(await busy.bot.onMessage(message({ id: '32', content: '19019', mentionIds: [], timestamp: Date.UTC(2026,10,3) + 131100 })), 'quiet');
});
test('an old prompt finishing delivery cannot restore expectation after newer same-asker talk', async () => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const s = setup(config(), { transport: { fresh: async () => true, send: async m => {
    entered(); await new Promise(resolve => { release = resolve; });
    return message({ id: '101', authorId: '99', bot: true, content: 'Give an item ID', replyToId: m.id });
  } } });
  const first = s.bot.onMessage(message({ content: '<@99> Which item?' })); await started;
  assert.equal(await s.bot.onMessage(message({ id: '21', content: 'New topic', mentionIds: [] })), 'busy');
  release(); assert.equal(await first, 'replied'); s.advance(1100);
  assert.equal(await s.bot.onMessage(message({ id: '22', content: '19019', mentionIds: [] })), 'quiet');
});
test('duplicate or older event during prompt delivery does not suppress a valid expectation', async () => {
  for (const older of [false, true]) {
    let enter, release, sends = 0;
    const started = new Promise(resolve => { enter = resolve; });
    const s = setup(config(), { transport: { fresh: async () => true, send: async m => {
      if (++sends === 1) { enter(); await new Promise(resolve => { release = resolve; }); }
      return message({ id: String(100 + sends), authorId: '99', bot: true, content: 'Give an item ID', replyToId: m.id });
    } } });
    const origin = message({ content: '<@99> Which item?' });
    const first = s.bot.onMessage(origin); await started;
    assert.equal(await s.bot.onMessage(older ? message({ id: '19', content: 'Earlier talk', mentionIds: [], timestamp: origin.timestamp - 1 }) : { ...origin }), 'busy');
    release(); assert.equal(await first, 'replied'); s.advance(1100);
    assert.equal(await s.bot.onMessage(message({ id: '21', content: '19019', mentionIds: [], timestamp: origin.timestamp + 1100 })), 'replied');
  }
});
