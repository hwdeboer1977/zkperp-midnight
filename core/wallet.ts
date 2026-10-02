// Adapted from midnight-polisZK (Copyright 2026 Henk Wim de Boer)
// SPDX-License-Identifier: Apache-2.0

import {
  HDWallet,
  Roles,
  createKeystore,
  type UnshieldedKeystore,
  PublicKey,
  WalletFacade,
  ShieldedWallet,
  UnshieldedWallet,
  DustWallet,
  WalletEntrySchema,
  mergeWalletEntries,
  InMemoryTransactionHistoryStorage,
} from "@midnight-ntwrk/wallet-sdk";
import {
  LedgerParameters,
  ZswapSecretKeys,
  DustSecretKey,
} from "@midnight-ntwrk/ledger-v8";
import { mnemonicToSeedSync } from "@scure/bip39";
import * as Rx from "rxjs";
import { WebSocket } from "ws";
import type { NetworkConfig } from "./network.js";
import { loadWalletState, saveWalletState } from "./wallet-cache.js";

// The indexer's GraphQL subscriptions need a WebSocket implementation on the
// global. Node 22 ships one, but the graphql-ws client the provider uses only
// picks up the `ws` implementation reliably when it is set explicitly.
if (!(globalThis as { WebSocket?: unknown }).WebSocket) {
  (globalThis as { WebSocket?: unknown }).WebSocket = WebSocket;
}

/**
 * How the wallet was identified. Browser wallets (Lace, IAM) only ever hand out
 * a recovery phrase, never a raw key, so a mnemonic is the normal case for a
 * wallet funded outside this project.
 */
export type WalletSecret =
  | { kind: "seed"; value: string }
  | { kind: "mnemonic"; value: string };

/**
 * The master seed every role key hangs off, as hex.
 *
 * A mnemonic becomes a seed by BIP-39, exactly as the Midnight wallet SDK's own
 * builder does it (`mnemonicToSeedSync` -> hex -> HD roles at account 0,
 * index 0). Matching that byte for byte is what makes an address derived here
 * identical to the one the browser wallet shows.
 */
export function masterSeedHex(secret: WalletSecret): string {
  return secret.kind === "mnemonic"
    ? Buffer.from(mnemonicToSeedSync(secret.value)).toString("hex")
    : secret.value;
}

/**
 * Keys for the three wallets the facade composes. Each comes from its own HD
 * role, which is what `Roles` exists to separate.
 */
export interface DerivedKeys {
  unshieldedKeystore: UnshieldedKeystore;
  shieldedSeed: Uint8Array;
  dustSeed: Uint8Array;
}

const ROLES = [Roles.NightExternal, Roles.Zswap, Roles.Dust] as const;

export function deriveKeys(
  secret: WalletSecret,
  networkId: string
): DerivedKeys {
  const seed = Buffer.from(masterSeedHex(secret), "hex");

  const hd = HDWallet.fromSeed(seed);
  if (hd.type !== "seedOk") {
    throw new Error(`Could not derive HD wallet from the wallet secret: ${hd.error}`);
  }

  const derived = hd.hdWallet
    .selectAccount(0)
    .selectRoles(ROLES)
    .deriveKeysAt(0);
  if (derived.type !== "keysDerived") {
    throw new Error(
      `Key derivation out of bounds for roles: ${derived.roles.join(", ")}`
    );
  }
  hd.hdWallet.clear();

  return {
    unshieldedKeystore: createKeystore(
      derived.keys[Roles.NightExternal],
      networkId
    ),
    shieldedSeed: derived.keys[Roles.Zswap],
    dustSeed: derived.keys[Roles.Dust],
  };
}

/**
 * The address the faucet funds. Derivable offline — no indexer round-trip — so
 * it stays available even when the network is unreachable.
 */
export function getUnshieldedAddress(
  secret: WalletSecret,
  networkId: string
): string {
  return deriveKeys(secret, networkId).unshieldedKeystore.getBech32Address().toString();
}

export function buildConfiguration(network: NetworkConfig) {
  return {
    networkId: network.networkId,
    indexerClientConnection: {
      indexerHttpUrl: network.indexer,
      indexerWsUrl: network.indexerWS,
    },
    relayURL: new URL(network.nodeWS),
    provingServerUrl: new URL(network.proofServer),
    txHistoryStorage: new InMemoryTransactionHistoryStorage(
      WalletEntrySchema,
      mergeWalletEntries
    ),
    // The dust wallet's fee dry-run needs the ledger's cost model. Without
    // `ledgerParams` the estimator never converges: balancing a call spins in
    // `dryRunFee`/`addIntent` inside the ledger WASM instead of returning.
    costParameters: {
      ledgerParams: LedgerParameters.initialParameters(),
      additionalFeeOverhead: 1_000n,
      feeBlocksMargin: 5,
    },
  };
}

export interface BuiltWallet {
  facade: WalletFacade;
  keys: DerivedKeys;
  shieldedSecretKeys: ZswapSecretKeys;
  dustSecretKey: DustSecretKey;
  unshieldedAddress: string;
  /** True when this run resumed from cached sync state. */
  resumed: boolean;
  /** Persists sync state so the next run resumes instead of replaying. */
  saveState: () => Promise<void>;
}

/** Builds and starts the three-wallet facade. Caller is responsible for stop(). */
export async function buildWallet(
  secret: WalletSecret,
  network: NetworkConfig
): Promise<BuiltWallet> {
  const keys = deriveKeys(secret, network.networkId);
  const configuration = buildConfiguration(network);
  const dustParameters = LedgerParameters.initialParameters().dust;
  const seedHex = masterSeedHex(secret);

  const cached = loadWalletState(seedHex, network.networkId);

  // Captured from the builders so their state can be serialized later; the
  // facade exposes wallet *state*, not the wallet objects themselves.
  let shieldedWallet: ReturnType<ReturnType<typeof ShieldedWallet>["startWithSeed"]>;
  let unshieldedWallet: ReturnType<
    ReturnType<typeof UnshieldedWallet>["startWithPublicKey"]
  >;
  let dustWallet: ReturnType<ReturnType<typeof DustWallet>["startWithSeed"]>;

  const facade = await WalletFacade.init({
    configuration,
    // Balancing adds zswap inputs/outputs that need their own proofs; with no
    // provingService the wallet sends them to `provingServerUrl`, the same
    // proof server the contract calls use.
    shielded: (config) => {
      const w = ShieldedWallet(config);
      shieldedWallet = cached
        ? w.restore(cached.shielded)
        : w.startWithSeed(keys.shieldedSeed);
      return shieldedWallet;
    },
    unshielded: (config) => {
      const w = UnshieldedWallet(config);
      unshieldedWallet = cached
        ? w.restore(cached.unshielded)
        : w.startWithPublicKey(PublicKey.fromKeyStore(keys.unshieldedKeystore));
      return unshieldedWallet;
    },
    dust: (config) => {
      const w = DustWallet(config);
      dustWallet = cached
        ? w.restore(cached.dust)
        : w.startWithSeed(keys.dustSeed, dustParameters);
      return dustWallet;
    },
  });

  const shieldedSecretKeys = ZswapSecretKeys.fromSeed(keys.shieldedSeed);
  const dustSecretKey = DustSecretKey.fromSeed(keys.dustSeed);

  await facade.start(shieldedSecretKeys, dustSecretKey);

  return {
    facade,
    keys,
    shieldedSecretKeys,
    dustSecretKey,
    unshieldedAddress: keys.unshieldedKeystore.getBech32Address().toString(),
    resumed: cached !== null,
    saveState: async () => {
      const [shielded, unshielded, dust] = await Promise.all([
        shieldedWallet.serializeState(),
        unshieldedWallet.serializeState(),
        dustWallet.serializeState(),
      ]);
      saveWalletState(seedHex, network.networkId, { shielded, unshielded, dust });
    },
  };
}

function isComplete(progress: unknown): boolean {
  const p = progress as { isStrictlyComplete?: () => boolean } | null;
  return typeof p?.isStrictlyComplete === "function" ? p.isStrictlyComplete() : false;
}

/**
 * Renders one wallet section as "name done (applied/target)". Shielded and dust
 * report appliedIndex/highestRelevantWalletIndex; unshielded reports
 * appliedId/highestTransactionId.
 */
function formatProgress(name: string, progress: unknown): string {
  const done = isComplete(progress) ? "✓" : "…";
  const p = progress as {
    appliedIndex?: bigint;
    highestRelevantWalletIndex?: bigint;
    appliedId?: bigint;
    highestTransactionId?: bigint;
  } | null;
  const applied = p?.appliedIndex ?? p?.appliedId;
  const target = p?.highestRelevantWalletIndex ?? p?.highestTransactionId;
  if (applied === undefined || target === undefined) return `${name}${done}`;
  return `${name}${done} ${applied}/${target}`;
}

/**
 * Waits for a synced state while reporting progress. All three sections have to
 * reach strictly-complete, so reporting only one of them makes a slow shielded
 * or dust scan look like a hang — which matters on remote networks, where a
 * first sync from genesis can take a long time.
 */
export async function waitForSync(
  wallet: BuiltWallet,
  onProgress?: (line: string) => void
) {
  const sub = wallet.facade
    .state()
    .pipe(Rx.throttleTime(5000, undefined, { leading: true, trailing: true }))
    .subscribe((state) => {
      onProgress?.(
        [
          formatProgress("shielded", state.shielded.state.progress),
          formatProgress("unshielded", state.unshielded.progress),
          formatProgress("dust", state.dust.state.progress),
        ].join("  ")
      );
    });

  try {
    const state = await wallet.facade.waitForSyncedState();
    // Persist only after reaching the tip, so a cached state is always one we
    // know was complete. A failure here costs the next run a full resync but
    // must not fail the command that just synced successfully.
    try {
      await wallet.saveState();
    } catch (error) {
      onProgress?.(
        `warning: could not cache wallet state (${
          error instanceof Error ? error.message : String(error)
        })`
      );
    }
    return state;
  } finally {
    sub.unsubscribe();
  }
}

/** Current wallet state snapshot, without waiting for a fresh sync. */
export function currentState(wallet: BuiltWallet) {
  return Rx.firstValueFrom(wallet.facade.state());
}

/** Default transaction time-to-live. */
const TTL_MS = 60 * 60 * 1000;

/**
 * Adapts the wallet facade to the midnight-js provider interfaces. Balancing is
 * now a two-step recipe: balance against the wallet's coins, then finalize.
 */
export function makeWalletProviders(wallet: BuiltWallet) {
  const secretKeys = {
    shieldedSecretKeys: wallet.shieldedSecretKeys,
    dustSecretKey: wallet.dustSecretKey,
  };

  const walletProvider = {
    balanceTx: async (tx: any, ttl?: Date) => {
      const recipe = await wallet.facade.balanceUnboundTransaction(
        tx,
        secretKeys,
        { ttl: ttl ?? new Date(Date.now() + TTL_MS) }
      );
      return wallet.facade.finalizeRecipe(recipe);
    },
    getCoinPublicKey: () => wallet.shieldedSecretKeys.coinPublicKey,
    getEncryptionPublicKey: () => wallet.shieldedSecretKeys.encryptionPublicKey,
  };

  const midnightProvider = {
    submitTx: (tx: any) => wallet.facade.submitTransaction(tx),
  };

  return { walletProvider, midnightProvider };
}
