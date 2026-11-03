import { NewsDelivery } from './news.js';

const validTime = value => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
export function validateNewsSettings(news, config) {
  if (news === undefined) return;
  const fail = () => { throw new Error('invalid_news_configuration'); };
  if (!news || typeof news.enabled !== 'boolean' || !['channelId', 'timezone', 'morning', 'evening'].every(key => typeof news[key] === 'string')) fail();
  if (news.enabled) {
    if (config.answerMode !== 'chat' || config.runForMs !== 0 || config.stopAfterReply ||
        !config.discord.channelIds.includes(news.channelId) || !validTime(news.morning) || !validTime(news.evening) || news.morning === news.evening) fail();
    try { new Intl.DateTimeFormat('en', { timeZone: news.timezone }).format(); } catch { fail(); }
    if (!news.timezone) fail();
  }
}

export function scheduledWindow(news, now) {
  if (!news?.enabled) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: news.timezone, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(row => [row.type, row.value]));
  const time = parts.hour + ':' + parts.minute;
  const name = ['morning', 'evening'].find(name => news[name] === time);
  return name ? { id: parts.year + '-' + parts.month + '-' + parts.day + '-' + name, now } : null;
}

// A 30-second main-process tick; no cron, service, catch-up queue or default times.
export class NewsScheduler {
  #active; #stopped = false; #abort = new AbortController();
  constructor({ settings, store, produce, send, ready = () => true, now = Date.now }) {
    Object.assign(this, { settings, store, produce, ready, now });
    this.delivery = new NewsDelivery({ store, send, now });
  }
  async tick() {
    if (this.#stopped || !this.settings?.enabled) return 'news_disabled';
    if (this.#active) return 'news_busy';
    const work = async () => {
      try {
        const now = this.now();
        this.store.prune(now); // Runs even when no bulletin is due/new.
        const window = scheduledWindow(this.settings, now);
        if (!window || !this.ready()) return 'news_idle';
        if (!this.store.claimWindow(window.id, now)) return 'news_window_claimed';
        // Persist the attempt BEFORE paid research; failures/restarts do not retry.
        const bulletin = await this.produce(window, this.#abort.signal);
        this.#abort.signal.throwIfAborted();
        if (!bulletin) return 'news_no_items';
        return 'news_' + await this.delivery.deliver(bulletin, this.#abort.signal);
      } catch { return this.#abort.signal.aborted ? 'news_cancelled' : 'news_failed'; }
    };
    this.#active = work();
    try { return await this.#active; } finally { this.#active = undefined; }
  }
  async stop() { this.#stopped = true; this.#abort.abort(); await this.#active; }
}
