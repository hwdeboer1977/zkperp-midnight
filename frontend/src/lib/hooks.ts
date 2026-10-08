// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from "react";
import { loadConfig, type AppConfig } from "./config";
import { readLedger } from "./providers";
import { contractActions, priceHistory, sharePriceHistory, type Action, type PricePoint } from "./activity";
import { contractModule } from "./contracts";

/** Polls a contract's public state. */
export function useLedger(name: "zkperp" | "pusdc" = "zkperp", everyMs = 5000) {
  const [ledger, setLedger] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const tick = () =>
      readLedger(name)
        .then((l) => live && (setLedger(l), setError(null)))
        .catch((e) => live && setError(String(e?.message ?? e)));
    void tick();
    const timer = setInterval(tick, everyMs);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [name, everyMs]);
  return { ledger, error };
}

export function useConfig(): AppConfig | null {
  const [config, setConfig] = useState<AppConfig | null>(null);
  useEffect(() => void loadConfig().then(setConfig, () => {}), []);
  return config;
}

/** JSON from one of the services, polled; null while unreachable. */
export function useService<T>(url: string | undefined, everyMs = 10_000): T | null {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    if (!url) return;
    let live = true;
    const tick = () =>
      fetch(url)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => live && setData(d))
        .catch(() => live && setData(null));
    void tick();
    const timer = setInterval(tick, everyMs);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [url, everyMs]);
  return data;
}

/** Seconds since the epoch, ticking. */
export function useNow(everyMs = 1000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

/**
 * The contract's public call history and its recent mark prices, from the
 * indexer (activity.ts); re-read every `everyMs`. Null until first read.
 */
export function useActivity(everyMs = 30_000) {
  const config = useConfig();
  const [actions, setActions] = useState<Action[] | null>(null);
  const [prices, setPrices] = useState<PricePoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!config) return;
    let live = true;
    const address = config.contracts.zkperp;
    const tick = async () => {
      try {
        const module = await contractModule("zkperp");
        const a = await contractActions(config, address);
        if (live) setActions([...a]);
        const p = await priceHistory(config, module, address);
        if (live) (setPrices(p), setError(null));
      } catch (e: any) {
        if (live) setError(String(e?.message ?? e));
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), everyMs);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [config, everyMs]);
  return { actions, prices, error };
}

/** The zLP share price after each pool-changing call, re-read every `everyMs`. Null until first read. */
export function useShareHistory(everyMs = 60_000): PricePoint[] | null {
  const config = useConfig();
  const [points, setPoints] = useState<PricePoint[] | null>(null);
  useEffect(() => {
    if (!config) return;
    let live = true;
    const tick = () =>
      contractModule("zkperp")
        .then((module) => sharePriceHistory(config, module, config.contracts.zkperp))
        .then((p) => live && setPoints(p), () => {});
    void tick();
    const timer = setInterval(tick, everyMs);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [config, everyMs]);
  return points;
}
