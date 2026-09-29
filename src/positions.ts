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
  status: "pending" | "open";
  contractAddress: string;
  networkId: string;
  /** hex */
  commitment: string;
  opening: {
    ownerSecret: string;
    isLong: boolean;
    size: string;
    collateral: string;
    entryPrice: string;
    collateralNonce: string;
    salt: string;
  };
  createdAt: string;
  txHash?: string;
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

export function confirmOpen(commitment: string, txHash: string): void {
  writeAll(
    readAll().map((r) => (r.commitment === commitment ? { ...r, status: "open", txHash } : r))
  );
}

export function positionsFile(): string {
  return FILE;
}
