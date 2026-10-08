// SPDX-License-Identifier: Apache-2.0

/**
 * The Midnight SDK's providers, assembled in the browser from the connected
 * wallet. Modelled on midnight-polisZK's connectContract.
 *
 * Proving: the contract call is proven on this app's proof server
 * (127.0.0.1:6300) whenever it answers, and the wallet only balances the fees
 * and signs; its own fee proofs hold no position data. Only when that server
 * is down does a wallet that offers `getProvingProvider` (1AM) prove the call,
 * on the proof server in its own network settings: on preview that is 1AM's
 * hosted one, which took ~40 s a proof (measured 2026-10-07) against 1–13 s
 * locally, and which sees each trade's private inputs — size, direction,
 * collateral. The wallet state exposes the route (`prover`, `proverIsLocal`,
 * `walletProves`) so the UI can say so.
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

/** Who proves the contract calls, and on which proof server. */
export interface ProverRoute {
  /** True when the wallet proves (on its own server), false when this app's proof server does. */
  walletProves: boolean;
  /** The proof server that sees each trade's private inputs; "unknown" if the wallet does not say. */
  url: string;
}

/** Whether the proof server at `url` answers its health check. */
export async function proofServerUp(url: string): Promise<boolean> {
  try {
    const res = await fetch(new URL("/health", url), { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * This app's proof server when it answers, else the wallet's if it can prove.
 * With neither, still this app's: proving then fails with a clear error.
 */
export async function proverRoute(api: ConnectedAPI): Promise<ProverRoute> {
  const config = await loadConfig();
  const local = config.network.proofServer;
  if (!walletCanProve(api) || (await proofServerUp(local))) return { walletProves: false, url: local };
  const wallet = await api.getConfiguration();
  return { walletProves: true, url: String((wallet as any).proverServerUri ?? "unknown") };
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

/**
 * Where a transaction is: proving its contract call, in the wallet (fees and
 * signature), or submitted. The providers below report each step as the SDK
 * reaches it, so the UI shows real progress rather than a spinner.
 */
export type TxStage = "proving" | "wallet" | "submitting";
const stageListeners = new Set<(stage: TxStage) => void>();
export function onTxStage(listener: (stage: TxStage) => void): () => void {
  stageListeners.add(listener);
  return () => void stageListeners.delete(listener);
}
const reportStage = (stage: TxStage) => stageListeners.forEach((l) => l(stage));

/** A contract, callable through the connected wallet, proven by `route`. */
export async function connectContract(api: ConnectedAPI, name: ContractName, route: ProverRoute): Promise<ContractHandle> {
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
      reportStage("wallet");
      const { tx: balanced } = await api.balanceUnsealedTransaction(toHex(tx.serialize()));
      return Transaction.deserialize("signature", "proof", "binding", fromHex(balanced)) as any;
    },
  };
  const midnightProvider = {
    submitTx: async (tx: any) => {
      reportStage("submitting");
      await api.submitTransaction(toHex(tx.serialize()));
      const ids: string[] = tx.identifiers?.() ?? [];
      if (ids.length === 0) throw new Error("The transaction was submitted but reported no identifier.");
      return ids[0] as any;
    },
  };
  const prover = route.walletProves
    ? createProofProvider(await (api as any).getProvingProvider(zkConfigProvider.asKeyMaterialProvider()))
    : httpClientProofProvider(route.url, zkConfigProvider as any);
  const proofProvider = {
    proveTx: (tx: any, proveConfig?: any) => {
      reportStage("proving");
      return prover.proveTx(tx, proveConfig);
    },
  };

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
