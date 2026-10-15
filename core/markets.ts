// SPDX-License-Identifier: Apache-2.0

/**
 * The markets: one zkperp deployment each, sharing pUSDC (docs/roadmap.md,
 * step 5). A market's contract holds its own pool, mark price and positions;
 * the oracle signers and keepers use the same keys for every market, and one
 * relayer or keeper process serves them all.
 *
 *   npm run setup -- --market BTC-USD    # deploys the BTC-USD market
 *
 * ETH-USD keeps the deployment record named "zkperp", as before markets
 * existed; another market's record is "zkperp:<symbol>".
 */

import fs from "fs";
import { getDeployment } from "./contracts.js";
import { stackFile, type NetworkConfig } from "./network.js";

export interface Market {
  symbol: string;
  /** The Chainlink proxy on Ethereum mainnet, never the underlying aggregator. */
  feed: string;
  /** Coinbase Exchange's product, for the frontend's candles. */
  candles: string;
}

export const MARKETS: Record<string, Market> = {
  "ETH-USD": { symbol: "ETH-USD", feed: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419", candles: "ETH-USD" },
  "BTC-USD": { symbol: "BTC-USD", feed: "0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c", candles: "BTC-USD" },
};

export const DEFAULT_MARKET = "ETH-USD";

export function market(symbol: string): Market {
  const m = MARKETS[symbol.toUpperCase()];
  if (!m) throw new Error(`no market "${symbol}"; known: ${Object.keys(MARKETS).join(", ")}`);
  return m;
}

/** The market `--market <symbol>` names, ETH-USD by default. */
export function marketArg(): Market {
  const i = process.argv.indexOf("--market");
  return market(i >= 0 ? process.argv[i + 1] ?? "" : process.env.ZKPERP_MARKET ?? DEFAULT_MARKET);
}

/** The deployment.json record a market's contract is saved under. */
export const deploymentKey = (symbol: string) => (symbol === DEFAULT_MARKET ? "zkperp" : `zkperp:${symbol}`);

/** The markets deployed on `network` from the current zkperp build, in MARKETS order. */
export function deployedMarkets(network: NetworkConfig): { market: Market; address: string }[] {
  return Object.values(MARKETS).flatMap((m) => {
    const address = getDeployment(network.networkId, "zkperp", deploymentKey(m.symbol));
    return address ? [{ market: m, address }] : [];
  });
}

/** One market as setup records it in the stack file. */
export interface StackMarket {
  symbol: string;
  address: string;
  feed: string;
  description: string;
  candles: string;
  treasury: { coinPublicKey: string; encryptionPublicKey: string };
  params: Record<string, string>;
}

/**
 * The stack file's markets. A stack written before markets existed has one
 * zkperp, ETH-USD, with its treasury and oracle at the top level.
 */
export function stackMarkets(stack: any): StackMarket[] {
  if (Array.isArray(stack.markets)) return stack.markets;
  if (!stack.contracts?.zkperp) return [];
  const eth = MARKETS[DEFAULT_MARKET]!;
  return [
    {
      symbol: eth.symbol,
      address: stack.contracts.zkperp,
      feed: stack.oracle?.feed ?? eth.feed,
      description: stack.oracle?.description ?? "ETH / USD",
      candles: eth.candles,
      treasury: stack.treasury,
      params: stack.params ?? {},
    },
  ];
}

export function readStack(network: NetworkConfig): any | undefined {
  const file = stackFile(network);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined;
}
