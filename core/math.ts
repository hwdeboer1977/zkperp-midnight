// SPDX-License-Identifier: Apache-2.0

/**
 * zkperp's arithmetic, as the contract pins it: fees, PnL, how a close is
 * settled, the pool's slot capacity. Pure — no Node or browser APIs — so the
 * services, the scripts and the frontend all run this one copy, the copy the
 * tests and the devnet demo check.
 */

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/**
 * A time for the circuit's clock checks: a little behind now, so the block
 * that includes the transaction is not earlier than it. The contract allows
 * `clockSlack` seconds between this and the block time.
 */
const CLOCK_LEAD_SECONDS = 2n;
export const circuitNow = () => BigInt(Math.floor(Date.now() / 1000)) - CLOCK_LEAD_SECONDS;

/**
 * The pool's slot capacity at `poolValue`, as the contract pins it: how many
 * positions of `maxPayout` it can back, floor((poolValue − 1) / maxPayout).
 * Every call that changes the pool's value passes the capacity afterwards.
 */
export function capacityOf(poolValue: bigint, maxPayout: bigint): bigint {
  return poolValue === 0n ? 0n : (poolValue - 1n) / maxPayout;
}

/** Liquidity set aside for open positions: maxPayout per used slot. */
export function reservedOf(ledger: { slotCapacity: bigint; freeSlots: bigint; maxPayout: bigint }): bigint {
  return (ledger.slotCapacity - ledger.freeSlots) * ledger.maxPayout;
}

/**
 * Whether the mock oracle should submit: a different price, or the same one
 * grown old. A real relayer submits only on a new Chainlink round instead.
 */
export function priceNeedsUpdate(ledger: { markPrice: bigint; priceTime: bigint }, price: bigint): boolean {
  const REFRESH_SECONDS = 600n;
  return ledger.markPrice !== price || circuitNow() - ledger.priceTime > REFRESH_SECONDS;
}

/** Fees as the circuit demands them, each rounded up. */
export function openFeeOf(size: bigint, openFeeBps: bigint): bigint {
  return ceilDiv(size * openFeeBps, 10_000n);
}
export function closeFeeOf(size: bigint, closeFeeBps: bigint): bigint {
  return ceilDiv(size * closeFeeBps, 10_000n);
}
export function borrowFeeOf(size: bigint, borrowRate: bigint, seconds: bigint): bigint {
  return ceilDiv(size * borrowRate * seconds, 1_000_000_000_000n);
}

/**
 * |PnL| of a position at `exit`, as the circuit demands: a profit rounded down
 * and capped at `maxPayout`, a loss rounded up — each in the pool's favour. A
 * long profits when the price rose, a short when it fell; unchanged is flat.
 */
export function positionPnl(
  isLong: boolean,
  size: bigint,
  entry: bigint,
  exit: bigint,
  maxPayout: bigint
): { profit: boolean; pnl: bigint; capped: boolean } {
  const delta = size * (exit >= entry ? exit - entry : entry - exit);
  if (isLong ? exit >= entry : exit <= entry) {
    const raw = delta / entry;
    return raw > maxPayout
      ? { profit: true, pnl: maxPayout, capped: true }
      : { profit: true, pnl: raw, capped: false };
  }
  return { profit: false, pnl: (delta + entry - 1n) / entry, capped: false };
}

/**
 * Where a closing position's coin and any profit go, as the circuit divides
 * them: the loss to the pool, the fees to the treasury, the rest to the
 * trader; a profit from the pool, less fees the collateral could not cover.
 */
export function settlement(
  p: { collateral: bigint; openFee: bigint },
  pnl: { profit: boolean; pnl: bigint },
  closeFee: bigint,
  borrowFee: bigint
): { toPool: bigint; toTreasury: bigint; toTrader: bigint; fromPool: bigint } {
  const loss = pnl.profit ? 0n : pnl.pnl < p.collateral ? pnl.pnl : p.collateral;
  const afterLoss = p.collateral - loss;
  const fees = closeFee + borrowFee;
  const feeTaken = fees < afterLoss ? fees : afterLoss;
  const shortfall = fees - feeTaken;
  const profit = pnl.profit ? pnl.pnl : 0n;
  const fromPool = profit > shortfall ? profit - shortfall : 0n;
  return {
    toPool: loss,
    toTreasury: p.openFee + feeTaken,
    toTrader: afterLoss - feeTaken + fromPool,
    fromPool,
  };
}
