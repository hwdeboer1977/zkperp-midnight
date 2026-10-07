// SPDX-License-Identifier: Apache-2.0

/** Endpoints for one Midnight network. */
import path from "path";

export interface NetworkConfig {
  /** Short name: what ZKPERP_NETWORK selects, and the stack file's prefix. */
  key: "local" | "preview";
  /** Network identifier used for address encoding and transaction binding. */
  networkId: string;
  indexer: string;
  indexerWS: string;
  /** The wallet's relay client requires ws:// or wss://. */
  nodeWS: string;
  proofServer: string;
  name: string;
}

/**
 * The local devnet in compose.yml, plus the standalone proof server.
 * `undeployed` is the network id the dev-preset node and the indexer agree on.
 */
export const LOCAL: NetworkConfig = {
  key: "local",
  networkId: "undeployed",
  indexer: "http://127.0.0.1:8088/api/v4/graphql",
  indexerWS: "ws://127.0.0.1:8088/api/v4/graphql/ws",
  nodeWS: "ws://127.0.0.1:9944",
  proofServer: process.env.PROOF_SERVER_URL || "http://127.0.0.1:6300",
  name: "Local devnet",
};

/**
 * Midnight's public preview testnet. Endpoints as used by midnight-polisZK.
 * The proof server stays on this machine: it sees every trade's private
 * inputs, so it is never a hosted one. tNIGHT for the dev wallet comes from
 * the faucet at https://midnight-tmnight-preview.nethermind.dev/.
 */
export const PREVIEW: NetworkConfig = {
  key: "preview",
  networkId: "preview",
  indexer: "https://indexer.preview.midnight.network/api/v4/graphql",
  indexerWS: "wss://indexer.preview.midnight.network/api/v4/graphql/ws",
  nodeWS: "wss://rpc.preview.midnight.network",
  proofServer: process.env.PROOF_SERVER_URL || "http://127.0.0.1:6300",
  name: "Preview",
};

const NETWORKS: Record<NetworkConfig["key"], NetworkConfig> = { local: LOCAL, preview: PREVIEW };

/** The network the scripts and services run against: ZKPERP_NETWORK, local by default. */
export function activeNetwork(): NetworkConfig {
  const key = (process.env.ZKPERP_NETWORK?.trim() || "local") as NetworkConfig["key"];
  const network = NETWORKS[key];
  if (!network) throw new Error(`ZKPERP_NETWORK must be one of ${Object.keys(NETWORKS).join(", ")}, not "${key}"`);
  return network;
}

export const isLocal = (network: NetworkConfig) => network.key === "local";

/**
 * For the devnet tools (demo, race, probes, fund, liquidation): they rely on
 * the dev preset's pre-funded wallet and on mock prices, so they refuse to run
 * against another network.
 */
export function requireLocal(tool: string): void {
  const network = activeNetwork();
  if (!isLocal(network)) {
    throw new Error(`${tool} runs on the local devnet only; ZKPERP_NETWORK is "${network.key}"`);
  }
}

/** What setup writes for the services and the frontend: .zkperp/<network>-stack.json. */
export function stackFile(network: NetworkConfig = activeNetwork()): string {
  return path.join(process.cwd(), ".zkperp", `${network.key}-stack.json`);
}

/**
 * The dev-preset genesis pre-funds this seed with NIGHT (and so DUST for
 * fees), so a local run needs no faucet. Override with WALLET_SEED.
 */
export const LOCAL_DEV_SEED =
  "0000000000000000000000000000000000000000000000000000000000000001";

export function walletSeed(network: NetworkConfig = activeNetwork()): string {
  // Per network first (WALLET_SEED_PREVIEW), so a public network's seed in
  // .env does not replace the devnet's pre-funded one.
  const variable = `WALLET_SEED_${network.key.toUpperCase()}`;
  const explicit = process.env[variable]?.trim() || process.env.WALLET_SEED?.trim();
  if (!explicit && !isLocal(network)) {
    // On a public network the dev seed controls the admin (oracle), the
    // liquidator key and every derived wallet: it must be a real secret.
    throw new Error(`set ${variable} in .env to a secret 64-hex seed for ${network.name}; the devnet seed is public`);
  }
  const seed = explicit || LOCAL_DEV_SEED;
  if (!/^[0-9a-fA-F]{64}$/.test(seed)) {
    throw new Error("WALLET_SEED must be 64 hex characters");
  }
  return seed;
}
