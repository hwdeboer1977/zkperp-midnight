// SPDX-License-Identifier: Apache-2.0

/**
 * A stop loss and a take profit, end to end on the local stack.
 *
 *   npm run setup:local && npm run stoploss
 *
 * The trader opens a 5x long and places a stop loss 2% below the entry, then
 * a second one on another long, which they cancel. The admin drops the mock
 * price 3% — past both stops, far from liquidation. The keeper finds the
 * first order from its note (and the position from its liquidator note),
 * never seeing the owner secret, and executes it: the trader's wallet gets the
 * collateral less the loss and the usual fees, the treasury gets the fees and
 * no liquidation fee. The cancelled order is not executable; that position
 * stays open, and the trader closes it. A third long carries a take profit 2%
 * above the entry, which the drop leaves alone; the admin then raises the
 * price 3% above the start and the keeper executes it the same way: the pool
 * pays the profit, the trader gets the collateral plus the profit less fees.
 *
 * Stop the relayer first: it would put the Chainlink price back. With the
 * keeper service running (`npm run keeper`), pass `--keeper`: the script then
 * waits for the service to execute the order instead of executing it itself.
 */

import chalk from "chalk";
import fs from "fs";
import { createHash } from "crypto";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { LOCAL, requireLocal, stackFile, walletSeed } from "../core/network.js";
import { buildWallet, waitForSync, type BuiltWallet } from "../core/wallet.js";
import { getDeployment } from "../core/contracts.js";
import { keeperSeed, liquidatorSecret, readyTrader, readyWallet, traderSeed, treasurySeed } from "../core/trader.js";
import {
  cancelOrder,
  canLiquidate,
  closePosition,
  executeOrder,
  openPosition,
  orderFires,
  placeOrder,
  readLedger,
  submitPrice,
  watchedOrders,
  watchedPositions,
  type WatchedOrder,
} from "../core/perp.js";
import { closeFeeOf, positionPnl } from "../core/math.js";
import { markClosed, type PositionRecord } from "../core/positions.js";
import { balance, handle, waitForBalance } from "../core/session.js";

const PUSDC = 1_000_000n;
const COIN = 100n * PUSDC;
const SIZE = 490n * PUSDC; // ~5x on the collateral left after the opening fee
const STOP_BPS = 200n; // the stop loss sits 2% below the entry
const DROP_BPS = 300n; // the admin moves the price down 3%
const TAKE_BPS = 200n; // the take profit sits 2% above the entry
const RISE_BPS = 300n; // then the admin moves the price up 3% from the start
const BY_SERVICE = process.argv.includes("--keeper");

const step = (s: string) => console.log(`\n${chalk.blue.bold("▶")} ${chalk.bold(s)}`);
const info = (s: string) => console.log(chalk.gray(`   ${s}`));
const fmt = (m: bigint) => `${m / PUSDC}.${(m % PUSDC).toString().padStart(6, "0")}`;
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`   ${ok ? chalk.green("✓") : chalk.red("✗")} ${name}${ok || !detail ? "" : chalk.gray(` (${detail})`)}`);
}
const timed = async <T>(what: string, f: () => Promise<T>): Promise<T> => {
  const t = Date.now();
  const r = await f();
  info(`${what} in ${((Date.now() - t) / 1000).toFixed(1)} s`);
  return r;
};

async function main() {
  requireLocal("npm run stoploss");
  setNetworkId(LOCAL.networkId);
  const perpAddress = getDeployment(LOCAL.networkId, "zkperp");
  const file = stackFile(LOCAL);
  if (!perpAddress || !fs.existsSync(file)) throw new Error("no local stack: run npm run setup:local first");
  const stack = JSON.parse(fs.readFileSync(file, "utf8"));
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
    if (l0.orderNotes === undefined) throw new Error("this deployment predates trigger orders: run npm run setup:local again");
    const usdc: Uint8Array = l0.usdc;
    const p0: bigint = l0.markPrice;
    info(`zkperp ${perpAddress} at $${fmt(p0)}`);

    step("The trader opens three 5x longs");
    await submitPrice(devPerp, p0, adminSecret);
    const before = await balance(trader, usdc);
    const first = await timed("opened the first", () => openPosition(traderPerp, usdc, COIN, SIZE, true, LOCAL.networkId));
    const second = await timed("opened the second", () => openPosition(traderPerp, usdc, COIN, SIZE, true, LOCAL.networkId));
    const third = await timed("opened the third", () => openPosition(traderPerp, usdc, COIN, SIZE, true, LOCAL.networkId));
    const entry = BigInt(first.record.opening.entryPrice);
    info(`size ${fmt(SIZE)} on ${fmt(BigInt(first.record.opening.collateral))} each, at $${fmt(entry)}`);
    await waitForBalance(trader, usdc, (b) => b <= before - 3n * COIN);

    step(`The trader places a stop loss ${Number(STOP_BPS) / 100}% below the entry on the first two`);
    const stop = (entry * (10_000n - STOP_BPS)) / 10_000n;
    const placed = await timed("placed the first", () => placeOrder(traderPerp, first.record, "stopLoss", stop));
    const placed2 = await timed("placed the second", () => placeOrder(traderPerp, second.record, "stopLoss", stop));
    info(`stop at $${fmt(stop)} (tx ${placed.txHash.slice(0, 16)}…)`);
    check("a long's stop loss fires at or below its level", placed.order.above === false);

    step(`The trader places a take profit ${Number(TAKE_BPS) / 100}% above the entry on the third`);
    const take = (BigInt(third.record.opening.entryPrice) * (10_000n + TAKE_BPS)) / 10_000n;
    const placed3 = await timed("placed", () => placeOrder(traderPerp, third.record, "takeProfit", take));
    info(`take profit at $${fmt(take)} (tx ${placed3.txHash.slice(0, 16)}…)`);
    check("a long's take profit fires at or above its level", placed3.order.above === true);

    step("The trader cancels the second");
    await timed("cancelled", () => cancelOrder(traderPerp, second.record, placed2.order));

    step("The keeper reads the orders from their notes");
    const ordersNow = async () => {
      const ledger = await readLedger(keeperPerp);
      const orders = watchedOrders(keeperPerp, ledger, secret, watchedPositions(keeperPerp, ledger, secret));
      const of = (r: { commitment: string }) => orders.find((o) => o.position.commitment === r.commitment);
      return { ledger, orders, of };
    };
    let now = await ordersNow();
    const mine = now.of(first.record);
    const tp = now.of(third.record);
    check("the keeper's secret opens the stop loss's note", mine !== undefined);
    check("and the take profit's", tp !== undefined);
    if (!mine || !tp) throw new Error("the keeper does not see the orders");
    check("the notes carry the trader's levels", mine.order.price === stop && tp.order.price === take, `$${fmt(mine.order.price)}, $${fmt(tp.order.price)}`);
    check("the cancelled order is not among the keeper's", now.of(second.record) === undefined);
    check("at the entry price neither order fires", !orderFires(now.ledger, mine) && !orderFires(now.ledger, tp));

    // Executes `firing` (or waits for the keeper service to), then checks the
    // pool, the treasury and the trader's wallet against the position's PnL.
    const settle = async (firing: WatchedOrder, record: PositionRecord, what: string) => {
      const ledger = (await ordersNow()).ledger;
      const traderBefore = await balance(trader, usdc);
      const treasuryBefore = await balance(treasury, usdc);
      const poolBefore: bigint = ledger.poolValue;
      const nullifier = devPerp.module.pureCircuits.positionNullifier(firing.position.position.salt);
      // The PnL and the trader's share do not depend on who executes; the borrow
      // fee does, by the second the executor names, so the treasury's receipt is
      // measured and the trader's share checked against what the coin held.
      const p = firing.position.position;
      const r = positionPnl(p.isLong, p.size, p.entryPrice, ledger.markPrice, ledger.maxPayout);
      const gain = r.profit ? r.pnl : -r.pnl; // the trader's, signed
      if (BY_SERVICE) {
        const t = Date.now();
        while (!(await readLedger(devPerp)).closed.member(nullifier)) {
          if (Date.now() - t > 300_000) throw new Error(`the keeper service did not execute the ${what} within 5 minutes`);
          await new Promise((r) => setTimeout(r, 3000));
        }
        info(`executed by the service ${((Date.now() - t) / 1000).toFixed(1)} s after the price moved`);
      } else {
        const x = await timed("executed (proof included)", () => executeOrder(keeperPerp, firing, usdc, treasuryEncKey));
        info(`executed ${x.txHash.slice(0, 16)}…: to treasury ${fmt(x.settled.toTreasury)}, to trader ${fmt(x.settled.toTrader)}`);
      }
      markClosed(record.commitment, "");
      const after = await readLedger(devPerp);
      check(
        r.profit ? "the pool paid the profit" : "the pool gained the loss",
        after.poolValue === poolBefore - gain,
        `${fmt((after.poolValue as bigint) - poolBefore)} vs ${fmt(-gain)}`
      );
      check("the position's nullifier is spent", after.closed.member(nullifier));
      const treasuryAfter = await waitForBalance(treasury, usdc, (b) => b > treasuryBefore);
      const toTreasury = treasuryAfter - treasuryBefore;
      const closeFee = closeFeeOf(p.size, BigInt(ledger.closeFeeBps));
      check(
        "the treasury received the opening, closing and borrow fees, and no liquidation fee",
        toTreasury >= p.openFee + closeFee && toTreasury < p.openFee + closeFee + PUSDC,
        fmt(toTreasury)
      );
      const toTrader = p.collateral + p.openFee + gain - toTreasury;
      const traderAfter = await waitForBalance(trader, usdc, (b) => b >= traderBefore + toTrader);
      check(
        r.profit
          ? "the trader's wallet received the collateral plus the profit, less fees"
          : "the trader's wallet received the rest of the coin: collateral less the loss and fees",
        traderAfter - traderBefore === toTrader,
        `${fmt(traderAfter - traderBefore)} vs ${fmt(toTrader)}`
      );
      info(`${r.profit ? "profit" : "loss"} ${fmt(r.pnl)}${r.capped ? " (capped)" : ""}, to treasury ${fmt(toTreasury)}, to trader ${fmt(toTrader)}`);

      let refused = false;
      try {
        await closePosition(traderPerp, { ...record, status: "open" }, usdc, treasuryEncKey);
      } catch (error) {
        refused = /already closed/.test(String(error instanceof Error ? error.message : error));
        if (!refused) info(`refused with: ${String(error).slice(0, 200)}`);
      }
      check(`the trader can no longer close it after the ${what}`, refused);
    };

    step(`The admin drops the price ${Number(DROP_BPS) / 100}%`);
    const low = (p0 * (10_000n - DROP_BPS)) / 10_000n;
    await submitPrice(devPerp, low, adminSecret);
    now = await ordersNow();
    const firing = now.of(first.record);
    const tpLow = now.of(third.record);
    info(`price $${fmt(now.ledger.markPrice)}`);
    check("now the stop loss fires", firing !== undefined && orderFires(now.ledger, firing));
    check("the take profit does not", tpLow !== undefined && !orderFires(now.ledger, tpLow));
    check("the position is far from liquidation", firing !== undefined && !canLiquidate(now.ledger, firing.position));
    if (!firing) throw new Error("the order went missing");

    step(BY_SERVICE ? "The keeper service executes the stop loss" : "The keeper executes the stop loss");
    await settle(firing, first.record, "stop loss");

    step("The second position, whose stop was cancelled, is still open");
    const stillOpen = watchedPositions(keeperPerp, await readLedger(keeperPerp), secret).some(
      (w) => w.commitment === second.record.commitment
    );
    check("it was not closed", stillOpen);
    const closed = await timed("the trader closed it", () => closePosition(traderPerp, second.record, usdc, treasuryEncKey));
    info(`loss ${fmt(closed.pnl)} (tx ${closed.txHash.slice(0, 16)}…)`);

    step(`The admin raises the price ${Number(RISE_BPS) / 100}% above the start`);
    const high = (p0 * (10_000n + RISE_BPS)) / 10_000n;
    await submitPrice(devPerp, high, adminSecret);
    now = await ordersNow();
    const tpFiring = now.of(third.record);
    info(`price $${fmt(now.ledger.markPrice)}`);
    check("now the take profit fires", tpFiring !== undefined && orderFires(now.ledger, tpFiring));
    if (!tpFiring) throw new Error("the take profit went missing");

    step(BY_SERVICE ? "The keeper service executes the take profit" : "The keeper executes the take profit");
    await settle(tpFiring, third.record, "take profit");

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
