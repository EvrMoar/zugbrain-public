# Zugbrain

**Meet Zug: a Discord companion for your World of Warcraft Forever guild.** Ask a question, talk through a build, or request a web search without leaving the channel. Zug answers in a short, plain orc-inspired voice, with room for the details when a question needs them.

WoW advice often mixes editions, old guides and uncertain claims. Zug is instructed to treat Forever as the default and respect requests about other editions. Ordinary chat appends an unverified-data notice; enable explicit web search when you want linked sources.

- **Help where your guild already talks.** Mention Zug or reply to its message. Direct chat stays running between questions.
- **Keep the conversation connected.** Recent, bounded reply context helps with follow-up questions.
- **Check the source.** Optional `search` requests return clickable citations. Zug is instructed to distinguish Forever evidence from Classic or Vanilla background.
- **Set your own scope and limits.** Choose the guild, channels and people Zug can answer, with daily/monthly estimated spend limits and request caps.

## Try a conversation

Mention the actual Discord bot; `@Zug` below represents that mention.

> **You:** @Zug What should I think about when choosing a leveling build?
>
> **Zug - illustrative reply:** Think about survival, downtime and how you like to fight. What class?
>
> *No database lookup used; game details may be unverified.*
>
> **You, replying to Zug:** Warrior. Mostly solo.

With web search enabled, ask:

> @Zug search What current written guides cover solo warrior leveling in WoW Forever?

Search uses the public query and returns a cited answer when valid sources are available. Ordinary chat does not search automatically. Examples illustrate usage; they are not recorded live results.

## Requirements

- **Node.js 24.17.0 or newer** and npm, as required by `package.json`.
- A Discord application/bot and permission to add it to your server.
- Your own Discord bot token and an OpenAI API key with access to the configured `gpt-6.1-sol` model. Live chat and search incur provider costs.
- A host that can keep one Node process running, with writable local storage for its budget ledger.

Basic direct chat needs no Jev or ForeverDB credentials.

## Install

```sh
git clone https://github.com/EvrMoar/zugbrain-public.git
cd zugbrain-public
npm ci --ignore-scripts --no-audit --no-fund
```

Installation downloads the locked dependencies. Then run the offline checks:

```sh
npm test
npm run check
npm run demo
node src/main.js --check config/chat.example.json
```

Tests and demo use fake providers and isolated temporary state; configuration checks do not read credentials. These checks make no live provider or Discord connections. Some durable-filesystem checks require Linux. On Windows PowerShell, use `npm.cmd` if script execution policy blocks `npm`.

## Connect your bot

1. Create a bot in the [Discord Developer Portal](https://discord.com/developers/applications). Enable **Message Content Intent**. Invite it with **View Channel**, **Send Messages** and **Read Message History** in the intended channels; it does not need Administrator.
2. Copy `config/chat.example.json` to `config/local.json`, which Git ignores. Inside its `discord` object, fill in `applicationId`, `guildId`, `channelIds` and `userIds`. Discord Developer Mode lets you copy IDs. The default policy allows only the listed human users; `discord.userPolicy: "channel-members"` allows humans in the configured channels.
3. Create the local credential files named by `credentials.discord` and `credentials.openai`, each containing its corresponding token/key. Example paths use `_private/secrets/`, which Git ignores. Protect those files with operating-system permissions. Credential and state paths resolve relative to the configuration file.
4. Set your own `budgets.openai` daily/monthly USD caps and request limit. Leave optional features off for your first run. Tell channel members what conversation text is read and sent to providers.
5. Set `enabled` to `true`, validate, then start:

```sh
node src/main.js --check config/local.json
node src/main.js --live config/local.json
```

Wait for `discord_ready`, then mention the bot or reply to it. Typing plain `@Zug` without selecting the Discord mention does not address it. Stop with Ctrl+C or SIGTERM. Keep the process running for ongoing chat; `npm start` without explicit arguments refuses startup.

## Optional features and current limits

| Feature | What to expect |
|---|---|
| Explicit web search | Set `webSearchEnabled: true` in chat mode, then mention/reply to Zug with `search <public game question>`. Sources are restricted to Blizzard, ForeverDB, Warcraft Wiki, Wowhead and Icy Veins domains. |
| ForeverDB lookup | Provisional numeric item/spell/quest/vendor/dungeon adapter. Requires approved API access, a named credential, real response-schema verification and `foreverdbApproved: true`. Leave disabled until verified. Name-based database search is not implemented. |
| Clarification follow-ups | `clarificationTtlMs` allows scoped continuations of code-generated prompts; set to `0` to disable. Optional `clarificationMode` adds a TypeSafe Jev judgment for an unmentioned same-person answer to Zug's model-written question: `"shadow"` evaluates without replying automatically; `"assist"` may answer accepted follow-ups. Both require `credentials.jev` and configured `budgets.jev`. Model clarification is off in the example; validate before enabling. |
| Jev room participation | In sourced mode, `participation: "shadow"` evaluates candidates without automatic replies; `"assist"` may answer accepted candidates. Both require TypeSafe Jev credentials, `budgets.jev` and deployment-specific validation. Chat mode requires `participation: "direct"`. |
| Zug's fictional memory | `characterMemoryEnabled: true` can retain up to four bounded fictional facts about Zug, such as his favorite food. Disabled by default; persistent storage requires Linux. It does not provide member profiles or personal memory. |
| Scheduled news | Optional public-source bulletins require Linux, explicit enablement, an allowed channel, timezone and morning/evening times. Disabled in the examples; validate before use. |

Direct chat normally answers mentions and replies. Scoped clarification can accept a follow-up without another mention; exact `zug zug` also gets a local orc reply without a model call. The synthetic configuration is a limited connection test using invented game data; running it live still calls paid providers. Interactive buttons and menus are not implemented. Offline tests do not establish live authentication, answer quality or delivery.

## Privacy and operation

Zug ignores DMs and requests from bots, webhooks or outside the configured scope. Relevant conversation is held in memory: at most 12 messages per channel, 1,200 characters each, expiring after 120 seconds with periodic cleanup. At most six selected messages/6,000 characters reach the answer context, using temporary speaker aliases. Limited Discord fetches verify replies and freshness. Shutdown/reconnect clears conversation memory.

When clarification TTL is nonzero, each pending clarification can retain two request/prompt snapshots beyond that normal window, up to 1,200 characters per snapshot. There are at most 16 pending clarifications, with a five-minute TTL in the template (15 minutes maximum) and periodic expiry. A follow-up attempt consumes its expectation; relevant edits/deletes and shutdown/reconnect also clear it. Topic changes are not guaranteed to be detected. Selected follow-up text can go to providers. This scoped retention also applies to code-generated prompts while model clarification is off.

Explicit search sends the query to OpenAI without recent chat history. Keep queries public; input checks cannot detect every private detail. Provider retention is separate from Zug's local memory policy.

Logs contain fixed outcomes and sanitized counters. The persistent ledger holds cost estimates, request counts and bounded hashed message IDs, not transcripts. Optional generated news files are stored separately and pruned after seven days only while the scheduler runs; files can remain longer while it is stopped. Budget reservations are conservative estimates, not invoices; uncertain failures retain reservations. Never delete a live ledger or lock to bypass limits.

Keep real configuration, credentials and runtime state out of Git. Ignore rules are not encryption. The runtime exposes no shell or administrative tools. See [SECURITY.md](SECURITY.md).

## Credits and license

Game-data credit: **[ForeverDB](https://foreverdb.net)**. Database-backed answers append linked ForeverDB attribution in code; search and news using ForeverDB retain credit too. No dataset or API access entitlement is bundled; review the service's access and data terms before use.

Zugbrain is available under the [MIT License](LICENSE). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for dependency licenses. Third-party data terms remain separate.
