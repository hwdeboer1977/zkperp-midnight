// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { foldLive, type Candle } from "../src/lib/market";

const M = 300; // 5-minute candles
const T = 1_800_000_000 - (1_800_000_000 % M);
const candle = (time: number, open: number, close: number): Candle => ({ time, open, high: Math.max(open, close), low: Math.min(open, close), close });
const series = [candle(T - M, 100, 102), candle(T, 102, 101)];

describe("foldLive", () => {
  it("folds a price inside the last candle's interval into it", () => {
    const c = foldLive(series, 105, M, T + 10);
    expect(c).toHaveLength(2);
    expect(c[1]).toEqual({ time: T, open: 102, high: 105, low: 101, close: 105 });
  });
  it("lowers the low and keeps the high", () => {
    const c = foldLive(series, 99, M, T + M - 1);
    expect(c[1]).toEqual({ time: T, open: 102, high: 102, low: 99, close: 99 });
  });
  it("opens a new candle at the last close exactly at the interval boundary", () => {
    const c = foldLive(series, 103, M, T + M);
    expect(c).toHaveLength(3);
    expect(c[2]).toEqual({ time: T + M, open: 101, high: 103, low: 103, close: 103 });
    expect(c[1]).toEqual(series[1]);
  });
  it("one second before the boundary still belongs to the last candle", () => {
    expect(foldLive(series, 103, M, T + M - 1)).toHaveLength(2);
  });
  it("after a gap, opens the candle of the current interval, not the next one", () => {
    const c = foldLive(series, 110, M, T + 5 * M + 7);
    expect(c[2]!.time).toBe(T + 5 * M);
  });
  it("ignores a price from before the last candle", () => {
    expect(foldLive(series, 50, M, T - 1)).toBe(series);
  });
  it("leaves no candles as none", () => {
    expect(foldLive([], 100, M, T)).toEqual([]);
  });
  it("works for every interval the chart offers", () => {
    for (const seconds of [300, 900, 3600, 21600, 86400]) {
      const start = T - (T % seconds);
      const c = foldLive([candle(start, 1, 1)], 2, seconds, start + seconds);
      expect(c.map((x) => x.time)).toEqual([start, start + seconds]);
    }
  });
});
