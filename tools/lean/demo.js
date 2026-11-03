import { configuration, message, setup } from '../../tests/lean/fixtures.js';
// Isolated synthetic providers and memory-only budget. No credential reads/login.
const direct = setup();
const outcome = await direct.bot.onMessage(message());
const shadow = setup(configuration({ answerMode: 'sourced', participation: 'shadow' }));
const shadowOutcome = await shadow.bot.onMessage(message({ content: 'item 19019?', mentionIds: [] }));
console.log(JSON.stringify({ direct: outcome, shadow: shadowOutcome, providerCallsAreFake: true, liveConnections: 0 }));
