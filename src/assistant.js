import { Conversation, isCandidate, isDirect, humanDirected, isThanks, withoutMentions, providerContext } from './conversation.js';
import { BOUNDS } from './config.js';
import { lookupIntent, validForeverDbEvidence, FOREVERDB_CREDIT } from './evidence.js';
import { webQuery, targetsForever } from './web.js';
import { humanAllowed, inChannel } from './access.js';
import { randomInt } from 'node:crypto';
import { parseClarificationEnvelope } from './clarification-envelope.js';
import { evaluateRuntimeClarification } from './clarification-prototype.js';
import { characterQuery, parseCharacterAnswer } from './zug-character.js';

export const PEON_QUOTES = Object.freeze(['Work, work.', 'Ready to work.', 'More work?']);

const fixture = Object.freeze({ synthetic: true, name: 'Training Axe', requiredLevel: 5 });
const safeReply = text => text.replace(/@(?!\u200b)/g, '@\u200b').slice(0, 1700);
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
  #active; #replyAt = new Map(); #decisionAt = new Map(); #eggAt = new Map(); #clarifications = new Map(); #latest = new Map(); #versions = new WeakMap();
  constructor({ config, botId, budget, answer, decide, clarify, lookup, search, character, transport, now = Date.now }) {
    Object.assign(this, { config, botId, budget, answer, decide, clarify, lookup, search, character, transport, now });
    this.conversation = new Conversation({ now });
  }
  allowed(message) {
    return humanAllowed(this.config.discord, message, this.botId) ||
      (inChannel(this.config.discord, message) && !message.webhook && message.authorId === this.botId);
  }
  sweepClarifications() {
    for (const [key, row] of this.#clarifications) if (row.expires <= this.now() || row.created > this.now()) this.#clarifications.delete(key);
  }
  rememberClarification(message, reply, envelope = null) {
    const ttl = this.config.clarificationTtlMs || 0;
    if (!ttl || this.config.answerMode === 'synthetic' || !this.allowed(message) || !this.#versions.has(message) || this.#latest.get(message.channelId + ':' + message.authorId) !== this.#versions.get(message) || this.conversation.get(message.channelId, message.id)?.content !== message.content || !reply || reply.authorId !== this.botId ||
        reply.channelId !== message.channelId || reply.guildId !== message.guildId || reply.replyToId !== message.id ||
        typeof reply.content !== 'string' || reply.content.length > BOUNDS.text || message.content.length > BOUNDS.text) return;
    this.sweepClarifications();
    const key = message.channelId + ':' + message.authorId;
    if (!this.#clarifications.has(key) && this.#clarifications.size >= 16) return;
    const kinds = [...new Set([...message.content.matchAll(/\b(item|spell|quest|vendor|dungeon)\b/gi)].map(match => match[1].toLowerCase()))];
    this.#clarifications.set(key, { created: this.now(), expires: this.now() + ttl, kind: kinds.length === 1 ? kinds[0] : null,
      origin: structuredClone(message), prompt: structuredClone(reply), envelope });
  }
  invalidate(channelId, id) {
    for (const [key, row] of this.#clarifications) if (row.origin.channelId === channelId && [row.origin.id, row.prompt.id].includes(id)) this.#clarifications.delete(key);
    this.conversation.remove(channelId, id);
    if (this.#active?.channelId === channelId && this.#active.ids.has(id)) this.#active.controller.abort();
  }
  stop() { this.#active?.controller.abort(); this.conversation.clear(); this.#clarifications.clear(); this.#latest.clear(); }
  async onMessage(message) {
    if (!this.allowed(message)) return 'out_of_scope';
    const age = this.now() - message.timestamp;
    if (age < -5000 || age > BOUNDS.ageMs || !this.conversation.observe(message)) return 'invalid_message';
    if (message.authorId === this.botId) return 'own_message';
    const versionKey = message.channelId + ':' + message.authorId;
    const previous = this.#latest.get(versionKey);
    const duplicate = previous?.id === message.id;
    const version = duplicate ? previous : { id: message.id, timestamp: message.timestamp };
    if (!previous || !duplicate && message.timestamp >= previous.timestamp) {
      this.#latest.delete(versionKey); this.#latest.set(versionKey, version);
    }
    this.#versions.set(message, version);
    if (this.#latest.size > 64) this.#latest.delete(this.#latest.keys().next().value);
    const botRoleIds = this.config.discord.botRoleIds || [];
    // Exact whole body only: no trimming, punctuation or mention stripping.
    // Short-circuit address/decision routing for this local response.
    const egg = this.config.answerMode === 'chat' && message.content.toLowerCase() === 'zug zug';
    const explicit = isDirect(message, this.botId, botRoleIds);
    this.sweepClarifications();
    const pendingKey = message.channelId + ':' + message.authorId;
    const pending = this.#clarifications.get(pendingKey);
    const bareId = !pending?.envelope && pending?.kind && /^\d{1,9}$/.test(message.content.trim()) ? pending.kind + ' ' + message.content.trim() : null;
    const typedLookup = resolveLookup([message]);
    let followup = !egg && pending && message.timestamp >= pending.created && !humanDirected(message, this.botId, botRoleIds) &&
      (!message.replyToId || message.replyToId === pending.prompt.id) &&
      (!explicit || message.replyToId === pending.prompt.id) &&
      (message.replyToId === pending.prompt.id || bareId || typedLookup && (!pending.kind || typedLookup.kind === pending.kind) || Boolean(webQuery(message.content)));
    const semantic = !egg && !explicit && pending?.envelope && this.config.clarificationMode && this.config.clarificationMode !== 'off' &&
      message.timestamp >= pending.created && !humanDirected(message, this.botId, botRoleIds) && !isThanks(message.content);
    if (semantic) followup = false;
    if (pending && !followup && !semantic && !egg && message.id !== pending.origin.id && message.timestamp >= pending.created) this.#clarifications.delete(pendingKey);
    if (this.#active) return 'busy'; // Supersede state, but never queue work.
    const direct = egg || explicit || Boolean(followup) || Boolean(semantic);
    if (!egg && (humanDirected(message, this.botId, botRoleIds) || isThanks(message.content))) {
      if (isThanks(message.content)) this.#clarifications.delete(pendingKey);
      return 'quiet';
    }
    if (this.config.answerMode === 'synthetic' && (!direct || !/^connection test[.!]?$/i.test(withoutMentions(message.content)))) return 'synthetic_command_only';
    if (!direct && !egg && (this.config.participation === 'direct' || !isCandidate(message, this.conversation.recentExchange(message, this.botId)))) return 'quiet';
    if (egg && this.now() - (this.#eggAt.get(message.channelId) ?? -Infinity) < 60000) return 'reply_cooldown';
    if (this.now() - (this.#replyAt.get(message.channelId) ?? -Infinity) < this.config.replyCooldownMs) return 'reply_cooldown';
    if (!direct && this.now() - (this.#decisionAt.get(message.channelId) ?? -Infinity) < this.config.decisionCooldownMs) return 'decision_cooldown';
    if (!this.budget.admitEvent(message.channelId, message.id, this.now())) return 'duplicate_or_ledger_unavailable';
    if (followup) this.#clarifications.delete(pendingKey); // Consume once before any asynchronous work.
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]);
    this.#active = { controller, channelId: message.channelId, ids: new Set([message.id]) };
    let sending = false;
    try {
      if (semantic) {
        for (const row of [pending.origin, pending.prompt, ...this.conversation.recent(message.channelId)]) this.#active.ids.add(row.id);
        const current = () => this.#clarifications.get(pendingKey) === pending && pending.expires > this.now() &&
          this.#latest.get(versionKey) === version && !signal.aborted;
        const result = await evaluateRuntimeClarification({ config: this.config, botId: this.botId, origin: pending.origin, prompt: pending.prompt,
          envelope: pending.envelope, target: message, recent: this.conversation.recent(message.channelId), now: this.now(), ttlMs: this.config.clarificationTtlMs },
        { signal, stillCurrent: current, admit: current, judge: this.clarify, claim: () => {
          if (!current()) return false; this.#clarifications.delete(pendingKey); return true;
        } });
        if (this.#clarifications.get(pendingKey) === pending) this.#clarifications.delete(pendingKey); // One bounded attempt per question.
        if (this.config.clarificationMode === 'shadow') return result.route === 'answer_candidate' ? 'clarification_shadow_would_answer' : 'clarification_shadow_abstain';
        if (result.route !== 'answer_candidate') return 'clarification_abstain';
        followup = true;
      }
      let selectedIds = [], continuation = false;
      if (!direct && !egg) {
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
      const selected = this.conversation.select(message, this.botId, selectedIds, continuation);
      const context = followup ? [pending.origin, pending.prompt, ...selected.filter(row => ![pending.origin.id, pending.prompt.id].includes(row.id)).slice(-4)] : selected;
      const lookupMessage = followup && bareId ? { ...message, content: bareId } : message;
      for (const row of context) this.#active.ids.add(row.id);
      if (!egg && !followup && this.config.answerMode !== 'synthetic' && message.replyAuthorId === this.botId && !context.some(row => row.id === message.replyToId) &&
          !resolveLookup([message]) && webQuery(message.content) === null) return 'missing_reply_context';
      if (!egg) await this.transport.typing?.(message, signal);
      signal.throwIfAborted();
      let text;
      let asksClarification = false;
      let answerEnvelope = null;
      let characterTurn = null;
      const complete = async input => {
        const value = await this.answer(input, signal);
        if (!this.config.clarificationMode || this.config.clarificationMode === 'off') return value;
        const parsed = parseClarificationEnvelope(value);
        answerEnvelope = parseClarificationEnvelope({ text: safeReply(parsed.text), clarification: parsed.clarification && {
          ...parsed.clarification, question: safeReply(parsed.clarification.question) } });
        return answerEnvelope.text;
      };
      if (egg) {
        text = PEON_QUOTES[randomInt(PEON_QUOTES.length)] + (this.config.discord.peonEmoji ? ' ' + this.config.discord.peonEmoji : '');
      } else if (this.config.answerMode === 'synthetic') {
        text = 'Connection test — synthetic fixture, not real game data.\n' + safeReply(await this.answer({ question: 'What is the required level of Training Axe?', evidence: fixture }, signal));
      } else if (this.config.answerMode === 'chat') {
        const input = providerContext(context, message, this.botId, botRoleIds).state;
        const ownQuery = this.config.characterMemoryEnabled && this.character && webQuery(message.content) === null && characterQuery(message.content);
        const lookupRows = resolveLookup([lookupMessage]) ? [lookupMessage] : message.replyToId ? context.filter(row => row.authorId !== this.botId) : [];
        const query = this.config.foreverdbApproved && lookupRows.every(row => targetsForever(row.content)) && resolveLookup(lookupRows);
        const publicQuery = webQuery(message.content);
        if (ownQuery) {
          const card = this.character.read(ownQuery);
          const creationSlot = ownQuery.slot && !Object.hasOwn(card.facts, ownQuery.slot) ? ownQuery.slot : null;
          // No conversation history: another speaker cannot seed a newly invented fact.
          const result = parseCharacterAnswer(await this.answer({ question: withoutMentions(message.content), characterCard: card, creationSlot }, signal));
          if (result.proposedFacts.some(fact => fact.key !== creationSlot)) return 'invalid_character_proposal';
          text = safeReply(result.text);
          characterTurn = { revision: card.revision, query: ownQuery, proposals: result.proposedFacts };
        } else if (publicQuery !== null) {
          if (!publicQuery) text = 'Give me a short public game question after search. Leave out links, names, IDs for people, and credentials.';
          else if (!this.config.webSearchEnabled) text = 'Web search is not enabled yet.';
          else text = await this.search(publicQuery, signal); // Already bounded; never cut a citation URL.
        } else if (query) {
          const evidence = await this.lookup(query, signal);
          if (!validForeverDbEvidence(evidence, query)) return 'invalid_evidence';
          text = safeReply(await complete({ ...input, evidence })) + '\n' + FOREVERDB_CREDIT;
        } else {
          text = safeReply(await complete(input)) + '\n*No database lookup used; game details may be unverified.*';
        }
      } else {
        const lookupRows = resolveLookup([lookupMessage]) ? [lookupMessage] : context.filter(row => row.authorId !== this.botId);
        const query = lookupRows.every(row => targetsForever(row.content)) && resolveLookup(lookupRows);
        if (!this.config.foreverdbApproved) {
          if (!direct) return 'source_unavailable';
          text = 'My verified WoW Forever data source is not connected yet, so I cannot give sourced game answers.';
        } else if (!query) {
          if (!direct) return 'lookup_needed';
          text = 'For now, give me one item, spell, quest, vendor or dungeon ID (for example, item 19019). Broader game search is still pending.';
          asksClarification = true;
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
      if (egg) this.#eggAt.set(message.channelId, this.now());
      sending = true;
      const reply = await this.transport.send(message, text, signal);
      if (reply) this.conversation.observe(reply);
      if (characterTurn && !signal.aborted && reply?.confirmedContent === true && reply.content === text &&
          this.#latest.get(versionKey) === version && this.conversation.get(message.channelId, message.id)?.content === message.content)
        this.character.commit({ ...characterTurn, sentText: text });
      if (asksClarification && !signal.aborted) this.rememberClarification(message, reply);
      if (answerEnvelope?.clarification && !signal.aborted && reply?.confirmedContent === true && reply.content === text) this.rememberClarification(message, reply, answerEnvelope);
      return 'replied';
    } catch (error) {
      if (sending) return 'reply_delivery_unknown';
      if (signal.aborted) return controller.signal.aborted ? 'cancelled' : 'provider_timeout';
      return error?.code === 'budget_exhausted' ? 'budget_exhausted' : 'dependency_failure';
    }
    finally { this.#active = undefined; }
  }
}
