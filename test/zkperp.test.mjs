// SPDX-License-Identifier: Apache-2.0

/**
 * zkperp's circuits, run locally through the compiled contract — no chain.
 *
 *   npm run compile:skip-zk && node test/zkperp.test.mjs
 *
 * Two halves:
 *
 *   · RULES. The pool accepts only pUSDC and mints the right share count; a
 *     long respects the leverage bounds; only the admin moves the price.
 *
 *   · PRIVACY. Opens a long, then renders everything a reader can pull off the
 *     chain — the ledger state and the call's public transcript — and searches
 *     it for the position's size, collateral, owner secret, salt and coin
 *     nonce, in every encoding Compact might use. Positive controls first: the
 *     same search must FIND the values that are public (pool value, mark price,
 *     the commitment), or an empty result means the search is broken, not that
 *     the position is private. Pattern from midnight-polisZK's privacy sweep.
 */

import {
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";
import { Contract, ledger, pureCircuits } from "../contracts/managed/zkperp/contract/index.js";

let failures = 0;
const expect = (name, cond, detail = "") => {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}\n        ${detail}`);
  }
};

const hex = (b) => Buffer.from(b).toString("hex");
const bytes32 = (byte) => new Uint8Array(32).fill(byte);
const key = (byte) => ({ bytes: bytes32(byte) });

const USDC = bytes32(0xc0);
const OTHER_TOKEN = bytes32(0xee);
const ADMIN_SECRET = bytes32(0xad);
const DEPLOYER = key(0x10);
const LP = key(0x20);
const TRADER = key(0x30);

const PRICE = 3_000_000_000n; // $3,000.000000
const MAX_LEVERAGE = 50n;
const MIN_COLLATERAL = 10_000_000n; // 10 pUSDC

const ADDRESS = sampleContractAddress();
const contract = new Contract({});

const deploy = () =>
  contract.initialState(
    createConstructorContext({}, hex(DEPLOYER.bytes)),
    USDC,
    pureCircuits.adminKey(ADMIN_SECRET),
    PRICE,
    MAX_LEVERAGE,
    MIN_COLLATERAL
  ).currentContractState;

/** Runs a circuit against `state`; reports rather than throws. */
function call(caller, state, circuit, ...args) {
  const wrapper = deploy();
  wrapper.data = state;
  try {
    const r = contract.impureCircuits[circuit](
      createCircuitContext(ADDRESS, hex(caller.bytes), wrapper, {}),
      ...args
    );
    return {
      ok: true,
      state: r.context.currentQueryContext.state,
      zswap: r.context.currentZswapLocalState,
      transcript: r.proofData.publicTranscript,
    };
  } catch (cause) {
    return { ok: false, error: String(cause?.message ?? cause) };
  }
}
const why = (r) => (r.ok ? "accepted" : r.error);

let nonceByte = 0;
const coin = (value, color = USDC) => ({ nonce: bytes32(++nonceByte), color, value });

console.log("\nzkperp\n");

// ── Deploy ──────────────────────────────────────────────────────────────────
const genesis = deploy().data;
{
  const l = ledger(genesis);
  expect("pUSDC is the configured token", hex(l.usdc) === hex(USDC));
  expect("the admin is stored as a hash, not the secret", hex(l.admin) !== hex(ADMIN_SECRET));
  expect("the mark price is the initial price", l.markPrice === PRICE);
  expect("the pool starts empty", l.poolValue === 0n && l.lpSupply === 0n);
}

// ── Oracle ──────────────────────────────────────────────────────────────────
{
  const wrong = call(TRADER, genesis, "setPrice", 1n, bytes32(0x01));
  expect("a stranger cannot set the price", !wrong.ok && /not the admin/.test(wrong.error), why(wrong));
  const right = call(TRADER, genesis, "setPrice", 3_100_000_000n, ADMIN_SECRET);
  expect(
    "the admin secret sets the price, whoever submits it",
    right.ok && ledger(right.state).markPrice === 3_100_000_000n,
    why(right)
  );
}

// ── Trading needs a pool ────────────────────────────────────────────────────
{
  const early = call(TRADER, genesis, "openLong", coin(100_000_000n), 1_000_000_000n, bytes32(1), bytes32(2));
  expect("no long can open against an empty pool", !early.ok && /no liquidity/.test(early.error), why(early));
}

// ── Liquidity ───────────────────────────────────────────────────────────────
let pooled;
{
  const wrongToken = call(LP, genesis, "addLiquidity", coin(1_000n, OTHER_TOKEN), 1_000n);
  expect("the pool refuses a token that is not pUSDC", !wrongToken.ok && /only takes pUSDC/.test(wrongToken.error), why(wrongToken));

  const badFirst = call(LP, genesis, "addLiquidity", coin(500_000_000_000n), 1n);
  expect("the first deposit must mint one share per unit", !badFirst.ok, why(badFirst));

  const first = call(LP, genesis, "addLiquidity", coin(500_000_000_000n), 500_000_000_000n);
  expect("the first deposit is accepted", first.ok, why(first));
  const l = ledger(first.state);
  expect("the pool holds it", l.poolValue === 500_000_000_000n && l.pool.value === 500_000_000_000n);
  expect("shares were minted", l.lpSupply === 500_000_000_000n);
  const lpCoins = first.zswap.outputs.filter((o) => o.recipient.is_left);
  expect(
    "the LP receives zLP of the share amount",
    lpCoins.length === 1 &&
      hex(lpCoins[0].recipient.left.bytes) === hex(LP.bytes) &&
      lpCoins[0].coinInfo.value === 500_000_000_000n &&
      hex(lpCoins[0].coinInfo.color) === hex(l.lpToken),
    JSON.stringify(lpCoins.map((o) => String(o.coinInfo.value)))
  );

  // The share count is pinned exactly: value 1000 / supply 1000, deposit 3 →
  // 3 shares; one fewer or one more is refused.
  const small = call(LP, genesis, "addLiquidity", coin(1_000n), 1_000n);
  const three = call(LP, small.state, "addLiquidity", coin(3n), 3n);
  const two = call(LP, small.state, "addLiquidity", coin(3n), 2n);
  const four = call(LP, small.state, "addLiquidity", coin(3n), 4n);
  expect("a later deposit mints its pro-rata share count", three.ok, why(three));
  expect("fewer shares than pro-rata are refused", !two.ok && /too few/.test(two.error), why(two));
  expect("more shares than pro-rata are refused", !four.ok && /too many/.test(four.error), why(four));

  const second = call(LP, first.state, "addLiquidity", coin(250_000_000_000n), 250_000_000_000n);
  expect("a second deposit merges into the one pool coin", second.ok && ledger(second.state).pool.value === 750_000_000_000n, why(second));

  pooled = first.state;
}

// ── Opening a long ──────────────────────────────────────────────────────────
const COLLATERAL = 1_234_567_891n; // 1,234.567891 pUSDC — distinctive on purpose
const SIZE = 12_345_678_912n; //   ~10x
const OWNER_SECRET = bytes32(0x5e);
const SALT = Uint8Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 0xff);

{
  const tooMuch = call(TRADER, pooled, "openLong", coin(COLLATERAL), COLLATERAL * 51n, OWNER_SECRET, SALT);
  expect("51x is refused", !tooMuch.ok && /leverage above/.test(tooMuch.error), why(tooMuch));
  const atCap = call(TRADER, pooled, "openLong", coin(COLLATERAL), COLLATERAL * 50n, OWNER_SECRET, SALT);
  expect("50x is accepted", atCap.ok, why(atCap));
  const under = call(TRADER, pooled, "openLong", coin(COLLATERAL), COLLATERAL - 1n, OWNER_SECRET, SALT);
  expect("under 1x is refused", !under.ok && /under 1x/.test(under.error), why(under));
  const small = call(TRADER, pooled, "openLong", coin(MIN_COLLATERAL - 1n), MIN_COLLATERAL, OWNER_SECRET, SALT);
  expect("collateral below the minimum is refused", !small.ok && /below the minimum/.test(small.error), why(small));
  const other = call(TRADER, pooled, "openLong", coin(COLLATERAL, OTHER_TOKEN), SIZE, OWNER_SECRET, SALT);
  expect("collateral that is not pUSDC is refused", !other.ok && /must be pUSDC/.test(other.error), why(other));
}

const collateralCoin = coin(COLLATERAL);
const opened = call(TRADER, pooled, "openLong", collateralCoin, SIZE, OWNER_SECRET, SALT);
expect("a 10x long opens", opened.ok, why(opened));
if (!opened.ok) {
  console.error(`\n${failures} failure(s)\n`);
  process.exit(1);
}

const after = ledger(opened.state);
const position = {
  owner: pureCircuits.ownerKey(OWNER_SECRET),
  isLong: true,
  size: SIZE,
  collateral: COLLATERAL,
  entryPrice: PRICE,
  collateralNonce: collateralCoin.nonce,
  salt: SALT,
};
const commitment = pureCircuits.positionCommitment(position);
{
  expect("one position is counted", after.openPositions === 1n);
  expect("the pool is untouched by an open", after.poolValue === ledger(pooled).poolValue);
  expect(
    "the trader's opening is in the positions tree",
    after.positions.findPathForLeaf(commitment) !== undefined
  );
  const wrongOpening = pureCircuits.positionCommitment({ ...position, size: SIZE + 1n });
  expect(
    "a different size does not match the commitment",
    after.positions.findPathForLeaf(wrongOpening) === undefined
  );
  const outs = opened.zswap.outputs;
  expect(
    "the collateral coin goes to the contract, not into the pool coin",
    outs.length === 1 && !outs[0].recipient.is_left && outs[0].coinInfo.value === COLLATERAL
  );
}

// ── Privacy sweep ───────────────────────────────────────────────────────────

function render(value, depth = 0) {
  if (depth > 12) return "…";
  if (value === null || value === undefined) return String(value);
  const t = typeof value;
  if (t === "bigint" || t === "boolean" || t === "number" || t === "string") return String(value);
  if (value instanceof Uint8Array) return hex(value);
  if (Array.isArray(value)) return `[${value.map((v) => render(v, depth + 1)).join(",")}]`;
  if (t === "object") {
    return `{${Object.entries(value)
      .map(([k, v]) => `${k}:${render(v, depth + 1)}`)
      .join(",")}}`;
  }
  return String(value);
}

/** Every way a number might appear in a rendering: decimal, BE/LE, minimal and padded. */
function encodings(n) {
  const out = new Set([n.toString()]);
  let h = n.toString(16);
  if (h.length % 2) h = `0${h}`;
  const le = (s) => s.match(/../g).reverse().join("");
  out.add(h).add(le(h));
  for (const width of [8, 16]) {
    const padded = h.padStart(width * 2, "0");
    out.add(padded).add(le(padded));
  }
  return [...out];
}

const haystack = [
  opened.state.toString(),
  render(opened.transcript),
  render({ markPrice: after.markPrice, poolValue: after.poolValue }),
].join("\n").toLowerCase();

const found = (needles) => needles.some((s) => haystack.includes(s.toLowerCase()));

console.log("\n  privacy — positive controls (must be found)\n");
expect("the pool value is visible", found(encodings(after.poolValue)));
expect("the mark price is visible", found(encodings(PRICE)));
// A 32-byte value the transcript really carries: the collateral's token type,
// disclosed to check it is pUSDC. Proves byte strings are rendered and searched.
// (Not the commitment: the tree stores a hash of each leaf, not the leaf.)
expect("the collateral's token type is visible", render(opened.transcript).includes(hex(USDC)));

console.log("\n  privacy — the position (must NOT be found)\n");
expect("size is not on chain", !found(encodings(SIZE)));
expect("collateral is not on chain", !found(encodings(COLLATERAL)));
expect("the owner secret is not on chain", !found([hex(OWNER_SECRET)]));
expect("the owner key is not on chain", !found([hex(position.owner)]));
expect("the salt is not on chain", !found([hex(SALT)]));
expect("the collateral coin nonce is not on chain", !found([hex(collateralCoin.nonce)]));

console.log(failures ? `\n${failures} failure(s)\n` : "\nall passed\n");
process.exit(failures ? 1 : 0);
