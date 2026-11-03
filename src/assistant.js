import { Conversation, isCandidate, isDirect, humanDirected, isThanks, withoutMentions, providerContext } from './conversation.js';
import { BOUNDS } from './config.js';
import { lookupIntent, validForeverDbEvidence, FOREVERDB_CREDIT } from './evidence.js';
import { webQuery, targetsForever } from './web.js';
import { humanAllowed, inChannel } from './access.js';

const fixture = Object.freeze({ synthetic: true, name: 'Training Axe', requiredLevel: 5 });
const safeReply = text => text.replace(/@/g, '@\u200b').slice(0, 1700);
export function resolveLookup(rows) {
  const intents = [];
  for (const row of rows) {
    // Reject ambiguity instead of silently using the first ID from a message.
    for (const match of row.content.matchAll(/\b(item|spell|quest|vendor|dungeon)\s+#?(\d{1,9})\b/gi)) {
      const intent = lookupIntent(match[0]);
      if (intent && !intents.some(i => i.kind === intent.kind && i.id === intent.id)) intents.push(intent);
    }
  }
  return intents.length === 1 ? intents[0] : null;
}

export class Assistant {
  #active; #replyAt = new Map(); #decisionAt = new Map();
  constructor({ config, botId, budget, answer, decide, lookup, search, transport, now = Date.now }) {
    Object.assign(this, { config, botId, budget, answer, decide, lookup, search, transport, now });
    this.conversation = new Conversation({ now });
  }
  allowed(message) {
    return humanAllowed(this.config.discord, message, this.botId) ||
      (inChannel(this.config.discord, message) && !message.webhook && message.authorId === this.botId);
  }
  invalidate(channelId, id) {
    this.conversation.remove(channelId, id);
    if (this.#active?.channelId === channelId && this.#active.ids.has(id)) this.#active.controller.abort();
  }
  stop() { this.#active?.controller.abort(); this.conversation.clear(); }
  async onMessage(message) {
    if (!this.allowed(message)) return 'out_of_scope';
    const age = this.now() - message.timestamp;
    if (age < -5000 || age > BOUNDS.ageMs || !this.conversation.observe(message)) return 'invalid_message';
    if (message.authorId === this.botId) return 'own_message';
    if (this.#active) return 'busy'; // Observe context, but never build a reply backlog.
    const botRoleIds = this.config.discord.botRoleIds || [];
    const direct = isDirect(message, this.botId, botRoleIds);
    if (humanDirected(message, this.botId, botRoleIds) || isThanks(message.content)) return 'quiet';
    if (this.config.answerMode === 'synthetic' && (!direct || !/^connection test[.!]?$/i.test(withoutMentions(message.content)))) return 'synthetic_command_only';
    if (!direct && (this.config.participation === 'direct' || !isCandidate(message, this.conversation.recentExchange(message, this.botId)))) return 'quiet';
    if (this.now() - (this.#replyAt.get(message.channelId) ?? -Infinity) < this.config.replyCooldownMs) return 'reply_cooldown';
    if (!direct && this.now() - (this.#decisionAt.get(message.channelId) ?? -Infinity) < this.config.decisionCooldownMs) return 'decision_cooldown';
    if (!this.budget.admitEvent(message.channelId, message.id, this.now())) return 'duplicate_or_ledger_unavailable';
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]);
    this.#active = { controller, channelId: message.channelId, ids: new Set([message.id]) };
    let sending = false;
    try {
      let selectedIds = [], continuation = false;
      if (!direct) {
        this.#decisionAt.set(message.channelId, this.now());
        const rows = this.conversation.recent(message.channelId);
        const { state, aliases } = providerContext(rows, message, this.botId, botRoleIds);
        for (const row of rows) this.#active.ids.add(row.id);
        const decision = await this.decide(state, signal);
        signal.throwIfAborted();
        const reverse = new Map([...aliases].map(([id, alias]) => [alias, id]));
        if (!decision || typeof decision.allow !== 'boolean' || typeof decision.continuation !== 'boolean' || !Array.isArray(decision.selectedIds) || decision.selectedIds.length > 5 ||
            new Set(decision.selectedIds).size !== decision.selectedIds.length || decision.selectedIds.some(id => !reverse.has(id))) return 'invalid_decision';
        if (this.config.participation === 'shadow') return decision.allow ? 'shadow_would_answer' : 'shadow_abstain';
        if (!decision.allow) return 'abstain';
        selectedIds = decision.selectedIds.map(id => reverse.get(id));
        continuation = decision.continuation;
      }
      const context = this.conversation.select(message, this.botId, selectedIds, continuation);
      for (const row of context) this.#active.ids.add(row.id);
      if (this.config.answerMode !== 'synthetic' && message.replyAuthorId === this.botId && !context.some(row => row.id === message.replyToId) &&
          !resolveLookup([message]) && webQuery(message.content) === null) return 'missing_reply_context';
      await this.transport.typing?.(message, signal);
      signal.throwIfAborted();
      let text;
      if (this.config.answerMode === 'synthetic') {
        text = 'Connection test — synthetic fixture, not real game data.\n' + safeReply(await this.answer({ question: 'What is the required level of Training Axe?', evidence: fixture }, signal));
      } else if (this.config.answerMode === 'chat') {
        const input = providerContext(context, message, this.botId, botRoleIds).state;
        const lookupRows = resolveLookup([message]) ? [message] : message.replyToId ? context.filter(row => row.authorId !== this.botId) : [];
        const query = this.config.foreverdbApproved && lookupRows.every(row => targetsForever(row.content)) && resolveLookup(lookupRows);
        const publicQuery = webQuery(message.content);
        if (publicQuery !== null) {
          if (!publicQuery) text = 'Give me a short public game question after search. Leave out links, names, IDs for people, and credentials.';
          else if (!this.config.webSearchEnabled) text = 'Web search is not enabled yet.';
          else text = await this.search(publicQuery, signal); // Already bounded; never cut a citation URL.
        } else if (query) {
          const evidence = await this.lookup(query, signal);
          if (!validForeverDbEvidence(evidence, query)) return 'invalid_evidence';
          text = safeReply(await this.answer({ ...input, evidence }, signal)) + '\n' + FOREVERDB_CREDIT;
        } else {
          text = safeReply(await this.answer(input, signal)) + '\n*No database lookup used; game details may be unverified.*';
        }
      } else {
        const lookupRows = resolveLookup([message]) ? [message] : context.filter(row => row.authorId !== this.botId);
        const query = lookupRows.every(row => targetsForever(row.content)) && resolveLookup(lookupRows);
        if (!this.config.foreverdbApproved) {
          if (!direct) return 'source_unavailable';
          text = 'My verified WoW Forever data source is not connected yet, so I cannot give sourced game answers.';
        } else if (!query) {
          if (!direct) return 'lookup_needed';
          text = 'For now, give me one item, spell, quest, vendor or dungeon ID (for example, item 19019). Broader game search is still pending.';
        } else {
          const evidence = await this.lookup(query, signal);
          if (!validForeverDbEvidence(evidence, query)) return 'invalid_evidence';
          const input = providerContext(context, message, this.botId, botRoleIds).state;
          text = safeReply(await this.answer({ ...input, evidence }, signal)) + '\n' + FOREVERDB_CREDIT;
        }
      }
      signal.throwIfAborted();
      if (!this.conversation.get(message.channelId, message.id) || this.now() - message.timestamp > BOUNDS.ageMs) return 'stale';
      if (!await this.transport.fresh(message, { direct, signal })) return 'stale';
      signal.throwIfAborted();
      // Charge cooldown before send. A timeout could mean Discord accepted it.
      this.#replyAt.set(message.channelId, this.now());
      sending = true;
      const reply = await this.transport.send(message, text, signal);
      if (reply) this.conversation.observe(reply);
      return 'replied';
    } catch (error) {
      if (sending) return 'reply_delivery_unknown';
      if (signal.aborted) return controller.signal.aborted ? 'cancelled' : 'provider_timeout';
      return error?.code === 'budget_exhausted' ? 'budget_exhausted' : 'dependency_failure';
    }
    finally { this.#active = undefined; }
  }
}
