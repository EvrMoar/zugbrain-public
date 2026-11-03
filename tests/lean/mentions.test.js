import test from 'node:test';
import assert from 'node:assert/strict';
import { Events, MessageMentions } from 'discord.js';
import { createClient, normalizeMessage, wireClient } from '../../src/discord.js';
import { isDirect, humanDirected, providerContext } from '../../src/conversation.js';
import { validateConfig } from '../../src/config.js';
import { configuration, message, setup } from './fixtures.js';

test('managed bot role is resolved by Discord identity, never by displayed role name', async () => {
  const client = createClient(); client.user = { id: '99', bot: true }; client.application = { id: '100' };
  const guild = client.guilds._add({ id: '1', unavailable: true });
  for (const [id, botId] of [['30', '99'], ['31', undefined], ['32', '88']]) {
    guild.roles._add({ id, name: 'Zug', managed: Boolean(botId), tags: botId ? { bot_id: botId } : {}, permissions: '0', position: 1, color: 0, hoist: false, mentionable: true });
  }
  const config = configuration(); config.discord.acceptManagedBotRoleMention = true;
  const wired = wireClient(client, { config }, { onFatal: () => assert.fail('identity should match') });
  try {
    client.emit(Events.ClientReady);
    assert.deepEqual(wired.assistant.config.discord.botRoleIds, ['30']);
    const nativeMentions = new MessageMentions({ client, guild, content: '<@&30> hello' }, [], ['30'], false);
    const normalized = normalizeMessage({ id: '20', guildId: '1', channelId: '2', author: { id: '10', bot: false },
      content: '<@&30> hello', createdTimestamp: Date.now(), mentions: nativeMentions });
    assert.deepEqual(normalized.mentionIds, []); assert.deepEqual(normalized.roleMentionIds, ['30']);
    assert.equal(isDirect(normalized, '99', ['30']), true);
    assert.equal(isDirect({ ...normalized, roleMentionIds: ['31'] }, '99', ['30']), false);
    assert.equal(humanDirected({ ...normalized, roleMentionIds: ['32'] }, '99', ['30']), true);
    const state = providerContext([normalized], normalized, '99', ['30']).state;
    assert.equal(state.messages[0].text, '@zug hello');
  } finally { wired.stop(); await client.destroy(); }
});

test('configured bot-role mention reaches chat; unrelated roles and literal text do not', async () => {
  const config = configuration({ answerMode: 'chat', runForMs: 0, stopAfterReply: false });
  config.discord.botRoleIds = ['30'];
  const s = setup(config);
  assert.equal(await s.bot.onMessage(message({ content: '<@&30> hello', mentionIds: [], roleMentionIds: ['30'] })), 'replied');
  assert.equal(s.calls.answer, 1); assert.equal(s.calls.decide, 0);
  for (const row of [message({ content: '<@&31> hello', mentionIds: [], roleMentionIds: ['31'] }),
    message({ content: '<@&30> hello', mentionIds: [], roleMentionIds: [] }), message({ content: '@Zug hello', mentionIds: [] })]) {
    const quiet = setup(config); assert.equal(await quiet.bot.onMessage(row), 'quiet'); assert.equal(quiet.calls.answer, 0);
  }
  assert.throws(() => validateConfig({ ...config, discord: { ...config.discord, botRoleIds: ['30', '30'] } }), /invalid_configuration/);
});
