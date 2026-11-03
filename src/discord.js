import { Client, Events, GatewayIntentBits, Options, Partials, Routes } from 'discord.js';
import { Assistant } from './assistant.js';
import { BOUNDS } from './config.js';
import { isDirect } from './conversation.js';
import { createHash } from 'node:crypto';
import { humanAllowed, inChannel } from './access.js';

export function createNewsSender(client, config, ready) {
  return async (text, bulletinId, signal) => {
    const channelId = config.news?.channelId;
    if (!config.news?.enabled || !config.discord.channelIds.includes(channelId) || !ready() ||
        client.application?.id !== config.discord.applicationId || !client.user?.bot ||
        client.channels.cache.get(channelId)?.guildId !== config.discord.guildId || typeof text !== 'string' || text.length > 1900 ||
        !/^\d{4}-\d{2}-\d{2}-(morning|evening)$/.test(bulletinId)) throw new Error('news_send_refused');
    signal?.throwIfAborted();
    const nonce = BigInt('0x' + createHash('sha256').update(bulletinId).digest('hex').slice(0, 16)).toString();
    const sent = await client.rest.post(Routes.channelMessages(channelId), {
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
      body: { content: text, allowed_mentions: { parse: [], replied_user: false }, nonce, enforce_nonce: true },
    });
    if (sent?.channel_id !== channelId || sent.author?.id !== client.user.id || !/^\d{1,20}$/.test(sent.id)) throw new Error('news_send_unknown');
    return { id: sent.id };
  };
}

export function createClient() {
  return new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Message], // Uncached edits/deletes must still invalidate context.
    makeCache: Options.cacheWithLimits({ ...Options.DefaultMakeCacheSettings, MessageManager: 0 }),
    allowedMentions: { parse: [], repliedUser: false },
    rest: { retries: 0, timeout: 5000, rejectOnRateLimit: () => true },
  });
}
export function normalizeMessage(message, replyAuthorId) {
  return { id: message.id, guildId: message.guildId, channelId: message.channelId,
    authorId: message.author.id, bot: message.author.bot, webhook: Boolean(message.webhookId),
    content: message.content, timestamp: message.createdTimestamp, edited: message.editedTimestamp || null,
    mentionIds: [...message.mentions.users.keys()], roleMentionIds: [...(message.mentions.roles?.keys() || [])], replyToId: message.reference?.messageId || null,
    replyAuthorId: replyAuthorId || message.mentions.repliedUser?.id || null };
}
export function createTransport(client, config) {
  const permitted = message => humanAllowed(config.discord, message, client.user?.id);
  const typingAt = new Map();
  return {
    async typing(message, signal) {
      if (!permitted(message) || message.bot || message.webhook || !client.user || signal.aborted) return;
      const now = Date.now();
      if (now - (typingAt.get(message.channelId) ?? -Infinity) < 8000) return;
      typingAt.set(message.channelId, now); // One short indicator; no renewal timer or retry.
      try {
        await client.rest.post(Routes.channelTyping(message.channelId), {
          signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]),
        });
      } catch { /* Optional feedback must not prevent an answer or expose raw errors. */ }
    },
    async fresh(message, { direct, signal }) {
      if (!permitted(message)) return false;
      signal.throwIfAborted();
      const current = await client.rest.get(Routes.channelMessage(message.channelId, message.id), { signal });
      if (current.id !== message.id || current.channel_id !== message.channelId || current.author?.id !== message.authorId ||
          current.author.bot || current.webhook_id || current.content !== message.content ||
          (current.edited_timestamp ? Date.parse(current.edited_timestamp) : null) !== message.edited) return false;
      const after = await client.rest.get(Routes.channelMessages(message.channelId), { query: new URLSearchParams({ after: message.id, limit: '20' }), signal });
      if (!Array.isArray(after) || after.length >= 20) return false;
      // Ambient interruptions stop for any newer human activity. Explicit
      // requests survive unrelated chat; a new asker message or human reply to
      // this target supersedes them. No extra semantic call is added here.
      return !after.some(m => !m.author?.bot && !m.webhook_id &&
        (!direct || m.author?.id === message.authorId || m.message_reference?.message_id === message.id));
    },
    async send(message, text, signal) {
      if (!permitted(message) || !client.user || typeof text !== 'string' || text.length > 2000) throw new Error('send_refused');
      signal.throwIfAborted();
      const sent = await client.rest.post(Routes.channelMessages(message.channelId), { signal, body: {
        content: text, allowed_mentions: { parse: [], replied_user: false },
        message_reference: { message_id: message.id, fail_if_not_exists: true },
        nonce: message.id, enforce_nonce: true,
      } });
      if (sent?.channel_id !== message.channelId || sent.author?.id !== client.user.id || typeof sent.id !== 'string') throw new Error('send_result_unknown');
      return { id: sent.id, guildId: message.guildId, channelId: message.channelId, authorId: client.user.id,
        bot: true, webhook: false, content: text.slice(0, BOUNDS.text), timestamp: Date.now(), edited: null,
        mentionIds: [], replyToId: message.id, replyAuthorId: message.authorId };
    },
  };
}

// Binding handlers does not connect. Only main's explicit --live branch logs in.
export function wireClient(client, dependencies, { log = () => {}, onFatal = () => {} } = {}) {
  const { config } = dependencies;
  let assistant;
  let receiving = false;
  let stopped = false;
  let connected = false;
  let connectionAbort = new AbortController();
  let transport;
  const noticeAt = new Map();
  const notices = Object.freeze({ busy: 'Zug is still thinking. Try again in a moment.',
    budget_exhausted: 'Usage limit reached. Zug cannot make another lookup right now.',
    dependency_failure: 'Lookup failed. Zug cannot verify that right now. Try again later.',
    provider_timeout: 'Lookup took too long. Try again later.',
    invalid_evidence: 'Source returned no usable record. Zug cannot verify that right now.',
    missing_reply_context: 'That earlier talk is gone from memory. Repeat the item, name or full question.' });
  const inScope = message => inChannel(config.discord, message);
  client.once(Events.ClientReady, () => {
    if (stopped) return;
    if (client.application?.id !== config.discord.applicationId || !client.user?.bot) {
      log('identity_mismatch'); onFatal(); return;
    }
    const guildRoles = client.guilds.cache.get(config.discord.guildId)?.roles.cache;
    const botRoleIds = new Set((config.discord.botRoleIds || []).filter(id => guildRoles?.has(id)));
    if (config.discord.acceptManagedBotRoleMention === true && guildRoles) {
      for (const role of guildRoles.values()) if (role.tags?.botId === client.user.id) botRoleIds.add(role.id);
    }
    const runtimeConfig = { ...config, discord: { ...config.discord, botRoleIds: [...botRoleIds] } };
    transport = createTransport(client, config);
    assistant = new Assistant({ ...dependencies, config: runtimeConfig, botId: client.user.id, transport });
    connected = true;
    log('discord_ready');
  });
  client.on(Events.MessageCreate, async message => {
    if (stopped || !connected || !assistant || !inScope(message) || message.webhookId || !message.author) return;
    if (message.author.id !== client.user.id && !humanAllowed(config.discord, { guildId: message.guildId, channelId: message.channelId,
      authorId: message.author.id, bot: message.author.bot, webhook: Boolean(message.webhookId) }, client.user.id)) return;
    try {
      let replyAuthor;
      // No historical scroll: at most the one explicit same-channel reference,
      // and only for an allowed sender. Do not fetch references during a burst.
      if (!receiving && message.author.id !== client.user.id && message.reference?.messageId && message.reference.channelId === message.channelId) {
        receiving = true;
        try {
          const ref = await client.rest.get(Routes.channelMessage(message.channelId, message.reference.messageId));
          if (ref.channel_id === message.channelId && ref.id === message.reference.messageId && !ref.webhook_id) replyAuthor = ref.author?.id;
        } finally { receiving = false; }
      }
      if (stopped || !connected) return;
      const normalized = normalizeMessage(message, replyAuthor);
      const outcome = await assistant.onMessage(normalized);
      log(outcome); // Fixed application codes only; never message/error text.
      if (!stopped && connected && notices[outcome] && isDirect(normalized, client.user.id, assistant.config.discord.botRoleIds)) {
        const now = Date.now();
        if (now - (noticeAt.get(message.channelId) ?? -Infinity) >= 30000) {
          noticeAt.set(message.channelId, now);
          const signal = AbortSignal.any([connectionAbort.signal, AbortSignal.timeout(2500)]);
          try {
            if (await transport.fresh(normalized, { direct: true, signal }) && connected && !stopped) {
              const reply = await transport.send(normalized, notices[outcome], signal);
              if (reply) assistant.conversation.observe(reply);
              log('notice_sent');
            }
          } catch { log('notice_unavailable'); }
        }
      }
    } catch { log('discord_event_failure'); }
  });
  const invalidate = message => { if (assistant && inScope(message)) assistant.invalidate(message.channelId, message.id); };
  client.on(Events.MessageUpdate, (_old, message) => {
    const stored = assistant?.conversation.get(message.channelId, message.id);
    // An active request can still use a row that aged out or was evicted.
    // Without retained text, conservatively invalidate only matching active IDs.
    if (!stored || (typeof message.content === 'string' && message.content !== stored.content) ||
        (message.editedTimestamp != null && message.editedTimestamp !== stored.edited)) invalidate(message);
  });
  client.on(Events.MessageDelete, invalidate);
  client.on(Events.MessageBulkDelete, messages => { for (const message of messages.values()) invalidate(message); });
  client.on(Events.Error, () => { log('discord_client_error'); onFatal(); });
  client.on(Events.ShardError, () => { log('discord_connection_error'); onFatal(); });
  client.on(Events.ShardDisconnect, () => {
    if (stopped) return;
    connected = false;
    connectionAbort.abort();
    assistant?.stop(); // Cancel work whose context may now miss edits/replies.
    log('discord_disconnected');
    onFatal(); // Pinned discord.js uses this event for unrecoverable closes.
  });
  client.on(Events.ShardReconnecting, () => {
    if (stopped) return;
    connected = false; connectionAbort.abort(); assistant?.stop(); log('discord_reconnecting');
    if (config.stopAfterReply) onFatal();
  });
  const resumed = () => { if (!stopped && assistant) { connectionAbort = new AbortController(); connected = true; log('discord_resumed'); } };
  client.on(Events.ShardResume, resumed);
  client.on(Events.ShardReady, resumed);
  const sweep = setInterval(() => assistant?.conversation.sweep(), 30000);
  sweep.unref();
  return { stop() { stopped = true; connected = false; connectionAbort.abort(); assistant?.stop(); clearInterval(sweep); }, get assistant() { return assistant; }, get ready() { return connected && !stopped; } };
}
