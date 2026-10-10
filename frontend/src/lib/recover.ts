// SPDX-License-Identifier: Apache-2.0

/**
 * The trader's positions, rebuilt from the chain with the position key.
 *
 *   · `recoverPositions` tries every note in the contract's `notes` set under
 *     the key. A note that opens is one of this trader's positions: its open
 *     landed, since the note and the commitment are written by the same call.
 *     It is closed if its nullifier is in `closed`, open otherwise. The note
 *     does not hold the payout key (`payTo`): it is the connected wallet's,
 *     and the rebuilt commitment must be in the tree. If it is not, the
 *     position was opened from another wallet and is skipped; this wallet
 *     could not be paid by its close anyway.
 *   · A limit order's note (`kind: "limit"`) becomes a position once the
 *     keeper fills it: its fields, at the entry price and open time the fill
 *     published in `limitFills`. Until then it is retried on every poll; the
 *     waiting order itself is limits.ts's.
 *   · `settleClosed` marks records closed whose nullifier has appeared, so a
 *     position closed on another device stops showing as open here.
 *
 * Every device decrypts every note once per session; a note that does not open
 * is remembered and not tried again. Fine at devnet scale. A large deployment
 * would want a per-trader tag on each note so devices can skip the rest.
 */

import { openNote, secretsOf, type PositionKey } from "@core/notes";
import { bytes, hex } from "./bytes";
import { allPositions, mergePosition, updatePosition, type PositionRecord } from "./positions";
import { positionOf } from "./trading";

/** Notes already tried under a key and wallet, so each ledger poll only tries new ones. */
const tried = new WeakMap<PositionKey, Set<string>>();

/** What the circuits need: the contract module (for its pure circuits). */
type Module = { pureCircuits: any };

/**
 * Adds or advances a record for each of this key's notes on `contractAddress`.
 * Returns how many records changed.
 */
export async function recoverPositions(
  module: Module,
  ledger: any,
  key: PositionKey,
  contractAddress: string,
  networkId: string,
  payTo: string
): Promise<number> {
  const contract = bytes(contractAddress);
  const seen = tried.get(key) ?? new Set<string>();
  tried.set(key, seen);
  const existing = new Map((await allPositions()).map((r) => [r.commitment, r]));
  let changed = 0;
  for (const note of ledger.notes as Iterable<Uint8Array>) {
    const id = `${payTo}:${hex(note)}`;
    if (seen.has(id)) continue;
    const record = await recordFromNote(module, ledger, key, contract, note, contractAddress, networkId, payTo);
    // A waiting limit order may fill later: look again next poll.
    if (record === WAITING) continue;
    seen.add(id);
    if (record && (await mergePosition(record, existing.get(record.commitment)))) changed += 1;
  }
  return changed;
}

/** A limit order's note whose order has not filled yet, nor been cancelled. */
const WAITING = "waiting" as const;

/**
 * The record a note describes, if it opens under `key` and its position is
 * this wallet's (its rebuilt commitment is in the tree); null otherwise, or
 * WAITING for a limit order that may still fill.
 */
async function recordFromNote(
  module: Module,
  ledger: any,
  key: PositionKey,
  contract: Uint8Array,
  note: Uint8Array,
  contractAddress: string,
  networkId: string,
  payTo: string
): Promise<PositionRecord | null | typeof WAITING> {
  const o = await openNote(key, contract, note);
  if (!o) return null;
  const s = await secretsOf(key, o.seed);
  let { entryPrice, openTime } = o;
  if (o.kind === "limit") {
    const nullifier = module.pureCircuits.limitNullifier(s.salt);
    if (!ledger.limitFills.member(nullifier)) return ledger.limitDone.member(nullifier) ? null : WAITING;
    ({ entryPrice, openTime } = ledger.limitFills.lookup(nullifier));
  }
  const record: PositionRecord = {
    status: "open",
    contractAddress,
    networkId,
    commitment: "",
    // The open time is the closest thing to a creation time the note has.
    createdAt: new Date(Number(openTime) * 1000).toISOString(),
    ...(o.kind === "limit" ? { via: "limit" as const } : {}),
    opening: {
      ownerSecret: hex(s.ownerSecret),
      isLong: o.isLong,
      size: o.size.toString(),
      collateral: o.collateral.toString(),
      openFee: o.openFee.toString(),
      entryPrice: entryPrice.toString(),
      openTime: openTime.toString(),
      collateralNonce: hex(s.collateralNonce),
      salt: hex(s.salt),
      payTo,
    },
  };
  record.commitment = hex(module.pureCircuits.positionCommitment(positionOf({ module } as any, record)));
  if (!ledger.positions.findPathForLeaf(bytes(record.commitment))) return null;
  if (ledger.closed.member(module.pureCircuits.positionNullifier(s.salt))) record.status = "closed";
  return record;
}

/**
 * Commitments of every position on `contractAddress` that a note under `key`
 * rebuilds for this wallet: the records this browser could drop and get back.
 * Tries every note, uncached.
 */
export async function recoverableCommitments(
  module: Module,
  ledger: any,
  key: PositionKey,
  contractAddress: string,
  networkId: string,
  payTo: string
): Promise<Set<string>> {
  const contract = bytes(contractAddress);
  const found = new Set<string>();
  for (const note of ledger.notes as Iterable<Uint8Array>) {
    const record = await recordFromNote(module, ledger, key, contract, note, contractAddress, networkId, payTo);
    if (record && record !== WAITING) found.add(record.commitment);
  }
  return found;
}

/** Marks open records on `contractAddress` closed once their nullifier is on chain. */
export async function settleClosed(module: Module, ledger: any, contractAddress: string): Promise<number> {
  let changed = 0;
  for (const r of await allPositions()) {
    if (r.status !== "open" || r.contractAddress !== contractAddress) continue;
    const nullifier = module.pureCircuits.positionNullifier(bytes(r.opening.salt));
    if (ledger.closed.member(nullifier)) {
      await updatePosition(r.commitment, { status: "closed" });
      changed += 1;
    }
  }
  return changed;
}
