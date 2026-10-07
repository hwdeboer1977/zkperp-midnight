// SPDX-License-Identifier: Apache-2.0

/**
 * Wallets besides the dev wallet, each funded from it on first use:
 *
 *   trader    separate from the dev wallet that deploys, provides liquidity
 *             and runs the oracle, so that a payout reaching the RIGHT wallet
 *             is something the demo can actually observe;
 *   treasury  receives every fee, and pays the LPs' share into the pool per
 *             epoch. Its own wallet, so its balance is fees and nothing else.
 *
 * Funded from the dev wallet on first use: NIGHT is sent, then registered for
 * DUST generation so the trader can pay its own fees. Pattern from
 * midnight-polisZK's treasury-night.ts.
 */

import { createHash } from "crypto";
import { MidnightBech32m, UnshieldedAddress } from "@midnight-ntwrk/wallet-sdk-address-format";
import { nativeToken } from "@midnight-ntwrk/ledger-v8";
import { scalarFrom } from "./liquidatorNote.js";
import type { NetworkConfig } from "./network.js";
import { buildWallet, currentState, waitForSync, type BuiltWallet } from "./wallet.js";

const NIGHT = nativeToken().raw;
/**
 * NIGHT given to each derived wallet (trader, treasury, keeper), in the
 * smallest unit: NIGHT_PER_WALLET, or 100 NIGHT. DUST accrues in proportion to
 * the NIGHT held, and registering costs about 0.3 DUST, so a handful of NIGHT
 * leaves a wallet waiting many minutes for its first transaction.
 */
const NIGHT_FOR_TRADER = BigInt(process.env.NIGHT_PER_WALLET ?? 100_000_000);
const nightText = (n: bigint) => `${n / 1_000_000n}.${(n % 1_000_000n).toString().padStart(6, "0")}`;

function seedFor(role: "trader" | "treasury" | "keeper", devSeed: string): string {
  const variable = `${role.toUpperCase()}_SEED`;
  const explicit = process.env[variable]?.trim();
  if (explicit) {
    if (!/^[0-9a-fA-F]{64}$/.test(explicit)) throw new Error(`${variable} must be 64 hex characters`);
    return explicit;
  }
  return createHash("sha256").update(`zkperp-${role}:${devSeed}`).digest("hex");
}

/** TRADER_SEED, or one derived from the dev seed so reruns reuse the same trader. */
export const traderSeed = (devSeed: string) => seedFor("trader", devSeed);

/** TREASURY_SEED, or one derived from the dev seed. */
export const treasurySeed = (devSeed: string) => seedFor("treasury", devSeed);

/** KEEPER_SEED, or one derived from the dev seed: the wallet that submits liquidations. */
export const keeperSeed = (devSeed: string) => seedFor("keeper", devSeed);

/**
 * The liquidator's secret scalar: LIQUIDATOR_SECRET (hex), or one derived from
 * the dev seed. Every open encrypts its position to this key's public half,
 * so whoever holds it sees every position; see docs/privacy.md.
 */
export function liquidatorSecret(devSeed: string): bigint {
  const explicit = process.env.LIQUIDATOR_SECRET?.trim();
  const raw = explicit
    ? Buffer.from(explicit.replace(/^0x/, "").padStart(128, "0"), "hex")
    : createHash("sha512").update(`zkperp-liquidator:${devSeed}`).digest();
  return scalarFrom(raw);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function nightOf(state: any): bigint {
  return ((state.unshielded as any).balances ?? {})[NIGHT] ?? 0n;
}

/** Sends `amount` NIGHT from `from` to an unshielded address. Returns the transaction id. */
export async function sendNight(
  from: BuiltWallet,
  receiverAddress: string,
  amount: bigint,
  network: NetworkConfig
): Promise<string> {
  const recipe = await from.facade.transferTransaction(
    [
      {
        type: "unshielded" as const,
        outputs: [
          {
            type: NIGHT,
            receiverAddress: MidnightBech32m.parse(receiverAddress).decode(UnshieldedAddress, network.networkId as never),
            amount,
          },
        ],
      },
    ],
    { shieldedSecretKeys: from.shieldedSecretKeys, dustSecretKey: from.dustSecretKey },
    { ttl: new Date(Date.now() + 60 * 60 * 1000) }
  );
  const signed = await from.facade.signRecipe(recipe, (data) => from.keys.unshieldedKeystore.signData(data));
  return from.facade.submitTransaction((await from.facade.finalizeRecipe(signed)) as any);
}

/**
 * Returns a synced wallet that can pay fees. Sends NIGHT and registers it for
 * DUST only when the wallet has none yet. `name` is for the log.
 *
 * `funder` may be a function that builds the funding wallet: it is then
 * built only if funding is needed. A long-running service should pass one, so
 * it does not sync — and write the sync cache of — a wallet another process
 * is using.
 */
export async function readyWallet(
  funder: BuiltWallet | (() => Promise<BuiltWallet>),
  seed: string,
  network: NetworkConfig,
  log: (line: string) => void,
  name: string
): Promise<BuiltWallet> {
  const wallet = await buildWallet({ kind: "seed", value: seed }, network);
  // On a public network a sync can take minutes: say so, at most every 30 s.
  let lastProgress = 0;
  const progress = (line: string) => {
    if (Date.now() - lastProgress < 30_000) return;
    lastProgress = Date.now();
    log(`   ${name} syncing: ${line}`);
  };
  try {
    await waitForSync(wallet, progress);
    let state = await currentState(wallet);
    if (state.dust.balance(new Date()) > 0n) return wallet;

    if (nightOf(state) === 0n) {
      const built = typeof funder === "function" ? await funder() : undefined;
      const dev = built ?? (funder as BuiltWallet);
      try {
        log(`sending ${nightText(NIGHT_FOR_TRADER)} NIGHT from the operator wallet to the ${name}…`);
        const txId = await sendNight(dev, wallet.unshieldedAddress, NIGHT_FOR_TRADER, network);
        log(`   sent: ${txId}`);
      } finally {
        await built?.facade.stop();
      }
    }

    // The NIGHT appears in the wallet's wallet a few blocks later.
    let utxos: readonly any[] = [];
    const deadline = Date.now() + 15 * 60 * 1000;
    for (;;) {
      await waitForSync(wallet, progress);
      state = await currentState(wallet);
      const all = (state.unshielded as any).availableCoins as readonly any[];
      utxos = all.filter((u) => u.utxo?.type === NIGHT && !u.meta?.registeredForDustGeneration);
      if (utxos.length > 0 || all.some((u) => u.utxo?.type === NIGHT)) break;
      if (Date.now() > deadline) throw new Error(`the ${name}'s NIGHT did not arrive within 15 minutes; run this again`);
      await sleep(3000);
    }

    if (utxos.length > 0) {
      log(`registering the ${name}'s NIGHT for DUST generation…`);
      const { fee } = await wallet.facade.estimateRegistration(utxos);
      await wallet.facade.waitForGeneratedDust(utxos, fee);
      const recipe = await wallet.facade.registerNightUtxosForDustGeneration(
        utxos,
        wallet.keys.unshieldedKeystore.getPublicKey(),
        (payload) => wallet.keys.unshieldedKeystore.signData(payload)
      );
      const txId = await wallet.facade.submitTransaction(
        (await wallet.facade.finalizeRecipe(recipe)) as any
      );
      log(`   registered: ${txId}`);
    }

    log(`waiting for the ${name}'s DUST to accrue…`);
    const dustDeadline = Date.now() + 15 * 60 * 1000;
    let lastReport = Date.now();
    for (;;) {
      await waitForSync(wallet, progress);
      state = await currentState(wallet);
      if (state.dust.balance(new Date()) > 0n) break;
      if (Date.now() - lastReport > 30_000) {
        lastReport = Date.now();
        log(`   ${name}: still no DUST (${Math.round((dustDeadline - Date.now()) / 60_000)} min left)`);
      }
      if (Date.now() > dustDeadline) throw new Error(`the ${name} has no DUST after 15 minutes; run this again`);
      await sleep(3000);
    }
    return wallet;
  } catch (error) {
    await wallet.facade.stop();
    throw error;
  }
}

export const readyTrader = (dev: BuiltWallet, seed: string, network: NetworkConfig, log: (line: string) => void) =>
  readyWallet(dev, seed, network, log, "trader");
