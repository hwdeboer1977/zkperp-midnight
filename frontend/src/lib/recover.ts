// SPDX-License-Identifier: Apache-2.0

/**
 * The trader's positions, rebuilt from the chain with the position key.
 *
 *   · `recoverPositions` tries every note in the contract's `notes` set under
 *     the key. A note that opens is one of this trader's positions: its open
 *     landed, since the note and the commitment are written by the same call.
 *     It is closed if its nullifier is in `closed`, open otherwise.
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

/** Notes already tried under a key, so each ledger poll only tries new ones. */
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
  networkId: string
): Promise<number> {
  const contract = bytes(contractAddress);
  const seen = tried.get(key) ?? new Set<string>();
  tried.set(key, seen);
  const existing = new Map((await allPositions()).map((r) => [r.commitment, r]));
  let changed = 0;
  for (const note of ledger.notes as Iterable<Uint8Array>) {
    const id = hex(note);
    if (seen.has(id)) continue;
    seen.add(id);
    const o = await openNote(key, contract, note);
    if (!o) continue;
    const s = await secretsOf(key, o.seed);
    const record: PositionRecord = {
      status: "open",
      contractAddress,
      networkId,
      commitment: "",
      // The open time is the closest thing to a creation time the note has.
      createdAt: new Date(Number(o.openTime) * 1000).toISOString(),
      opening: {
        ownerSecret: hex(s.ownerSecret),
        isLong: o.isLong,
        size: o.size.toString(),
        collateral: o.collateral.toString(),
        openFee: o.openFee.toString(),
        entryPrice: o.entryPrice.toString(),
        openTime: o.openTime.toString(),
        collateralNonce: hex(s.collateralNonce),
        salt: hex(s.salt),
      },
    };
    record.commitment = hex(module.pureCircuits.positionCommitment(positionOf({ module } as any, record)));
    if (ledger.closed.member(module.pureCircuits.positionNullifier(s.ownerSecret, s.salt))) record.status = "closed";
    if (await mergePosition(record, existing.get(record.commitment))) changed += 1;
  }
  return changed;
}

/** Marks open records on `contractAddress` closed once their nullifier is on chain. */
export async function settleClosed(module: Module, ledger: any, contractAddress: string): Promise<number> {
  let changed = 0;
  for (const r of await allPositions()) {
    if (r.status !== "open" || r.contractAddress !== contractAddress) continue;
    const nullifier = module.pureCircuits.positionNullifier(bytes(r.opening.ownerSecret), bytes(r.opening.salt));
    if (ledger.closed.member(nullifier)) {
      await updatePosition(r.commitment, { status: "closed" });
      changed += 1;
    }
  }
  return changed;
}
