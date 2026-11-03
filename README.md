# Zugbrain

Zug is a small Discord guild assistant for World of Warcraft Forever, using a dedicated Node process with pinned discord.js dependencies.

## Status

Direct mentions and replies support persistent OpenAI chat, bounded reply context, concise orc-inspired wording, explicit guild/channel/sender scope, shared budgets and stale-message checks. Source-free game details are labelled unverified. Optional explicit public web search returns linked sources. Ambient Jev decisions and scheduled public news are implemented but disabled in the examples and need deployment-specific validation.

ForeverDB numeric item/spell/quest/vendor/dungeon lookup is provisional: approved access and real response-schema verification are required before enabling it. Natural-language database search and interactive Discord controls are not implemented. Fake tests do not prove live authentication, provider quality or delivery.

## Install and verify offline

Use Node 24.22.1, the project's previously documented tested runtime; package.json records the minimum requirement. Install official locked dependencies with lifecycle scripts disabled:

    npm ci --ignore-scripts --no-audit --no-fund
    npm test
    npm run check
    npm run demo
    node src/main.js --check config/chat.example.json

Tests use fake providers and isolated temporary state, with no real credentials or live connections. Some durable-filesystem checks require Linux.

## Configure and run

Create a dedicated Discord application/bot. Enable Message Content intent and grant only View Channel, Send Messages and Read Message History in the intended guild/channel. Administrator permission is unnecessary.

Copy config/chat.example.json to ignored config/local.json. Set the exact application, guild, channel and allowed human user IDs. The example uses a sender allowlist. Optional channel-members policy admits any human in the configured channels with the same shared budget.

Save your own Discord token and OpenAI API key in protected local files and configure their named paths. Paths resolve relative to the config. Never commit real config or credentials. Example budgets are illustrative; set your own caps and review provider-side billing and data terms. Set enabled to true only when ready for live requests:

    node src/main.js --live config/local.json

Mention the actual bot or reply to its message. Literal typed @text is not a Discord mention. Optional managed-bot-role mentions use trusted role identity. discord_ready indicates readiness. SIGTERM/SIGINT shuts down the process. npm start without explicit arguments refuses startup. This copy includes no deployment automation.

The synthetic example is a bounded connection test; enabling it still uses live providers. Optional web search requires webSearchEnabled and an explicit bot-addressed search command. ForeverDB requires approved access, a named key, verified schema and foreverdbApproved. News requires explicit channel, timezone and times. Leave optional features off until configured and verified.

## Privacy and limits

DMs, out-of-scope messages, bots and webhooks cannot request answers. Relevant context is memory-only, bounded to 12 messages, 120 seconds and 1,200 characters each, with periodic expiry and clearing on shutdown/reconnect. Providers receive temporary speaker aliases and bounded selected text. Limited Discord fetches verify reply authors and freshness. Explicit web queries go to OpenAI without conversation history; basic input checks cannot recognize every private detail. Give channel members clear notice of what is read and sent to providers.

Logs contain fixed outcomes and sanitized counters. The ledger records cost estimates, counts and bounded hashed message IDs, not transcripts; older IDs are pruned on subsequent admissions. Optional generated news is retained separately for seven days. Provider retention is separate. Plaintext credential files need operating-system protection; ignore rules are not encryption. Never delete a live ledger or lock to bypass limits. Reservations are conservative estimates, not invoices; uncertain failures retain charges.

## Credits and licensing

Game-data credit: [ForeverDB](https://foreverdb.net). Database-backed answers append linked ForeverDB credit in code; search/news using ForeverDB retain credit too. No dataset or API access entitlement is bundled. Review the service's access/data terms before use.

See THIRD_PARTY_NOTICES.md for locked dependency licenses and retained texts. This project is available under the [MIT License](LICENSE). Dependency and third-party data terms remain separate.
