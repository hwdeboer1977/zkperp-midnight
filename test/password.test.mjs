// SPDX-License-Identifier: Apache-2.0

/**
 * The password root (core/password.ts): the wallet plus a password give the
 * same position key on any computer, and nothing else does.
 *
 *   npm run build && node test/password.test.mjs
 */

import { wordlist } from "@scure/bip39/wordlists/english.js";
import { generatePassphrase, passwordProblem, passwordRoot } from "../dist/core/password.js";
import { openNote, positionKey, sealNote, secretsOf } from "../dist/core/notes.js";

let failures = 0;
const expect = (name, cond, detail = "") => {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}\n        ${detail}`);
  }
};
const rejects = async (promise) => promise.then(() => false, () => true);

const hex = (b) => Buffer.from(b).toString("hex");
const filled = (n, byte) => new Uint8Array(n).fill(byte);

const ACCOUNT = filled(32, 0xa1);
const OTHER_ACCOUNT = filled(32, 0xa2);
const PASSWORD = "zkperp test vector password";
const CONTRACT = filled(32, 0xc1);

console.log("\npassword root\n");

const root = await passwordRoot(PASSWORD, ACCOUNT);
// Cross-checked against @noble/hashes' argon2id with the same inputs. If this
// changes, every position opened under the old parameters is hidden.
expect(
  "known answer: the parameters and salt label are unchanged",
  hex(root) === "2d160b2fdcb662b56f1d0c47ffcafe443f138741e55822fb86761624c6de377c",
  hex(root)
);
expect("a root is 32 bytes", root.length === 32);
expect("the same password and account give the same root", hex(await passwordRoot(PASSWORD, ACCOUNT)) === hex(root));
expect("another account gives another root", hex(await passwordRoot(PASSWORD, OTHER_ACCOUNT)) !== hex(root));
expect("another password gives another root", hex(await passwordRoot(`${PASSWORD}!`, ACCOUNT)) !== hex(root));
{
  // "é" typed as one code point, or as "e" plus a combining accent.
  const composed = "crème brûlée à la française";
  const decomposed = composed.normalize("NFD");
  expect(
    "a password is the same however its accents are encoded",
    composed !== decomposed && hex(await passwordRoot(composed, ACCOUNT)) === hex(await passwordRoot(decomposed, ACCOUNT))
  );
}
expect("a short password is refused", passwordProblem("hunter2") !== null && (await rejects(passwordRoot("hunter2", ACCOUNT))));
expect("a long run of one character is refused", passwordProblem("a".repeat(30)) !== null);
expect("a coin key of the wrong length is refused", await rejects(passwordRoot(PASSWORD, filled(31, 1))));

console.log("\ngenerated passphrases\n");
{
  const p = generatePassphrase();
  const words = p.split("-");
  expect("six words by default", words.length === 6, p);
  expect("every word is from the list", words.every((w) => wordlist.includes(w)), p);
  expect("a generated passphrase is accepted", passwordProblem(p) === null, `${p}: ${passwordProblem(p)}`);
  const many = new Set(Array.from({ length: 50 }, () => generatePassphrase()));
  expect("fifty passphrases are all different", many.size === 50);
}

console.log("\nanother computer\n");
{
  // Device A opens a position under the password root.
  const keyA = await positionKey(await passwordRoot(PASSWORD, ACCOUNT));
  const seed = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);
  const opening = { seed, isLong: true, size: 5_000_000_000n, collateral: 500_000_000n, openFee: 5_000_000n, entryPrice: 3_000_000_000n, openTime: 1_800_000_000n };
  const note = await sealNote(keyA, CONTRACT, opening);
  const secretsA = await secretsOf(keyA, seed);

  // Device B has only the wallet account and the password.
  const keyB = await positionKey(await passwordRoot(PASSWORD, ACCOUNT));
  const found = await openNote(keyB, CONTRACT, note);
  expect("the password and wallet open the note elsewhere", found !== null && found.size === opening.size && found.isLong);
  const secretsB = found && (await secretsOf(keyB, found.seed));
  expect(
    "and rebuild the owner secret, salt and coin nonce",
    secretsB !== null &&
      hex(secretsB.ownerSecret) === hex(secretsA.ownerSecret) &&
      hex(secretsB.salt) === hex(secretsA.salt) &&
      hex(secretsB.collateralNonce) === hex(secretsA.collateralNonce)
  );
  const wrongAccount = await positionKey(await passwordRoot(PASSWORD, OTHER_ACCOUNT));
  expect("the password with another wallet account opens nothing", (await openNote(wrongAccount, CONTRACT, note)) === null);
  const wrongPassword = await positionKey(await passwordRoot(`${PASSWORD}?`, ACCOUNT));
  expect("the wallet with another password opens nothing", (await openNote(wrongPassword, CONTRACT, note)) === null);
}

console.log(failures === 0 ? "\nall passed\n" : `\n${failures} failure(s)\n`);
process.exit(failures === 0 ? 0 : 1);
