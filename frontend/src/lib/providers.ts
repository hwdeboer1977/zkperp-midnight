// SPDX-License-Identifier: Apache-2.0

/**
 * The Midnight SDK's providers, assembled in the browser from the connected
 * wallet. Modelled on midnight-polisZK's connectContract.
 *
 * Proving: a wallet that offers `getProvingProvider` (1AM) takes the proving
 * over, and sends it to the proof server in its own network settings
 * (measured 2026-10-07: on the local network 1AM posts /check and /prove to
 * localhost:6300, nothing runs in the tab). Anything else proves on this
 * app's proof server (127.0.0.1:6300). Either way that server sees each
 * trade's private inputs — size, direction, collateral — so it must be on the
 * trader's own machine, never hosted. The wallet state exposes which one is
 * used (`prover`, `proverIsLocal`) so the UI can say so.
 */

import type { ConnectedAPI } from "@midnight-ntwrk/dapp-connector-api";
import { findDeployedContract } from "@midnight-ntwrk/midnight-js-contracts";
import { FetchZkConfigProvider } from "@midnight-ntwrk/midnight-js-fetch-zk-config-provider";
import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { createProofProvider } from "@midnight-ntwrk/midnight-js-types";
import { fromHex, toHex } from "@midnight-ntwrk/midnight-js-utils";
import { Transaction } from "@midnight-ntwrk/ledger-v8";
import { loadConfig, type AppConfig } from "./config";
import { compiledContract, contractModule, type ContractName } from "./contracts";

/** What the shared trading code works with; the same shape as core/perp.ts's ContractHandle. */
export interface ContractHandle {
  address: string;
  deployed: any;
  providers: any;
  module: any;
}

// One indexer provider (and so one websocket) per endpoint: a new one per call
// gets rate limited by the public indexers. (midnight-polisZK)
const indexers = new Map<string, ReturnType<typeof indexerPublicDataProvider>>();
function indexer(config: AppConfig) {
  const key = `${config.network.indexer} ${config.network.indexerWS}`;
  if (!indexers.has(key)) indexers.set(key, indexerPublicDataProvider(config.network.indexer, config.network.indexerWS));
  return indexers.get(key)!;
}

/** A contract's public state, decoded. Needs no wallet. */
export async function readLedger(name: ContractName): Promise<any> {
  const config = await loadConfig();
  setNetworkId(config.network.networkId);
  const address = config.contracts[name];
  const state = await indexer(config).queryContractState(address);
  if (!state) throw new Error(`${name} at ${address.slice(0, 12)}… has no state on chain. Is the devnet up, and the config current?`);
  return (await contractModule(name)).ledger(state.data);
}

/** The indexer, for queries the trading code makes directly. */
export async function publicData() {
  return indexer(await loadConfig());
}

export function walletCanProve(api: ConnectedAPI): boolean {
  return typeof (api as any)?.getProvingProvider === "function";
}

// Keys are served with a long cache; the version stops a browser that cached
// one deployment's keys from proving against the next one's.
function zkFetch(version: string): typeof fetch {
  return (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return fetch(url.includes("/zk/") ? `${url}${url.includes("?") ? "&" : "?"}v=${version}` : input, init);
  };
}

function inMemoryPrivateState(): any {
  // zkperp keeps no private state in the SDK: openings live in our own store.
  const states = new Map<string, unknown>();
  const keys = new Map<string, unknown>();
  return {
    setContractAddress: () => {},
    set: async (id: string, s: unknown) => void states.set(id, s),
    get: async (id: string) => states.get(id) ?? null,
    remove: async (id: string) => void states.delete(id),
    clear: async () => states.clear(),
    setSigningKey: async (a: string, k: unknown) => void keys.set(a, k),
    getSigningKey: async (a: string) => keys.get(a) ?? null,
    removeSigningKey: async (a: string) => void keys.delete(a),
    clearSigningKeys: async () => keys.clear(),
    exportPrivateStates: async () => {
      throw new Error("not supported");
    },
    importPrivateStates: async () => {
      throw new Error("not supported");
    },
    exportSigningKeys: async () => {
      throw new Error("not supported");
    },
    importSigningKeys: async () => {
      throw new Error("not supported");
    },
  };
}

/** A contract, callable through the connected wallet. */
export async function connectContract(api: ConnectedAPI, name: ContractName): Promise<ContractHandle> {
  const config = await loadConfig();
  const walletConfig = await api.getConfiguration();
  if (walletConfig.networkId !== config.network.networkId) {
    throw new Error(
      `The wallet is on "${walletConfig.networkId}", this deployment on "${config.network.networkId}". Switch the wallet's network.`
    );
  }
  setNetworkId(config.network.networkId);

  const zkConfigProvider = new FetchZkConfigProvider<any>(`${window.location.origin}/zk/${name}`, zkFetch(config.zkVersion));
  const shielded = await api.getShieldedAddresses();
  const walletProvider = {
    getCoinPublicKey: () => shielded.shieldedCoinPublicKey as any,
    getEncryptionPublicKey: () => shielded.shieldedEncryptionPublicKey as any,
    balanceTx: async (tx: any) => {
      const { tx: balanced } = await api.balanceUnsealedTransaction(toHex(tx.serialize()));
      return Transaction.deserialize("signature", "proof", "binding", fromHex(balanced)) as any;
    },
  };
  const midnightProvider = {
    submitTx: async (tx: any) => {
      await api.submitTransaction(toHex(tx.serialize()));
      const ids: string[] = tx.identifiers?.() ?? [];
      if (ids.length === 0) throw new Error("The transaction was submitted but reported no identifier.");
      return ids[0] as any;
    },
  };
  const proofProvider = walletCanProve(api)
    ? createProofProvider(await (api as any).getProvingProvider(zkConfigProvider.asKeyMaterialProvider()))
    : httpClientProofProvider(config.network.proofServer, zkConfigProvider as any);

  const providers: any = {
    privateStateProvider: inMemoryPrivateState(),
    publicDataProvider: indexer(config),
    zkConfigProvider,
    proofProvider,
    walletProvider,
    midnightProvider,
  };
  const address = config.contracts[name];
  const deployed = await findDeployedContract(providers, {
    compiledContract: await compiledContract(name),
    contractAddress: address,
  } as any);
  return { address, deployed, providers, module: await contractModule(name) };
}
