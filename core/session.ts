// SPDX-License-Identifier: Apache-2.0

/**
 * Wallet and contract plumbing shared by the scripts and services, on the
 * network ZKPERP_NETWORK selects (core/network.ts):
 * providers and contract handles per wallet, and shielded balances.
 */

import * as Rx from "rxjs";
import { ContractState } from "@midnight-ntwrk/compact-runtime";
import { deployContract, findDeployedContract, submitInsertVerifierKeyTx } from "@midnight-ntwrk/midnight-js-contracts";
import { activeNetwork } from "./network.js";
import { makeWalletProviders, type BuiltWallet } from "./wallet.js";
import { makeProviders } from "./providers.js";
import { contractModule, getDeployment, loadCompiledContract, saveDeployment, type ContractName } from "./contracts.js";
import type { ContractHandle } from "./perp.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

export function providersFor(wallet: BuiltWallet, seed: string, name: ContractName) {
  const { walletProvider, midnightProvider } = makeWalletProviders(wallet);
  return makeProviders({
    contractName: name,
    network: activeNetwork(),
    seedHex: seed,
    accountId: wallet.unshieldedAddress,
    walletProvider,
    midnightProvider,
  });
}

export async function handle(wallet: BuiltWallet, seed: string, name: ContractName, address: string): Promise<ContractHandle> {
  const providers = providersFor(wallet, seed, name);
  const { module, compiledContract } = await loadCompiledContract(name);
  const deployed: any = await findDeployedContract(providers as any, {
    contractAddress: address,
    compiledContract: compiledContract as any,
  } as any);
  return { address, deployed, providers, module };
}

export function coinKey(wallet: BuiltWallet): Uint8Array {
  return Uint8Array.from(Buffer.from(String(wallet.shieldedSecretKeys.coinPublicKey), "hex"));
}

export function shieldedBalance(state: any, usdc: Uint8Array): bigint {
  const balances = (state.shielded as any).balances as Record<string, bigint>;
  return balances[hex(usdc)] ?? balances[`0x${hex(usdc)}`] ?? 0n;
}

export async function balance(wallet: BuiltWallet, usdc: Uint8Array): Promise<bigint> {
  return shieldedBalance(await Rx.firstValueFrom(wallet.facade.state()), usdc);
}

/** Wallets see a transaction's coins a moment after it lands. */
export function waitForBalance(wallet: BuiltWallet, usdc: Uint8Array, ok: (b: bigint) => boolean): Promise<bigint> {
  return Rx.firstValueFrom(
    wallet.facade.state().pipe(
      Rx.map((s) => shieldedBalance(s, usdc)),
      Rx.filter(ok),
      Rx.timeout(180_000)
    )
  );
}

/**
 * Circuits whose verifier keys the deploy leaves out and inserts afterwards,
 * one maintenance transaction each.
 *
 * A deploy carries every circuit's verifier key, and the node refuses one that
 * is too heavy: "1010: Invalid Transaction: Transaction would exhaust the
 * block limits", with nothing about which limit. zkperp with 13 circuits is
 * refused (2026-10-09); the 10 before limit orders deployed. midnight-polisZK
 * found the same ceiling (docs/findings.md, "The deploy ceiling"), around
 * 12 circuits. Inserting a key later is a maintenance update, signed with the
 * key the deploy stored in the private state provider.
 */
const DEFERRED: Partial<Record<ContractName, string[]>> = {
  zkperp: ["placeOrder", "cancelOrder", "executeOrder", "placeLimitOrder", "executeLimitOrder", "cancelLimitOrder"],
};

/** `Base` with the circuits in `omit` left out of its initial state and its provable circuits. */
function withoutCircuits(Base: any, omit: string[]): any {
  return class extends Base {
    constructor(...args: any[]) {
      super(...args);
      for (const id of omit) delete (this as any).provableCircuits[id];
    }
    initialState(...args: any[]) {
      const r = super.initialState(...args);
      const full: ContractState = r.currentContractState;
      const slim = new ContractState();
      slim.data = full.data;
      for (const id of full.operations()) {
        if (!omit.includes(String(id))) slim.setOperation(id, full.operation(id)!);
      }
      return { ...r, currentContractState: slim };
    }
  };
}

/** Inserts the verifier key of every deferred circuit `address` does not have yet. */
async function insertDeferred(log: (line: string) => void, providers: any, name: ContractName, address: string): Promise<void> {
  const { compiledContract } = await loadCompiledContract(name);
  providers.privateStateProvider.setContractAddress?.(address);
  for (const id of DEFERRED[name] ?? []) {
    const state = await providers.publicDataProvider.queryContractState(address);
    if (state?.operation(id)) continue;
    log(`adding ${id}'s verifier key…`);
    const vk = await providers.zkConfigProvider.getVerifierKey(id);
    await submitInsertVerifierKeyTx(providers, compiledContract as any, address as any, id as any, vk);
  }
}

/**
 * The address of `name` on the local devnet: the recorded deployment if it
 * still exists and `accept` approves its state, a fresh one otherwise. Either
 * way it ends with every circuit's verifier key on chain; see `DEFERRED`.
 */
export async function deployOrFind(
  log: (line: string) => void,
  wallet: BuiltWallet,
  seed: string,
  name: ContractName,
  args: (module: any) => Promise<unknown[]>,
  accept: (ledger: any) => boolean = () => true
): Promise<string> {
  const known = getDeployment(activeNetwork().networkId, name);
  const providers = providersFor(wallet, seed, name);
  const deferred = DEFERRED[name] ?? [];
  const module = await contractModule(name);
  const { compiledContract } = await loadCompiledContract(name, deferred.length ? withoutCircuits(module.Contract, deferred) : undefined);
  const state = known ? await providers.publicDataProvider.queryContractState(known) : undefined;
  if (known && state && accept(module.ledger(state.data))) {
    await insertDeferred(log, providers, name, known);
    return known;
  }
  log(`deploying ${name}${deferred.length ? `, without ${deferred.length} circuits' verifier keys` : ""}…`);
  const deployed: any = await deployContract(providers as any, {
    compiledContract: compiledContract as any,
    args: await args(module),
  } as any);
  const address: string = deployed.deployTxData.public.contractAddress;
  saveDeployment(activeNetwork().networkId, name, address);
  await insertDeferred(log, providers, name, address);
  return address;
}
