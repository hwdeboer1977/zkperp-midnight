// SPDX-License-Identifier: Apache-2.0

/** A seeded mulberry32, so a failing random case replays: TEST_SEED=<n> npx vitest. */
export function rng(seed = Number(process.env.TEST_SEED ?? 1)) {
  let s = seed >>> 0;
  const u32 = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
  /** Uniform in [lo, hi]. */
  const between = (lo: bigint, hi: bigint): bigint => {
    if (hi <= lo) return lo;
    const span = hi - lo + 1n;
    let r = 0n;
    for (let bits = 0; bits < span.toString(2).length + 32; bits += 32) r = (r << 32n) | BigInt(u32());
    return lo + (r % span);
  };
  /** Spread over orders of magnitude in [lo, hi]. */
  const logBetween = (lo: bigint, hi: bigint): bigint => {
    const bits = Number(between(BigInt(lo.toString(2).length), BigInt(hi.toString(2).length)));
    const top = 1n << BigInt(bits);
    return between(lo, hi < top ? hi : top);
  };
  return { u32, between, logBetween, pick: <T>(xs: T[]): T => xs[u32() % xs.length]! };
}
