// SPDX-License-Identifier: Apache-2.0

/**
 * How each closed position ended: closed by its owner or liquidated, at what
 * price, and what the owner received.
 *
 * A close made in this browser records that itself (trading.ts). Anything
 * else — a close on another device, or a liquidation by the keeper — is found
 * on chain. A close and a liquidation both insert the position's nullifier in
 * `closed`, so the closing transaction is the first `closePosition` or
 * `liquidatePosition` call after which that nullifier is a member. The call's
 * entry point says who closed it, its state the exit price, its block the
 * time. The settlement is then recomputed as the circuit does it; the close
 * time is the block's, so the borrow fee is an estimate (`exact: false`).
 *
 * The state after EVERY close and liquidation is read, never just the ones
 * that matter: a binary search, or asking for one transaction by hash, would
 * show the indexer which close is this trader's. The list of calls comes from
 * the indexer's `contractActions` subscription, replayed from the deployment
 * once per session and extended later; states are cached for the session.
 * About 20 KB of state per close: fine at preview scale, not for a busy
 * deployment.
 */

import { borrowFeeOf, closeFeeOf, liquidationFeeOf, positionPnl, settlement } from "@core/math";
import type { PositionClosing } from "@core/types";
import { contractActions, ledgerAfter, type Module } from "./activity";
import { bytes } from "./bytes";
import type { AppConfig } from "./config";
import { allPositions, updatePosition, type PositionRecord } from "./positions";

interface Settle {
  hash: string;
  entryPoint: "closePosition" | "liquidatePosition";
  /** Milliseconds since the epoch. */
  timestamp: number;
}

/** The settlement of `record` by `settle`, recomputed from the ledger after it. */
function closingOf(record: PositionRecord, settle: Settle, l: any): PositionClosing {
  const o = record.opening;
  const position = {
    isLong: o.isLong,
    size: BigInt(o.size),
    collateral: BigInt(o.collateral),
    openFee: BigInt(o.openFee),
    entryPrice: BigInt(o.entryPrice),
  };
  const closeTime = BigInt(Math.floor(settle.timestamp / 1000));
  const openTime = BigInt(o.openTime);
  const pnl = positionPnl(position.isLong, position.size, position.entryPrice, l.markPrice, l.maxPayout);
  const closeFee = closeFeeOf(position.size, BigInt(l.closeFeeBps));
  const borrowFee = borrowFeeOf(position.size, BigInt(l.borrowRate), closeTime > openTime ? closeTime - openTime : 0n);
  const liquidated = settle.entryPoint === "liquidatePosition";
  const liquidationFee = liquidated ? liquidationFeeOf(position.size, BigInt(l.liquidationFeeBps)) : 0n;
  const s = settlement(position, pnl, closeFee, borrowFee, liquidationFee);
  return {
    by: liquidated ? "liquidation" : "trader",
    exitPrice: String(l.markPrice),
    closeTime: closeTime.toString(),
    pnl: (pnl.profit ? pnl.pnl : -pnl.pnl).toString(),
    // What the treasury took beyond the opening fee.
    fees: (s.toTreasury - position.openFee).toString(),
    received: s.toTrader.toString(),
    closeFee: closeFee.toString(),
    borrowFee: borrowFee.toString(),
    liquidationFee: liquidationFee.toString(),
    exact: false,
  };
}

/**
 * Fills in `closing` for closed records on `address` that lack it. Returns how
 * many records changed.
 */
export async function describeClosings(config: AppConfig, module: Module, address: string): Promise<number> {
  const todo = (await allPositions()).filter((r) =>
      r.status === "closed" &&
      r.contractAddress === address &&
      // Missing, or rebuilt before the fee breakdown was kept.
      (!r.closing || (!r.closing.exact && r.closing.closeFee === undefined)));
  if (todo.length === 0) return 0;
  const calls = (await contractActions(config, address)).filter(
    (a): a is typeof a & Settle => a.entryPoint === "closePosition" || a.entryPoint === "liquidatePosition"
  );
  const after = await Promise.all(calls.map((c) => ledgerAfter(config, module, address, c.hash)));

  let changed = 0;
  for (const record of todo) {
    const nullifier = module.pureCircuits.positionNullifier(bytes(record.opening.salt));
    const i = after.findIndex((l) => l.closed.member(nullifier));
    if (i < 0) continue;
    await updatePosition(record.commitment, { closing: closingOf(record, calls[i], after[i]), closeTxHash: calls[i].hash });
    changed += 1;
  }
  return changed;
}
