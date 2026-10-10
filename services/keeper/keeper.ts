// SPDX-License-Identifier: Apache-2.0

/**
 * The keeper: liquidates positions whose equity fell below maintenance margin,
 * executes trigger orders (stop loss, take profit) whose level is reached, and
 * fills limit orders whose price is reached.
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
 * Trigger orders come with a note of their own, sealed by the trader to the
 * same key (core/orders.ts): the keeper matches it to its position by salt and
 * submits `executeOrder` once the mark price reaches the order's level. The
 * close pays the trader as their own close would.
 *
 * Limit orders, too: the trader seals each one's fields to the same key
 * (core/limits.ts), and the keeper submits `executeLimitOrder` once the mark
 * price reaches its limit, opening the position with the coin the order holds.
 *
 * ⚠️ Whoever runs this sees every position, and every order's level. That is the trust the design
 * accepts; see docs/privacy.md.
 *
 * It decrypts each note once and keeps the plaintext in memory:
 * `transientHash`, which the masks use, is not promised to stay the same
 * across compiler versions, so notes are read while the code that wrote them
 * is current.
 *
 * Submits from its own wallet (KEEPER_SEED, or derived from the dev seed),
 * not the dev wallet the relayer uses, so the two never race for coins.
 *
 * Each action logs its steps with their times: prepare, prove, balance and
 * sign (the keeper's DUST), submit and wait for the block. What it is doing
 * now, and how its last action ended, are at
 *
 *   GET http://127.0.0.1:3012/health
 *
 * which the frontend shows next to an order whose price is reached. It names
 * the kind of action and the step, never the position or the order: the
 * endpoint is as public as the frontend, and the order's commitment would tie
 * it to its fill.
 */

import "dotenv/config";
import fs from "fs";
import http from "http";
import chalk from "chalk";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { activeNetwork, stackFile, walletSeed } from "../../core/network.js";
import { buildWallet, waitForSync } from "../../core/wallet.js";
import { getDeployment } from "../../core/contracts.js";
import {
  canLiquidate,
  circuitNow,
  executeLimitOrder,
  executeOrder,
  limitFires,
  watchedLimits,
  liquidatePosition,
  orderFires,
  watchedOrders,
  liquidationPrice,
  readLedger,
  watchedPositions,
  type ContractHandle,
} from "../../core/perp.js";
import { keeperSeed, liquidatorSecret, readyWallet } from "../../core/trader.js";
import { handle } from "../../core/session.js";
import { reportStages, type TxStage } from "../../core/txStages.js";
import { limitExpired } from "../../core/limits.js";

const CHECK_MS = Number(process.env.KEEPER_CHECK_MS ?? 15_000);
const PORT = Number(process.env.KEEPER_PORT ?? 3012);

const log = (s: string) => console.log(`${new Date().toISOString()} ${s}`);
const fmt = (m: bigint) => `${m / 1_000_000n}.${(m % 1_000_000n).toString().padStart(6, "0")}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

type Action = "liquidation" | "order" | "limit";
type Step = "prepare" | TxStage;

/** What the keeper is doing, step by step: the logs, and /health. */
class Jobs {
  current: { action: Action; step: Step; startedAt: number; stepAt: number } | null = null;
  last: { action: Action; ok: boolean; step: Step; at: number; seconds: number } | null = null;
  lastTick: number | null = null;

  constructor(private readonly proofServer: string) {}

  private label(step: Step): string {
    return {
      prepare: "prepare",
      proving: `prove on ${this.proofServer}`,
      wallet: "balance + sign (DUST)",
      submitting: "submit, wait for the block",
    }[step];
  }

  /** Called by the providers as the running call reaches `step`. */
  step(step: Step): void {
    const j = this.current;
    if (!j || j.step === step) return;
    this.done(j);
    j.step = step;
    j.stepAt = Date.now();
  }

  private done(j: NonNullable<Jobs["current"]>): void {
    log(`   ✓ ${this.label(j.step).padEnd(42)} ${secs(Date.now() - j.stepAt)}`);
  }

  /** Runs one keeper action, logging each of its steps. */
  async run<T>(action: Action, f: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    this.current = { action, step: "prepare", startedAt, stepAt: startedAt };
    try {
      const r = await f();
      this.done(this.current!);
      this.last = { action, ok: true, step: "submitting", at: Date.now(), seconds: (Date.now() - startedAt) / 1000 };
      log(`   total ${secs(Date.now() - startedAt)}`);
      return r;
    } catch (error) {
      const j = this.current!;
      log(chalk.red(`   ✗ ${this.label(j.step)} failed after ${secs(Date.now() - j.stepAt)}`));
      this.last = { action, ok: false, step: j.step, at: Date.now(), seconds: (Date.now() - startedAt) / 1000 };
      throw error;
    } finally {
      this.current = null;
    }
  }

  health(contract: string) {
    const now = Date.now();
    const j = this.current;
    return {
      contract,
      checkEverySeconds: CHECK_MS / 1000,
      lastTickSecondsAgo: this.lastTick === null ? null : Math.round((now - this.lastTick) / 1000),
      busy: j && { action: j.action, step: j.step, stepSeconds: Math.round((now - j.stepAt) / 1000), seconds: Math.round((now - j.startedAt) / 1000) },
      last: this.last && { ...this.last, at: new Date(this.last.at).toISOString(), secondsAgo: Math.round((now - this.last.at) / 1000) },
    };
  }
}

async function main() {
  const network = activeNetwork();
  setNetworkId(network.networkId);
  const perpAddress = getDeployment(network.networkId, "zkperp");
  if (!perpAddress) throw new Error(`no current zkperp deployment on ${network.name}: run the setup first`);
  const STACK_FILE = stackFile(network);
  if (!fs.existsSync(STACK_FILE)) throw new Error(`${STACK_FILE} is missing: run the setup first`);
  const stack = JSON.parse(fs.readFileSync(STACK_FILE, "utf8"));
  const treasuryEncKey: string = stack.treasury.encryptionPublicKey;

  const devSeed = walletSeed();
  const secret = liquidatorSecret(devSeed);
  log("syncing the keeper wallet…");
  const seed = keeperSeed(devSeed);
  const fundFromDev = async () => {
    const dev = await buildWallet({ kind: "seed", value: devSeed }, network);
    await waitForSync(dev, () => {});
    return dev;
  };
  const wallet = await readyWallet(fundFromDev, seed, network, log, "keeper");
  const perp: ContractHandle = await handle(wallet, seed, "zkperp", perpAddress);
  const jobs = new Jobs(network.proofServer);
  reportStages(perp.providers, (stage) => jobs.step(stage));

  const ledger0 = await readLedger(perp);
  const ourKey = perp.module.pureCircuits.liquidatorPublicKey(secret);
  if (ledger0.liquidator.x !== ourKey.x || ledger0.liquidator.y !== ourKey.y) {
    throw new Error("this zkperp encrypts to a different liquidator key; redeploy with the setup");
  }
  const usdc: Uint8Array = ledger0.usdc;
  http
    .createServer((req, res) => {
      if (req.method !== "GET" || req.url !== "/health") return res.writeHead(404).end();
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(jobs.health(perpAddress), null, 2));
    })
    .listen(PORT, "127.0.0.1");
  log(chalk.green(`keeper ready on ${perpAddress}, checking every ${CHECK_MS / 1000}s, health on http://127.0.0.1:${PORT}/health`));

  const seen = new Set<string>();
  const seenOrders = new Set<string>();
  const seenLimits = new Set<string>();
  const expiredLimits = new Set<string>();
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
      const orders = watchedOrders(perp, ledger, secret, live);
      for (const o of orders) {
        const id = Buffer.from(o.view.salt).toString("hex");
        if (seenOrders.has(id)) continue;
        seenOrders.add(id);
        log(
          `watching an order on ${o.position.commitment.slice(0, 12)}…: close at or ${o.order.above ? "above" : "below"} $${fmt(o.order.price)}`
        );
      }
      // An order that fires on a position also below maintenance is executed,
      // not liquidated: the trader asked for this close, and it costs no fee.
      const executed = new Set<string>();
      for (const o of orders.filter((x) => orderFires(ledger, x))) {
        if (executed.has(o.position.commitment)) continue;
        executed.add(o.position.commitment);
        log(chalk.yellow(`executing an order on ${o.position.commitment.slice(0, 12)}… at $${fmt(ledger.markPrice)}`));
        try {
          const r = await jobs.run("order", () => executeOrder(perp, o, usdc, treasuryEncKey));
          log(
            chalk.green(
              `executed on ${o.position.commitment.slice(0, 12)}…: ${r.profit ? "profit" : "loss"} ${fmt(r.pnl)}, ` +
                `${fmt(r.settled.toTreasury)} to the treasury, ${fmt(r.settled.toTrader)} to the trader (tx ${r.txHash.slice(0, 12)}…)`
            )
          );
        } catch (error) {
          log(chalk.red(`order execution failed: ${error instanceof Error ? error.message : String(error)}`));
        }
      }
      for (const w of live.filter((x) => !executed.has(x.commitment) && canLiquidate(ledger, x))) {
        log(chalk.yellow(`liquidating ${w.commitment.slice(0, 12)}… at $${fmt(ledger.markPrice)}`));
        try {
          const r = await jobs.run("liquidation", () => liquidatePosition(perp, w, usdc, treasuryEncKey));
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
      // Last: a fill takes a slot that a close above may just have freed.
      const limits = watchedLimits(perp, ledger, secret);
      for (const w of limits) {
        if (seenLimits.has(w.commitment)) continue;
        seenLimits.add(w.commitment);
        const o = w.order;
        log(
          `watching a limit order ${w.commitment.slice(0, 12)}…: ${o.isLong ? "long" : "short"} ${fmt(o.size)} on ${fmt(o.collateral)} ` +
            `at or ${o.isLong ? "below" : "above"} $${fmt(o.price)}` +
            (o.expiry ? `, until ${new Date(Number(o.expiry) * 1000).toISOString()}` : "")
        );
      }
      for (const w of limits) {
        if (expiredLimits.has(w.commitment) || !limitExpired(w.order, circuitNow())) continue;
        expiredLimits.add(w.commitment);
        log(`limit order ${w.commitment.slice(0, 12)}… expired; it waits for its owner to cancel it`);
      }
      for (const w of limits.filter((x) => limitFires(ledger, x))) {
        log(chalk.yellow(`filling limit order ${w.commitment.slice(0, 12)}… at $${fmt(ledger.markPrice)}`));
        try {
          const r = await jobs.run("limit", () => executeLimitOrder(perp, w));
          log(chalk.green(`filled: position ${r.commitment.slice(0, 12)}… opened at $${fmt(r.entryPrice)} (tx ${r.txHash.slice(0, 12)}…)`));
        } catch (error) {
          // Most often the price moved back, or the pool has no free slot; the next tick decides again.
          log(chalk.red(`limit fill failed: ${error instanceof Error ? error.message : String(error)}`));
        }
      }
      jobs.lastTick = Date.now();
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
