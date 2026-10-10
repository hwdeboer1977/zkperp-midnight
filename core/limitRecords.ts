// SPDX-License-Identifier: Apache-2.0

import fs from "fs";
import path from "path";
import type { LimitRecord } from "./types.js";

export type { LimitRecord };

/**
 * The trader's record of their limit orders, as positions.ts keeps positions:
 * written BEFORE the placement is submitted, since the order's coin can only
 * be named — to cancel, or once filled to close — with every field below.
 * Secret material, so 0600 and gitignored.
 */
const FILE = path.join(process.cwd(), ".zkperp", "limits.json");

function readAll(): LimitRecord[] {
  return fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, "utf8")) : [];
}

function writeAll(records: LimitRecord[]): void {
  fs.mkdirSync(path.dirname(FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(FILE, JSON.stringify(records, null, 2) + "\n", { mode: 0o600 });
}

export function recordLimitPending(record: Omit<LimitRecord, "status" | "createdAt">): void {
  writeAll([...readAll(), { ...record, status: "pending", createdAt: new Date().toISOString() }]);
}

export function updateLimit(commitment: string, patch: Partial<LimitRecord>): void {
  writeAll(readAll().map((r) => (r.commitment === commitment ? { ...r, ...patch } : r)));
}

/** Limit orders recorded as waiting on `contractAddress`. */
export function waitingLimitsOn(contractAddress: string): LimitRecord[] {
  return readAll().filter((r) => r.status === "waiting" && r.contractAddress === contractAddress);
}
