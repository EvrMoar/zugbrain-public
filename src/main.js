import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { openFileBudget } from './budget.js';
import { createAnswerer, createDecisionGate, createClarificationJudge } from './providers.js';
import { createForeverDb } from './evidence.js';
import { createWebAnswerer } from './web.js';
import { openNewsStore } from './news.js';
import { NewsScheduler } from './news-schedule.js';
import { createNewsProducer } from './news-producer.js';
import { readNamedKey } from './network.js';
import { createClient, wireClient, createNewsSender } from './discord.js';
import { Events } from 'discord.js';
import { openZugCharacter } from './zug-character.js';

export async function main(args) {
  if (args.length !== 2 || !['--check', '--live'].includes(args[0])) {
    console.error('Use --check CONFIG to validate, or --live CONFIG only for an approved deployment.');
    return 1;
  }
  let client, ledger, wired, startupTimer, runTimer, newsStore, scheduler, newsTimer, characterStore;
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true; clearTimeout(startupTimer); clearTimeout(runTimer); clearInterval(newsTimer); wired?.stop();
    await scheduler?.stop();
    try { await client?.destroy(); } catch { console.error('shutdown_failed'); process.exitCode = 1; }
    finally {
      try { newsStore?.close(); } catch { console.error('news_close_failed'); process.exitCode = 1; }
      try { characterStore?.close(); } catch { console.error('character_close_failed'); process.exitCode = 1; }
      try { ledger?.close(); } catch { console.error('ledger_close_failed'); process.exitCode = 1; }
    }
  };
  try {
    const config = loadConfig(args[1]);
    if (args[0] === '--check') { console.log('configuration_valid'); return 0; }
    if (!config.enabled) { console.error('live_mode_disabled'); return 1; }
    ledger = openFileBudget(config.stateDirectory, config.budgets);
    if (config.characterMemoryEnabled) characterStore = openZugCharacter(path.join(config.stateDirectory, 'character'));
    client = createClient();
    const onUsage = record => console.log(JSON.stringify(record)); // Sanitized counters only; no prompts, IDs, headers or raw errors.
    wired = wireClient(client, { config, budget: ledger.budget,
      character: characterStore?.card,
      answer: createAnswerer({ budget: ledger.budget, keyFile: config.credentials.openai, answerMode: config.answerMode, clarificationMode: config.clarificationMode || 'off', onUsage }),
      clarify: createClarificationJudge({ budget: ledger.budget, keyFile: config.credentials.jev, onUsage }),
      decide: createDecisionGate({ budget: ledger.budget, keyFile: config.credentials.jev, onUsage }),
      lookup: createForeverDb({ live: true, approved: config.foreverdbApproved, keyFile: config.credentials.foreverdb }),
      search: createWebAnswerer({ enabled: config.webSearchEnabled === true, budget: ledger.budget, keyFile: config.credentials.openai, onUsage }),
    }, { log(code) {
      if (code === 'discord_ready') clearTimeout(startupTimer);
      console.log(code);
      if (config.stopAfterReply && ['replied', 'dependency_failure', 'provider_timeout', 'budget_exhausted', 'reply_delivery_unknown', 'discord_event_failure', 'duplicate_or_ledger_unavailable', 'cancelled', 'stale'].includes(code)) void stop();
    },
      onFatal() { process.exitCode = 1; void stop(); } });
    if (config.news?.enabled) {
      newsStore = openNewsStore(path.join(config.stateDirectory, 'news'));
      scheduler = new NewsScheduler({ settings: config.news, store: newsStore, ready: () => wired.ready,
        produce: createNewsProducer({ budget: ledger.budget, keyFile: config.credentials.openai, onUsage }),
        send: createNewsSender(client, config, () => wired.ready),
      });
      const tick = async () => { const code = await scheduler.tick(); if (!['news_idle', 'news_window_claimed'].includes(code)) console.log(code); };
      client.once(Events.ClientReady, () => { if (!stopped) { newsTimer = setInterval(() => { void tick(); }, 30000); void tick(); } });
    }
    process.once('SIGINT', () => { void stop(); });
    process.once('SIGTERM', () => { void stop(); });
    startupTimer = setTimeout(() => { console.error('discord_startup_timeout'); process.exitCode = 1; void stop(); }, 30000);
    if (config.runForMs) runTimer = setTimeout(() => { console.log('session_expired'); void stop(); }, config.runForMs);
    const key = await readNamedKey(config.credentials.discord);
    if (stopped) return 1;
    await client.login(key);
    return stopped ? 1 : 0;
  } catch {
    await stop(); console.error('startup_failed'); return 1;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
