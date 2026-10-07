// SPDX-License-Identifier: Apache-2.0

/**
 * Liquidation, end to end on the local stack.
 *
 *   npm run setup:local && npm run liquidation
 *
 * The trader opens a 19x long; the admin drops the mock price 3.5%; the keeper
 * finds the position from its liquidator note — which it decrypts with the
 * liquidator secret, never seeing the owner secret — and liquidates it. Then:
 * the trader's wallet receives the equity left, which proves the output was
 * encrypted to the trader's key carried in the note; the treasury gets the
 * fees and the liquidation fee; the position can no longer be closed.
 *
 * Stop the relayer first: it would put the Chainlink price back.
 */

import chalk from "chalk";
import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { LOCAL, walletSeed } from "../core/network.js";
import { buildWallet, waitForSync, type BuiltWallet } from "../core/wallet.js";
import { getDeployment } from "../core/contracts.js";
import { keeperSeed, liquidatorSecret, readyTrader, readyWallet, traderSeed, treasurySeed } from "../core/trader.js";
import {
  canLiquidate,
  closePosition,
  liquidatePosition,
  liquidationPrice,
  openPosition,
  readLedger,
  reservedOf,
  submitPrice,
  watchedPositions,
  circuitNow,
} from "../core/perp.js";
import { markClosed } from "../core/positions.js";
import { balance, handle, waitForBalance } from "../core/session.js";

const PUSDC = 1_000_000n;
const COIN = 100n * PUSDC;
const SIZE = 1_900n * PUSDC; // ~19x on the collateral left after the opening fee
const DROP_BPS = 350n; // the admin moves the price down 3.5%

const step = (s: string) => console.log(`\n${chalk.blue.bold("▶")} ${chalk.bold(s)}`);
const info = (s: string) => console.log(chalk.gray(`   ${s}`));
const fmt = (m: bigint) => `${m / PUSDC}.${(m % PUSDC).toString().padStart(6, "0")}`;
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`   ${ok ? chalk.green("✓") : chalk.red("✗")} ${name}${ok || !detail ? "" : chalk.gray(` (${detail})`)}`);
}

async function main() {
  setNetworkId(LOCAL.networkId);
  const perpAddress = getDeployment(LOCAL.networkId, "zkperp");
  const stackFile = path.join(process.cwd(), ".zkperp", "local-stack.json");
  if (!perpAddress || !fs.existsSync(stackFile)) throw new Error("no local stack: run npm run setup:local first");
  const stack = JSON.parse(fs.readFileSync(stackFile, "utf8"));
  const treasuryEncKey: string = stack.treasury.encryptionPublicKey;

  const devSeed = walletSeed();
  const adminSecret = createHash("sha256").update(`zkperp-admin:${devSeed}`).digest();
  const secret = liquidatorSecret(devSeed);

  step("Wallets");
  const wallets: BuiltWallet[] = [];
  try {
    const dev = await buildWallet({ kind: "seed", value: devSeed }, LOCAL);
    wallets.push(dev);
    await waitForSync(dev, () => {});
    const trader = await readyTrader(dev, traderSeed(devSeed), LOCAL, info);
    wallets.push(trader);
    const keeper = await readyWallet(dev, keeperSeed(devSeed), LOCAL, info, "keeper");
    wallets.push(keeper);
    const treasury = await readyWallet(dev, treasurySeed(devSeed), LOCAL, info, "treasury");
    wallets.push(treasury);

    const devPerp = await handle(dev, devSeed, "zkperp", perpAddress);
    const traderPerp = await handle(trader, traderSeed(devSeed), "zkperp", perpAddress);
    const keeperPerp = await handle(keeper, keeperSeed(devSeed), "zkperp", perpAddress);
    const l0 = await readLedger(devPerp);
    const usdc: Uint8Array = l0.usdc;
    const p0: bigint = l0.markPrice;
    info(`zkperp ${perpAddress} at $${fmt(p0)}, maintenance ${l0.maintenanceBps} bps, liquidation fee ${l0.liquidationFeeBps} bps`);
    if (reservedOf(l0) !== 0n) info("note: other positions are open on this deployment");

    step("The trader opens a 19x long");
    // A fresh price, so the open is not refused as stale.
    await submitPrice(devPerp, p0, adminSecret);
    const before = await balance(trader, usdc);
    const opened = await openPosition(traderPerp, usdc, COIN, SIZE, true, LOCAL.networkId);
    const o = opened.record.opening;
    info(`opened ${opened.txHash.slice(0, 16)}…: size ${fmt(SIZE)} on ${fmt(BigInt(o.collateral))} at $${fmt(BigInt(o.entryPrice))}`);
    const posted = await waitForBalance(trader, usdc, (b) => b < before);
    check("the trader posted the coin", before - posted === COIN, `${fmt(before)} → ${fmt(posted)}`);

    step("The keeper reads it from its liquidator note");
    let ledger = await readLedger(keeperPerp);
    const watched = watchedPositions(keeperPerp, ledger, secret).find((w) => w.commitment === opened.record.commitment);
    check("the keeper's secret opens the note into this position", watched !== undefined);
    if (!watched) throw new Error("the keeper does not see the position");
    check(
      "the note carries the trader's real payout key",
      Buffer.from(watched.position.payTo.bytes).toString("hex") === o.payTo
    );
    info(`liquidation near $${fmt(liquidationPrice(watched.position, ledger, circuitNow()))}`);
    check("at the entry price it is not liquidatable", !canLiquidate(ledger, watched));

    step(`The admin drops the price ${Number(DROP_BPS) / 100}%`);
    const low = (p0 * (10_000n - DROP_BPS)) / 10_000n;
    await submitPrice(devPerp, low, adminSecret);
    ledger = await readLedger(keeperPerp);
    info(`price $${fmt(ledger.markPrice)}`);
    check("now it is below maintenance", canLiquidate(ledger, watched));

    step("The keeper liquidates");
    const traderBefore = await balance(trader, usdc);
    const treasuryBefore = await balance(treasury, usdc);
    const poolBefore: bigint = ledger.poolValue;
    const liq = await liquidatePosition(keeperPerp, watched, usdc, treasuryEncKey);
    markClosed(opened.record.commitment, liq.txHash);
    info(
      `liquidated ${liq.txHash.slice(0, 16)}…: loss ${fmt(liq.settled.toPool)}, to treasury ${fmt(liq.settled.toTreasury)}, ` +
        `to trader ${fmt(liq.settled.toTrader)}`
    );
    const after = await readLedger(devPerp);
    check("the pool gained the loss", after.poolValue === poolBefore + liq.settled.toPool, fmt((after.poolValue as bigint) - poolBefore));
    check(
      "the nullifier is spent",
      after.closed.member(devPerp.module.pureCircuits.positionNullifier(watched.position.salt))
    );
    const traderAfter = await waitForBalance(trader, usdc, (b) => b >= traderBefore + liq.settled.toTrader);
    check(
      "the trader's wallet received the equity left, and can see it",
      traderAfter - traderBefore === liq.settled.toTrader,
      `${fmt(traderAfter - traderBefore)} vs ${fmt(liq.settled.toTrader)}`
    );
    const treasuryAfter = await waitForBalance(treasury, usdc, (b) => b >= treasuryBefore + liq.settled.toTreasury);
    check(
      "the treasury received the fees and the liquidation fee",
      treasuryAfter - treasuryBefore === liq.settled.toTreasury,
      `${fmt(treasuryAfter - treasuryBefore)} vs ${fmt(liq.settled.toTreasury)}`
    );

    step("The trader can no longer close it");
    let refused = false;
    try {
      await closePosition(traderPerp, { ...opened.record, status: "open" }, usdc, treasuryEncKey);
    } catch (error) {
      refused = /already closed/.test(String(error instanceof Error ? error.message : error));
      if (!refused) info(`refused with: ${String(error).slice(0, 200)}`);
    }
    check("a close after the liquidation is refused", refused);

    step("Restoring the price");
    await submitPrice(devPerp, p0, adminSecret);
    info(`price $${fmt(p0)}`);
  } finally {
    for (const w of wallets) await w.facade.stop();
  }
  console.log(failures === 0 ? chalk.green.bold("\nall checks passed\n") : chalk.red.bold(`\n${failures} check(s) failed\n`));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(chalk.red(`\n✗ ${error instanceof Error ? error.stack ?? error.message : String(error)}`));
  process.exit(1);
});
