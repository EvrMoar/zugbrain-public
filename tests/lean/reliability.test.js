import test from 'node:test';
import assert from 'node:assert/strict';
import { Events, ChannelType } from 'discord.js';
import { createClient, wireClient } from '../../src/discord.js';
import { providerContext } from '../../src/conversation.js';
import { Budget } from '../../src/budget.js';
import { ProviderError } from '../../src/network.js';
import { configuration, message, setup, epoch } from './fixtures.js';

function harness(answer) {
  const config = configuration({ answerMode: 'chat', runForMs: 0, stopAfterReply: false, replyCooldownMs: 1000 });
  const client = createClient(); client.user = { id: '99', bot: true }; client.application = { id: '100' };
  client.guilds._add({ id: '1', unavailable: true });
  client.channels._add({ id: '2', guild_id: '1', type: ChannelType.GuildText, name: 'fixture', permission_overwrites: [] });
  const records = new Map(), posts = [], events = [], waiters = []; let fatal = 0;
  client.rest.get = async route => records.get(route.split('/').at(-1)) || [];
  client.rest.post = async (route, { body }) => {
    if (route.endsWith('/typing')) return;
    posts.push(body); const row = { id: String(100 + posts.length), channel_id: '2', author: { id: '99', bot: true }, content: body.content };
    records.set(row.id, row); return row;
  };
  const wired = wireClient(client, { config, answer, budget: new Budget(config.budgets) }, { onFatal() { fatal++; }, log(code) {
    events.push(code); for (const waiter of [...waiters]) if (waiter.code === code) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(); }
  } });
  client.emit(Events.ClientReady);
  return { client, wired, posts, events, get fatal() { return fatal; },
    wait(code) { return new Promise(resolve => waiters.push({ code, resolve })); },
    emit(id = '20', extra = {}) {
      const row = { id, guildId: '1', channelId: '2', author: { id: '10', bot: false }, content: '<@99> Explain this fixture',
        createdTimestamp: Date.now(), editedTimestamp: null, mentions: { users: new Map([['99', {}]]) }, ...extra };
      records.set(id, { id, channel_id: '2', author: row.author, content: row.content, edited_timestamp: null });
      client.emit(Events.MessageCreate, row);
    }, async close() { wired.stop(); await client.destroy(); },
  };
}

test('native embed-only updates keep pending answers; actual edits cancel them', async () => {
  for (const edit of [false, true]) {
    let entered, release;
    const started = new Promise(resolve => { entered = resolve; });
    const h = harness(async (_input, signal) => { entered(); await new Promise(resolve => { release = resolve; }); signal.throwIfAborted(); return 'Fixture answer'; });
    try {
      const done = h.wait(edit ? 'cancelled' : 'replied'); h.emit(); await started;
      const update = h.client.actions.MessageUpdate.handle({ id: '20', channel_id: '2', guild_id: '1', embeds: [],
        ...(edit ? { content: 'Changed question', edited_timestamp: new Date().toISOString() } : {}) });
      h.client.emit(Events.MessageUpdate, update.old, update.updated);
      release(); await done; assert.equal(h.posts.length, edit ? 0 : 1);
    } finally { await h.close(); }
  }
});

test('recoverable reconnect aborts work and pauses intake until resume; fatal disconnect stays fatal', async () => {
  let entered, release, calls = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const h = harness(async (_input, signal) => { if (++calls === 1) { entered(); await new Promise(resolve => { release = resolve; }); } signal.throwIfAborted(); return 'Fixture'; });
  try {
    const cancelled = h.wait('cancelled'); h.emit(); await started;
    h.client.emit(Events.ShardReconnecting, 0); h.emit('21'); release(); await cancelled;
    assert.equal(calls, 1); assert.equal(h.posts.length, 0); assert.equal(h.wired.assistant.conversation.recent('2').length, 0);
    h.client.emit(Events.ShardResume, 0); const replied = h.wait('replied'); h.emit('22'); await replied;
    assert.equal(calls, 2); assert.equal(h.posts.length, 1);
    h.client.emit(Events.ShardDisconnect, {}, 0); assert.equal(h.fatal, 1);
  } finally { await h.close(); }
});

test('an edited ancestor still cancels its active request after buffer eviction', async () => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const h = harness(async (input, signal) => {
    assert.ok(JSON.stringify(input).includes('Earlier fixture question'));
    entered(); await new Promise(resolve => { release = resolve; }); signal.throwIfAborted(); return 'Fixture';
  });
  try {
    h.wired.assistant.conversation.observe(message({ id: '19', content: 'Earlier fixture question', timestamp: Date.now() - 1000 }));
    const cancelled = h.wait('cancelled');
    h.emit('20', { reference: { messageId: '19', channelId: '2' } }); await started;
    for (let i = 0; i < 12; i++) h.wired.assistant.conversation.observe(message({ id: String(30 + i), timestamp: Date.now() }));
    assert.equal(h.wired.assistant.conversation.get('2', '19'), undefined);
    const update = h.client.actions.MessageUpdate.handle({ id: '19', channel_id: '2', guild_id: '1', content: 'Changed ancestor', edited_timestamp: new Date().toISOString() });
    h.client.emit(Events.MessageUpdate, update.old, update.updated);
    release(); await cancelled; assert.equal(h.posts.length, 0);
  } finally { await h.close(); }
});

test('direct provider/budget failures get a fixed throttled notice, never raw exception details', async () => {
  const h = harness(async () => { throw new ProviderError('budget_exhausted'); });
  try {
    const sent = h.wait('notice_sent'); h.emit(); await sent;
    assert.equal(h.posts.length, 1); assert.ok(h.posts[0].content.includes('Usage limit reached'));
    assert.deepEqual(h.posts[0].allowed_mentions.parse, []);
    const failed = h.wait('budget_exhausted'); h.emit('21'); await failed;
    await new Promise(resolve => setImmediate(resolve)); assert.equal(h.posts.length, 1);
  } finally { await h.close(); }
});

test('explicit source reply ancestry is re-queried; expired context is not guessed', async () => {
  const s = setup(configuration({ answerMode: 'chat', foreverdbApproved: true, replyCooldownMs: 1000 }));
  assert.equal(await s.bot.onMessage(message({ content: '<@99> item 19019?' })), 'replied');
  s.advance(1100);
  assert.equal(await s.bot.onMessage(message({ id: '21', content: 'Where does it drop?', mentionIds: [], replyToId: '101', replyAuthorId: '99', timestamp: epoch + 1100 })), 'replied');
  assert.equal(s.calls.lookup, 2); assert.ok(s.sent[1].endsWith('Data: [ForeverDB](https://foreverdb.net)'));
  s.advance(120001);
  assert.equal(await s.bot.onMessage(message({ id: '22', content: 'What about its level?', mentionIds: [], replyToId: '102', replyAuthorId: '99', timestamp: epoch + 121101 })), 'missing_reply_context');
  assert.equal(s.calls.answer, 2);
});

test('structured Discord references are hidden without destroying numeric game IDs', () => {
  const target = message({ content: '<@99> item 19019 in <#111111111111111111> https://discord.com/channels/222222222222222222/111111111111111111/333333333333333333', replyToId: 'old' });
  const state = providerContext([target], target, '99').state;
  assert.equal(state.messages[0].missingReplyContext, true);
  assert.ok(state.messages[0].text.includes('item 19019'));
  assert.ok(!/111111111111111111|222222222222222222|333333333333333333/.test(JSON.stringify(state)));
});
