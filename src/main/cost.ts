import type { Rates } from '../shared/types.ts';

/** Token counts as the API reports them on an assistant message. */
export interface ApiUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/** One model's cumulative usage as the SDK's result message carries it. */
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
  canonicalModel?: string;
  costBasis?: 'list' | 'managed' | 'unknown';
}

/**
 * Claude's list prices keep fixed ratios between token kinds: output costs five times input,
 * a cache write 1.25 times, a cache read a tenth. One number per model - the input rate -
 * therefore prices any usage, and a result's cost divided by its weighted tokens recovers it.
 */
export function weightedTokens(u: ApiUsage): number {
  return (
    (u.input_tokens ?? 0) +
    5 * (u.output_tokens ?? 0) +
    1.25 * (u.cache_creation_input_tokens ?? 0) +
    0.1 * (u.cache_read_input_tokens ?? 0)
  );
}

/** Learn each model's rates from a result's per-model totals; models with no tokens keep their old rate. */
export function ratesFrom(modelUsage: Record<string, ModelUsage> | undefined, prev: Rates = {}): Rates {
  const next: Rates = { ...prev };
  for (const [model, u] of Object.entries(modelUsage ?? {})) {
    const weighted = weightedTokens({
      input_tokens: u.inputTokens,
      output_tokens: u.outputTokens,
      cache_creation_input_tokens: u.cacheCreationInputTokens,
      cache_read_input_tokens: u.cacheReadInputTokens,
    });
    const raw = u.inputTokens + u.outputTokens + u.cacheCreationInputTokens + u.cacheReadInputTokens;
    if (!weighted || !raw || !(u.costUSD > 0)) continue;
    const rate = { perWeighted: u.costUSD / weighted, perToken: u.costUSD / raw, basis: u.costBasis ?? 'list' };
    next[model] = rate;
    if (u.canonicalModel) next[u.canonicalModel] = rate;
  }
  return next;
}

/** The rate for a model id as a message names it, matching loosely against the ids results used. */
export function rateFor(model: string | null | undefined, rates: Rates): Rates[string] | null {
  if (!model) return null;
  if (rates[model]) return rates[model];
  const bare = model.replace(/\[.*\]$/, '');
  const key = Object.keys(rates).find((k) => k.includes(bare) || bare.includes(k.replace(/^.*?anthropic\./, '')));
  return key ? rates[key] : null;
}

/** What one API response cost, as a guess from the model's learned rate; 0 when the model is new. */
export function estimateUsd(usage: ApiUsage | undefined, model: string | null | undefined, rates: Rates): number {
  const rate = rateFor(model, rates);
  return usage && rate ? weightedTokens(usage) * rate.perWeighted : 0;
}

/** What a subagent's running token total has cost so far, at the lane model's average price per token. */
export function estimateAgentUsd(tokens: number, model: string | null | undefined, rates: Rates): number {
  const rate = rateFor(model, rates);
  return rate && tokens > 0 ? tokens * rate.perToken : 0;
}

/** The pricing basis the CLI reports across a result's models: the least trustworthy wins. */
export function basisOf(modelUsage: Record<string, ModelUsage> | undefined): 'list' | 'managed' | 'unknown' | null {
  const all = Object.values(modelUsage ?? {}).map((u) => u.costBasis ?? 'list');
  if (!all.length) return null;
  if (all.includes('unknown')) return 'unknown';
  if (all.includes('managed')) return 'managed';
  return 'list';
}

/** The local calendar day a timestamp falls on, as YYYY-MM-DD. */
export function localDay(now: number): string {
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Running spend for the current local day; a new day starts from zero. */
export class SpendLedger {
  #day: string;
  #usd: number;

  constructor(saved: { day: string; usd: number } | null, now: number) {
    const today = localDay(now);
    this.#day = today;
    this.#usd = saved && saved.day === today ? saved.usd : 0;
  }

  add(usd: number, now: number): void {
    const today = localDay(now);
    if (today !== this.#day) {
      this.#day = today;
      this.#usd = 0;
    }
    if (usd > 0) this.#usd += usd;
  }

  today(now: number): number {
    return localDay(now) === this.#day ? this.#usd : 0;
  }

  toJSON(): { day: string; usd: number } {
    return { day: this.#day, usd: this.#usd };
  }
}
