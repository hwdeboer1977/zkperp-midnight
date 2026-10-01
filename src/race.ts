// SPDX-License-Identifier: Apache-2.0

/**
 * Do concurrent transactions against zkperp invalidate each other?
 *
 *   npm run demo        # once, so the contracts are deployed
 *   npm run race
 *
 * The demo submits one transaction at a time. On a public network the oracle
 * updates the price while traders are proving, and traders close at the same
 * time as each other. Each race below submits two transactions from two
 * different wallets at the same moment and reports what landed:
 *
 *   A  a close against a price update      — EXPECTED to invalidate the close.
 *                                            Pricing is strict: a trade settles
 *                                            at the latest price or not at all,
 *                                            so the trader re-proves at the new
 *                                            one. The relayer updates only on a
 *                                            new Chainlink round (a real move),
 *                                            so this is rare, not routine.
 *   B  two closes in profit                — both spend the one pool coin.
 *                                            Known: one is rejected, free, and
 *                                            the frontend retries.
 *   C  two closes at an unchanged price    — neither touches the pool coin.
 *                                            Target: both land.
 *   D  two opens                           — Target: both land.
 *
 * Positions a race leaves open are closed one at a time at the end.
 */

import chalk from "chalk";
import { createHash } from "crypto";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { LOCAL, walletSeed } from "./network.js";
import { buildWallet, waitForSync, type BuiltWallet } from "./wallet.js";
import { getDeployment } from "./contracts.js";
import { readyTrader, traderSeed } from "./trader.js";
import { closePosition, openPosition, readLedger, reservedOf, type ContractHandle } from "./perp.js";
import { addLiquidity } from "./pool.js";
import { openPositionsOn, type PositionRecord } from "./positions.js";
import { balance, coinKey, handle, waitForBalance } from "./session.js";

const PUSDC = 1_000_000n;
const LIQUIDITY = 500_000n * PUSDC;
const PRICE = 3_000_000_000n;
const UP = 3_300_000_000n;
const COLLATERAL = 1_234_567_891n;
const SIZE = 12_345_678_912n;

const fmt = (minor: bigint) => `${minor / PUSDC}.${(minor % PUSDC).toString().padStart(6, "0")}`;
const step = (s: string) => console.log(`\n${chalk.blue.bold("▶")} ${chalk.bold(s)}`);
const info = (s: string) => console.log(chalk.gray(`   ${s}`));

interface Party {
  name: string;
  wallet: BuiltWallet;
  perp: ContractHandle;
  coinPublicKey: Uint8Array;
}

interface Outcome {
  label: string;
  ok: boolean;
  ms: number;
  txHash?: string;
  height?: number;
  detail: string;
}

/** The block a transaction landed in, from the indexer. */
async function blockOf(txHash: string): Promise<number | undefined> {
  const query = `query T($hash: HexEncoded!) {
    transactions(offset: { hash: $hash }) { block { height } }
  }`;
  const response = await fetch(LOCAL.indexer, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables: { hash: txHash } }),
  });
  const body: any = await response.json();
  return body.data?.transactions?.[0]?.block?.height;
}

/** Runs two transactions at the same moment and reports both. */
async function race(
  a: [string, () => Promise<{ txHash: string; detail?: string }>],
  b: [string, () => Promise<{ txHash: string; detail?: string }>]
): Promise<[Outcome, Outcome]> {
  const run = async ([label, fn]: [string, () => Promise<{ txHash: string; detail?: string }>]): Promise<Outcome> => {
    const start = Date.now();
    try {
      const r = await fn();
      return { label, ok: true, ms: Date.now() - start, txHash: r.txHash, detail: r.detail ?? "" };
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error).replace(/\s+/g, " ");
      return { label, ok: false, ms: Date.now() - start, detail: message.slice(0, 400) };
    }
  };
  const results = (await Promise.all([run(a), run(b)])) as [Outcome, Outcome];
  for (const r of results) {
    if (r.txHash) r.height = await blockOf(r.txHash);
    const mark = r.ok ? chalk.green("landed") : chalk.red("failed");
    const where = r.height !== undefined ? ` in block ${r.height}` : "";
    console.log(`   ${mark} ${r.label} after ${(r.ms / 1000).toFixed(1)}s${where}`);
    if (r.detail) info(`  ${r.detail}`);
  }
  return results;
}

async function main() {
  setNetworkId(LOCAL.networkId);
  const devSeed = walletSeed();
  const adminSecret = createHash("sha256").update(`zkperp-admin:${devSeed}`).digest();
  const perpAddress = getDeployment(LOCAL.networkId, "zkperp");
  const pusdcAddress = getDeployment(LOCAL.networkId, "pusdc");
  if (!perpAddress || !pusdcAddress) throw new Error("no current deployment: run npm run demo first");

  step("Wallets");
  const devWallet = await buildWallet({ kind: "seed", value: devSeed }, LOCAL);
  let traderWallet: BuiltWallet | null = null;
  const findings: string[] = [];
  /** ok: met the expectation; false: did not; undefined: inconclusive. */
  const verdict = (race: string, ok: boolean | undefined, what: string) =>
    findings.push(`${ok === undefined ? chalk.yellow("?") : ok ? chalk.green("✓") : chalk.red("✗")} ${race}: ${what}`);
  try {
    await waitForSync(devWallet, () => {});
    const traderSeedHex = traderSeed(devSeed);
    traderWallet = await readyTrader(devWallet, traderSeedHex, LOCAL, info);

    const dev: Party = {
      name: "dev",
      wallet: devWallet,
      perp: await handle(devWallet, devSeed, "zkperp", perpAddress),
      coinPublicKey: coinKey(devWallet),
    };
    const trader: Party = {
      name: "trader",
      wallet: traderWallet,
      perp: await handle(traderWallet, traderSeedHex, "zkperp", perpAddress),
      coinPublicKey: coinKey(traderWallet),
    };
    const devPusdc = await handle(devWallet, devSeed, "pusdc", pusdcAddress);
    const traderPusdc = await handle(traderWallet, traderSeedHex, "pusdc", pusdcAddress);
    const usdc: Uint8Array = (await readLedger(devPusdc)).tokenId;
    // The dev wallet is the treasury, as in the demo.
    const treasuryEncKey = String(devWallet.shieldedSecretKeys.encryptionPublicKey);

    const setPrice = async (price: bigint) => {
      if ((await readLedger(dev.perp)).markPrice === price) return;
      await dev.perp.deployed.callTx.setPrice(price, adminSecret);
    };
    const open = async (p: Party, isLong = true) => {
      const opened = await openPosition(p.perp, usdc, COLLATERAL, SIZE, isLong, LOCAL.networkId);
      return opened.record;
    };
    const close = async (p: Party, record: PositionRecord) => {
      const closed = await closePosition(p.perp, record, usdc, p.coinPublicKey, treasuryEncKey);
      return {
        txHash: closed.txHash,
        detail: `settled at $${fmt(closed.exit)}: ${closed.profit ? "profit" : "loss"} ${fmt(closed.pnl)}`,
      };
    };

    step("Setup");
    if ((await readLedger(dev.perp)).poolValue === 0n) {
      info(`dev adds ${fmt(LIQUIDITY)} pUSDC of liquidity…`);
      await addLiquidity(dev.perp, usdc, LIQUIDITY);
    }
    if ((await balance(trader.wallet, usdc)) < 4n * COLLATERAL) {
      info("trader mints pUSDC…");
      await traderPusdc.deployed.callTx.mint(10_000n * PUSDC);
      await waitForBalance(trader.wallet, usdc, (b) => b >= 4n * COLLATERAL);
    }
    await setPrice(PRICE);
    const l = await readLedger(dev.perp);
    info(`pool ${fmt(l.poolValue)}, reserved ${fmt(reservedOf(l))}, price $${fmt(l.markPrice)}`);

    // ── A: a close against a price update ─────────────────────────────────
    step("A — a close, proven at $3,000, against a price update to $3,300");
    {
      const record = await open(trader);
      info("trader opened a long at $3,000");
      const [c, p] = await race(
        ["trader's close", () => close(trader, record)],
        ["dev's setPrice($3,300)", async () => ({ txHash: (await dev.perp.deployed.callTx.setPrice(UP, adminSecret)).public.txHash })]
      );
      const after = await readLedger(dev.perp);
      info(`price now $${fmt(after.markPrice)}`);
      if (c.ok && p.ok && c.height !== undefined && p.height !== undefined && p.height < c.height) {
        verdict("A", false, "a close proven at the old price landed after the price changed — stale pricing is possible");
      } else if (c.ok && p.ok) {
        verdict("A", undefined, "the close landed before the price update; the race did not overlap — rerun");
      } else if (!c.ok && p.ok) {
        verdict("A", true, "the price update invalidated the close: strict pricing, as designed");
      } else {
        verdict("A", false, `close ${c.ok ? "landed" : "failed"}, setPrice ${p.ok ? "landed" : "failed"}`);
      }
    }

    // ── B: two closes that both spend the pool coin ───────────────────────
    step("B — two closes in profit, both spending the one pool coin");
    {
      await setPrice(PRICE);
      const t = await open(trader);
      const d = await open(dev);
      info("trader and dev each opened a long at $3,000");
      await setPrice(UP);
      info("price → $3,300: both are in profit, both will draw on the pool");
      const [x, y] = await race(["trader's close", () => close(trader, t)], ["dev's close", () => close(dev, d)]);
      verdict("B", x.ok !== y.ok, x.ok !== y.ok ? "one close landed, the other must retry (single pool coin, known)" : `trader's ${x.ok ? "landed" : "failed"}, dev's ${y.ok ? "landed" : "failed"}`);
    }

    // ── C: two closes that leave the pool coin alone ──────────────────────
    step("C — two closes at an unchanged price: neither touches the pool");
    {
      await setPrice(PRICE);
      const t = await open(trader);
      const d = await open(dev);
      info("trader and dev each opened a long at $3,000");
      const [x, y] = await race(["trader's close", () => close(trader, t)], ["dev's close", () => close(dev, d)]);
      verdict("C", x.ok && y.ok, x.ok && y.ok ? "both flat closes landed" : `trader's ${x.ok ? "landed" : "failed"}, dev's ${y.ok ? "landed" : "failed"}`);
    }

    // ── D: two opens ──────────────────────────────────────────────────────
    step("D — two opens at once, both taking a slot");
    {
      const [x, y] = await race(
        ["trader's open", async () => ({ txHash: (await openPosition(trader.perp, usdc, COLLATERAL, SIZE, true, LOCAL.networkId)).txHash })],
        ["dev's open", async () => ({ txHash: (await openPosition(dev.perp, usdc, COLLATERAL, SIZE, false, LOCAL.networkId)).txHash })]
      );
      verdict("D", x.ok && y.ok, x.ok && y.ok ? "both opens landed" : `trader's ${x.ok ? "landed" : "failed"}, dev's ${y.ok ? "landed" : "failed"}`);
    }

    // ── Clean up: close whatever the races left open ──────────────────────
    step("Clean-up");
    await setPrice(PRICE);
    for (const record of openPositionsOn(perpAddress)) {
      // Any record's owner secret closes it; the trader wallet pays the fees.
      info(`closing ${record.commitment.slice(0, 12)}…`);
      await closePosition(trader.perp, record, usdc, trader.coinPublicKey, treasuryEncKey);
    }
    const end = await readLedger(dev.perp);
    info(`pool ${fmt(end.poolValue)}, reserved ${fmt(reservedOf(end))}`);
    if (reservedOf(end) !== 0n) verdict("clean-up", false, "liquidity is still reserved; some position was not closed");

    console.log(`\n${chalk.bold("Findings")}`);
    for (const f of findings) console.log(`   ${f}`);
  } finally {
    await traderWallet?.facade.stop();
    await devWallet.facade.stop();
  }
}

main().catch((error) => {
  console.error(chalk.red(`\n✗ ${error instanceof Error ? error.stack ?? error.message : String(error)}`));
  process.exit(1);
});
