import test from 'node:test';
import assert from 'node:assert/strict';
import { Events, ChannelType, MessageMentions } from 'discord.js';
import { validateConfig } from '../../src/config.js';
import { humanAllowed } from '../../src/access.js';
import { createClient, createTransport, wireClient } from '../../src/discord.js';
import { Budget } from '../../src/budget.js';
import { configuration, message, setup, json } from './fixtures.js';
import { createAnswerer, OPENAI_MODEL } from '../../src/providers.js';
const members = () => {
  const config = configuration({ answerMode: 'chat', runForMs: 0, stopAfterReply: false });
  config.discord.userPolicy = 'channel-members'; config.discord.userIds = []; config.discord.botRoleIds = ['30'];
  return config;
};

test('channel-member access is explicit; absent/unknown policy never opens the allowlist', () => {
  const config = members(); config.enabled = true;
  assert.doesNotThrow(() => validateConfig(config));
  assert.deepEqual(validateConfig(config).discord.channelIds, ['2']);
  assert.equal(humanAllowed(config.discord, message({ authorId: '12' }), '99'), true);
  for (const policy of ['allowlist', undefined]) {
    const old = { ...config.discord, userPolicy: policy, userIds: ['10'] };
    assert.equal(humanAllowed(old, message({ authorId: '12' }), '99'), false);
    assert.equal(humanAllowed(old, message(), '99'), true);
    assert.throws(() => validateConfig({ ...config, discord: { ...old, userIds: [] } }), /invalid_configuration/);
  }
  assert.throws(() => validateConfig({ ...config, discord: { ...config.discord, userPolicy: 'everyone-everywhere' } }), /invalid_configuration/);
  assert.throws(() => validateConfig({ ...config, discord: { ...config.discord, channelIds: [] } }), /invalid_configuration/);
});

test('non-owner direct, reply and configured-role paths work; other channels/guilds/bots and ambient stay quiet', async () => {
  const cases = [
    [{ authorId: '12', content: '<@99> hello' }, 'replied'],
    [{ authorId: '12', content: 'item 19019?', mentionIds: [], replyToId: '19', replyAuthorId: '99' }, 'replied'],
    [{ authorId: '12', content: '<@&30> hello', mentionIds: [], roleMentionIds: ['30'] }, 'replied'],
    [{ authorId: '12', content: '<@&31> hello', mentionIds: [], roleMentionIds: ['31'] }, 'quiet'],
    [{ authorId: '12', content: 'Room question?', mentionIds: [] }, 'quiet'],
    [{ authorId: '12', channelId: '3' }, 'out_of_scope'],
    [{ authorId: '12', guildId: 'other' }, 'out_of_scope'],
    [{ authorId: '88', bot: true }, 'out_of_scope'],
    [{ authorId: '12', webhook: true }, 'out_of_scope'],
    [{ authorId: '99', bot: true }, 'own_message'],
  ];
  for (const [input, expected] of cases) {
    const s = setup(members()); assert.equal(await s.bot.onMessage(message(input)), expected);
    assert.equal(s.calls.answer, expected === 'replied' ? 1 : 0); assert.equal(s.calls.decide, 0);
  }
});

test('non-owner typing/fresh/send share channel-member scope; bot/self/webhook and cross-channel sends are refused', async () => {
  const client = createClient(); client.user = { id: '99', bot: true };
  const transport = createTransport(client, members()), input = message({ authorId: '12' }), signal = new AbortController().signal;
  let calls = 0;
  client.rest.get = async route => { calls++; return route.endsWith('/20') ? { id: '20', channel_id: '2', author: { id: '12', bot: false }, content: input.content } : []; };
  client.rest.post = async (route, { body }) => { calls++; return route.endsWith('/typing') ? undefined : { id: '42', channel_id: '2', author: { id: '99' }, content: body.content }; };
  try {
    await transport.typing(input, signal); assert.equal(await transport.fresh(input, { direct: true, signal }), true);
    assert.equal((await transport.send(input, 'Fixture reply', signal)).id, '42'); assert.equal(calls, 4);
    for (const change of [{ channelId: '3' }, { guildId: 'other' }, { bot: true }, { webhook: true }, { authorId: '99' }]) {
      const bad = { ...input, ...change };
      await transport.typing(bad, signal); assert.equal(await transport.fresh(bad, { direct: true, signal }), false);
      await assert.rejects(transport.send(bad, 'No', signal), /send_refused/);
    }
    assert.equal(calls, 4);
  } finally { await client.destroy(); }
});

test('channel members share the existing provider budget instead of gaining a separate allowance', async () => {
  const config = members(); config.budgets.openai = { dailyUsd: 1, monthlyUsd: 10, maxRequestsPerDay: 1 };
  const budget = new Budget(config.budgets); let calls = 0;
  const answer = createAnswerer({ answerMode: 'chat', budget, keyReader: async () => 'FAKE-ONLY', fetchImpl: async () => {
    calls++; return json({ model: OPENAI_MODEL, status: 'completed', service_tier: 'default', usage: { input_tokens: 100, output_tokens: 10 },
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixture answer' }] }] });
  } });
  const s = setup(config, { budget, answer });
  assert.equal(await s.bot.onMessage(message({ authorId: '12', content: '<@99> hello' })), 'replied');
  s.advance(config.replyCooldownMs + 1);
  assert.equal(await s.bot.onMessage(message({ id: '21', authorId: '13', content: '<@99> hello' })), 'budget_exhausted');
  assert.equal(calls, 1); assert.equal(budget.status().openai.count, 1);
});

test('native intake sends a non-owner bot-role request through the actual guarded reply path only in the configured channel', async () => {
  const client = createClient(), config = members(); let answers = 0, sends = 0, finish;
  const done = new Promise(resolve => { finish = resolve; });
  client.user = { id: '99', bot: true }; client.application = { id: '100' };
  const guild = client.guilds._add({ id: '1', unavailable: true });
  client.channels._add({ id: '2', guild_id: '1', type: ChannelType.GuildText, name: 'fixture', permission_overwrites: [] });
  guild.roles._add({ id: '30', name: 'Zug', managed: true, tags: { bot_id: '99' }, permissions: '0', position: 1, color: 0, hoist: false, mentionable: true });
  const content = '<@&30> hello';
  const native = { id: '20', guildId: '1', channelId: '2', author: { id: '12', bot: false }, content, createdTimestamp: Date.now(), editedTimestamp: null,
    mentions: new MessageMentions({ client, guild, content }, [], ['30'], false) };
  client.rest.get = async route => route.endsWith('/20') ? { id: '20', channel_id: '2', author: native.author, content } : [];
  client.rest.post = async (route, { body }) => {
    if (route.endsWith('/typing')) return;
    sends++; assert.deepEqual(body.allowed_mentions.parse, []); return { id: '42', channel_id: '2', author: { id: '99' }, content: body.content };
  };
  const wired = wireClient(client, { config, budget: new Budget(config.budgets), answer: async () => { answers++; return 'Hello'; } },
    { log: code => { if (code === 'replied' || code === 'discord_event_failure') finish(code); } });
  try {
    client.emit(Events.ClientReady);
    for (const change of [{ channelId: '3' }, { guildId: 'other' }, { author: { id: '88', bot: true } }, { webhookId: 'webhook' }]) client.emit(Events.MessageCreate, { ...native, ...change });
    client.emit(Events.MessageCreate, { ...native, id: '19', author: { id: '99', bot: true } });
    client.emit(Events.MessageCreate, native);
    assert.equal(await done, 'replied'); assert.equal(answers, 1); assert.equal(sends, 1);
  } finally { wired.stop(); await client.destroy(); }
});
