import { BOUNDS } from './config.js';

export class Conversation {
  #channels = new Map();
  constructor({ now = Date.now } = {}) { this.now = now; }
  recent(channelId) {
    const rows = (this.#channels.get(channelId) || []).filter(m => this.now() - m.timestamp <= BOUNDS.ageMs && m.timestamp <= this.now() + 5000);
    this.#channels.set(channelId, rows);
    return rows;
  }
  observe(message) {
    if (typeof message.content !== 'string' || !Number.isFinite(message.timestamp) || message.content.length > BOUNDS.text) return false;
    const rows = this.recent(message.channelId).filter(m => m.id !== message.id);
    rows.push(Object.freeze({ ...message, mentionIds: [...(message.mentionIds || [])], roleMentionIds: [...(message.roleMentionIds || [])] }));
    rows.sort((a, b) => a.timestamp - b.timestamp);
    this.#channels.set(message.channelId, rows.slice(-BOUNDS.messages));
    return true;
  }
  remove(channelId, id) { this.#channels.set(channelId, this.recent(channelId).filter(m => m.id !== id)); }
  get(channelId, id) { return this.recent(channelId).find(m => m.id === id); }
  clear() { this.#channels.clear(); }
  sweep() { for (const channel of this.#channels.keys()) this.recent(channel); }
  recentExchange(target, botId) {
    const rows = this.recent(target.channelId);
    return rows.some(m => m.authorId === botId && rows.some(q => q.id === m.replyToId && q.authorId === target.authorId));
  }
  select(target, botId, selectedIds = [], continuation = false) {
    const rows = this.recent(target.channelId);
    const byId = new Map(rows.map(m => [m.id, m]));
    if (!Array.isArray(selectedIds) || selectedIds.length > BOUNDS.selected || new Set(selectedIds).size !== selectedIds.length ||
        selectedIds.some(id => !byId.has(id))) throw new Error('invalid_context_selection');
    const selected = new Set([target.id]);
    const addChain = row => {
      for (let n = 0; row?.replyToId && n < BOUNDS.replyDepth && selected.size < BOUNDS.selected; n++) {
        row = byId.get(row.replyToId); if (!row) break; selected.add(row.id);
      }
    };
    addChain(target);
    // Include only this user's most recent exchange with Zug, not adjacent chat.
    const prior = continuation && rows.findLast(m => m.authorId === botId && byId.get(m.replyToId)?.authorId === target.authorId);
    if (prior && selected.size < BOUNDS.selected) { selected.add(prior.id); addChain(prior); }
    for (const id of selectedIds) {
      if (selected.size >= BOUNDS.selected) break;
      selected.add(id); addChain(byId.get(id));
    }
    // Target and its ancestry take precedence over optional context.
    const chosen = rows.filter(m => selected.has(m.id));
    let remaining = BOUNDS.contextChars - target.content.length;
    return chosen.filter(m => { if (m.id === target.id) return true; if (m.content.length > remaining) return false; remaining -= m.content.length; return true; });
  }
}

export function isDirect(message, botId, botRoleIds = []) {
  return message.mentionIds.includes(botId) || message.replyAuthorId === botId || (message.roleMentionIds || []).some(id => botRoleIds.includes(id));
}
export function humanDirected(message, botId, botRoleIds = []) {
  return !isDirect(message, botId, botRoleIds) && ((message.replyAuthorId && message.replyAuthorId !== botId) ||
    (message.replyToId && !message.replyAuthorId) || message.mentionIds.some(id => id !== botId) || (message.roleMentionIds || []).length > 0);
}
export const withoutMentions = text => text.replace(/<@(?:!|&)?\d+>/g, '').trim();
export const isThanks = text => /^(?:thanks?|thank you|ty|cheers)[!.\s]*$/i.test(withoutMentions(text));
export function isCandidate(message, recentExchange) {
  return recentExchange || /[?？]|\b(?:zug|who|what|where|when|why|how|which|anyone|can someone)\b/i.test(message.content);
}

// Provider-visible IDs are per-request aliases, never Discord snowflakes.
export function providerText(text, speakers = new Map(), botRoleIds = []) {
  return text.replace(/<@!?(\d+)>/g, (_, id) => `@${speakers.get(id) || 'another_member'}`)
    .replace(/<@&(\d+)>/g, (_, id) => botRoleIds.includes(id) ? '@zug' : '@role')
    .replace(/<#\d+>/g, '#channel')
    .replace(/https?:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/channels\/[^\s<>]+/gi, '[Discord message reference]');
}
export function providerContext(rows, target, botId, botRoleIds = []) {
  let remaining = BOUNDS.contextChars - target.content.length;
  rows = rows.filter(m => m.id !== target.id).slice(-BOUNDS.messages + 1).reverse().filter(m => {
    if (m.content.length > remaining) return false; remaining -= m.content.length; return true;
  }).reverse();
  rows.push(target);
  rows.sort((a, b) => a.timestamp - b.timestamp);
  const aliases = new Map(rows.map((m, i) => [m.id, `m${i + 1}`]));
  const speakers = new Map([[botId, 'zug']]);
  const speaker = id => { if (!speakers.has(id)) speakers.set(id, `p${speakers.size}`); return speakers.get(id); };
  for (const row of rows) speaker(row.authorId);
  const messages = rows.map(row => ({ id: aliases.get(row.id), speaker: speaker(row.authorId),
    replyTo: aliases.get(row.replyToId) || null,
    missingReplyContext: Boolean(row.replyToId && !aliases.has(row.replyToId)),
    text: providerText(row.content, speakers, botRoleIds),
  }));
  return { state: { target: aliases.get(target.id), messages }, aliases };
}
