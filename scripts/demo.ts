// SPDX-License-Identifier: Apache-2.0

/**
 * The position lifecycle on the local devnet, with two wallets.
 *
 *   npm run devnet:up && npm run compile && npm run demo
 *
 *   dev wallet       deploys pUSDC and zkperp, provides liquidity, runs the oracle
 *   trader wallet    a separate seed, funded from the dev wallet on first use
 *   treasury wallet  receives every fee and pays the LPs' share per epoch;
 *                    also its own seed, so its balance is fees alone
 *
 * CUSTODY — does collateral come back out?
 *   The contract never records a position's collateral coin; only the trader
 *   knows its nonce. This opens a long and a short and closes each at an
 *   unchanged price, and requires the trader's pUSDC balance to return to exactly where it was.
 *
 * FEES — opening, closing and borrow fees, each pinned and rounded up, go to
 *   the treasury wallet as shielded outputs; none reaches the
 *   pool at a close. Then the treasury deposits the LPs' 70% share in one
 *   public epoch payment.
 *
 * SOLVENCY — every open reserves the constant `maxPayout` and every close
 *   releases it; a profit beyond the cap is paid exactly the cap.
 *
 * PNL — does the pool settle both ways, for both directions?
 *   Opens, moves the price, closes: the trader gains exactly the profit and
 *   the pool loses exactly that, or the trader loses exactly the loss and the
 *   pool gains it. Every settlement path, once for a long and once for a
 *   short, mirrored: a short's profit is a long's loss.
 *
 * LIQUIDITY — can LPs get out, and only what is not reserved?
 *   Redeems a tenth of the dev wallet's zLP; is refused emptying the pool
 *   while a position is open; then empties it once nothing is open. The next
 *   run deposits afresh.
 *
 * Every trade transaction is fetched raw from the indexer and searched for the
 * position's size, collateral, secrets and the trader's key, with the search
 * whose coverage `npm run probe:leak` verifies.
 */

import chalk from "chalk";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { createHash } from "crypto";
import { LOCAL, walletSeed } from "../core/network.js";
import { buildWallet, waitForSync, type BuiltWallet } from "../core/wallet.js";
import { readyTrader, readyWallet, traderSeed, treasurySeed } from "../core/trader.js";
import {
  borrowFeeOf,
  circuitNow,
  closeFeeOf,
  closePosition,
  openFeeOf,
  openPosition,
  positionPnl,
  priceNeedsUpdate,
  readLedger,
  reservedOf,
  settlement,
  submitPrice,
  type ContractHandle,
} from "../core/perp.js";
import { openPositionsOn, positionsFile, reconcile } from "../core/positions.js";
import { addLiquidity, depositFees, redeemable, removeLiquidity } from "../core/pool.js";
import { findBytes, findNumber, findNumberLoose, rawTransaction } from "../core/leak-search.js";
import { balance, coinKey, deployOrFind, handle, waitForBalance } from "../core/session.js";

const PUSDC = 1_000_000n;
const DEV_MINT = 1_000_000n * PUSDC;
const LIQUIDITY = 500_000n * PUSDC;
const TRADER_MINT = 10_000n * PUSDC;
const PRICE = 3_000_000_000n; // $3,000.000000
const MAX_LEVERAGE = 20n;
// 0.10% of size to open and to close. The borrow rate is far above a real
// one — 10^-6 of size per second, 0.36% an hour — so a demo position held
// for a minute pays a fee big enough to see.
const OPEN_FEE_BPS = 10n;
const CLOSE_FEE_BPS = 10n;
const BORROW_RATE = 1_000_000n;
const CLOCK_SLACK = 600n;
// Just above Chainlink's hourly heartbeat.
const MAX_PRICE_AGE = 3_900n;
// The LPs' share of fees, paid into the pool at the end of the epoch.
const LP_FEE_SHARE_PCT = 70n;
const MIN_COLLATERAL = 10n * PUSDC;
// The most any position can win, and so what each open reserves. Small enough
// that a 50% move at 10x hits it, so the demo can show the cap binding.
const MAX_PAYOUT = 5_000n * PUSDC;

// Distinctive, so a match in raw bytes means a leak and not a coincidence.
const COLLATERAL = 1_234_567_891n; // 1,234.567891 pUSDC, the coin posted
const SIZE = 12_345_678_912n; //    ~10x

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const fmt = (minor: bigint) => {
  const sign = minor < 0n ? "-" : "";
  const m = minor < 0n ? -minor : minor;
  return `${sign}${(m / PUSDC).toLocaleString("en-US")}.${(m % PUSDC).toString().padStart(6, "0")}`;
};
const step = (s: string) => console.log(`\n${chalk.blue.bold("▶")} ${chalk.bold(s)}`);
const info = (s: string) => console.log(chalk.gray(`   ${s}`));

const results: Array<{ section: string; name: string; ok: boolean }> = [];
let section = "";
function check(name: string, ok: boolean) {
  results.push({ section, name, ok });
  console.log(`   ${ok ? chalk.green("✓") : chalk.red("✗")} ${name}`);
}

interface Party {
  wallet: BuiltWallet;
  seed: string;
  coinPublicKey: Uint8Array;
  pusdc: ContractHandle;
  perp: ContractHandle;
}

async function main() {
  const network = LOCAL;
  setNetworkId(network.networkId);
  const devSeed = walletSeed();
  const adminSecret = createHash("sha256").update(`zkperp-admin:${devSeed}`).digest();

  step("Wallets");
  const devWallet = await buildWallet({ kind: "seed", value: devSeed }, network);
  let traderWallet: BuiltWallet | null = null;
  let treasuryWallet: BuiltWallet | null = null;
  try {
    await waitForSync(devWallet, () => {});
    info(`dev    ${devWallet.unshieldedAddress}`);
    traderWallet = await readyTrader(devWallet, traderSeed(devSeed), network, info);
    info(`trader ${traderWallet.unshieldedAddress}`);
    const treasurySeedHex = treasurySeed(devSeed);
    const treasury = await readyWallet(devWallet, treasurySeedHex, network, info, "treasury");
    treasuryWallet = treasury;
    info(`treasury ${treasury.unshieldedAddress}`);

    // ── Contracts, deployed by the dev wallet ─────────────────────────────
    step("Contracts");
    const pusdcAddress = await deployOrFind(info, devWallet, devSeed, "pusdc", async () => []);
    const devPusdc = await handle(devWallet, devSeed, "pusdc", pusdcAddress);
    // Before the first mint pUSDC has no token type yet, so the balance check
    // needs one mint to exist; after that, top up whenever a new pool needs it.
    if ((await readLedger(devPusdc)).totalSupply === 0n) {
      info(`dev mints ${fmt(DEV_MINT)} pUSDC for liquidity…`);
      await devPusdc.deployed.callTx.mint(DEV_MINT);
    }
    const usdc: Uint8Array = (await readLedger(devPusdc)).tokenId;
    if ((await balance(devWallet, usdc)) < LIQUIDITY) {
      info(`dev mints ${fmt(DEV_MINT)} pUSDC for liquidity…`);
      await devPusdc.deployed.callTx.mint(DEV_MINT);
    }
    info(`pUSDC  ${pusdcAddress}`);

    // A zkperp deployed with another fee recipient is not this demo's: deploy anew.
    const treasuryKey = hex(coinKey(treasury));
    const ownTreasury = (l: any) => hex(l.treasury.bytes) === treasuryKey;
    const perpAddress = await deployOrFind(info, devWallet, devSeed, "zkperp", async (module) => [
      usdc,
      module.pureCircuits.adminKey(adminSecret),
      PRICE,
      circuitNow(),
      MAX_LEVERAGE,
      MIN_COLLATERAL,
      MAX_PAYOUT,
      OPEN_FEE_BPS,
      CLOSE_FEE_BPS,
      BORROW_RATE,
      { bytes: coinKey(treasury) },
      CLOCK_SLACK,
      MAX_PRICE_AGE,
    ], ownTreasury);
    const devPerp = await handle(devWallet, devSeed, "zkperp", perpAddress);
    info(`zkperp ${perpAddress}`);
    if (hex((await readLedger(devPerp)).usdc) !== hex(usdc)) {
      throw new Error("deployment.json pairs this zkperp with a different pUSDC — run npm run devnet:reset");
    }

    if ((await readLedger(devPerp)).poolValue === 0n) {
      await waitForBalance(devWallet, usdc, (b) => b >= LIQUIDITY);
      info(`dev adds ${fmt(LIQUIDITY)} pUSDC of liquidity…`);
      await addLiquidity(devPerp, usdc, LIQUIDITY);
    }
    await setPrice(devPerp, PRICE, adminSecret);

    const dev: Party = {
      wallet: devWallet,
      seed: devSeed,
      coinPublicKey: coinKey(devWallet),
      pusdc: devPusdc,
      perp: devPerp,
    };
    const traderSeedHex = traderSeed(devSeed);
    const trader: Party = {
      wallet: traderWallet,
      seed: traderSeedHex,
      coinPublicKey: coinKey(traderWallet),
      pusdc: await handle(traderWallet, traderSeedHex, "pusdc", pusdcAddress),
      perp: await handle(traderWallet, traderSeedHex, "zkperp", perpAddress),
    };

    const tree = (await readLedger(devPerp)).positions;
    const settled = reconcile(perpAddress, (c) => tree.findPathForLeaf(Uint8Array.from(Buffer.from(c, "hex"))) !== undefined);
    if (settled.opened || settled.failed) {
      info(`reconciled earlier pending positions: ${settled.opened} open, ${settled.failed} failed`);
    }

    if ((await balance(trader.wallet, usdc)) < 3n * COLLATERAL) {
      info(`trader mints ${fmt(TRADER_MINT)} pUSDC…`);
      await trader.pusdc.deployed.callTx.mint(TRADER_MINT);
    }
    await waitForBalance(trader.wallet, usdc, (b) => b >= 3n * COLLATERAL);
    info(`trader holds ${fmt(await balance(trader.wallet, usdc))} pUSDC, shielded`);
    info(`pool ${fmt((await readLedger(devPerp)).poolValue)} pUSDC at $${fmt(PRICE)}`);

    // ── Step 3: custody ───────────────────────────────────────────────────
    // The treasury publishes its encryption key, as any payee publishes an
    // address; traders need it to pay fees the treasury's wallet can find.
    const treasuryEncKey = String(treasury.shieldedSecretKeys.encryptionPublicKey);
    const treasuryPerp = await handle(treasury, treasurySeedHex, "zkperp", perpAddress);

    // A run that died mid-way can leave positions open, and their reservations
    // would throw off every check below. Close them first.
    for (const leftover of openPositionsOn(perpAddress)) {
      info(`closing a position left open by an earlier run (${leftover.commitment.slice(0, 12)}…)`);
      await closePosition(trader.perp, leftover, usdc, trader.coinPublicKey, treasuryEncKey);
    }
    if (reservedOf(await readLedger(devPerp)) !== 0n) {
      throw new Error("liquidity is still reserved for positions this machine has no record of");
    }

    // Fees go to the treasury wallet; the run's total is paid out to LPs at
    // the end.
    let feesCollected = 0n;
    const openFee = openFeeOf(SIZE, OPEN_FEE_BPS);
    const closeFee = closeFeeOf(SIZE, CLOSE_FEE_BPS);
    info(`fees on a ${fmt(SIZE)} position: ${fmt(openFee)} to open, ${fmt(closeFee)} to close, plus borrow`);

    for (const isLong of [true, false]) {
      const dir = isLong ? "long" : "short";
      section = `custody, ${dir}`;
      step(`Custody — open and close a ${dir} at an unchanged price`);
      const before = await balance(trader.wallet, usdc);
      const poolBefore = (await readLedger(devPerp)).poolValue;
      const reservedBefore = reservedOf(await readLedger(devPerp));

      const opened = await openPosition(trader.perp, usdc, COLLATERAL, SIZE, isLong, network.networkId);
      info(`opened ${opened.txHash}`);
      check(
        "the open reserved exactly maxPayout — the same for every position",
        reservedOf(await readLedger(devPerp)) === reservedBefore + MAX_PAYOUT
      );
      check("the pool is untouched by an open, fee included", (await readLedger(devPerp)).poolValue === poolBefore);
      const whileOpen = await waitForBalance(trader.wallet, usdc, (b) => b < before);
      check(`the trader posted exactly the coin (${fmt(before)} → ${fmt(whileOpen)})`, before - whileOpen === COLLATERAL);
      check(
        "the position's collateral is the coin less the opening fee",
        BigInt(opened.record.opening.collateral) === COLLATERAL - openFee && BigInt(opened.record.opening.openFee) === openFee
      );
      await privacy("open", opened.txHash, trader, opened.record, perpAddress, usdc);

      const treasuryBefore = await balance(treasury, usdc);
      const closed = await closePosition(trader.perp, opened.record, usdc, trader.coinPublicKey, treasuryEncKey);
      info(`closed ${closed.txHash} after ${closed.held}s: borrow fee ${fmt(closed.borrowFee)}`);
      const fees = openFee + closed.closeFee + closed.borrowFee;
      check("the closing fee is size × 0.10%, rounded up", closed.closeFee === closeFee);
      check(
        "the borrow fee is size × rate × seconds held, rounded up",
        closed.borrowFee === borrowFeeOf(SIZE, BORROW_RATE, closed.held) && closed.borrowFee > 0n
      );
      const afterClose = await waitForBalance(trader.wallet, usdc, (b) => b > whileOpen);
      check(
        `the trader gets the coin back less all three fees (${fmt(whileOpen)} → ${fmt(afterClose)})`,
        afterClose === before - fees
      );
      const treasuryAfter = await waitForBalance(treasury, usdc, (b) => b > treasuryBefore);
      check(`the treasury receives exactly the fees (${fmt(fees)})`, treasuryAfter - treasuryBefore === fees);
      check("the pool did not move: no fee reaches it", (await readLedger(devPerp)).poolValue === poolBefore);
      check("the close released the reservation", reservedOf(await readLedger(devPerp)) === reservedBefore);
      feesCollected += fees;
      await privacy("close", closed.txHash, trader, opened.record, perpAddress, usdc, closed.nullifier, [
        ["closing fee", closed.closeFee],
        ["borrow fee", closed.borrowFee],
        ["fees to the treasury", fees],
        ["trader's payout", COLLATERAL - fees],
      ]);
    }

    // ── Step 4: PnL against the pool ──────────────────────────────────────
    for (const [label, isLong, exit] of [
      ["long profit — price up 10%", true, 3_300_000_000n],
      ["long loss — price down 5%", true, 2_850_000_000n],
      // Each of these exercises a branch combination that only the real
      // circuit can check: the JS runtime skips untaken branches, the proof
      // does not (see the note in closePosition).
      ["long profit above the collateral — price up 25%", true, 3_750_000_000n],
      ["long wipe-out — price down 20%", true, 2_400_000_000n],
      // Raw profit ≈ 6,173 pUSDC; the cap pays 5,000 — an enforced take-profit.
      ["long payout cap — price up 50%", true, 4_500_000_000n],
      // The same paths for a short, with the price moving the other way.
      ["short profit — price down 10%", false, 2_700_000_000n],
      ["short loss — price up 5%", false, 3_150_000_000n],
      ["short profit above the collateral — price down 25%", false, 2_250_000_000n],
      ["short wipe-out — price up 20%", false, 3_600_000_000n],
      ["short payout cap — price down 50%", false, 1_500_000_000n],
    ] as const) {
      section = label;
      step(`PnL, ${label}`);
      await setPrice(devPerp, PRICE, adminSecret);
      const before = await balance(trader.wallet, usdc);
      const opened = await openPosition(trader.perp, usdc, COLLATERAL, SIZE, isLong, network.networkId);
      info(`opened at $${fmt(PRICE)}: ${opened.txHash}`);
      await waitForBalance(trader.wallet, usdc, (b) => b < before);

      await setPrice(devPerp, exit, adminSecret);
      const poolBefore = (await readLedger(devPerp)).poolValue;
      const treasuryBefore = await balance(treasury, usdc);
      const closed = await closePosition(trader.perp, opened.record, usdc, trader.coinPublicKey, treasuryEncKey);
      const expected = positionPnl(isLong, SIZE, PRICE, exit, MAX_PAYOUT);
      info(`closed at $${fmt(exit)}: ${closed.txHash}`);
      info(
        `${closed.profit ? "profit" : "loss"} ${fmt(closed.pnl)} pUSDC${closed.capped ? " (capped at maxPayout)" : ""}; ` +
          `fees ${fmt(openFee)} + ${fmt(closed.closeFee)} + ${fmt(closed.borrowFee)} borrow`
      );
      check(
        closed.capped
          ? "the profit is exactly maxPayout, not the larger raw PnL"
          : "the PnL is size × Δprice / entry, rounded for the pool",
        closed.pnl === expected.pnl && closed.profit === expected.profit && closed.capped === expected.capped
      );
      if (label.includes("payout cap")) check("the cap bound, as intended", closed.capped);

      // Worked out here from the opening, independently of closePosition.
      const s = settlement(
        { collateral: COLLATERAL - openFee, openFee },
        expected,
        closeFeeOf(SIZE, CLOSE_FEE_BPS),
        borrowFeeOf(SIZE, BORROW_RATE, closed.held)
      );
      const afterClose =
        s.toTrader === 0n
          ? await balance(trader.wallet, usdc) // nothing comes back to wait for
          : await waitForBalance(trader.wallet, usdc, (b) => b > before - COLLATERAL);
      check(
        `the trader receives ${fmt(s.toTrader)} for a ${fmt(COLLATERAL)} coin (${fmt(before)} → ${fmt(afterClose)})`,
        afterClose === before - COLLATERAL + s.toTrader
      );
      const poolAfter = (await readLedger(devPerp)).poolValue;
      check(
        `the pool moves by the PnL alone, no fees (${fmt(poolBefore)} → ${fmt(poolAfter)})`,
        poolAfter === poolBefore + s.toPool - s.fromPool
      );
      const treasuryAfter = await waitForBalance(treasury, usdc, (b) => b > treasuryBefore);
      check(`the treasury receives exactly ${fmt(s.toTreasury)} in fees`, treasuryAfter - treasuryBefore === s.toTreasury);
      if (label.includes("wipe-out")) {
        check("a wipe-out forgives the closing and borrow fees: the treasury gets the opening fee only", s.toTreasury === openFee);
      }
      check("no reservation is left behind", reservedOf(await readLedger(devPerp)) === 0n);
      feesCollected += s.toTreasury;
      await privacy("close", closed.txHash, trader, opened.record, perpAddress, usdc, closed.nullifier, [
        ["closing fee", closed.closeFee],
        ["borrow fee", closed.borrowFee],
        ["fees to the treasury", s.toTreasury],
        ...(s.toTrader > 0n ? ([["trader's payout from the coin", s.toTrader - s.fromPool]] as Array<[string, bigint]>) : []),
      ]);
    }
    await setPrice(devPerp, PRICE, adminSecret);

    // ── Fee epoch: the treasury pays the LPs their share ──────────────────
    section = "fee epoch";
    step("Fee epoch — the treasury pays the LPs' share into the pool");
    {
      const toLps = (feesCollected * LP_FEE_SHARE_PCT) / 100n;
      info(`fees collected this run ${fmt(feesCollected)}; ${LP_FEE_SHARE_PCT}% to LPs: ${fmt(toLps)}`);
      const l = await readLedger(devPerp);
      const shareBefore = redeemable(l, 1_000_000n);
      const treasuryBefore = await balance(treasury, usdc);
      const txHash = await depositFees(treasuryPerp, usdc, toLps);
      info(`deposited ${txHash}`);
      // Wait for the wallet's change to come back, so later balances are settled.
      await waitForBalance(treasury, usdc, (b) => b === treasuryBefore - toLps);
      const l2 = await readLedger(devPerp);
      check("the pool grows by exactly the deposit", l2.poolValue === l.poolValue + toLps);
      check("no shares are minted for it", l2.lpSupply === l.lpSupply);
      check(
        `each zLP share is worth more (${fmt(shareBefore)} → ${fmt(redeemable(l2, 1_000_000n))} per share)`,
        redeemable(l2, 1_000_000n) > shareBefore
      );
    }

    // ── Step 5: LP withdrawal ─────────────────────────────────────────────
    section = "liquidity";
    step("Liquidity — withdraw only what is not reserved");
    {
      const l = await readLedger(devPerp);
      const lpToken: Uint8Array = l.lpToken;
      const shares = await balance(dev.wallet, lpToken);
      check(`the dev wallet holds every zLP share (${fmt(shares)})`, shares === l.lpSupply);

      const part = shares / 10n;
      const devBefore = await balance(dev.wallet, usdc);
      const expected = redeemable(l, part);
      const out = await removeLiquidity(devPerp, part);
      info(`redeemed ${fmt(part)} zLP for ${fmt(out.amount)} pUSDC: ${out.txHash}`);
      const devAfter = await waitForBalance(dev.wallet, usdc, (b) => b > devBefore);
      check("the LP is paid shares × poolValue / lpSupply, rounded down", out.amount === expected && devAfter - devBefore === expected);
      const l2 = await readLedger(devPerp);
      check("the pool shrinks by exactly that", l2.poolValue === l.poolValue - expected);
      check("the redeemed shares are retired", l2.lpSupply === l.lpSupply - part);
      check("the LP's zLP balance drops by them", (await waitForBalance(dev.wallet, lpToken, (b) => b < shares)) === shares - part);

      // An open position reserves maxPayout: the pool cannot be emptied.
      const opened = await openPosition(trader.perp, usdc, COLLATERAL, SIZE, true, network.networkId);
      info(`opened ${opened.txHash}`);
      let refusal = "";
      try {
        await removeLiquidity(devPerp, l2.lpSupply);
      } catch (error) {
        refusal = String(error instanceof Error ? error.message : error);
      }
      check("emptying the pool is refused while a position is open", /reserved for open positions/.test(refusal));
      await closePosition(trader.perp, opened.record, usdc, trader.coinPublicKey, treasuryEncKey);
      info("closed it at an unchanged price");

      // Nothing open: the last LP may take everything.
      const l3 = await readLedger(devPerp);
      const devBeforeAll = await balance(dev.wallet, usdc);
      const all = await removeLiquidity(devPerp, l3.lpSupply);
      info(`redeemed the remaining ${fmt(l3.lpSupply)} zLP for ${fmt(all.amount)} pUSDC: ${all.txHash}`);
      const devAfterAll = await waitForBalance(dev.wallet, usdc, (b) => b > devBeforeAll);
      check("the last LP receives the whole pool", all.amount === l3.poolValue && devAfterAll - devBeforeAll === l3.poolValue);
      const l4 = await readLedger(devPerp);
      check("the pool is empty and has no shares left", l4.poolValue === 0n && l4.lpSupply === 0n);
    }

    // ── Summary ───────────────────────────────────────────────────────────
    const l = await readLedger(devPerp);
    console.log();
    info(`positions opened ${l.openPositions}, closed ${l.closedPositions}; pool ${fmt(l.poolValue)} pUSDC, reserved ${fmt(reservedOf(l))}`);
    info(`trader's openings: ${positionsFile()}`);
    const failed = results.filter((r) => !r.ok);
    console.log();
    if (failed.length) {
      console.log(chalk.red.bold(`${failed.length} of ${results.length} checks failed`));
      process.exitCode = 1;
    } else {
      console.log(chalk.green.bold(`All ${results.length} checks passed.`));
    }
  } finally {
    await traderWallet?.facade.stop();
    await treasuryWallet?.facade.stop();
    await devWallet.facade.stop();
  }
}

/**
 * Searches one trade's raw transaction for what must stay private. Controls
 * first: the contract address, and for a close its nullifier — 32 bytes the
 * circuit publishes on purpose. Numbers are covered by `probe:leak`.
 */
async function privacy(
  kind: "open" | "close",
  txHash: string,
  trader: Party,
  record: { commitment: string; opening: Record<string, any> },
  contractAddress: string,
  usdc: Uint8Array,
  nullifier?: Uint8Array,
  amounts: Array<[string, bigint]> = []
) {
  const raw = await rawTransaction(LOCAL.indexer, txHash);
  const o = record.opening;
  info(`${kind}: searching ${raw.length / 2} bytes of raw transaction`);
  check(`${kind} control: the contract address is found`, findBytes(raw, contractAddress));
  if (nullifier) check(`${kind} control: the nullifier is found`, findBytes(raw, nullifier));

  const absent = (label: string, found: boolean | string[]) =>
    check(
      `${kind}: ${label} is not in the transaction`,
      Array.isArray(found) ? found.length === 0 : !found
    );
  const absentNumber = (label: string, n: bigint) => {
    absent(label, findNumber(raw, n));
    // Plain bytes of a short number turn up by chance; worth a look, not a verdict.
    const loose = findNumberLoose(raw, n);
    if (loose.length) info(chalk.yellow(`  ${label}: possible chance match as ${loose.join(", ")} — review`));
  };
  absentNumber("size", BigInt(o.size));
  absentNumber("collateral", BigInt(o.collateral));
  absentNumber("coin value", BigInt(o.collateral) + BigInt(o.openFee));
  absentNumber("opening fee", BigInt(o.openFee));
  for (const [label, n] of amounts) absentNumber(label, n);
  absent("owner secret", findBytes(raw, o.ownerSecret));
  absent("salt", findBytes(raw, o.salt));
  absent("collateral coin nonce", findBytes(raw, o.collateralNonce));
  absent("position commitment", findBytes(raw, record.commitment));
  absent("trader's coin public key", findBytes(raw, trader.coinPublicKey));
  void usdc;
}


async function setPrice(perp: ContractHandle, price: bigint, adminSecret: Uint8Array) {
  if (!priceNeedsUpdate(await readLedger(perp), price)) return;
  info(`oracle: price → $${fmt(price)}`);
  await submitPrice(perp, price, adminSecret);
}

main().catch((error) => {
  console.error(chalk.red(`\n✗ ${error instanceof Error ? error.stack ?? error.message : String(error)}`));
  process.exit(1);
});
