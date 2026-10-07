// SPDX-License-Identifier: Apache-2.0

/**
 * Wallet and contract plumbing shared by the scripts and services, on the
 * network ZKPERP_NETWORK selects (core/network.ts):
 * providers and contract handles per wallet, and shielded balances.
 */

import * as Rx from "rxjs";
import { deployContract, findDeployedContract } from "@midnight-ntwrk/midnight-js-contracts";
import { activeNetwork } from "./network.js";
import { makeWalletProviders, type BuiltWallet } from "./wallet.js";
import { makeProviders } from "./providers.js";
import { getDeployment, loadCompiledContract, saveDeployment, type ContractName } from "./contracts.js";
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
 * The address of `name` on the local devnet: the recorded deployment if it
 * still exists and `accept` approves its state, a fresh one otherwise.
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
  const { module, compiledContract } = await loadCompiledContract(name);
  const state = known ? await providers.publicDataProvider.queryContractState(known) : undefined;
  if (known && state && accept(module.ledger(state.data))) return known;
  log(`deploying ${name}…`);
  const deployed: any = await deployContract(providers as any, {
    compiledContract: compiledContract as any,
    args: await args(module),
  } as any);
  const address: string = deployed.deployTxData.public.contractAddress;
  saveDeployment(activeNetwork().networkId, name, address);
  return address;
}
