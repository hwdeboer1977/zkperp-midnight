// SPDX-License-Identifier: Apache-2.0

/**
 * Notices for what the keeper did for this trader while the page was open: a
 * limit order filled, a stop loss or take profit executed, a position
 * liquidated. Fed by the hooks that already follow positions and limit orders
 * (usePositions, useLimitOrders): a notice is raised only for a change seen
 * in this session, never for what was already history when the page loaded.
 */

import { useSyncExternalStore } from "react";
import { fmt6 } from "./bytes";
import { limitExpired } from "@core/limits";
import type { OwnLimit } from "./limits";
import type { PositionRecord } from "./positions";

export interface Notice {
  id: string;
  tone: "good" | "bad" | "warn";
  title: string;
  text: string;
}

let notices: Notice[] = [];
const listeners = new Set<() => void>();
const publish = (next: Notice[]) => ((notices = next), listeners.forEach((l) => l()));

export function useNotices(): Notice[] {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => void listeners.delete(l)),
    () => notices
  );
}

export const dismissNotice = (id: string) => publish(notices.filter((n) => n.id !== id));

function raise(n: Notice): void {
  if (!notices.some((x) => x.id === n.id)) publish([...notices, n]);
}

const side = (isLong: boolean) => (isLong ? "long" : "short");

/** Open positions seen this session, so a later close by the keeper raises a notice. */
const seenOpen = new Set<string>();
const told = new Set<string>();

export function watchPositions(records: PositionRecord[]): void {
  for (const r of records) {
    if (r.status === "open") seenOpen.add(r.commitment);
    const c = r.closing;
    // The close's details arrive a little after the close (history.ts).
    if (r.status !== "closed" || !c || c.by === "trader" || !seenOpen.has(r.commitment) || told.has(r.commitment)) continue;
    told.add(r.commitment);
    const o = r.opening;
    const what = `${side(o.isLong)} of ${fmt6(BigInt(o.size))} pUSDC`;
    const paid = `${c.exact ? "" : "≈ "}${fmt6(BigInt(c.received))} pUSDC paid to your wallet`;
    raise(
      c.by === "liquidation"
        ? { id: `close:${r.commitment}`, tone: "bad", title: "Position liquidated", text: `The keeper liquidated your ${what} at $${fmt6(BigInt(c.exitPrice))}; ${paid}.` }
        : {
            id: `close:${r.commitment}`,
            tone: c.by === "takeProfit" ? "good" : "warn",
            title: c.by === "takeProfit" ? "Take profit executed" : "Stop loss executed",
            text: `The keeper closed your ${what} at $${fmt6(BigInt(c.exitPrice))}; ${paid}.`,
          }
    );
  }
}

/** Limit orders seen waiting this session, so a later fill raises a notice. */
const seenWaiting = new Set<string>();

export function watchLimits(orders: OwnLimit[], now: number): void {
  for (const o of orders) {
    if (o.status === "waiting" && limitExpired(o, BigInt(now))) {
      if (!seenWaiting.has(o.id) || told.has(`expired:${o.id}`)) continue;
      told.add(`expired:${o.id}`);
      raise({
        id: `expired:${o.id}`,
        tone: "warn",
        title: "Limit order expired",
        text: `Your limit ${side(o.isLong)} at $${fmt6(o.price)} expired without filling. Cancel it to get its ${fmt6(o.collateral + o.openFee)} pUSDC back.`,
      });
      continue;
    }
    if (o.status === "waiting") seenWaiting.add(o.id);
    if (o.status !== "filled" || !seenWaiting.has(o.id) || told.has(o.id)) continue;
    told.add(o.id);
    raise({
      id: `fill:${o.id}`,
      tone: "good",
      title: "Limit order filled",
      text: `Your limit ${side(o.isLong)} of ${fmt6(o.size)} pUSDC opened at $${fmt6(o.fill!.entryPrice)} (limit $${fmt6(o.price)}). It is now under your positions.`,
    });
  }
}
