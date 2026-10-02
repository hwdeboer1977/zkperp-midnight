// SPDX-License-Identifier: Apache-2.0

/**
 * The trader's position records, in this browser's IndexedDB.
 *
 * A position exists on chain only as a commitment. Closing it takes every
 * field of the opening — owner secret, salt, the collateral coin's nonce —
 * and none of them is recoverable from the chain. Lose these records and the
 * collateral is stuck for good. So, as in core/positions.ts:
 *
 *   · a record is written BEFORE the open is submitted, and marked open or
 *     failed after: a crash leaves a `pending` record, never a position
 *     nobody can describe;
 *   · after every open the trader is asked to download an encrypted backup,
 *     restorable on any browser.
 */

import type { PositionRecord } from "@core/types";

export type { PositionRecord };

const DB = "zkperp";
const STORE = "positions";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "commitment" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = run(t.objectStore(STORE));
    t.oncomplete = () => resolve(req.result);
    t.onerror = () => reject(t.error);
  });
}

export const allPositions = () => tx<PositionRecord[]>("readonly", (s) => s.getAll() as IDBRequest<PositionRecord[]>);

export const putPosition = (record: PositionRecord) => tx("readwrite", (s) => s.put(record));

export async function updatePosition(commitment: string, patch: Partial<PositionRecord>): Promise<void> {
  const current = await tx<PositionRecord | undefined>("readonly", (s) => s.get(commitment) as IDBRequest<PositionRecord | undefined>);
  if (!current) throw new Error(`no record of position ${commitment.slice(0, 12)}…`);
  await putPosition({ ...current, ...patch });
}

// ── Encrypted backup ─────────────────────────────────────────────────────────
//
// AES-GCM under a key derived from a passphrase (PBKDF2-SHA256, 310k rounds).
// The file holds owner secrets: without the passphrase it is useless, with it
// it closes every position in it.

const enc = new TextEncoder();
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function keyFrom(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: 310_000 },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function backupFile(passphrase: string): Promise<Blob> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = enc.encode(JSON.stringify(await allPositions()));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await keyFrom(passphrase, salt), plain)
  );
  const body = { format: "zkperp-positions-v1", kdf: "PBKDF2-SHA256-310000", salt: b64(salt), iv: b64(iv), data: b64(cipher) };
  return new Blob([JSON.stringify(body, null, 2)], { type: "application/json" });
}

/** Rank, so a restore never moves a record backwards (closed beats open). */
const rank: Record<PositionRecord["status"], number> = { failed: 0, pending: 1, open: 2, closed: 3 };

/** Restores a backup, merging: returns how many records were added or advanced. */
export async function restoreBackup(text: string, passphrase: string): Promise<number> {
  const body = JSON.parse(text);
  if (body.format !== "zkperp-positions-v1") throw new Error("not a zkperp positions backup");
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(body.iv) as BufferSource },
      await keyFrom(passphrase, unb64(body.salt)),
      unb64(body.data) as BufferSource
    );
  } catch {
    throw new Error("wrong passphrase, or the file is damaged");
  }
  const records: PositionRecord[] = JSON.parse(new TextDecoder().decode(plain));
  const existing = new Map((await allPositions()).map((r) => [r.commitment, r]));
  let changed = 0;
  for (const r of records) {
    const have = existing.get(r.commitment);
    if (!have || rank[r.status] > rank[have.status]) {
      await putPosition(r);
      changed += 1;
    }
  }
  return changed;
}
