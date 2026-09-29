// SPDX-License-Identifier: Apache-2.0

import path from "path";
import { createHash } from "crypto";
import { levelPrivateStateProvider } from "@midnight-ntwrk/midnight-js-level-private-state-provider";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { NodeZkConfigProvider } from "@midnight-ntwrk/midnight-js-node-zk-config-provider";
import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import type { NetworkConfig } from "./network.js";

export function managedPath(contractName: string): string {
  return path.join(process.cwd(), "contracts", "managed", contractName);
}

/**
 * Providers for one contract. Proofs go to the HTTP proof server.
 *
 * zkperp keeps no SDK private state — position openings are circuit arguments,
 * saved by the caller — but the SDK requires a private state provider anyway.
 * Its store is encrypted with a password derived from the wallet seed, since
 * it is only as secret as the seed.
 */
export function makeProviders(options: {
  contractName: string;
  network: NetworkConfig;
  seedHex: string;
  accountId: string;
  walletProvider: any;
  midnightProvider: any;
}) {
  const { contractName, network } = options;
  const zkConfigProvider = new NodeZkConfigProvider(managedPath(contractName));
  const digest = createHash("sha256")
    .update(`zkperp-private-state:${options.seedHex}`)
    .digest("base64");

  return {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: `${contractName}-state`,
      accountId: options.accountId,
      privateStoragePasswordProvider: () => `Ps1!${digest.slice(0, 28)}`,
    }),
    publicDataProvider: indexerPublicDataProvider(network.indexer, network.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(network.proofServer, zkConfigProvider),
    walletProvider: options.walletProvider,
    midnightProvider: options.midnightProvider,
  };
}
