// SPDX-License-Identifier: Apache-2.0

/** Endpoints for one Midnight network. */
export interface NetworkConfig {
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
  networkId: "undeployed",
  indexer: "http://127.0.0.1:8088/api/v4/graphql",
  indexerWS: "ws://127.0.0.1:8088/api/v4/graphql/ws",
  nodeWS: "ws://127.0.0.1:9944",
  proofServer: process.env.PROOF_SERVER_URL || "http://127.0.0.1:6300",
  name: "Local devnet",
};

/**
 * The dev-preset genesis pre-funds this seed with NIGHT (and so DUST for
 * fees), so a local run needs no faucet. Override with WALLET_SEED.
 */
export const LOCAL_DEV_SEED =
  "0000000000000000000000000000000000000000000000000000000000000001";

export function walletSeed(): string {
  const seed = process.env.WALLET_SEED?.trim() || LOCAL_DEV_SEED;
  if (!/^[0-9a-fA-F]{64}$/.test(seed)) {
    throw new Error("WALLET_SEED must be 64 hex characters");
  }
  return seed;
}
