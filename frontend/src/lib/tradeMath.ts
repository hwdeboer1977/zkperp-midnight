// SPDX-License-Identifier: Apache-2.0

/**
 * The order ticket's arithmetic, apart from React so it can be tested
 * (frontend/test/): how large a position a coin carries, and whether the
 * oracle price is fresh enough and close enough to the market to trade on.
 */

import { openFeeOf } from "@core/math";

/**
 * The largest size `coin` can carry at `leverage`, after the opening fee:
 * size ≤ leverage × (coin − fee(size)), the contract's own bound.
 */
export function sizeFor(coin: bigint, leverage: bigint, feeBps: bigint): bigint {
  let size = (coin * leverage * 10_000n) / (10_000n + leverage * feeBps);
  while (size > 0n && size > leverage * (coin - openFeeOf(size, feeBps))) size -= 1n;
  return size;
}

/** A proof plus the wallet's part takes about this long; a price closer than this to its limit may expire on the way. */
export const TRADE_SECONDS = 120;
/** Above this gap between the live market and the execution price, warn: Chainlink itself updates at 0.5%. */
export const DEVIATION_WARN = 1;

/**
 * The oracle price's age against its limit, at `now` (seconds): stale once
 * `maxAge` has passed, the contract then refuses trades; expiring when less
 * than a trade's time is left.
 */
export function oracleAge(priceTime: number, maxAge: number, now: number) {
  const age = now - priceTime;
  const stale = age >= maxAge;
  return { age, maxAge, stale, nearStale: !stale && maxAge - age < TRADE_SECONDS };
}

/** How far, in percent, the execution price is from the live market; and whether to warn. */
export function deviationOf(oracle: number | null, market: number | null) {
  const deviation = market !== null && oracle !== null ? ((oracle - market) / market) * 100 : null;
  return { deviation, deviates: deviation !== null && Math.abs(deviation) >= DEVIATION_WARN };
}
