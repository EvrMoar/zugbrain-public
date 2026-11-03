import test from 'node:test';
import assert from 'node:assert/strict';
import { Events, GatewayIntentBits, ChannelType, Partials } from 'discord.js';
import { createClient, createTransport, wireClient } from '../../src/discord.js';
import { Budget } from '../../src/budget.js';
import { validateConfig, loadConfig } from '../../src/config.js';
import { configuration, message, epoch } from './fixtures.js';
const current = m => ({ id: m.id, channel_id: m.channelId, author: { id: m.authorId, bot: false }, content: m.content, edited_timestamp: null });
const nativeMessage = m => ({ id: m.id, guildId: m.guildId, channelId: m.channelId, author: { id: m.authorId, bot: m.bot },
  content: m.content, createdTimestamp: m.timestamp, editedTimestamp: null, mentions: { users: new Map(m.mentionIds.map(id => [id, {}])) } });

test('genuine pinned client constructs with narrow intents, bounded REST and no login', async () => {
  const client = createClient();
  try {
    assert.equal(client.options.intents.bitfield, GatewayIntentBits.Guilds | GatewayIntentBits.GuildMessages | GatewayIntentBits.MessageContent);
    assert.equal(client.rest.options.retries, 0); assert.equal(client.rest.options.timeout, 5000);
    assert.ok(client.options.partials.includes(Partials.Message));
    assert.equal(client.isReady(), false); assert.equal(client.token, null);
  } finally { await client.destroy(); }
});
test('native client events reach synthetic answer and one guarded REST send through stubbed transport', async () => {
  const client = createClient(), config = configuration(); let calls = 0, sends = 0, typing = 0, finish;
  const outcome = new Promise(resolve => { finish = resolve; });
  client.user = { id: '99', bot: true }; client.application = { id: '100' };
  const input = message({ timestamp: Date.now() });
  client.rest.get = async route => route.endsWith('/20') ? current(input) : [];
  client.rest.post = async (route, { body }) => {
    if (route.endsWith('/typing')) { typing++; assert.equal(calls, 0); assert.equal(body, undefined); return; }
    sends++; assert.equal(body.message_reference.message_id, '20'); assert.equal(body.allowed_mentions.replied_user, false);
    assert.deepEqual(body.allowed_mentions.parse, []); assert.equal(body.enforce_nonce, true);
    return { id: '30', channel_id: '2', author: { id: '99' } };
  };
  const wired = wireClient(client, { config, budget: new Budget(config.budgets), answer: async () => { calls++; return 'level 5'; },
    decide: async () => assert.fail('direct must not classify'), lookup: async () => assert.fail('synthetic must not retrieve') },
  { log: code => { if (code === 'replied' || code === 'discord_event_failure') finish(code); } });
  try {
    client.emit(Events.ClientReady, client);
    client.emit(Events.MessageCreate, nativeMessage({ ...input, authorId: '12' }));
    client.emit(Events.MessageCreate, nativeMessage(input));
    assert.equal(await outcome, 'replied'); assert.equal(calls, 1); assert.equal(sends, 1); assert.equal(typing, 1);
  } finally { wired.stop(); await client.destroy(); }
});

test('typing feedback is scoped, throttled, cancellable and optional on Discord failure', async () => {
  const client = createClient(); client.user = { id: '99' };
  let calls = 0;
  client.rest.post = async route => { calls++; assert.equal(route, '/channels/2/typing'); throw Error('fake unavailable'); };
  const transport = createTransport(client, configuration()), signal = new AbortController().signal;
  try {
    await transport.typing(message({ channelId: '3' }), signal);
    await transport.typing(message({ authorId: '12' }), signal);
    await transport.typing(message({ webhook: true }), signal);
    await transport.typing(message(), AbortSignal.abort());
    assert.equal(calls, 0);
    await transport.typing(message(), signal);
    await transport.typing(message({ id: '21' }), signal);
    assert.equal(calls, 1); // Failure neither leaks nor causes another indicator/retry.
  } finally { await client.destroy(); }
});
test('fresh reads reject edits, overflow and relevant replies; direct questions survive unrelated chatter', async () => {
  const input = message(); const signal = new AbortController().signal;
  for (const scenario of ['edit', 'answer', 'overflow', 'ambient', 'unthreaded-answer']) {
    const client = createClient(); client.user = { id: '99' };
    client.rest.get = async route => {
      if (route.endsWith('/20')) return { ...current(input), content: scenario === 'edit' ? 'changed' : input.content };
      if (scenario === 'overflow') return Array(20).fill({ author: { bot: true } });
      return [{ author: { id: '11', bot: false }, message_reference: scenario === 'answer' ? { message_id: '20' } : undefined }];
    };
    try { assert.equal(await createTransport(client, configuration()).fresh(input, { signal, direct: scenario !== 'ambient' }), scenario === 'unthreaded-answer'); }
    finally { await client.destroy(); }
  }
});
test('wrong application identity cannot wire the assistant', async () => {
  const client = createClient(); client.user = { id: '99', bot: true }; client.application = { id: 'wrong' };
  let failed = false;
  const wired = wireClient(client, { config: configuration() }, { onFatal: () => { failed = true; } });
  try { client.emit(Events.ClientReady); assert.equal(failed, true); assert.equal(wired.assistant, undefined); }
  finally { wired.stop(); await client.destroy(); }
});
test('pinned client actions emit uncached partial deletes and provide uncached updates', async () => {
  const client = createClient(); client.user = { id: '99', bot: true };
  client.guilds._add({ id: '1', unavailable: true });
  const channel = client.channels._add({ id: '2', type: ChannelType.GuildText, guild_id: '1', name: 'synthetic', permission_overwrites: [] });
  let deleted;
  client.on(Events.MessageDelete, m => { deleted = m; });
  try {
    assert.equal(channel.messages.cache.size, 0);
    client.actions.MessageDelete.handle({ id: '20', channel_id: '2', guild_id: '1' });
    assert.equal(deleted.id, '20'); assert.equal(deleted.guildId, '1');
    const updated = client.actions.MessageUpdate.handle({ id: '21', channel_id: '2', guild_id: '1', content: 'changed' });
    assert.equal(updated.updated.id, '21'); assert.equal(updated.updated.guildId, '1');
    assert.equal(channel.messages.cache.size, 0);
  } finally { await client.destroy(); }
});
test('configuration is disabled by default, uses string IDs and resolves paths without reading keys', () => {
  const config = loadConfig(new URL('../../config/zugbrain.example.json', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
  assert.equal(config.enabled, false);
  assert.throws(() => validateConfig({ ...config, enabled: true }), /invalid_configuration/);
  const valid = configuration({ enabled: true }); assert.equal(validateConfig(valid).discord.applicationId, '100');
  assert.throws(() => validateConfig({ ...valid, discord: { ...valid.discord, applicationId: 100 } }), /invalid_configuration/);
  assert.throws(() => validateConfig({ ...valid, participation: 'assist' }), /invalid_configuration/);
  assert.throws(() => validateConfig({ ...valid, replyCooldownMs: 0 }), /invalid_configuration/);
});
