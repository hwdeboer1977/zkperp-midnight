// SPDX-License-Identifier: Apache-2.0

/**
 * The keeper: liquidates positions whose equity fell below maintenance margin.
 *
 *   npm run keeper
 *
 * Every open writes a liquidator note, encrypted in the circuit to the
 * liquidator key (see `sealLiquidatorNote` in contracts/zkperp.compact). The
 * keeper holds that key's secret, so it reads every live position — size,
 * direction, entry, collateral, everything but the owner secret — and on each
 * tick submits `liquidatePosition` for those below maintenance at the current
 * price. The fee goes to the treasury; what equity remains goes to the trader.
 *
 * ⚠️ Whoever runs this sees every position. That is the trust the design
 * accepts; see docs/privacy.md.
 *
 * It decrypts each note once and keeps the plaintext in memory:
 * `transientHash`, which the masks use, is not promised to stay the same
 * across compiler versions, so notes are read while the code that wrote them
 * is current.
 *
 * Submits from its own wallet (KEEPER_SEED, or derived from the dev seed),
 * not the dev wallet the relayer uses, so the two never race for coins.
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import chalk from "chalk";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { LOCAL, walletSeed } from "../../core/network.js";
import { buildWallet, waitForSync } from "../../core/wallet.js";
import { getDeployment } from "../../core/contracts.js";
import {
  canLiquidate,
  circuitNow,
  liquidatePosition,
  liquidationPrice,
  readLedger,
  watchedPositions,
  type ContractHandle,
} from "../../core/perp.js";
import { keeperSeed, liquidatorSecret, readyWallet } from "../../core/trader.js";
import { handle } from "../../core/session.js";

const CHECK_MS = Number(process.env.KEEPER_CHECK_MS ?? 15_000);
const STACK_FILE = path.join(process.cwd(), ".zkperp", "local-stack.json");

const log = (s: string) => console.log(`${new Date().toISOString()} ${s}`);
const fmt = (m: bigint) => `${m / 1_000_000n}.${(m % 1_000_000n).toString().padStart(6, "0")}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  setNetworkId(LOCAL.networkId);
  const perpAddress = getDeployment(LOCAL.networkId, "zkperp");
  if (!perpAddress) throw new Error("no current zkperp deployment: run npm run setup:local first");
  if (!fs.existsSync(STACK_FILE)) throw new Error(`${STACK_FILE} is missing: run npm run setup:local first`);
  const stack = JSON.parse(fs.readFileSync(STACK_FILE, "utf8"));
  const treasuryEncKey: string = stack.treasury.encryptionPublicKey;

  const devSeed = walletSeed();
  const secret = liquidatorSecret(devSeed);
  log("syncing the keeper wallet…");
  const seed = keeperSeed(devSeed);
  const fundFromDev = async () => {
    const dev = await buildWallet({ kind: "seed", value: devSeed }, LOCAL);
    await waitForSync(dev, () => {});
    return dev;
  };
  const wallet = await readyWallet(fundFromDev, seed, LOCAL, log, "keeper");
  const perp: ContractHandle = await handle(wallet, seed, "zkperp", perpAddress);

  const ledger0 = await readLedger(perp);
  const ourKey = perp.module.pureCircuits.liquidatorPublicKey(secret);
  if (ledger0.liquidator.x !== ourKey.x || ledger0.liquidator.y !== ourKey.y) {
    throw new Error("this zkperp encrypts to a different liquidator key; redeploy with npm run setup:local");
  }
  const usdc: Uint8Array = ledger0.usdc;
  log(chalk.green(`keeper ready on ${perpAddress}, checking every ${CHECK_MS / 1000}s`));

  const seen = new Set<string>();
  for (;;) {
    try {
      const ledger = await readLedger(perp);
      const live = watchedPositions(perp, ledger, secret);
      for (const w of live) {
        if (seen.has(w.commitment)) continue;
        seen.add(w.commitment);
        const p = w.position;
        log(
          `watching ${w.commitment.slice(0, 12)}…: ${p.isLong ? "long" : "short"} ${fmt(p.size)} on ${fmt(p.collateral)} ` +
            `from $${fmt(p.entryPrice)}, liquidation near $${fmt(liquidationPrice(p, ledger, circuitNow()))}`
        );
      }
      for (const w of live.filter((x) => canLiquidate(ledger, x))) {
        log(chalk.yellow(`liquidating ${w.commitment.slice(0, 12)}… at $${fmt(ledger.markPrice)}`));
        try {
          const r = await liquidatePosition(perp, w, usdc, treasuryEncKey);
          log(
            chalk.green(
              `liquidated ${w.commitment.slice(0, 12)}…: loss ${fmt(r.settled.toPool)} to the pool, ` +
                `${fmt(r.settled.toTreasury)} to the treasury, ${fmt(r.settled.toTrader)} back to the trader (tx ${r.txHash.slice(0, 12)}…)`
            )
          );
        } catch (error) {
          // Most often the price moved or the trader closed first; the next tick decides again.
          log(chalk.red(`liquidation failed: ${error instanceof Error ? error.message : String(error)}`));
        }
      }
    } catch (error) {
      log(chalk.red(`tick failed: ${error instanceof Error ? error.message : String(error)}`));
    }
    await sleep(CHECK_MS);
  }
}

main().catch((error) => {
  console.error(chalk.red(`\n✗ ${error instanceof Error ? error.stack ?? error.message : String(error)}`));
  process.exit(1);
});
