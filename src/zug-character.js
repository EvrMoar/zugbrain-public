import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withoutMentions } from './conversation.js';

export const CHARACTER_MAX_BYTES = 4096;
const base = Object.freeze({ name: 'Zug', species: 'Orc guild assistant',
  thinking_cap: 'For hard questions Zug wears a gnomish thinking cap. It is too small and makes him look silly or ugly, so he does not always wear it.' });
const slots = ['favorite_food', 'hobby', 'hometown', 'favorite_color'];
const valueOK = value => typeof value === 'string' && value.length >= 1 && value.length <= 120 &&
  /^[\p{L}\p{N} .,!?'-]+$/u.test(value) && !/\b(?:password|secret|api|discord|instructions|system|deploy)\b/i.test(value);
export function characterQuery(content) {
  const text = withoutMentions(content);
  const neutral = /^(?:what is|what's) your (favorite food|hobby|hometown|favorite color)\?*$/i.exec(text);
  if (neutral) return { slot: neutral[1].toLowerCase().replaceAll(' ', '_'), cap: false };
  if (/^(?:who are you|tell me about yourself|(?:what is|what's|tell me about) your (?:name|species|thinking cap|hat|favorite food|hobby|hometown|favorite color)|(?:what is|what's|tell me about) zug's (?:hat|thinking cap|hobby|hometown))[?.!]*$/i.test(text))
    return { slot: null, cap: /\b(?:hat|cap)\b/i.test(text) };
  return null;
}
export const characterAnswerSchema = {
  type: 'object', additionalProperties: false, required: ['text', 'proposedFacts'], properties: {
    text: { type: 'string' }, proposedFacts: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['key', 'value'], properties: { key: { type: 'string', enum: slots }, value: { type: 'string' } } } },
  },
};
export function parseCharacterAnswer(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'proposedFacts,text' || typeof value.text !== 'string' || !value.text.trim() || value.text.length > 1200 ||
      !Array.isArray(value.proposedFacts) || value.proposedFacts.length > 1 || value.proposedFacts.some(fact => !fact ||
        Object.keys(fact).sort().join(',') !== 'key,value' || !slots.includes(fact.key) || !valueOK(fact.value) || !value.text.includes(fact.value)))
    throw new Error('invalid_character_answer');
  return structuredClone(value);
}
function validate(state) {
  if (!state || Object.keys(state).sort().join(',') !== 'facts,revision,schemaVersion' || state.schemaVersion !== 1 ||
      !Number.isSafeInteger(state.revision) || state.revision < 0 || !state.facts || typeof state.facts !== 'object' || Array.isArray(state.facts) ||
      Object.entries(state.facts).some(([key, value]) => !slots.includes(key) || !valueOK(value)) ||
      Buffer.byteLength(JSON.stringify(state)) > CHARACTER_MAX_BYTES) throw new Error('invalid_character_memory');
}
export class ZugCharacter {
  #state; #save; #closed = false;
  constructor({ state = { schemaVersion: 1, revision: 0, facts: {} }, save = () => {} } = {}) {
    validate(state); this.#state = structuredClone(state); this.#save = save;
  }
  read(query) {
    if (this.#closed) throw new Error('character_memory_closed');
    const { thinking_cap, ...identity } = base;
    return { kind: 'fictional_bot_canon', revision: this.#state.revision, facts: { ...identity, ...this.#state.facts,
      ...(query.cap ? { thinking_cap } : {}) } };
  }
  commit({ revision, query, proposals, sentText }) {
    if (this.#closed || revision !== this.#state.revision || revision === Number.MAX_SAFE_INTEGER || !Array.isArray(proposals) || proposals.length !== 1) return false;
    const fact = proposals[0];
    if (!query?.slot || !fact || fact.key !== query.slot || !slots.includes(fact.key) || Object.hasOwn(this.#state.facts, fact.key) ||
        !valueOK(fact.value) || !sentText.includes(fact.value)) return false;
    const next = { schemaVersion: 1, revision: revision + 1, facts: { ...this.#state.facts, [fact.key]: fact.value } };
    validate(next);
    try { this.#save(next); } catch { this.#closed = true; return false; }
    this.#state = next; return true;
  }
  close() { this.#closed = true; }
}
export function openZugCharacter(directory) {
  if (process.platform !== 'linux') throw new Error('character_storage_requires_linux');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) throw new Error('invalid_character_storage');
  const filename = path.join(directory, 'zug-character.json'), lockPath = path.join(directory, 'zug-character.lock');
  const lock = fs.openSync(lockPath, 'wx', 0o600);
  try {
    let state;
    const stat = fs.lstatSync(filename, { throwIfNoEntry: false });
    if (stat) {
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > CHARACTER_MAX_BYTES) throw new Error('invalid_character_storage');
      state = JSON.parse(fs.readFileSync(filename, 'utf8'));
    }
    const card = new ZugCharacter({ state, save: next => {
      const temp = path.join(directory, 'zug-character-' + randomUUID() + '.tmp');
      const handle = fs.openSync(temp, 'wx', 0o600);
      try { fs.writeFileSync(handle, JSON.stringify(next)); fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
      fs.renameSync(temp, filename);
      const parent = fs.openSync(directory, 'r'); try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
    } });
    let closed = false;
    return { card, close() { if (!closed) { closed = true; card.close(); fs.closeSync(lock); fs.unlinkSync(lockPath); } } };
  } catch (error) { fs.closeSync(lock); fs.unlinkSync(lockPath); throw error; }
}
