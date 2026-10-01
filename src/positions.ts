// SPDX-License-Identifier: Apache-2.0

import fs from "fs";
import path from "path";

/**
 * The trader's record of their positions: the only copy of each opening.
 *
 * The chain holds a commitment, which cannot be opened without every field
 * below — including the collateral coin's nonce, the one thing that lets the
 * contract's coin be named and spent at close. Lose this file and the position
 * cannot be closed and its collateral is stranded.
 *
 * Written BEFORE the open is submitted, as polisZK does for pool coins: a crash
 * between the two then leaves a `pending` record that may or may not describe a
 * real position — recoverable by checking the commitment on chain. The other
 * order leaves a real position nobody can describe.
 *
 * Secret material, so 0600 and gitignored.
 */
const FILE = path.join(process.cwd(), ".zkperp", "positions.json");

export interface PositionRecord {
  /**
   * pending — written, open not yet confirmed; may or may not exist on chain.
   * open    — the commitment is in the positions tree.
   * failed  — the open was never accepted; nothing on chain to recover.
   * closed  — settled; kept as a record, holds nothing spendable.
   */
  status: "pending" | "open" | "failed" | "closed";
  contractAddress: string;
  networkId: string;
  /** hex */
  commitment: string;
  opening: {
    ownerSecret: string;
    isLong: boolean;
    size: string;
    /** Net of the opening fee; the coin holds collateral + openFee. */
    collateral: string;
    openFee: string;
    entryPrice: string;
    /** Seconds since the epoch. */
    openTime: string;
    collateralNonce: string;
    salt: string;
  };
  createdAt: string;
  txHash?: string;
  closeTxHash?: string;
}

function readAll(): PositionRecord[] {
  return fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, "utf8")) : [];
}

function writeAll(records: PositionRecord[]): void {
  fs.mkdirSync(path.dirname(FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(FILE, JSON.stringify(records, null, 2) + "\n", { mode: 0o600 });
}

export function recordPending(record: Omit<PositionRecord, "status" | "createdAt">): void {
  writeAll([...readAll(), { ...record, status: "pending", createdAt: new Date().toISOString() }]);
}

function update(commitment: string, patch: Partial<PositionRecord>): void {
  writeAll(readAll().map((r) => (r.commitment === commitment ? { ...r, ...patch } : r)));
}

export function confirmOpen(commitment: string, txHash: string): void {
  update(commitment, { status: "open", txHash });
}

export function markFailed(commitment: string): void {
  update(commitment, { status: "failed" });
}

export function markClosed(commitment: string, closeTxHash: string): void {
  update(commitment, { status: "closed", closeTxHash });
}

/**
 * Settles `pending` records against the chain: a commitment in the tree was
 * opened (the process died after submitting), one that is not never landed.
 * Only safe once any in-flight open has finished, which is why it runs at
 * start-up rather than concurrently with a trade, and why a record is only
 * called failed once it is ten minutes old: an indexer running behind must not
 * turn a real position into a "failed" one. Nothing is ever deleted — a
 * mislabelled record still holds everything needed to close.
 */
export function reconcile(contractAddress: string, isInTree: (commitmentHex: string) => boolean): {
  opened: number;
  failed: number;
} {
  let opened = 0;
  let failed = 0;
  writeAll(
    readAll().map((r) => {
      if (r.status !== "pending" || r.contractAddress !== contractAddress) return r;
      if (isInTree(r.commitment)) {
        opened += 1;
        return { ...r, status: "open" };
      }
      if (Date.now() - Date.parse(r.createdAt) < 10 * 60 * 1000) return r;
      failed += 1;
      return { ...r, status: "failed" };
    })
  );
  return { opened, failed };
}

/** Positions recorded as open on `contractAddress`. */
export function openPositionsOn(contractAddress: string): PositionRecord[] {
  return readAll().filter((r) => r.status === "open" && r.contractAddress === contractAddress);
}

export function positionsFile(): string {
  return FILE;
}
