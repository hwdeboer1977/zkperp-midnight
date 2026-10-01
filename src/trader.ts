// SPDX-License-Identifier: Apache-2.0

/**
 * The trader's wallet: separate from the dev wallet that deploys, provides
 * liquidity and runs the oracle, so that a payout reaching the RIGHT wallet is
 * something the demo can actually observe.
 *
 * Funded from the dev wallet on first use: NIGHT is sent, then registered for
 * DUST generation so the trader can pay its own fees. Pattern from
 * midnight-polisZK's treasury-night.ts.
 */

import { createHash } from "crypto";
import { MidnightBech32m, UnshieldedAddress } from "@midnight-ntwrk/wallet-sdk-address-format";
import { nativeToken } from "@midnight-ntwrk/ledger-v8";
import type { NetworkConfig } from "./network.js";
import { buildWallet, currentState, waitForSync, type BuiltWallet } from "./wallet.js";

const NIGHT = nativeToken().raw;
const NIGHT_FOR_TRADER = 5_000_000n;

/** TRADER_SEED, or one derived from the dev seed so reruns reuse the same trader. */
export function traderSeed(devSeed: string): string {
  const explicit = process.env.TRADER_SEED?.trim();
  if (explicit) {
    if (!/^[0-9a-fA-F]{64}$/.test(explicit)) throw new Error("TRADER_SEED must be 64 hex characters");
    return explicit;
  }
  return createHash("sha256").update(`zkperp-trader:${devSeed}`).digest("hex");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function nightOf(state: any): bigint {
  return ((state.unshielded as any).balances ?? {})[NIGHT] ?? 0n;
}

/**
 * Returns a synced trader wallet that can pay fees. Sends NIGHT and registers
 * it for DUST only when the trader has none yet.
 */
export async function readyTrader(
  dev: BuiltWallet,
  seed: string,
  network: NetworkConfig,
  log: (line: string) => void
): Promise<BuiltWallet> {
  const trader = await buildWallet({ kind: "seed", value: seed }, network);
  try {
    await waitForSync(trader, () => {});
    let state = await currentState(trader);
    if (state.dust.balance(new Date()) > 0n) return trader;

    if (nightOf(state) === 0n) {
      log(`sending ${NIGHT_FOR_TRADER} NIGHT from the dev wallet to the trader…`);
      const recipe = await dev.facade.transferTransaction(
        [
          {
            type: "unshielded" as const,
            outputs: [
              {
                type: NIGHT,
                receiverAddress: MidnightBech32m.parse(trader.unshieldedAddress).decode(
                  UnshieldedAddress,
                  network.networkId as never
                ),
                amount: NIGHT_FOR_TRADER,
              },
            ],
          },
        ],
        { shieldedSecretKeys: dev.shieldedSecretKeys, dustSecretKey: dev.dustSecretKey },
        { ttl: new Date(Date.now() + 60 * 60 * 1000) }
      );
      const signed = await dev.facade.signRecipe(recipe, (data) =>
        dev.keys.unshieldedKeystore.signData(data)
      );
      const txId = await dev.facade.submitTransaction((await dev.facade.finalizeRecipe(signed)) as any);
      log(`   sent: ${txId}`);
    }

    // The NIGHT appears in the trader's wallet a few blocks later.
    let utxos: readonly any[] = [];
    const deadline = Date.now() + 5 * 60 * 1000;
    for (;;) {
      await waitForSync(trader, () => {});
      state = await currentState(trader);
      const all = (state.unshielded as any).availableCoins as readonly any[];
      utxos = all.filter((u) => u.utxo?.type === NIGHT && !u.meta?.registeredForDustGeneration);
      if (utxos.length > 0 || all.some((u) => u.utxo?.type === NIGHT)) break;
      if (Date.now() > deadline) throw new Error("the trader's NIGHT did not arrive within five minutes");
      await sleep(3000);
    }

    if (utxos.length > 0) {
      log("registering the trader's NIGHT for DUST generation…");
      const { fee } = await trader.facade.estimateRegistration(utxos);
      await trader.facade.waitForGeneratedDust(utxos, fee);
      const recipe = await trader.facade.registerNightUtxosForDustGeneration(
        utxos,
        trader.keys.unshieldedKeystore.getPublicKey(),
        (payload) => trader.keys.unshieldedKeystore.signData(payload)
      );
      const txId = await trader.facade.submitTransaction(
        (await trader.facade.finalizeRecipe(recipe)) as any
      );
      log(`   registered: ${txId}`);
    }

    log("waiting for the trader's DUST to accrue…");
    const dustDeadline = Date.now() + 5 * 60 * 1000;
    for (;;) {
      await waitForSync(trader, () => {});
      state = await currentState(trader);
      if (state.dust.balance(new Date()) > 0n) break;
      if (Date.now() > dustDeadline) throw new Error("the trader has no DUST after five minutes");
      await sleep(3000);
    }
    return trader;
  } catch (error) {
    await trader.facade.stop();
    throw error;
  }
}
