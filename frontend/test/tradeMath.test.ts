// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { openFeeOf } from "@core/math";
import { DEVIATION_WARN, TRADE_SECONDS, deviationOf, oracleAge, sizeFor } from "../src/lib/tradeMath";
import { rng } from "./rng";

describe("sizeFor", () => {
  const r = rng();
  const cases = Array.from({ length: 5_000 }, () => ({
    coin: r.logBetween(1n, 10n ** 13n),
    leverage: r.pick([1n, 2n, 5n, 20n, 100n, 255n, r.between(1n, 255n)]),
    feeBps: r.pick([0n, 1n, 10n, 100n, 10_000n, r.between(0n, 10_000n)]),
  }));

  it("never exceeds the contract's leverage bound, for any coin, leverage and fee", () => {
    for (const { coin, leverage, feeBps } of cases) {
      const size = sizeFor(coin, leverage, feeBps);
      const collateral = coin - openFeeOf(size, feeBps);
      expect(size <= leverage * collateral, `${size} on ${collateral} at ${leverage}x, fee ${feeBps}`).toBe(true);
    }
  });

  it("is the largest size within the bound", () => {
    for (const { coin, leverage, feeBps } of cases) {
      const size = sizeFor(coin, leverage, feeBps);
      const next = size + 1n;
      const fee = openFeeOf(next, feeBps);
      const fits = fee < coin && next <= leverage * (coin - fee);
      expect(fits, `${next} would also fit ${coin} at ${leverage}x, fee ${feeBps}`).toBe(false);
    }
  });

  it("leaves a fee the coin can pay", () => {
    for (const { coin, leverage, feeBps } of cases) {
      const size = sizeFor(coin, leverage, feeBps);
      if (size > 0n) expect(openFeeOf(size, feeBps) < coin).toBe(true);
    }
  });

  it("10 pUSDC at 5x with a 0.10% fee", () => {
    const size = sizeFor(10_000_000n, 5n, 10n);
    // size ≤ 5 × (10 − 0.001 × size) → size ≤ 50 / 1.005 ≈ 49.751243; the fee rounds up.
    expect(size).toBe(49_751_240n);
    expect(size <= 5n * (10_000_000n - openFeeOf(size, 10n))).toBe(true);
  });
});

describe("oracleAge", () => {
  const MAX = 3_900;
  const T = 1_800_000_000;
  it("is live while more than a trade's time is left", () => {
    expect(oracleAge(T, MAX, T + MAX - TRADE_SECONDS)).toMatchObject({ stale: false, nearStale: false, age: MAX - TRADE_SECONDS });
    expect(oracleAge(T, MAX, T)).toMatchObject({ stale: false, nearStale: false, age: 0 });
  });
  it("is expiring when less than a trade's time is left", () => {
    expect(oracleAge(T, MAX, T + MAX - TRADE_SECONDS + 1)).toMatchObject({ stale: false, nearStale: true });
    expect(oracleAge(T, MAX, T + MAX - 1)).toMatchObject({ stale: false, nearStale: true });
  });
  it("is stale from exactly the maximum age on, as the contract refuses it", () => {
    expect(oracleAge(T, MAX, T + MAX)).toMatchObject({ stale: true, nearStale: false });
    expect(oracleAge(T, MAX, T + 10 * MAX)).toMatchObject({ stale: true, nearStale: false });
  });
  it("is never both stale and expiring", () => {
    for (let now = T - 10; now < T + MAX + 10; now++) {
      const a = oracleAge(T, MAX, now);
      expect(a.stale && a.nearStale).toBe(false);
    }
  });
});

describe("deviationOf", () => {
  it("is unknown without both prices", () => {
    expect(deviationOf(null, 2000)).toEqual({ deviation: null, deviates: false });
    expect(deviationOf(2000, null)).toEqual({ deviation: null, deviates: false });
  });
  it("is the execution price's distance from the market, in percent, signed", () => {
    expect(deviationOf(2020, 2000).deviation).toBeCloseTo(1);
    expect(deviationOf(1980, 2000).deviation).toBeCloseTo(-1);
  });
  it(`warns from ${DEVIATION_WARN}% either way, not below`, () => {
    expect(deviationOf(2020, 2000).deviates).toBe(true);
    expect(deviationOf(1980, 2000).deviates).toBe(true);
    expect(deviationOf(2019.8, 2000).deviates).toBe(false);
    expect(deviationOf(2000, 2000).deviates).toBe(false);
  });
});
