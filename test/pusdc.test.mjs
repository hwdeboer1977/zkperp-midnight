// SPDX-License-Identifier: Apache-2.0

/**
 * pUSDC's circuits, run locally through the compiled contract — no chain.
 *
 *   npm run compile:skip-zk && node test/pusdc.test.mjs
 */

import {
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";
import { Contract, ledger } from "../contracts/managed/pusdc/contract/index.js";

let failures = 0;
const expect = (name, cond, detail = "") => {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}\n        ${detail}`);
  }
};

const hex = (b) => Buffer.from(b).toString("hex");
const key = (byte) => ({ bytes: new Uint8Array(32).fill(byte) });
const ZERO32 = "00".repeat(32);

const DEPLOYER = key(0x10);
const ALICE = key(0x20);
const BOB = key(0x30);

const ADDRESS = sampleContractAddress();
const contract = new Contract({});
const deploy = () =>
  contract.initialState(createConstructorContext({}, hex(DEPLOYER.bytes))).currentContractState;

function call(caller, state, circuit, ...args) {
  const wrapper = deploy();
  wrapper.data = state;
  try {
    const r = contract.impureCircuits[circuit](
      createCircuitContext(ADDRESS, hex(caller.bytes), wrapper, {}),
      ...args
    );
    return { ok: true, state: r.context.currentQueryContext.state, zswap: r.context.currentZswapLocalState };
  } catch (cause) {
    return { ok: false, error: String(cause?.message ?? cause) };
  }
}

const minted = (r) =>
  r.zswap.outputs.map((o) => ({
    to: o.recipient.is_left ? hex(o.recipient.left.bytes) : "contract",
    value: o.coinInfo.value,
    color: hex(o.coinInfo.color),
    nonce: hex(o.coinInfo.nonce),
  }));

console.log("\npUSDC\n");

{
  const l = ledger(deploy().data);
  expect("no supply at deploy", l.totalSupply === 0n);
  expect("the token type is unset until the first mint", hex(l.tokenId) === ZERO32);
}

const first = call(ALICE, deploy().data, "mint", 1_000_000_000n);
expect("anyone may mint", first.ok, first.error);
if (first.ok) {
  const l = ledger(first.state);
  const coins = minted(first);
  expect("supply moves by the amount", l.totalSupply === 1_000_000_000n);
  expect("the first mint records the token type", hex(l.tokenId) !== ZERO32);
  expect(
    "one coin of that amount, to the caller, of that token type",
    coins.length === 1 &&
      coins[0].to === hex(ALICE.bytes) &&
      coins[0].value === 1_000_000_000n &&
      coins[0].color === hex(l.tokenId)
  );

  const again = call(ALICE, first.state, "mint", 1_000_000_000n);
  expect("an identical second mint is a different coin", again.ok && minted(again)[0].nonce !== coins[0].nonce);

  const to = call(ALICE, first.state, "mintTo", 5n, BOB);
  expect(
    "mintTo pays the named recipient",
    to.ok && minted(to)[0].to === hex(BOB.bytes) && minted(to)[0].color === hex(l.tokenId)
  );
}

console.log(failures ? `\n${failures} failure(s)\n` : "\nall passed\n");
process.exit(failures ? 1 : 0);
