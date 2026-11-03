import test from 'node:test';
import assert from 'node:assert/strict';
import { Budget, openFileBudget } from '../../src/budget.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
test('spending, request and replay caps survive a synthetic reopen; backwards clock fails closed', () => {
  let date = Date.UTC(2026, 10, 3), saved;
  const limits = { openai: { dailyUsd: 0.1, monthlyUsd: 0.15, maxRequestsPerDay: 2 } };
  const options = { now: () => date, save: state => { saved = structuredClone(state); } };
  let b = new Budget(limits, options);
  assert.equal(b.reserve('openai', 0.05), true); assert.equal(b.reserve('openai', 0.05), true); assert.equal(b.reserve('openai', 0.01), false);
  assert.equal(b.admitEvent('2', '20', date), true);
  b = new Budget(limits, { ...options, state: saved });
  assert.equal(b.admitEvent('2', '20', date), false);
  date += 86400000; assert.equal(b.reserve('openai', 0.05), true); assert.equal(b.reserve('openai', 0.01), false);
  date -= 86400000; assert.equal(b.reserve('openai', 0.001), false);
  date = Date.UTC(2026, 9, 3); assert.equal(b.reserve('openai', 0.001), false);
});
test('uncertain persistence poisons the ledger, including event admission', () => {
  let saves = 0;
  const b = new Budget({ openai: { dailyUsd: 1, monthlyUsd: 10, maxRequestsPerDay: 1 } }, { save: () => { saves++; throw Error('simulated write failure'); } });
  assert.equal(b.reserve('openai', 0.01), false); assert.equal(b.reserve('openai', 0.01), false); assert.equal(b.admitEvent('2', '20', Date.now()), false);
  assert.equal(saves, 1);
});

test('tracked successful usage settles once, retains count and leaves crashes/failures reserved', () => {
  const limits = { openai: { dailyUsd: 1, monthlyUsd: 10, maxRequestsPerDay: 2 } };
  let saved, date = Date.UTC(2026, 10, 3);
  const b = new Budget(limits, { now: () => date, save: state => { saved = structuredClone(state); } });
  const receipt = b.reserveTracked('openai', 0.57);
  assert.equal(b.settle({}, 0.01), false);
  assert.equal(b.settle(receipt, 0.0143), true);
  assert.equal(b.settle(receipt, 0), false);
  assert.equal(b.status().openai.dayMicros, 14300); assert.equal(b.status().openai.count, 1);
  assert.ok(b.reserveTracked('openai', 0.57));
  const reopened = new Budget(limits, { state: saved });
  assert.equal(reopened.status().openai.dayMicros, 584300);
  assert.equal(reopened.reserve('openai', 0.01), false); // Two requests, despite settlement.
  date += 86400000;
  const next = b.reserveTracked('openai', 0.57);
  date += 86400000; assert.equal(b.reserve('openai', 0.1), true);
  assert.equal(b.settle(next, 0.01), false); assert.equal(b.status().openai.dayMicros, 100000);
});

test('settlement write uncertainty or invalid charge never reopens allowance', () => {
  let calls = 0;
  const b = new Budget({ openai: { dailyUsd: 1, monthlyUsd: 10, maxRequestsPerDay: 5 } }, { save: () => { if (++calls === 2) throw Error('fake write uncertainty'); } });
  const receipt = b.reserveTracked('openai', 0.57);
  assert.equal(b.settle(receipt, 0.01), false); assert.equal(b.status().openai.dayMicros, 570000);
  assert.equal(b.reserve('openai', 0.01), false); assert.equal(b.settle(receipt, 0.01), false);
  const clean = new Budget({ openai: { dailyUsd: 1, monthlyUsd: 10, maxRequestsPerDay: 5 } });
  assert.equal(clean.settle(clean.reserveTracked('openai', 0.57), NaN), false);
  assert.equal(clean.status().openai.dayMicros, 570000);
});

test('closing a ledger prevents late settlement or writes after its lock is released', () => {
  let saves = 0;
  const b = new Budget({ openai: { dailyUsd: 1, monthlyUsd: 10, maxRequestsPerDay: 5 } }, { save: () => { saves++; } });
  const receipt = b.reserveTracked('openai', 0.57); b.close();
  assert.equal(b.settle(receipt, 0.01), false); assert.equal(b.reserve('openai', 0.01), false);
  assert.equal(b.admitEvent('2', '20', Date.now()), false); assert.equal(saves, 1);
});
test('Linux temporary ledger persists reservations and excludes a second process', { skip: process.platform !== 'linux' }, () => {
  // Never exercise the previously denied Windows rename, or real runtime state.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zugbrain-lean-test-'));
  const limits = { openai: { dailyUsd: 0.1, monthlyUsd: 0.1, maxRequestsPerDay: 1 } };
  let opened;
  try {
    opened = openFileBudget(directory, limits);
    const receipt = opened.budget.reserveTracked('openai', 0.05); assert.ok(receipt);
    assert.equal(opened.budget.settle(receipt, 0.01), true);
    assert.throws(() => openFileBudget(directory, limits), /already in use/);
    const closedBudget = opened.budget; opened.close(); assert.equal(closedBudget.reserve('openai', 0.01), false);
    opened = openFileBudget(directory, limits); assert.equal(opened.budget.status().openai.dayMicros, 10000);
    assert.equal(opened.budget.reserve('openai', 0.01), false);
  } finally {
    opened?.close();
    if (fs.existsSync(path.join(directory, 'budget.json'))) fs.unlinkSync(path.join(directory, 'budget.json'));
    fs.rmdirSync(directory);
  }
});
