// SPDX-License-Identifier: Apache-2.0

/**
 * The deployment this frontend talks to, from /config.json — written by
 * `npm run frontend:config` from the local stack (or, later, a testnet
 * deployment). Nothing about the network is hardcoded in the app.
 *
 * Each market is its own zkperp contract (core/markets.ts). The app shows one
 * at a time, the one picked in the header: `loadConfig()` returns the config
 * with that market's contract as `contracts.zkperp`, and its treasury, oracle
 * and parameters, so the rest of the app needs no idea of markets.
 */

export interface MarketConfig {
  symbol: string;
  address: string;
  feed: string;
  description: string;
  /** Coinbase Exchange's product, for the candles. */
  candles: string;
  treasury: { coinPublicKey: string; encryptionPublicKey: string };
  params: Record<string, string>;
}

export interface AppConfig {
  network: { networkId: string; indexer: string; indexerWS: string; nodeWS: string; proofServer: string };
  /** `zkperp` is the selected market's contract. */
  contracts: { pusdc: string; zkperp: string };
  usdcToken: string;
  treasury: { coinPublicKey: string; encryptionPublicKey: string };
  oracle: { feed: string; description: string };
  params: Record<string, string>;
  zkVersion: string;
  services: { relayer: string; signers?: string[]; treasury: string; keeper?: string; keepers?: string[] };
  markets: MarketConfig[];
  /** The selected market's symbol. */
  market: string;
}

const STORAGE_KEY = "zkperp.market";

let raw: Promise<AppConfig> | undefined;
let selected: string | null = null;
try {
  selected = localStorage.getItem(STORAGE_KEY);
} catch {
  // No storage: the first market.
}
const listeners = new Set<() => void>();
const derived = new Map<string, AppConfig>();

/** A config.json from before markets lists one zkperp: ETH-USD. */
function normalise(c: any): AppConfig {
  if (Array.isArray(c.markets) && c.markets.length) return c;
  return {
    ...c,
    markets: [
      {
        symbol: "ETH-USD",
        address: c.contracts.zkperp,
        feed: c.oracle?.feed ?? "",
        description: c.oracle?.description ?? "ETH / USD",
        candles: "ETH-USD",
        treasury: c.treasury,
        params: c.params ?? {},
      },
    ],
  };
}

/** `c` with `symbol`'s market selected; the same object for the same market, so effects keyed on it do not rerun. */
function withMarket(c: AppConfig, symbol: string | null): AppConfig {
  const m = c.markets.find((x) => x.symbol === symbol) ?? c.markets[0]!;
  if (!derived.has(m.symbol)) {
    derived.set(m.symbol, {
      ...c,
      market: m.symbol,
      contracts: { ...c.contracts, zkperp: m.address },
      treasury: m.treasury,
      oracle: { feed: m.feed, description: m.description },
      params: m.params,
    });
  }
  return derived.get(m.symbol)!;
}

export function loadConfig(): Promise<AppConfig> {
  raw ??= fetch("/config.json", { cache: "no-store" }).then(async (r) => {
    if (!r.ok) throw new Error("No /config.json: run npm run frontend:config in the repository root.");
    return normalise(await r.json());
  });
  return raw.then((c) => withMarket(c, selected));
}

/**
 * `?market=<symbol>` for a service URL (relayer, keeper, treasury), or nothing
 * while there is one market: services from before markets answer only the
 * bare path.
 */
export function marketQuery(config: AppConfig): string {
  return config.markets.length > 1 ? `?market=${config.market}` : "";
}

/** The selected market's symbol, as last picked; null before any pick (then the first market). */
export function selectedMarket(): string | null {
  return selected;
}

export function selectMarket(symbol: string): void {
  if (symbol === selected) return;
  selected = symbol;
  try {
    localStorage.setItem(STORAGE_KEY, symbol);
  } catch {
    // Remembered for this page only.
  }
  listeners.forEach((l) => l());
}

export function onMarketChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
