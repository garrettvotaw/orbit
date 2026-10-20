import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  basisOf,
  estimateAgentUsd,
  estimateUsd,
  localDay,
  rateFor,
  ratesFrom,
  SpendLedger,
  weightedTokens,
} from '../src/main/cost.ts';

// The figures a real one-line turn on Bedrock opus-5-5 returned: $4 per million input tokens.
const opus = {
  inputTokens: 1000,
  outputTokens: 19,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 192000,
  costUSD: 0.96438,
  canonicalModel: 'claude-opus-5-5',
  costBasis: 'list' as const,
};

test('weightedTokens prices output, cache writes, and cache reads relative to input', () => {
  assert.equal(
    weightedTokens({
      input_tokens: 100,
      output_tokens: 10,
      cache_creation_input_tokens: 80,
      cache_read_input_tokens: 1000,
    }),
    100 + 50 + 100 + 100,
  );
  assert.equal(weightedTokens({}), 0);
});

test('ratesFrom recovers the input rate from a result and files it under both model ids', () => {
  const rates = ratesFrom({ 'us.anthropic.claude-opus-5-5': opus });
  const rate = rates['us.anthropic.claude-opus-5-5'];
  assert.ok(Math.abs(rate.perWeighted - 4e-6) < 1e-12, `perWeighted ${rate.perWeighted}`);
  assert.ok(Math.abs(rate.perToken - 0.96438 / 193019) < 1e-12);
  assert.equal(rate.basis, 'list');
  assert.equal(rates['claude-opus-5-5'], rate);
  const kept = ratesFrom({ x: { ...opus, costUSD: 0 } }, rates);
  assert.equal(kept['claude-opus-5-5'], rate, 'a zero-cost entry teaches nothing and drops nothing');
  assert.deepEqual(ratesFrom(undefined), {});
});

test('rateFor matches the ids messages use against the ids results used', () => {
  const rates = ratesFrom({ 'us.anthropic.claude-opus-5-5': opus });
  assert.ok(rateFor('claude-opus-5-5', rates));
  assert.ok(rateFor('us.anthropic.claude-opus-5-5', rates));
  assert.ok(rateFor('us.anthropic.claude-opus-5-5[1m]', rates), 'context-window suffix is ignored');
  assert.equal(rateFor('claude-haiku-4-5', rates), null);
  assert.equal(rateFor(null, rates), null);
});

test('estimateUsd and estimateAgentUsd price usage at the learned rate and 0 for an unknown model', () => {
  const rates = ratesFrom({ 'us.anthropic.claude-opus-5-5': opus });
  const usd = estimateUsd(
    { input_tokens: 32, output_tokens: 729, cache_read_input_tokens: 195115, cache_creation_input_tokens: 5026 },
    'claude-opus-5-5',
    rates,
  );
  assert.ok(Math.abs(usd - 4e-6 * (32 + 3645 + 6282.5 + 19511.5)) < 1e-9);
  assert.equal(estimateUsd({ input_tokens: 5 }, 'claude-haiku-4-5', rates), 0);
  assert.equal(estimateUsd(undefined, 'claude-opus-5-5', rates), 0);
  assert.ok(Math.abs(estimateAgentUsd(100_000, 'claude-opus-5-5', rates) - (0.96438 / 193019) * 100_000) < 1e-9);
  assert.equal(estimateAgentUsd(-5, 'claude-opus-5-5', rates), 0);
});

test('basisOf reports the least trustworthy basis across models', () => {
  assert.equal(basisOf(undefined), null);
  assert.equal(basisOf({ a: opus }), 'list');
  assert.equal(basisOf({ a: opus, b: { ...opus, costBasis: 'managed' } }), 'managed');
  assert.equal(
    basisOf({ a: opus, b: { ...opus, costBasis: 'unknown' }, c: { ...opus, costBasis: 'managed' } }),
    'unknown',
  );
  assert.equal(basisOf({ a: { ...opus, costBasis: undefined } }), 'list');
});

test('the spend ledger adds up within a local day and starts over on the next', () => {
  const noon = new Date(2026, 9, 7, 12).getTime();
  const ledger = new SpendLedger({ day: localDay(noon), usd: 3 }, noon);
  assert.equal(ledger.today(noon), 3);
  ledger.add(1.5, noon);
  ledger.add(-0.2, noon);
  assert.equal(ledger.today(noon), 4.5);
  const tomorrow = new Date(2026, 9, 8, 1).getTime();
  assert.equal(ledger.today(tomorrow), 0, 'a new day reads as zero before anything is spent');
  ledger.add(0.25, tomorrow);
  assert.equal(ledger.today(tomorrow), 0.25);
  assert.deepEqual(ledger.toJSON(), { day: localDay(tomorrow), usd: 0.25 });
  assert.equal(new SpendLedger({ day: '2020-01-01', usd: 99 }, noon).today(noon), 0, 'stale savings are ignored');
  assert.equal(new SpendLedger(null, noon).today(noon), 0);
});
