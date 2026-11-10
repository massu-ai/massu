// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Claude model prices, and the ONE function that turns a response's usage into dollars.
 *
 * Every response in a Claude Code transcript records its own model and a usage object
 * with the cache writes split by lifetime (`cache_creation.ephemeral_5m/1h_input_tokens`),
 * `speed` ("fast" is premium-priced) and `inference_geo` ("us" is a 1.1x multiplier on 4.6+
 * models). Pricing each response from those fields is exact; pricing a whole session at one
 * rate was not (operator decision 2026-11-09).
 *
 * A model with no known price is UNKNOWN. It is never priced at a guessed default: the old
 * fallback charged $3/$15 with cache reads free, which under-reported an Opus 5.5 session
 * about 10x while looking like a real number.
 *
 * PRICES: copied from the official page below on PRICE_TABLE_AS_OF. When prices change,
 * update the table AND bump PRICING_VERSION; stored session rows priced under an older
 * version are then repriced from their transcripts (cost-reprice.ts).
 */

export const PRICE_TABLE_SOURCE = 'https://platform.claude.com/docs/en/about-claude/pricing';
export const PRICE_TABLE_AS_OF = '2026-11-09';
export const PRICING_VERSION = 1;

/** Dollars per million tokens. */
export interface Rates {
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
}

export interface ModelPrice extends Rates {
  /** A request whose prompt (input + cache reads + cache writes) exceeds this pays `rates`. */
  longPrompt?: { overTokens: number; rates: Rates };
  /** Fast mode input/output prices; prompt-caching multipliers apply on top. */
  fast?: { input: number; output: number };
  /** `inference_geo: "us"` costs 1.1x on Claude 4.6 and later. */
  usGeoMultiplier?: number;
}

const r = (input: number, cacheWrite5m: number, cacheWrite1h: number, cacheRead: number, output: number): Rates =>
  ({ input, cacheWrite5m, cacheWrite1h, cacheRead, output });
const US = 1.1;

/** Keys are model ids with any `-YYYYMMDD` snapshot suffix removed (see normalizeModelId). */
export const BUILT_IN_PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-fable-5-1': { ...r(10, 12.5, 20, 0.25, 50), usGeoMultiplier: US },
  'claude-mythos-5-1': { ...r(10, 12.5, 20, 0.25, 50), usGeoMultiplier: US },
  'claude-fable-5': { ...r(10, 12.5, 20, 1, 50), usGeoMultiplier: US },
  'claude-mythos-5': { ...r(10, 12.5, 20, 1, 50), usGeoMultiplier: US },
  'claude-opus-5-5': { ...r(4, 5, 8, 0.2, 20), fast: { input: 8, output: 40 }, usGeoMultiplier: US },
  'claude-opus-5': { ...r(5, 6.25, 10, 0.5, 25), fast: { input: 10, output: 50 }, usGeoMultiplier: US },
  'claude-opus-4-8': { ...r(5, 6.25, 10, 0.5, 25), fast: { input: 10, output: 50 }, usGeoMultiplier: US },
  'claude-opus-4-7': { ...r(5, 6.25, 10, 0.5, 25), usGeoMultiplier: US },
  'claude-opus-4-6': { ...r(5, 6.25, 10, 0.5, 25), usGeoMultiplier: US },
  'claude-opus-4-5': r(5, 6.25, 10, 0.5, 25),
  'claude-opus-4-1': r(15, 18.75, 30, 1.5, 75),
  'claude-opus-4': r(15, 18.75, 30, 1.5, 75),
  'claude-sonnet-5-5': { ...r(2, 2.5, 4, 0.1, 10), usGeoMultiplier: US },
  'claude-sonnet-5': { ...r(2, 2.5, 4, 0.2, 10), usGeoMultiplier: US },
  'claude-sonnet-4-6': { ...r(3, 3.75, 6, 0.3, 15), usGeoMultiplier: US },
  'claude-sonnet-4-5': r(3, 3.75, 6, 0.3, 15),
  'claude-sonnet-4': r(3, 3.75, 6, 0.3, 15),
  'claude-haiku-5-5': {
    ...r(0.1, 0.125, 0.2, 0.01, 0.5),
    longPrompt: { overTokens: 100_000, rates: r(0.5, 0.625, 1, 0.05, 2.5) },
    usGeoMultiplier: US,
  },
  'claude-haiku-4-5': r(1, 1.25, 2, 0.1, 5),
};

/** A config override, in the shape `analytics.cost.models.<id>` has always used. */
export interface ConfigModelPrice {
  input_per_million: number;
  output_per_million: number;
  cache_read_per_million?: number;
  cache_write_per_million?: number;
  cache_write_1h_per_million?: number;
}

/** `claude-sonnet-4-5-20250929` -> `claude-sonnet-4-5`. Ids without a date are unchanged. */
export function normalizeModelId(model: string): string {
  return model.trim().replace(/-\d{8}$/, '');
}

/**
 * The price for `model`: a config override for that exact id (dated or not) wins, then the
 * built-in table. A config entry that omits a cache rate takes the built-in model's rate,
 * else Anthropic's published standard multiplier of base input (5m write 1.25x, 1h write
 * 2x, read 0.1x). Returns null when nothing prices the model.
 */
export function resolveModelPrice(
  model: string | undefined,
  overrides: Readonly<Record<string, ConfigModelPrice>> = {},
): ModelPrice | null {
  if (!model) return null;
  const id = normalizeModelId(model);
  const builtIn = BUILT_IN_PRICES[id];
  const o = overrides[model] ?? overrides[id];
  if (!o) return builtIn ?? null;
  const input = o.input_per_million;
  return {
    ...builtIn,
    input,
    output: o.output_per_million,
    cacheRead: o.cache_read_per_million ?? builtIn?.cacheRead ?? input * 0.1,
    cacheWrite5m: o.cache_write_per_million ?? builtIn?.cacheWrite5m ?? input * 1.25,
    cacheWrite1h: o.cache_write_1h_per_million ?? builtIn?.cacheWrite1h ?? input * 2,
  };
}

/** The usage fields a response carries (Anthropic Messages API `usage`). */
export interface ResponseUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
  speed?: string;
  inference_geo?: string;
}

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export function tokenCounts(u: ResponseUsage): TokenCounts {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  const total = n(u.cache_creation_input_tokens);
  const has5m = typeof u.cache_creation?.ephemeral_5m_input_tokens === 'number';
  const has1h = typeof u.cache_creation?.ephemeral_1h_input_tokens === 'number';
  // Without the lifetime breakdown (older transcripts), a cache write is a 5-minute write:
  // that is the API's default lifetime.
  const w1h = has1h ? n(u.cache_creation?.ephemeral_1h_input_tokens) : 0;
  const w5m = has5m ? n(u.cache_creation?.ephemeral_5m_input_tokens) : total - w1h;
  return {
    input: n(u.input_tokens),
    output: n(u.output_tokens),
    cacheRead: n(u.cache_read_input_tokens),
    cacheWrite5m: Math.max(0, w5m),
    cacheWrite1h: w1h,
  };
}

/** Dollars for one response, or null when its model has no price. */
export function priceResponse(price: ModelPrice | null, u: ResponseUsage): number | null {
  if (!price) return null;
  const t = tokenCounts(u);
  const prompt = t.input + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h;
  let rates: Rates = price.longPrompt && prompt > price.longPrompt.overTokens ? price.longPrompt.rates : price;
  if (u.speed === 'fast' && price.fast) {
    // Caching multipliers apply on top of fast-mode prices: keep each cache rate's ratio
    // to base input, applied to the fast input price.
    const k = price.fast.input / rates.input;
    rates = {
      input: price.fast.input,
      output: price.fast.output,
      cacheRead: rates.cacheRead * k,
      cacheWrite5m: rates.cacheWrite5m * k,
      cacheWrite1h: rates.cacheWrite1h * k,
    };
  }
  const geo = u.inference_geo === 'us' ? price.usGeoMultiplier ?? 1 : 1;
  const dollars =
    t.input * rates.input +
    t.output * rates.output +
    t.cacheRead * rates.cacheRead +
    t.cacheWrite5m * rates.cacheWrite5m +
    t.cacheWrite1h * rates.cacheWrite1h;
  return (dollars / 1_000_000) * geo;
}
