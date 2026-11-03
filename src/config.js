import fs from 'node:fs';
import path from 'node:path';
import { validateNewsSettings } from './news-schedule.js';

export const BOUNDS = Object.freeze({ messages: 12, ageMs: 120000, text: 1200, contextChars: 6000, selected: 6, replyDepth: 4 });
const id = value => typeof value === 'string' && /^\d{1,20}$/.test(value);
const positive = value => Number.isFinite(value) && value > 0;
export function validateConfig(config) {
  const fail = () => { throw new Error('invalid_configuration'); };
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      typeof config.enabled !== 'boolean' || !['synthetic', 'sourced', 'chat'].includes(config.answerMode) ||
      !['direct', 'shadow', 'assist'].includes(config.participation)) fail();
  const d = config.discord;
  if (!d || typeof d.applicationId !== 'string' || typeof d.guildId !== 'string') fail();
  for (const key of ['channelIds', 'userIds']) {
    if (!Array.isArray(d[key]) || d[key].length > 32 || !d[key].every(id) || new Set(d[key]).size !== d[key].length) fail();
  }
  if (d.botRoleIds !== undefined && (!Array.isArray(d.botRoleIds) || d.botRoleIds.length > 8 || !d.botRoleIds.every(id) || new Set(d.botRoleIds).size !== d.botRoleIds.length)) fail();
  if (d.acceptManagedBotRoleMention !== undefined && typeof d.acceptManagedBotRoleMention !== 'boolean') fail();
  if (d.userPolicy !== undefined && !['allowlist', 'channel-members'].includes(d.userPolicy)) fail();
  if (config.enabled && (!id(d.applicationId) || !id(d.guildId) || !d.channelIds.length ||
      (d.userPolicy !== 'channel-members' && !d.userIds.length))) fail();
  if (!Number.isInteger(config.replyCooldownMs) || config.replyCooldownMs < 1000 || config.replyCooldownMs > 300000 ||
      !Number.isInteger(config.decisionCooldownMs) || config.decisionCooldownMs < 1000 || config.decisionCooldownMs > 300000) fail();
  if (!config.credentials || typeof config.stateDirectory !== 'string' || !config.stateDirectory) fail();
  for (const name of ['discord', 'openai', 'jev', 'foreverdb']) {
    if (typeof config.credentials[name] !== 'string' || !config.credentials[name]) fail();
  }
  for (const provider of ['openai', 'jev']) {
    const b = config.budgets?.[provider];
    if (!b || !positive(b.dailyUsd) || !positive(b.monthlyUsd) || b.dailyUsd > b.monthlyUsd ||
        !Number.isSafeInteger(b.maxRequestsPerDay) || b.maxRequestsPerDay < 1 || b.maxRequestsPerDay > 10000) fail();
  }
  if (typeof config.foreverdbApproved !== 'boolean') fail();
  if (config.webSearchEnabled !== undefined && typeof config.webSearchEnabled !== 'boolean') fail();
  if (config.webSearchEnabled && config.answerMode !== 'chat') fail();
  if (!Number.isInteger(config.runForMs) || config.runForMs < 0 || config.runForMs > 86400000 || typeof config.stopAfterReply !== 'boolean') fail();
  // A connection test must never quietly expand into conversation classification.
  if (config.answerMode === 'synthetic' && config.participation !== 'direct') fail();
  if (config.answerMode === 'chat' && config.participation !== 'direct') fail();
  if (config.answerMode === 'synthetic' && (!config.stopAfterReply || config.runForMs < 1000 || config.runForMs > 600000 ||
      config.budgets.openai.maxRequestsPerDay !== 1 || config.budgets.openai.dailyUsd > 0.25 || config.budgets.openai.monthlyUsd > 0.25)) fail();
  validateNewsSettings(config.news, config);
  return structuredClone(config);
}
export function loadConfig(filename) {
  try {
    const raw = fs.readFileSync(filename, 'utf8');
    if (Buffer.byteLength(raw) > 16384) throw new Error();
    const config = validateConfig(JSON.parse(raw));
    // Paths are relative to this config file, not the caller's working directory.
    const base = path.dirname(path.resolve(filename));
    config.stateDirectory = path.resolve(base, config.stateDirectory);
    for (const name of Object.keys(config.credentials)) config.credentials[name] = path.resolve(base, config.credentials[name]);
    return config;
  } catch { throw new Error('invalid_configuration'); }
}
