// SPDX-License-Identifier: Apache-2.0

/**
 * zkperp's arithmetic (core/math.ts) on its own: fees, PnL, settlement,
 * liquidation. Hand-worked cases and the invariants the circuit relies on.
 * That these numbers are the ones the circuit accepts is checked in
 * test/zkperp.test.mjs ("core/math.ts against the circuit").
 *
 *   npm run build && node test/math.test.mjs
 */

import {
  borrowFeeOf,
  capacityOf,
  circuitNow,
  closeFeeOf,
  isLiquidatable,
  liquidationFeeOf,
  liquidationPrice,
  openFeeOf,
  positionPnl,
  priceNeedsUpdate,
  reservedOf,
  settlement,
} from "../dist/core/math.js";

let failures = 0;
const expect = (name, cond, detail = "") => {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}\n        ${detail}`);
  }
};
const eq = (name, got, want) => expect(name, got === want, `${got} vs ${want}`);

const PUSDC = 1_000_000n;
const PRICE = 3_000_000_000n; // $3,000
const CAP = 100_000n * PUSDC;

console.log("\nmath\n");

// ── Fees ────────────────────────────────────────────────────────────────────

console.log("  fees\n");
eq("10 bps of 10,000 pUSDC is 10 pUSDC", openFeeOf(10_000n * PUSDC, 10n), 10n * PUSDC);
eq("a fee rounds up: 10 bps of 1 unit is 1", openFeeOf(1n, 10n), 1n);
eq("a fee that divides exactly is not rounded up", openFeeOf(1_000n, 10n), 1n);
eq("one unit over an exact fee rounds up", openFeeOf(1_001n, 10n), 2n);
eq("a zero size pays nothing", openFeeOf(0n, 10n), 0n);
eq("a zero rate charges nothing", closeFeeOf(10_000n * PUSDC, 0n), 0n);
eq("the closing fee is the same formula", closeFeeOf(12_345_678_912n, 10n), 12_345_679n);
eq("the liquidation fee is the same formula", liquidationFeeOf(12_345_678_912n, 50n), 61_728_395n);
// 10^-6 of size per second: 10,000 pUSDC for an hour is 36 pUSDC.
eq("borrowing 10,000 pUSDC for an hour at 10^-6/s is 36 pUSDC", borrowFeeOf(10_000n * PUSDC, 1_000_000n, 3_600n), 36n * PUSDC);
eq("a borrow fee rounds up", borrowFeeOf(1n, 1_000_000n, 1n), 1n);
eq("no time held, no borrow fee", borrowFeeOf(10_000n * PUSDC, 1_000_000n, 0n), 0n);

// ── PnL ─────────────────────────────────────────────────────────────────────

console.log("\n  PnL\n");
{
  const size = 10_000n * PUSDC;
  const pnl = (isLong, exit) => positionPnl(isLong, size, PRICE, exit, CAP);
  const same = (r, profit, value, capped = false) => r.profit === profit && r.pnl === value && r.capped === capped;

  expect("a long up 10% gains 10% of size", same(pnl(true, 3_300_000_000n), true, 1_000n * PUSDC));
  expect("a long down 10% loses 10% of size", same(pnl(true, 2_700_000_000n), false, 1_000n * PUSDC));
  expect("a short down 10% gains 10% of size", same(pnl(false, 2_700_000_000n), true, 1_000n * PUSDC));
  expect("a short up 10% loses 10% of size", same(pnl(false, 3_300_000_000n), false, 1_000n * PUSDC));
  expect("an unchanged price is a zero profit for a long", same(pnl(true, PRICE), true, 0n));
  expect("and for a short", same(pnl(false, PRICE), true, 0n));

  // A one-unit move on 10,000 pUSDC at $3,000 is 3.33… units: a profit rounds
  // down, a loss rounds up.
  expect("a profit rounds down, in the pool's favour", same(pnl(true, PRICE + 1n), true, 3n));
  expect("a loss rounds up, in the pool's favour", same(pnl(true, PRICE - 1n), false, 4n));
  expect("the same for a short's profit", same(pnl(false, PRICE - 1n), true, 3n));
  expect("and a short's loss", same(pnl(false, PRICE + 1n), false, 4n));

  const big = positionPnl(true, 200_000n * PUSDC, PRICE, 4_800_000_000n, CAP); // raw 120k
  expect("a profit above the cap is the cap, flagged", same(big, true, CAP, true));
  expect("a profit at the cap is not flagged", same(positionPnl(true, 100_000n * PUSDC, PRICE, 6_000_000_000n, CAP), true, CAP, false));
  const crash = positionPnl(true, 200_000n * PUSDC, PRICE, 1_200_000_000n, CAP); // loss 120k
  expect("a loss is never capped", same(crash, false, 120_000n * PUSDC));
  expect("a short's loss can exceed 100% of size", same(pnl(false, 9_000_000_000n), false, 20_000n * PUSDC));

  let mirrored = true;
  for (const move of [1n, 7n, 123_456_789n, 999_999_999n]) {
    const longUp = pnl(true, PRICE + move);
    const shortDown = pnl(false, PRICE - move);
    const longDown = pnl(true, PRICE - move);
    const shortUp = pnl(false, PRICE + move);
    if (longUp.pnl !== shortDown.pnl || longDown.pnl !== shortUp.pnl || !longUp.profit || !shortDown.profit || longDown.profit || shortUp.profit) mirrored = false;
  }
  expect("a short mirrors a long: the same move the other way, the same PnL", mirrored);
}

// ── Settlement ──────────────────────────────────────────────────────────────

console.log("\n  settlement\n");
{
  const p = { collateral: 1_000n * PUSDC, openFee: 10n * PUSDC };
  const closeFee = 10n * PUSDC;
  const borrowFee = 2n * PUSDC;
  const s = (pnl, liquidationFee = 0n) => settlement(p, pnl, closeFee, borrowFee, liquidationFee);
  const show = (r) => JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? String(v) : v));

  const flat = s({ profit: true, pnl: 0n });
  expect(
    "flat: the trader gets the collateral less fees, the treasury all three fees",
    flat.toTrader === 988n * PUSDC && flat.toTreasury === 22n * PUSDC && flat.toPool === 0n && flat.fromPool === 0n,
    show(flat)
  );
  const win = s({ profit: true, pnl: 50n * PUSDC });
  expect("a profit comes from the pool to the trader", win.toTrader === 1_038n * PUSDC && win.fromPool === 50n * PUSDC && win.toPool === 0n, show(win));
  const lose = s({ profit: false, pnl: 300n * PUSDC });
  expect(
    "a loss goes to the pool, the fees still to the treasury",
    lose.toPool === 300n * PUSDC && lose.toTreasury === 22n * PUSDC && lose.toTrader === 688n * PUSDC && lose.equity === 688n * PUSDC,
    show(lose)
  );
  const thin = s({ profit: false, pnl: 995n * PUSDC });
  expect(
    "a loss that leaves less than the fees: the fees take what is left",
    thin.toPool === 995n * PUSDC && thin.toTreasury === 15n * PUSDC && thin.toTrader === 0n && thin.equity === 0n,
    show(thin)
  );
  const wiped = s({ profit: false, pnl: 5_000n * PUSDC });
  expect(
    "a loss beyond the collateral: the pool takes the collateral, no more; the treasury the opening fee",
    wiped.toPool === p.collateral && wiped.toTreasury === p.openFee && wiped.toTrader === 0n,
    show(wiped)
  );
  const liq = s({ profit: false, pnl: 900n * PUSDC }, 5n * PUSDC);
  expect(
    "a liquidation fee comes out of the equity, to the treasury",
    liq.equity === 88n * PUSDC && liq.toTreasury === 27n * PUSDC && liq.toTrader === 83n * PUSDC,
    show(liq)
  );
  const liqThin = s({ profit: false, pnl: 986n * PUSDC }, 5n * PUSDC);
  expect("a liquidation fee is capped by the equity left", liqThin.equity === 2n * PUSDC && liqThin.toTreasury === 24n * PUSDC && liqThin.toTrader === 0n, show(liqThin));

  // The coin and the profit are conserved: whatever goes in comes out.
  let conserved = true;
  let firstBroken = "";
  for (const profit of [true, false]) {
    for (const v of [0n, 1n, 11n * PUSDC, 987_654_321n, 1_000n * PUSDC - 1n, 1_000n * PUSDC, 10_000n * PUSDC]) {
      for (const lf of [0n, 5n * PUSDC]) {
        const r = s({ profit, pnl: v }, lf);
        const inn = p.collateral + p.openFee + r.fromPool;
        const out = r.toPool + r.toTreasury + r.toTrader;
        if (inn !== out || r.toTrader < 0n || r.toTreasury < 0n || r.toPool < 0n) {
          conserved = false;
          firstBroken ||= `${profit} ${v} ${lf}: ${show(r)}`;
        }
      }
    }
  }
  expect("collateral + opening fee + profit = to the pool + to the treasury + to the trader, never negative", conserved, firstBroken);
}

// ── Liquidation ─────────────────────────────────────────────────────────────

console.log("\n  liquidation\n");
{
  const l = { markPrice: PRICE, maxPayout: CAP, closeFeeBps: 10n, borrowRate: 1_000_000n, maintenanceBps: 250n };
  const T0 = 1_800_000_000n;
  const T1 = T0 + 3_600n;
  const long = { isLong: true, size: 10_000n * PUSDC, collateral: 1_000n * PUSDC, openFee: 10n * PUSDC, entryPrice: PRICE, openTime: T0 };
  const short = { ...long, isLong: false };
  const at = (price) => ({ ...l, markPrice: price });

  expect("a 10x long at its entry is healthy", !isLiquidatable(long, l, T1));
  expect("a 10x long down 9% is liquidatable", isLiquidatable(long, at(2_730_000_000n), T1));
  expect("a 10x short up 9% is liquidatable", isLiquidatable(short, at(3_270_000_000n), T1));
  expect("a 10x short down 9% is not: it is in profit", !isLiquidatable(short, at(2_730_000_000n), T1));
  // Fees alone sink a thin position: 1,000 collateral on 38,000 size keeps
  // 962 after the closing fee against a maintenance of 950, and owes about
  // 3,283 of borrow fee a day.
  const thin = { ...long, size: 38_000n * PUSDC };
  expect("fees grow with time: a thin position is healthy at first", !isLiquidatable(thin, l, T0));
  expect("and liquidatable a day later at the same price", isLiquidatable(thin, l, T0 + 86_400n));

  for (const [name, p] of [["long", long], ["short", short]]) {
    const lp = liquidationPrice(p, l, T1);
    const worse = p.isLong ? lp - 1_000n : lp + 1_000n;
    const better = p.isLong ? lp + 1_000n : lp - 1_000n;
    expect(`a ${name}'s liquidation price is on the losing side`, p.isLong ? lp < PRICE : lp > PRICE, String(lp));
    expect(`a ${name} just past its liquidation price is liquidatable`, isLiquidatable(p, at(worse), T1), String(worse));
    expect(`and just short of it is not`, !isLiquidatable(p, at(better), T1), String(better));
  }
}

// ── The pool and the clock ──────────────────────────────────────────────────

console.log("\n  the pool and the clock\n");
eq("an empty pool backs no slot", capacityOf(0n, CAP), 0n);
eq("a pool of exactly one cap backs no slot: the last unit stays free", capacityOf(CAP, CAP), 0n);
eq("one unit more backs one", capacityOf(CAP + 1n, CAP), 1n);
eq("500k backs four 100k slots", capacityOf(500_000n * PUSDC, CAP), 4n);
eq("reserved is used slots × maxPayout", reservedOf({ slotCapacity: 4n, freeSlots: 1n, maxPayout: CAP }), 3n * CAP);
const now = BigInt(Math.floor(Date.now() / 1000));
expect("the circuit's clock runs a little behind now", circuitNow() <= now - 1n && circuitNow() >= now - 3n, `${circuitNow()} vs ${now}`);
expect("a new price needs an update", priceNeedsUpdate({ markPrice: PRICE, priceTime: now }, PRICE + 1n));
expect("the same fresh price does not", !priceNeedsUpdate({ markPrice: PRICE, priceTime: now }, PRICE));
expect("the same price, 11 minutes old, does", priceNeedsUpdate({ markPrice: PRICE, priceTime: now - 660n }, PRICE));

console.log(failures === 0 ? "\nall passed\n" : `\n${failures} failure(s)\n`);
process.exit(failures === 0 ? 0 : 1);
