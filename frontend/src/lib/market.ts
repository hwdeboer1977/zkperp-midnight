// SPDX-License-Identifier: Apache-2.0

/**
 * Live market data for the trading chart (ETH-USD, BTC-USD…), from Coinbase Exchange's
 * public API: candles over REST, the last trade over its websocket.
 *
 * This is a REFERENCE only. Every open and close executes at the contract's
 * mark price, set by the oracle relayer from Chainlink. The chart shows where
 * the market is; the gap between the two is what the deviation check warns
 * about. Reading it tells Coinbase this browser's IP watches the market, nothing
 * about any position.
 */

import { useEffect, useState } from "react";

const REST = "https://api.exchange.coinbase.com/products";
const WS = "wss://ws-feed.exchange.coinbase.com";

export interface Candle {
  /** Seconds since the epoch, the candle's open. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export const INTERVALS = [
  { label: "5m", seconds: 300 },
  { label: "15m", seconds: 900 },
  { label: "1h", seconds: 3600 },
  { label: "6h", seconds: 21600 },
  { label: "1D", seconds: 86400 },
] as const;

/** Up to 300 candles of `seconds` each for Coinbase's `product`, oldest first. */
export async function fetchCandles(product: string, seconds: number): Promise<Candle[]> {
  const res = await fetch(`${REST}/${product}/candles?granularity=${seconds}`);
  if (!res.ok) throw new Error(`market data: HTTP ${res.status}`);
  // [time, low, high, open, close, volume], newest first.
  const rows = (await res.json()) as number[][];
  return rows.map(([time, low, high, open, close]) => ({ time, open, high, low, close })).reverse();
}

/** The last trade price of `product`, streamed; null until the first tick or while disconnected. */
export function useLivePrice(product: string | undefined): number | null {
  const [price, setPrice] = useState<number | null>(null);
  useEffect(() => {
    setPrice(null);
    if (!product) return;
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const connect = () => {
      ws = new WebSocket(WS);
      ws.onopen = () => ws?.send(JSON.stringify({ type: "subscribe", product_ids: [product], channels: ["ticker"] }));
      ws.onmessage = (e) => {
        const m = JSON.parse(String(e.data));
        if (m.type === "ticker" && m.price) setPrice(Number(m.price));
      };
      ws.onclose = () => {
        setPrice(null);
        if (!closed) retry = setTimeout(connect, 5000);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, [product]);
  return price;
}

/**
 * `candles` with the live price `live` at `now` (seconds) folded in: into the
 * last candle while `now` is in its interval, else as a new candle opening at
 * the last close. A price from an interval before the last candle is ignored.
 */
export function foldLive(candles: Candle[], live: number, seconds: number, now: number): Candle[] {
  if (candles.length === 0) return candles;
  const start = now - (now % seconds);
  const last = candles[candles.length - 1];
  if (last.time === start) {
    return [...candles.slice(0, -1), { ...last, close: live, high: Math.max(last.high, live), low: Math.min(last.low, live) }];
  }
  if (start > last.time) return [...candles, { time: start, open: last.close, high: live, low: live, close: live }];
  return candles;
}

/** Candles of `product` for `seconds`, refreshed each minute, with the live price folded into the last one. */
export function useCandles(product: string | undefined, seconds: number, live: number | null) {
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setCandles(null);
    if (!product) return;
    const load = () =>
      fetchCandles(product, seconds).then(
        (c) => alive && (setCandles(c), setError(null)),
        (e) => alive && setError(String(e?.message ?? e))
      );
    void load();
    const timer = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [product, seconds]);

  useEffect(() => {
    if (live === null) return;
    setCandles((c) => (c ? foldLive(c, live, seconds, Math.floor(Date.now() / 1000)) : c));
  }, [live, seconds]);

  return { candles, error };
}
