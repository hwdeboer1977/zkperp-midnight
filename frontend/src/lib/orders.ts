// SPDX-License-Identifier: Apache-2.0

/**
 * Stop losses and take profits from the browser: placing, cancelling and
 * finding them again.
 *
 * An order is a commitment on chain and a note sealed to the keeper's key
 * (core/orders.ts). Its salt and the note's ephemeral scalar derive from the
 * position's owner secret and salt and the order's index, so this browser
 * keeps no record of its own: `ordersOf` rebuilds a position's orders from
 * the ledger, here or on any other device that has the position.
 */

import { useEffect, useState } from "react";
import { MAX_ORDERS_PER_POSITION, deriveOrder, findOwnOrderNote, firesAbove, orderReached, sealOrderNote, type TriggerOrder } from "@core/orders";
import { bytes } from "./bytes";
import { contractModule } from "./contracts";
import type { PositionRecord } from "./positions";
import type { ContractHandle } from "./providers";
import { ledgerOf, positionOf } from "./trading";

export type OrderKind = "stopLoss" | "takeProfit";

export const KIND_LABEL: Record<OrderKind, string> = { stopLoss: "stop loss", takeProfit: "take profit" };

export interface OwnOrder {
  index: number;
  kind: OrderKind;
  order: TriggerOrder;
  cancelled: boolean;
}

/** Which kind an order is, from its position's side and its direction. */
export const kindOf = (isLong: boolean, above: boolean): OrderKind => (above === firesAbove(isLong, "stopLoss") ? "stopLoss" : "takeProfit");

/**
 * Every order placed on `record`'s position, cancelled ones included, in
 * index order. Indices are used in sequence, so the first index with no note
 * ends the scan.
 */
export async function ordersOf(module: { pureCircuits: any }, ledger: any, record: PositionRecord): Promise<OwnOrder[]> {
  const pure = module.pureCircuits;
  const ownerSecret = bytes(record.opening.ownerSecret);
  const salt = bytes(record.opening.salt);
  const out: OwnOrder[] = [];
  for (let index = 0; index < MAX_ORDERS_PER_POSITION; index++) {
    const { ephemeral } = await deriveOrder(ownerSecret, salt, index);
    const view = findOwnOrderNote(pure, ledger.orderNotes, ledger.liquidator, ephemeral);
    if (!view) break;
    const order: TriggerOrder = { position: bytes(record.commitment), price: view.price, above: view.above, salt: view.salt };
    // A note alone is not an order: the commitment is what executeOrder checks.
    if (!ledger.orders.findPathForLeaf(pure.orderCommitment(order))) continue;
    out.push({
      index,
      kind: kindOf(record.opening.isLong, view.above),
      order,
      cancelled: ledger.cancelledOrders.member(pure.orderNullifier(view.salt)),
    });
  }
  return out;
}

/** The live order of each kind on a position (the latest, should there be two). */
export function liveOrders(orders: OwnOrder[]): Partial<Record<OrderKind, OwnOrder>> {
  const out: Partial<Record<OrderKind, OwnOrder>> = {};
  for (const o of orders) if (!o.cancelled) out[o.kind] = o;
  return out;
}

/**
 * Whether `price` is a sensible level for a `kind` order on a position, at
 * mark price `mark`. An error refuses it; a warning only informs.
 */
export function checkLevel(
  kind: OrderKind,
  isLong: boolean,
  price: bigint,
  mark: bigint,
  liquidation: bigint | null
): { error?: string; warning?: string } {
  if (price <= 0n) return { error: "Enter a price." };
  const above = firesAbove(isLong, kind);
  if (orderReached({ price, above }, mark)) {
    return { error: `A ${KIND_LABEL[kind]} on a ${isLong ? "long" : "short"} must be ${above ? "above" : "below"} the current price; this one would fire at once.` };
  }
  if (kind === "stopLoss" && liquidation !== null && (isLong ? price <= liquidation : price >= liquidation)) {
    return { warning: "This is past the liquidation price: the position would be liquidated before the stop loss fires." };
  }
  return {};
}

/** Indices handed out in this session, so a quick second order does not reuse one the indexer has not shown yet. */
const usedIndex = new Map<string, number>();

async function nextIndex(perp: ContractHandle, record: PositionRecord, ledger: any): Promise<number> {
  const onChain = (await ordersOf(perp.module, ledger, record)).length;
  const local = (usedIndex.get(record.commitment) ?? -1) + 1;
  const index = Math.max(onChain, local);
  if (index >= MAX_ORDERS_PER_POSITION) {
    throw new Error(`A position takes at most ${MAX_ORDERS_PER_POSITION} orders, cancelled ones included. Close it and open a new one to set more.`);
  }
  return index;
}

/** Places a stop loss or take profit at `price` on `record`'s open position. */
export async function placeOrder(perp: ContractHandle, record: PositionRecord, kind: OrderKind, price: bigint): Promise<{ txHash: string; order: OwnOrder }> {
  if (record.status !== "open") throw new Error(`this position is ${record.status}`);
  const ledger = await ledgerOf(perp);
  const position = positionOf(perp, record);
  const index = await nextIndex(perp, record, ledger);
  const ownerSecret = bytes(record.opening.ownerSecret);
  const { salt, ephemeral } = await deriveOrder(ownerSecret, position.salt, index);
  const order: TriggerOrder = { position: bytes(record.commitment), price, above: firesAbove(position.isLong, kind), salt };
  const note = sealOrderNote(perp.module.pureCircuits, ledger.liquidator, position.salt, order, ephemeral);
  usedIndex.set(record.commitment, index);
  const tx: any = await perp.deployed.callTx.placeOrder(position, ownerSecret, order, note);
  return { txHash: tx.public.txHash, order: { index, kind, order, cancelled: false } };
}

/** Cancels `order` on `record`'s position, so the keeper can no longer execute it. */
export async function cancelOrder(perp: ContractHandle, record: PositionRecord, order: TriggerOrder): Promise<string> {
  const tx: any = await perp.deployed.callTx.cancelOrder(positionOf(perp, record), bytes(record.opening.ownerSecret), order);
  return tx.public.txHash;
}

/**
 * Moves an order to `price`: places the new one, then cancels the old, so the
 * position is never without one. If the cancel fails, both are live until it
 * is retried; whichever fires first closes the position.
 */
export async function replaceOrder(perp: ContractHandle, record: PositionRecord, old: OwnOrder, price: bigint, onStep?: (step: 1 | 2) => void) {
  onStep?.(1);
  const placed = await placeOrder(perp, record, old.kind, price);
  onStep?.(2);
  await cancelOrder(perp, record, old.order);
  return placed;
}

/** `record`'s orders, rebuilt from the ledger whenever its orders change. Null until read. */
export function useOrders(record: PositionRecord | null, ledger: any): OwnOrder[] | null {
  const [orders, setOrders] = useState<OwnOrder[] | null>(null);
  const version = ledger && record ? `${record.commitment}:${ledger.orderNotes.size()}:${ledger.cancelledOrders.size()}` : "";
  useEffect(() => {
    if (!ledger || !record || record.status !== "open") return;
    let live = true;
    void contractModule("zkperp")
      .then((module) => ordersOf(module, ledger, record))
      .then((o) => live && setOrders(o), () => live && setOrders(null));
    return () => {
      live = false;
    };
    // Only when the orders change, not on every ledger poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);
  return orders;
}


