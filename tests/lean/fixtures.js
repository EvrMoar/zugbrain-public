import { readFileSync } from 'node:fs';
import { Budget } from '../../src/budget.js';
import { Assistant } from '../../src/assistant.js';
export const epoch = Date.UTC(2026, 10, 3);
export function configuration(overrides = {}) {
  return { ...JSON.parse(readFileSync(new URL('../../config/zugbrain.example.json', import.meta.url))),
    discord: { applicationId: '100', guildId: '1', channelIds: ['2'], userIds: ['10', '11'] },
    ...overrides };
}
export function message(overrides = {}) {
  return { id: '20', guildId: '1', channelId: '2', authorId: '10', bot: false, webhook: false,
    content: '<@99> connection test', timestamp: epoch, edited: null, mentionIds: ['99'], replyToId: null, replyAuthorId: null, ...overrides };
}
export function setup(config = configuration(), overrides = {}) {
  let time = epoch;
  const calls = { answer: 0, decide: 0, lookup: 0, send: 0 };
  const sent = [];
  const budget = new Budget(config.budgets, { now: () => time });
  const bot = new Assistant({ config, botId: '99', budget, now: () => time,
    answer: async () => { calls.answer++; return 'Training Axe requires level 5.'; },
    decide: async state => { calls.decide++; return { allow: true, selectedIds: [], continuation: state.messages.some(m => m.speaker === 'zug') }; },
    lookup: async query => { calls.lookup++; return { source: `https://foreverdb.net/api/v1/items/${query.id}`, attribution: 'ForeverDB', data: { id: query.id, name: 'Fixture item' }, meta: { synthetic: true } }; },
    transport: { fresh: async () => true, send: async (target, text) => {
      calls.send++; sent.push(text); return message({ id: String(100 + calls.send), authorId: '99', bot: true, content: text, timestamp: time, replyToId: target.id, replyAuthorId: target.authorId });
    } }, ...overrides });
  return { bot, calls, sent, budget, advance(ms) { time += ms; } };
}
export const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
