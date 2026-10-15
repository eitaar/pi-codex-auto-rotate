import test from 'node:test';
import assert from 'node:assert/strict';
import { findActiveLabel, isUsageLimitError, nextAccount, quotaResetAt, pruneCooldowns } from '../src/rotation.ts';

const cred = (id) => ({ type: 'oauth', access: `access-${id}`, refresh: `refresh-${id}`, expires: 9999999999999, accountId: `acct-${id}` });
const store = {
  accounts: {
    alpha: { credential: cred('a'), savedAt: 1 },
    beta: { credential: cred('b'), savedAt: 2 },
    gamma: { credential: cred('c'), savedAt: 3 },
  },
  active: 'alpha',
};

test('only known usage-limit errors trigger failover', () => {
  for (const err of ['429 Too Many Requests', 'rate_limit_exceeded', 'usageLimitExceeded', 'You have hit your ChatGPT usage limit (plus plan)', 'quota exceeded']) {
    assert.equal(isUsageLimitError(err), true, err);
  }
  for (const err of ['401 Unauthorized', 'invalid refresh token', 'network reset', 'connection aborted', '403 forbidden']) {
    assert.equal(isUsageLimitError(err), false, err);
  }
});
test('next account follows save order and wraps', () => {
  assert.equal(nextAccount(store, 'alpha', {}), 'beta');
  assert.equal(nextAccount(store, 'gamma', {}), 'alpha');
  assert.equal(nextAccount(store, 'alpha', {beta: Date.now()+10000}), 'gamma');
});
test('cooldown prevents selecting unavailable accounts', () => {
  const now = 1000;
  assert.equal(nextAccount(store, 'alpha', { beta: 2000 }, now), 'gamma');
  assert.equal(nextAccount(store, 'alpha', { beta: 2000, gamma: 2000 }, now), undefined);
});
test('active account is identified from OAuth identity not stale store.active', () => {
  assert.equal(findActiveLabel(store, { ...cred('b'), refresh: 'refreshed-token' }), 'beta');
  assert.equal(findActiveLabel(store, cred('unknown')), undefined);
});
test('duplicate account identities are not selected for failover', () => {
  const duplicate = structuredClone(store);
  duplicate.accounts.beta.credential = cred('a');
  assert.equal(nextAccount(duplicate, 'alpha', {}), 'gamma');
});
test('weekly and 5h windows: latest exhausted window wins', () => {
  const now = 1_000_000;
  assert.equal(quotaResetAt({ rate_limit: {
    primary_window: { used_percent: 100, reset_at: 2000 },
    secondary_window: { used_percent: 100, reset_at: 3000 },
  } }, now), 3_000_000);
  assert.equal(quotaResetAt({ rate_limit: { primary_window: { used_percent: 80, reset_at: 2000 } } }, now), undefined);
});
test('expired cooldowns are removed', () => {
  const state = pruneCooldowns({cooldownUntil:{a:123,b:456}},300);
  assert.deepEqual(state.cooldownUntil,{b:456});
});

test('expired cooldown makes wrapped account eligible again', () => {
  assert.equal(nextAccount(store, 'gamma', {alpha: 2000}, 1000), 'beta');
  assert.equal(nextAccount(store, 'gamma', {alpha: 2000, beta: 3000}, 1000), undefined);
  assert.equal(nextAccount(store, 'gamma', {alpha: 2000, beta: 3000}, 2100), 'alpha');
});
