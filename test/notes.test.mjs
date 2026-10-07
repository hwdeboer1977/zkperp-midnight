// SPDX-License-Identifier: Apache-2.0

/**
 * Position notes (core/notes.ts): the encrypted openings that let a trader find
 * and close positions from any device.
 *
 *   npm run build && node test/notes.test.mjs
 */

import { NOTE_BYTES, openNote, positionKey, sealNote, secretsOf } from "../dist/core/notes.js";

let failures = 0;
const expect = (name, cond, detail = "") => {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}\n        ${detail}`);
  }
};

const hex = (b) => Buffer.from(b).toString("hex");
const filled = (n, byte) => new Uint8Array(n).fill(byte);

const ROOT = filled(32, 0x42);
const OTHER_ROOT = filled(32, 0x43);
const CONTRACT = filled(32, 0xc1);
const OTHER_CONTRACT = filled(32, 0xc2);
const opening = {
  seed: Uint8Array.from({ length: 32 }, (_, i) => i),
  isLong: false,
  size: 12_345_678_912n,
  collateral: 1_234_567_891n,
  openFee: 12_345_679n,
  entryPrice: 3_000_123_456n,
  openTime: 1_790_000_000n,
};

console.log("\nnotes\n");

const key = await positionKey(ROOT);
const note = await sealNote(key, CONTRACT, opening);
expect(`a note is ${NOTE_BYTES} bytes`, note.length === NOTE_BYTES && NOTE_BYTES === 128);

const back = await openNote(key, CONTRACT, note);
expect(
  "the key that sealed a note opens it",
  back &&
    hex(back.seed) === hex(opening.seed) &&
    back.isLong === opening.isLong &&
    ["size", "collateral", "openFee", "entryPrice", "openTime"].every((f) => back[f] === opening[f]),
  JSON.stringify(back, (_, v) => (typeof v === "bigint" ? v.toString() : v))
);

const long = await openNote(key, CONTRACT, await sealNote(key, CONTRACT, { ...opening, isLong: true }));
expect("direction survives both ways", long?.isLong === true);

// The same root, re-derived, is what another device does.
const again = await positionKey(ROOT);
expect("the same root on another device opens it", (await openNote(again, CONTRACT, note)) !== null);

expect("another key does not open it", (await openNote(await positionKey(OTHER_ROOT), CONTRACT, note)) === null);
expect("it does not open for another contract", (await openNote(key, OTHER_CONTRACT, note)) === null);
const tampered = note.slice();
tampered[40] ^= 1;
expect("a tampered note does not open", (await openNote(key, CONTRACT, tampered)) === null);
expect("a short note does not open", (await openNote(key, CONTRACT, note.slice(0, 100))) === null);

const second = await sealNote(key, CONTRACT, opening);
expect("sealing the same opening twice gives different notes", hex(second) !== hex(note));

// The note must not carry any field in clear.
const be64 = (v) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v);
  return hex(b);
};
const clear = [hex(opening.seed), be64(opening.size), be64(opening.collateral), be64(opening.entryPrice)];
expect("no field appears in clear", clear.every((c) => !hex(note).includes(c)));

const s1 = await secretsOf(key, opening.seed);
const s1again = await secretsOf(again, opening.seed);
const s2 = await secretsOf(key, filled(32, 0x99));
const sOther = await secretsOf(await positionKey(OTHER_ROOT), opening.seed);
expect(
  "secrets are reproducible from the root and the seed",
  hex(s1.ownerSecret) === hex(s1again.ownerSecret) && hex(s1.salt) === hex(s1again.salt) && hex(s1.collateralNonce) === hex(s1again.collateralNonce)
);
expect("secrets are 32 bytes each", [s1.ownerSecret, s1.salt, s1.collateralNonce].every((b) => b.length === 32));
expect("the three secrets differ from each other", new Set([s1.ownerSecret, s1.salt, s1.collateralNonce].map(hex)).size === 3);
expect("another seed gives other secrets", hex(s2.ownerSecret) !== hex(s1.ownerSecret) && hex(s2.salt) !== hex(s1.salt));
expect("another root gives other secrets", hex(sOther.ownerSecret) !== hex(s1.ownerSecret));

if (failures > 0) {
  console.error(`\n${failures} failure(s)\n`);
  process.exit(1);
}
console.log("\nall passed\n");
