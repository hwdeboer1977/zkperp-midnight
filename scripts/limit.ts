// SPDX-License-Identifier: Apache-2.0

/**
 * Limit orders, end to end on the local stack.
 *
 *   npm run setup:local && npm run limit
 *
 * The trader places a 5x long limit 2% below the mark price, a 5x short limit
 * 2% above, and a third long limit 5% below, which they cancel: its coin comes
 * back. The admin drops the mock price 3%; the keeper finds the long from its
 * note, never seeing the owner secret, and fills it at the new mark, opening
 * the position with the coin the order holds. The admin then raises the price
 * 3% above the start and the keeper fills the short. The trader rebuilds both
 * positions from the published fills and closes them: the long in profit,
 * the short flat.
 *
 * Stop the relayer first: it would put the Chainlink price back. With the
 * keeper service running (`npm run keeper`), pass `--keeper`: the script then
 * waits for the service to fill the orders instead of filling them itself.
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
  cancelLimitOrder,
  closePosition,
  executeLimitOrder,
  limitFillOf,
  limitFires,
  placeLimitOrder,
  readLedger,
  submitPrice,
  watchedLimits,
  watchedPositions,
} from "../core/perp.js";
import { updateLimit, type LimitRecord } from "../core/limitRecords.js";
import type { PositionRecord } from "../core/types.js";
import { balance, handle, waitForBalance } from "../core/session.js";

const PUSDC = 1_000_000n;
const COIN = 100n * PUSDC;
const SIZE = 490n * PUSDC; // ~5x on the collateral left after the opening fee
const LIMIT_BPS = 200n; // the long's limit 2% below the start, the short's 2% above
const FAR_BPS = 500n; // the cancelled long's, 5% below
const MOVE_BPS = 300n; // the admin moves the price 3% each way
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
  requireLocal("npm run limit");
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
    if (l0.limitNotes === undefined) throw new Error("this deployment predates limit orders: run npm run setup:local again");
    const usdc: Uint8Array = l0.usdc;
    const p0: bigint = l0.markPrice;
    info(`zkperp ${perpAddress} at $${fmt(p0)}`);
    await submitPrice(devPerp, p0, adminSecret);

    step("The trader places three limit orders");
    const before = await balance(trader, usdc);
    const buyAt = (p0 * (10_000n - LIMIT_BPS)) / 10_000n;
    const sellAt = (p0 * (10_000n + LIMIT_BPS)) / 10_000n;
    const farAt = (p0 * (10_000n - FAR_BPS)) / 10_000n;
    const long = await timed("placed a long limit", () => placeLimitOrder(traderPerp, usdc, COIN, SIZE, true, buyAt, LOCAL.networkId));
    const short = await timed("placed a short limit", () => placeLimitOrder(traderPerp, usdc, COIN, SIZE, false, sellAt, LOCAL.networkId));
    const far = await timed("placed a far long limit", () => placeLimitOrder(traderPerp, usdc, COIN, SIZE, true, farAt, LOCAL.networkId));
    info(`long at or below $${fmt(buyAt)}, short at or above $${fmt(sellAt)}, far long at or below $${fmt(farAt)}`);
    const placedBalance = await waitForBalance(trader, usdc, (b) => b <= before - 3n * COIN);
    check("each order's coin left the trader's wallet", placedBalance === before - 3n * COIN, fmt(before - placedBalance));

    const limitsNow = async () => {
      const ledger = await readLedger(keeperPerp);
      const limits = watchedLimits(keeperPerp, ledger, secret);
      const of = (r: LimitRecord) => limits.find((w) => w.commitment === r.commitment);
      return { ledger, limits, of };
    };

    step("The keeper reads the orders from their notes");
    let now = await limitsNow();
    const wl = now.of(long.record);
    const ws = now.of(short.record);
    check("the keeper's secret opens all three", wl !== undefined && ws !== undefined && now.of(far.record) !== undefined);
    check(
      "the notes carry the trader's sides, sizes and levels",
      wl?.order.isLong === true && wl.order.price === buyAt && ws?.order.isLong === false && ws.order.price === sellAt && wl.order.size === SIZE
    );
    check("at the start price none fills", now.limits.every((w) => !limitFires(now.ledger, w)));

    step("The trader cancels the far one");
    await timed("cancelled (proof included)", () => cancelLimitOrder(traderPerp, far.record, usdc));
    const refunded = await waitForBalance(trader, usdc, (b) => b >= placedBalance + COIN);
    check("its whole coin came back", refunded === placedBalance + COIN, fmt(refunded - placedBalance));
    now = await limitsNow();
    check("the keeper no longer watches it", now.of(far.record) === undefined && now.limits.length >= 2);

    // Fills `record`'s order (or waits for the keeper service to), then checks
    // the position it opened.
    const filled = async (record: LimitRecord, what: string): Promise<PositionRecord> => {
      const { ledger, of } = await limitsNow();
      const w = of(record);
      if (!w) throw new Error(`the keeper does not see the ${what}`);
      check(`the ${what} fills at $${fmt(ledger.markPrice)}`, limitFires(ledger, w));
      let fill: PositionRecord | null = null;
      if (BY_SERVICE) {
        const t = Date.now();
        while (!(fill = limitFillOf(devPerp, await readLedger(devPerp), record))) {
          if (Date.now() - t > 300_000) throw new Error(`the keeper service did not fill the ${what} within 5 minutes`);
          await new Promise((r) => setTimeout(r, 3000));
        }
        info(`filled by the service ${((Date.now() - t) / 1000).toFixed(1)} s after the price moved`);
      } else {
        const x = await timed("filled (proof included)", () => executeLimitOrder(keeperPerp, w));
        info(`position ${x.commitment.slice(0, 16)}… at $${fmt(x.entryPrice)} (tx ${x.txHash.slice(0, 16)}…)`);
        fill = limitFillOf(devPerp, await readLedger(devPerp), record);
      }
      if (!fill) throw new Error(`no fill published for the ${what}`);
      updateLimit(record.commitment, { status: "filled", position: fill });
      const after = await readLedger(devPerp);
      check("the trader rebuilds the position from the published fill", after.positions.findPathForLeaf(Buffer.from(fill.commitment, "hex")) !== undefined);
      check("at the mark of the fill, no worse than the limit", BigInt(fill.opening.entryPrice) === ledger.markPrice);
      check(
        "the keeper now watches it like any position",
        watchedPositions(keeperPerp, after, secret).some((p) => p.commitment === fill!.commitment)
      );
      check("the order no longer waits", !watchedLimits(keeperPerp, after, secret).some((x) => x.commitment === record.commitment));
      return fill;
    };

    step(`The admin drops the price ${Number(MOVE_BPS) / 100}%`);
    const low = (p0 * (10_000n - MOVE_BPS)) / 10_000n;
    await submitPrice(devPerp, low, adminSecret);
    now = await limitsNow();
    check("the short does not fill below its limit", !limitFires(now.ledger, now.of(short.record)!));
    step(BY_SERVICE ? "The keeper service fills the long" : "The keeper fills the long");
    const longPosition = await filled(long.record, "long");

    step(`The admin raises the price ${Number(MOVE_BPS) / 100}% above the start`);
    const high = (p0 * (10_000n + MOVE_BPS)) / 10_000n;
    await submitPrice(devPerp, high, adminSecret);
    step(BY_SERVICE ? "The keeper service fills the short" : "The keeper fills the short");
    const shortPosition = await filled(short.record, "short");

    step("The trader closes both");
    const c1 = await timed("closed the long", () => closePosition(traderPerp, longPosition, usdc, treasuryEncKey));
    check("the long, bought at the dip, closes in profit", c1.profit && c1.pnl > 0n, `${c1.profit ? "+" : "-"}${fmt(c1.pnl)}`);
    info(`profit ${fmt(c1.pnl)}, to trader ${fmt(c1.settled.toTrader)}`);
    const c2 = await timed("closed the short", () => closePosition(traderPerp, shortPosition, usdc, treasuryEncKey));
    check("the short, sold at the top, closes flat at an unchanged price", c2.pnl === 0n);

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
