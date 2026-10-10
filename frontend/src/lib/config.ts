// SPDX-License-Identifier: Apache-2.0

/**
 * The deployment this frontend talks to, from /config.json — written by
 * `npm run frontend:config` from the local stack (or, later, a testnet
 * deployment). Nothing about the network is hardcoded in the app.
 */

export interface AppConfig {
  network: { networkId: string; indexer: string; indexerWS: string; nodeWS: string; proofServer: string };
  contracts: { pusdc: string; zkperp: string };
  usdcToken: string;
  treasury: { coinPublicKey: string; encryptionPublicKey: string };
  oracle: { feed: string; description: string };
  params: Record<string, string>;
  zkVersion: string;
  services: { relayer: string; treasury: string; keeper?: string };
}

let loaded: Promise<AppConfig> | undefined;

export function loadConfig(): Promise<AppConfig> {
  loaded ??= fetch("/config.json", { cache: "no-store" }).then(async (r) => {
    if (!r.ok) throw new Error("No /config.json: run npm run frontend:config in the repository root.");
    return (await r.json()) as AppConfig;
  });
  return loaded;
}
