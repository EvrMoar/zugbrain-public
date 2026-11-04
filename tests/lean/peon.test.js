import test from 'node:test';
import assert from 'node:assert/strict';
import { Events } from 'discord.js';
import { createClient, wireClient } from '../../src/discord.js';
import { validateConfig } from '../../src/config.js';
import { PEON_QUOTES } from '../../src/assistant.js';
import { configuration, message, setup } from './fixtures.js';
const config = () => configuration({ answerMode: 'chat', runForMs: 0, stopAfterReply: false, replyCooldownMs: 1000 });
test('exact zug zug is a scoped local reply with no provider/typing calls and a channel cooldown', async () => {
  const s = setup(config(), { transport: { fresh: async () => true, send: async (_m, text) => { s.sent.push(text); }, typing: async () => assert.fail('no typing needed') },
    answer: async () => assert.fail('no model'), decide: async () => assert.fail('no Jev'), lookup: async () => assert.fail('no lookup') });
  assert.equal(await s.bot.onMessage(message({ content: 'ZUG zug', mentionIds: [] })), 'replied');
  assert.equal(s.sent.length, 1); assert.ok(PEON_QUOTES.includes(s.sent[0])); assert.equal(s.budget.status().openai, undefined);
  s.advance(1100); assert.equal(await s.bot.onMessage(message({ id: '21', content: 'zug zug', mentionIds: [] })), 'reply_cooldown');
  s.advance(30000); assert.equal(await s.bot.onMessage(message({ id: '23', content: 'zug zug', mentionIds: [], authorId: '11' })), 'reply_cooldown');
  s.advance(30000); assert.equal(await s.bot.onMessage(message({ id: '22', content: 'zUg ZuG', mentionIds: [] })), 'replied');
  assert.equal(await s.bot.onMessage(message({ id: '22', content: 'zUg ZuG', mentionIds: [] })), 'reply_cooldown');
  for (const row of [{ channelId: 'other' }, { guildId: 'other' }, { bot: true }, { webhook: true }]) {
    assert.equal(await setup(config()).bot.onMessage(message({ content: 'zug zug', mentionIds: [], ...row })), 'out_of_scope');
  }
  assert.equal(await setup(config()).bot.onMessage(message({ content: 'zug zug', authorId: '99', bot: true })), 'own_message');
  assert.equal(await setup(config()).bot.onMessage(message({ content: 'Mira, zug zug?', mentionIds: [] })), 'quiet');
});
test('near matches are not easter eggs; a mention follows only the ordinary answer path', async () => {
  for (const content of ['zug zug!', 'zug zug.', ' zug zug', 'zug zug ', 'zug zug\n', 'zug  zug', 'zug\tzug', 'say zug zug', '"zug zug"']) {
    const s = setup(config()); assert.equal(await s.bot.onMessage(message({ content, mentionIds: [] })), 'quiet'); assert.equal(s.calls.answer, 0);
  }
  const s = setup(config());
  assert.equal(await s.bot.onMessage(message({ content: '<@99> zug zug' })), 'replied');
  assert.equal(s.calls.answer, 1); assert.equal(s.calls.decide, 0); assert.equal(s.sent.length, 1);
  assert.ok(!s.sent[0].startsWith('Work, work.'));
});
test('optional peon emoji is validated and omitted when unavailable in the connected guild', async () => {
  const cfg = config(); cfg.discord.peonEmoji = '<:peon:123>';
  assert.doesNotThrow(() => validateConfig(cfg));
  assert.throws(() => validateConfig({ ...cfg, discord: { ...cfg.discord, peonEmoji: '@everyone' } }));
  const client = createClient(); client.user = { id: '99', bot: true }; client.application = { id: '100' };
  const guild = client.guilds._add({ id: '1', unavailable: true });
  guild.emojis = { cache: new Map([['123', { name: 'peon', animated: false, available: true }]]) };
  const wired = wireClient(client, { config: cfg });
  try { client.emit(Events.ClientReady); assert.equal(wired.assistant.config.discord.peonEmoji, '<:peon:123>'); }
  finally { wired.stop(); await client.destroy(); }
  const missing = createClient(); missing.user = { id: '99', bot: true }; missing.application = { id: '100' };
  const quiet = wireClient(missing, { config: cfg });
  try { missing.emit(Events.ClientReady); assert.equal(quiet.assistant.config.discord.peonEmoji, ''); }
  finally { quiet.stop(); await missing.destroy(); }
});
