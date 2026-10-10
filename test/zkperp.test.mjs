// SPDX-License-Identifier: Apache-2.0

/**
 * zkperp's circuits, run locally through the compiled contract — no chain.
 *
 *   npm run compile:skip-zk && node test/zkperp.test.mjs
 *
 * Two halves:
 *
 *   · RULES. The pool accepts only pUSDC and mints the right share count; a
 *     position respects the leverage bounds and pays exactly its fees; only
 *     the admin moves the price.
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
import { JUBJUB_ORDER as JUBJUB_ORDER_TS, belowField, decodeLiquidatorPlaintext, randomScalar } from "../dist/core/liquidatorNote.js";
import { deriveOrder, findOwnOrderNote, firesAbove, openOrderNote, orderReached, sealOrderNote } from "../dist/core/orders.js";
import { cancelOrder, executeOrderCall, orderFires, placeOrder, positionOf, watchedOrders, watchedPositions } from "../dist/core/perp.js";
import { decodeLimitPlaintext, filledPosition, limitExpired, limitReached, openLimitNote, sealLimitNote } from "../dist/core/limits.js";
import { executeLimitCall, limitFillOf, limitFires, limitOf, watchedLimits } from "../dist/core/perp.js";
import { orderPlaintext } from "../dist/core/orders.js";
import * as m from "../dist/core/math.js";

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
/** 32 bytes as the two 16-byte halves the open circuit takes. */
const halves = (b) => [b.slice(0, 16), b.slice(16, 32)];

const USDC = bytes32(0xc0);
const OTHER_TOKEN = bytes32(0xee);
const ADMIN_SECRET = bytes32(0xad);
const DEPLOYER = key(0x10);
const LP = key(0x20);
const TRADER = key(0x30);

const PRICE = 3_000_000_000n; // $3,000.000000
const MAX_LEVERAGE = 20n;
const MIN_COLLATERAL = 10_000_000n; // 10 pUSDC
const MAX_PAYOUT = 100_000_000_000n; // 100,000 pUSDC: a 500k pool holds 4 positions
const OPEN_FEE_BPS = 10n; // 0.10%
const CLOSE_FEE_BPS = 10n;
const BORROW_RATE = 1_000_000n; // 10^-6 of size per second
const CLOCK_SLACK = 600n;
const TREASURY = key(0x7e);
// Stands in for an encrypted opening (core/notes.ts); the contract never reads it.
const NOTE = Uint8Array.from({ length: 128 }, (_, i) => (i * 53 + 7) & 0xff);

// Liquidation: below 2.5% of size in equity, a 0.5% fee. The keeper's key
// pair, and what every open passes: an ephemeral scalar and the trader's
// encryption key, both private.
const MAINTENANCE_BPS = 250n;
const LIQUIDATION_FEE_BPS = 50n;
// Near the top of the Jubjub scalar range on purpose: scalars at or above
// the subgroup order are refused, and small ones would not show it.
const JUBJUB_ORDER = 6554484396890773809930967563523245729705921265872317281365359162392183254199n;
if (JUBJUB_ORDER !== JUBJUB_ORDER_TS) throw new Error("core/liquidatorNote.ts has another Jubjub order");
const LIQUIDATOR_SECRET = JUBJUB_ORDER - 0x1234_5678_9abcn;
const LIQUIDATOR_KEY = pureCircuits.liquidatorPublicKey(LIQUIDATOR_SECRET);
const EPHEMERAL = JUBJUB_ORDER - 0xfeed_beefn;
const TRADER_ENC = bytes32(0x3e);

// Block times: positions open at T0 and close an hour later at T1.
const T0 = 1_800_000_000n;
const HELD = 3_600n;
const T1 = T0 + HELD;
// The oracle's price is from just before T0, and stays good for 65 minutes.
const PRICE_TIME = T0 - 10n;
const MAX_PRICE_AGE = 3_900n;

const ceilDiv = (a, b) => (a + b - 1n) / b;
const floorDiv = (a, b) => a / b;
const openFeeOf = (size) => ceilDiv(size * OPEN_FEE_BPS, 10_000n);
const closeFeeOf = (size) => ceilDiv(size * CLOSE_FEE_BPS, 10_000n);
const borrowFeeOf = (size, seconds) => ceilDiv(size * BORROW_RATE * seconds, 1_000_000_000_000n);

const ADDRESS = sampleContractAddress();
const contract = new Contract({});

const deploy = () =>
  contract.initialState(
    createConstructorContext({}, hex(DEPLOYER.bytes)),
    USDC,
    pureCircuits.adminKey(ADMIN_SECRET),
    PRICE,
    PRICE_TIME,
    MAX_LEVERAGE,
    MIN_COLLATERAL,
    MAX_PAYOUT,
    OPEN_FEE_BPS,
    CLOSE_FEE_BPS,
    BORROW_RATE,
    TREASURY,
    CLOCK_SLACK,
    MAX_PRICE_AGE,
    MAINTENANCE_BPS,
    LIQUIDATION_FEE_BPS,
    LIQUIDATOR_KEY
  ).currentContractState;

/** Slots of MAX_PAYOUT a pool of `value` backs, as the contract pins it. */
const capOf = (value) => (value === 0n ? 0n : (value - 1n) / MAX_PAYOUT);
/** Liquidity reserved for open positions. */
const reservedOf = (l) => (l.slotCapacity - l.freeSlots) * MAX_PAYOUT;

// Circuits that change the pool's value take its slot capacity afterwards as
// a last argument. Unless a test passes one, it is computed here.
const POOL_CHANGE = {
  addLiquidity: { arity: 3, delta: (c) => c.value },
  depositFees: { arity: 2, delta: (c) => c.value },
  removeLiquidity: { arity: 3, delta: (_c, amount) => -amount },
};

/** Runs a circuit against `state` at block time `time`; reports rather than throws. */
function callAt(time, caller, state, circuit, ...args) {
  const change = POOL_CHANGE[circuit];
  if (change && args.length === change.arity - 1) {
    args.push(capOf(ledger(state).poolValue + change.delta(...args)));
  }
  const wrapper = deploy();
  wrapper.data = state;
  try {
    const r = contract.impureCircuits[circuit](
      createCircuitContext(ADDRESS, hex(caller.bytes), wrapper, {}, undefined, undefined, Number(time)),
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
const call = (...args) => callAt(T0, ...args);
const why = (r) => (r.ok ? "accepted" : r.error);

let nonceByte = 0;
const coin = (value, color = USDC) => ({ nonce: bytes32(++nonceByte), color, value });

/**
 * Opens a position whose collateral, net of the opening fee, is `c.value`:
 * the coin posted is that plus the fee, which is what a trader does.
 */
function openCall(caller, state, c, size, isLong, secret, salt, overrides = {}) {
  const o = { fee: openFeeOf(size), openTime: T0, time: T0, ...overrides };
  const posted = { ...c, value: c.value + o.fee };
  return callAt(o.time, caller, state, "openPosition", posted, size, isLong, o.fee, o.openTime, secret, salt, o.note ?? NOTE, o.ephemeral ?? EPHEMERAL, ...(o.payToHalves ?? halves(caller.bytes)), ...halves(o.enc ?? TRADER_ENC));
}
/** The collateral coin as the contract holds it: net collateral plus opening fee. */
const held = (c, size) => ({ ...c, value: c.value + openFeeOf(size), mt_index: 0n });

console.log("\nzkperp\n");

// ── Deploy ──────────────────────────────────────────────────────────────────
const genesis = deploy().data;
{
  const l = ledger(genesis);
  expect("pUSDC is the configured token", hex(l.usdc) === hex(USDC));
  expect("the admin is stored as a hash, not the secret", hex(l.admin) !== hex(ADMIN_SECRET));
  expect("the mark price is the initial price", l.markPrice === PRICE);
  expect("the pool starts empty", l.poolValue === 0n && l.lpSupply === 0n);
  expect("the fees and treasury are as configured", l.openFeeBps === OPEN_FEE_BPS && l.borrowRate === BORROW_RATE && hex(l.treasury.bytes) === hex(TREASURY.bytes));
}

// ── Oracle ──────────────────────────────────────────────────────────────────
{
  const wrong = call(TRADER, genesis, "setPrice", 1n, T0, bytes32(0x01));
  expect("a stranger cannot set the price", !wrong.ok && /not the admin/.test(wrong.error), why(wrong));
  const right = call(TRADER, genesis, "setPrice", 3_100_000_000n, T0, ADMIN_SECRET);
  expect(
    "the admin secret sets the price and its time, whoever submits it",
    right.ok && ledger(right.state).markPrice === 3_100_000_000n && ledger(right.state).priceTime === T0,
    why(right)
  );
  const future = call(TRADER, genesis, "setPrice", 3_100_000_000n, T0 + 1n, ADMIN_SECRET);
  expect("a price time in the future is refused", !future.ok && /in the future/.test(future.error), why(future));
  const replay = call(TRADER, genesis, "setPrice", 2_900_000_000n, PRICE_TIME - 1n, ADMIN_SECRET);
  expect("an older round cannot replace the price", !replay.ok && /older than the current/.test(replay.error), why(replay));
}

// ── Trading needs a pool ────────────────────────────────────────────────────
{
  const early = openCall(TRADER, genesis, coin(100_000_000n), 1_000_000_000n, true, bytes32(1), bytes32(2));
  expect("no long can open against an empty pool", !early.ok && /no room/.test(early.error), why(early));
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
  expect("a 500k pool backs four 100k slots, all free", l.slotCapacity === 4n && l.freeSlots === 4n, `${l.slotCapacity}/${l.freeSlots}`);
  const overCap = call(LP, genesis, "addLiquidity", coin(500_000_000_000n), 500_000_000_000n, 5n);
  expect("an overstated slot capacity is refused", !overCap.ok && /capacity overstated/.test(overCap.error), why(overCap));
  const underCap = call(LP, genesis, "addLiquidity", coin(500_000_000_000n), 500_000_000_000n, 3n);
  expect("an understated slot capacity is refused", !underCap.ok && /capacity understated/.test(underCap.error), why(underCap));
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
// Salts and coin nonces must be below the field size (see `belowField`).
const SALT = belowField(Uint8Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 0xff));

{
  const tooMuch = openCall(TRADER, pooled, coin(COLLATERAL), COLLATERAL * 21n, true, OWNER_SECRET, SALT);
  expect("21x is refused", !tooMuch.ok && /leverage above/.test(tooMuch.error), why(tooMuch));
  const atCap = openCall(TRADER, pooled, coin(COLLATERAL), COLLATERAL * 20n, true, OWNER_SECRET, SALT);
  expect("20x of the collateral net of the fee is accepted", atCap.ok, why(atCap));
  // The fee comes out of the coin first, so 20x of the whole coin is too much.
  const grossTooBig = callAt(T0, TRADER, pooled, "openPosition", coin(COLLATERAL), COLLATERAL * 20n, true, openFeeOf(COLLATERAL * 20n), T0, OWNER_SECRET, SALT, NOTE, EPHEMERAL, ...halves(TRADER.bytes), ...halves(TRADER_ENC));
  expect("leverage is checked on the collateral net of the fee", !grossTooBig.ok && /leverage above/.test(grossTooBig.error), why(grossTooBig));
  const under = openCall(TRADER, pooled, coin(COLLATERAL), COLLATERAL - 1n, true, OWNER_SECRET, SALT);
  expect("under 1x is refused", !under.ok && /under 1x/.test(under.error), why(under));
  const small = openCall(TRADER, pooled, coin(MIN_COLLATERAL - 1n), MIN_COLLATERAL, true, OWNER_SECRET, SALT);
  expect("collateral below the minimum is refused", !small.ok && /below the minimum/.test(small.error), why(small));
  const other = openCall(TRADER, pooled, coin(COLLATERAL, OTHER_TOKEN), SIZE, true, OWNER_SECRET, SALT);
  expect("collateral that is not pUSDC is refused", !other.ok && /must be pUSDC/.test(other.error), why(other));

  const fee = openFeeOf(SIZE);
  const lowFee = openCall(TRADER, pooled, coin(COLLATERAL), SIZE, true, OWNER_SECRET, SALT, { fee: fee - 1n });
  expect("an opening fee one unit short is refused", !lowFee.ok && /opening fee understated/.test(lowFee.error), why(lowFee));
  const highFee = openCall(TRADER, pooled, coin(COLLATERAL), SIZE, true, OWNER_SECRET, SALT, { fee: fee + 1n });
  expect("an opening fee one unit over is refused", !highFee.ok && /opening fee overstated/.test(highFee.error), why(highFee));
  // 1 unit of size at 10 bps is 0.001 of a unit: rounded up, it costs 1.
  expect("(fees round up: size 1 pays 1)", openFeeOf(1n) === 1n);

  const future = openCall(TRADER, pooled, coin(COLLATERAL), SIZE, true, OWNER_SECRET, SALT, { openTime: T0 + 1n });
  expect("an open time in the future is refused", !future.ok && /in the future/.test(future.error), why(future));
  const stale = openCall(TRADER, pooled, coin(COLLATERAL), SIZE, true, OWNER_SECRET, SALT, { openTime: T0 - CLOCK_SLACK });
  expect("an open time older than the slack is refused", !stale.ok && /too far in the past/.test(stale.error), why(stale));
  const lagging = openCall(TRADER, pooled, coin(COLLATERAL), SIZE, true, OWNER_SECRET, SALT, { openTime: T0 - CLOCK_SLACK + 1n });
  expect("an open time within the slack is accepted", lagging.ok, why(lagging));
}

const collateralCoin = coin(COLLATERAL);
const opened = openCall(TRADER, pooled, collateralCoin, SIZE, true, OWNER_SECRET, SALT);
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
  openFee: openFeeOf(SIZE),
  entryPrice: PRICE,
  openTime: T0,
  collateralNonce: collateralCoin.nonce,
  salt: SALT,
  // ownPublicKey() at the open: the caller's coin key.
  payTo: TRADER,
};
const commitment = pureCircuits.positionCommitment(position);
{
  expect("one position is counted", after.openPositions === 1n);
  expect("the open's note is stored", after.notes.size() === 1n && after.notes.member(NOTE));
  expect("the pool is untouched by an open", after.poolValue === ledger(pooled).poolValue);
  expect("an open reserves exactly maxPayout", reservedOf(after) === MAX_PAYOUT, String(reservedOf(after)));
  expect("an open takes one free slot", after.freeSlots === ledger(pooled).freeSlots - 1n);
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
    "the whole coin, fee included, goes to the contract, not into the pool coin",
    outs.length === 1 && !outs[0].recipient.is_left && outs[0].coinInfo.value === COLLATERAL + openFeeOf(SIZE)
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
expect("the coin's value is not on chain", !found(encodings(COLLATERAL + openFeeOf(SIZE))));
expect("the opening fee is not on chain", !found(encodings(openFeeOf(SIZE))));
expect("the owner secret is not on chain", !found([hex(OWNER_SECRET)]));
expect("the owner key is not on chain", !found(encodings(position.owner)));
expect("the salt is not on chain", !found([hex(SALT)]));
expect("the collateral coin nonce is not on chain", !found([hex(collateralCoin.nonce)]));
expect("the payout key is not on chain", !found([hex(TRADER.bytes)]));
expect("the trader's encryption key is not on chain", !found([hex(TRADER_ENC)]));
expect("control: the liquidator note is stored", after.liquidatorNotes.size() === 1n);

// ── The liquidator's note ───────────────────────────────────────────────────

console.log("\n  the liquidator's note\n");
{
  const [note] = [...after.liquidatorNotes];
  const view = decodeLiquidatorPlaintext(pureCircuits.openLiquidatorNote(note, LIQUIDATOR_SECRET));
  expect(
    "the keeper's key opens it into the position, owner secret excluded",
    hex(pureCircuits.positionCommitment(view.position)) === hex(commitment)
  );
  expect("it carries the trader's encryption key", hex(view.payToEnc) === hex(TRADER_ENC));
  expect("it does not carry the owner secret", !render(note).includes(hex(OWNER_SECRET)));
  let wrong;
  try {
    wrong = decodeLiquidatorPlaintext(pureCircuits.openLiquidatorNote(note, LIQUIDATOR_SECRET + 1n));
  } catch {
    wrong = null;
  }
  expect(
    "another key does not open it",
    wrong === null || hex(pureCircuits.positionCommitment(wrong.position)) !== hex(commitment)
  );
  const twin = openCall(TRADER, pooled, collateralCoin, SIZE, true, OWNER_SECRET, SALT, { ephemeral: EPHEMERAL + 1n });
  const [twinNote] = [...ledger(twin.state).liquidatorNotes];
  expect(
    "the same position under another ephemeral scalar gives an unrelated note",
    twin.ok && render(twinNote.fields) !== render(note.fields) && !render(twinNote).includes(render(note.ephemeral))
  );
  const zero = openCall(TRADER, pooled, coin(COLLATERAL), SIZE, true, OWNER_SECRET, SALT, { ephemeral: 0n });
  expect("a zero ephemeral scalar is refused", !zero.ok && /ephemeral/.test(zero.error), why(zero));
  const wrongHalves = openCall(TRADER, pooled, coin(COLLATERAL), SIZE, true, OWNER_SECRET, SALT, { payToHalves: halves(bytes32(0x66)) });
  expect(
    "payout key halves that are not the opener's key are refused",
    !wrongHalves.ok && /halves do not match/.test(wrongHalves.error),
    why(wrongHalves)
  );
  const highSalt = openCall(TRADER, pooled, coin(COLLATERAL), SIZE, true, OWNER_SECRET, bytes32(0xff));
  expect("a salt above the field size is refused", !highSalt.ok, why(highSalt));
  const tooBig = openCall(TRADER, pooled, coin(COLLATERAL), SIZE, true, OWNER_SECRET, SALT, { ephemeral: JUBJUB_ORDER });
  expect("an ephemeral scalar at the Jubjub order is refused", !tooBig.ok, why(tooBig));
  const drawn = Array.from({ length: 200 }, () => randomScalar());
  expect("random scalars are non-zero and below the Jubjub order", drawn.every((x) => x > 0n && x < JUBJUB_ORDER));
  expect("and reach the top of the range", drawn.some((x) => x > JUBJUB_ORDER / 2n));
  const random = openCall(TRADER, pooled, coin(COLLATERAL), SIZE, true, OWNER_SECRET, SALT, { ephemeral: drawn[0] });
  expect("an open with a random scalar is accepted", random.ok, why(random));
}


// ── Closing ─────────────────────────────────────────────────────────────────

console.log("\n  closing\n");

// A close pays the wallet that opened the position, whoever submits it.
const RECIPIENT = TRADER;
const THIEF = key(0x66);
const qualified = held(collateralCoin, SIZE);
const OPEN_FEE = openFeeOf(SIZE);
const CLOSE_FEE = closeFeeOf(SIZE);
const BORROW_FEE = borrowFeeOf(SIZE, HELD);
const FEES = OPEN_FEE + CLOSE_FEE + BORROW_FEE;
// What the trader gets from the coin when nothing is lost: the collateral
// less the closing and borrow fees.
const KEEP = COLLATERAL - CLOSE_FEE - BORROW_FEE;
const pathFor = (state) => ledger(state).positions.findPathForLeaf(commitment);
const at = (price) => {
  const r = call(DEPLOYER, opened.state, "setPrice", price, T0, ADMIN_SECRET);
  if (!r.ok) throw new Error(r.error);
  return r.state;
};
const closeArgs = (o) => [o.position, o.secret, o.path, o.coin, o.pnl, o.closeFee, o.borrowFee, o.closeTime, o.capacity];

/**
 * The pool's slot capacity after a close, worked out as the contract settles:
 * a loss (at most the collateral) in, a profit less any fee shortfall out.
 */
function closeCapacity(state, o) {
  const l = ledger(state);
  const p = o.position;
  const profit = p.isLong ? l.markPrice >= p.entryPrice : l.markPrice <= p.entryPrice;
  const toPool = profit ? 0n : o.pnl < p.collateral ? o.pnl : p.collateral;
  const afterLoss = p.collateral - toPool;
  const fees = o.closeFee + o.borrowFee;
  const shortfall = fees > afterLoss ? fees - afterLoss : 0n;
  const fromPool = profit && o.pnl > shortfall ? o.pnl - shortfall : 0n;
  return capOf(l.poolValue + toPool - fromPool);
}
const close = (state, overrides = {}) => {
  const o = {
    position,
    secret: OWNER_SECRET,
    path: pathFor(state),
    coin: qualified,
    pnl: 0n,
    closeFee: CLOSE_FEE,
    borrowFee: BORROW_FEE,
    closeTime: T1,
    time: T1,
    caller: TRADER,
    ...overrides,
  };
  o.capacity ??= closeCapacity(state, o);
  return callAt(o.time, o.caller, state, "closePosition", ...closeArgs(o));
};
const paidTo = (r, who) =>
  r.zswap.outputs
    .filter((o) => o.recipient.is_left && hex(o.recipient.left.bytes) === hex(who.bytes))
    .reduce((sum, o) => sum + o.coinInfo.value, 0n);
const toContract = (r) => r.zswap.outputs.filter((o) => !o.recipient.is_left);

// Unchanged price: the custody test. The collateral back less closing and
// borrow fees, all three fees to the treasury, the pool untouched.
const flat = close(opened.state);
expect("close at an unchanged price is accepted", flat.ok, why(flat));
if (flat.ok) {
  const l = ledger(flat.state);
  expect("the recipient gets the collateral less the closing and borrow fees", paidTo(flat, RECIPIENT) === KEEP, `${paidTo(flat, RECIPIENT)} vs ${KEEP}`);
  expect("the treasury gets all three fees", paidTo(flat, TREASURY) === FEES, `${paidTo(flat, TREASURY)} vs ${FEES}`);
  expect("no one else is paid", flat.zswap.outputs.filter((o) => o.recipient.is_left).length === 2);
  expect("the pool is untouched: no fee reaches it", l.poolValue === after.poolValue);
  expect("the close is counted", l.closedPositions === 1n);
  expect(
    "the nullifier is recorded",
    l.closed.member(pureCircuits.positionNullifier(SALT))
  );
  expect("a close gives its slot back", l.freeSlots === ledger(pooled).freeSlots);
  const anyCap = close(opened.state, { capacity: 12_345n });
  expect("at an unchanged price the slot capacity is ignored: the pool is not touched", anyCap.ok, why(anyCap));
  const twice = close(flat.state);
  expect("a position cannot close twice", !twice.ok && /already closed/.test(twice.error), why(twice));

  // Privacy of the close itself.
  const closeHaystack = [flat.state.toString(), render(flat.transcript)].join("\n").toLowerCase();
  const inClose = (needles) => needles.some((s) => closeHaystack.includes(s.toLowerCase()));
  expect(
    "control: the close's nullifier is visible",
    inClose([hex(pureCircuits.positionNullifier(SALT))])
  );
  expect("close: size is not published", !inClose(encodings(SIZE)));
  expect("close: collateral is not published", !inClose(encodings(COLLATERAL)));
  expect("close: the fees to the treasury are not published", !inClose(encodings(FEES)));
  expect("close: the closing fee is not published", !inClose(encodings(CLOSE_FEE)));
  expect("close: the trader's payout is not published", !inClose(encodings(KEEP)));
  expect("control: the close time is visible", inClose(encodings(T1)));
  expect("close: the recipient's key is not published", !inClose([hex(RECIPIENT.bytes)]));
  expect("close: the owner secret is not published", !inClose([hex(OWNER_SECRET)]));
  expect("close: the salt is not published", !inClose([hex(SALT)]));
  expect("close: the collateral nonce is not published", !inClose([hex(collateralCoin.nonce)]));
}

{
  const stranger = close(opened.state, { secret: bytes32(0x99) });
  expect("a wrong owner secret cannot close", !stranger.ok && /not the owner/.test(stranger.error), why(stranger));

  // Payout binding: the owner secret lets anyone close, but only pays the opener.
  const stolen = close(opened.state, { caller: THIEF });
  expect("another wallet holding the owner secret can close", stolen.ok, why(stolen));
  if (stolen.ok) {
    expect("that close still pays the opening wallet", paidTo(stolen, TRADER) === KEEP, `${paidTo(stolen, TRADER)} vs ${KEEP}`);
    expect("and pays the closing wallet nothing", paidTo(stolen, THIEF) === 0n);
  }
  const redirected = close(opened.state, { position: { ...position, payTo: THIEF }, caller: THIEF });
  expect(
    "a close cannot name another payout key",
    !redirected.ok && /different position/.test(redirected.error),
    why(redirected)
  );
  const otherCoin = close(opened.state, { coin: { ...qualified, nonce: bytes32(0x42) } });
  expect("a different collateral coin is refused", !otherCoin.ok && /not this position's collateral/.test(otherCoin.error), why(otherCoin));
  const forged = close(opened.state, { position: { ...position, size: SIZE * 2n } });
  expect("an altered opening is not in the tree", !forged.ok, why(forged));
  const greedy = close(opened.state, { pnl: 1n });
  expect("a profit at an unchanged price is refused", !greedy.ok && /profit overstated/.test(greedy.error), why(greedy));

  const lowClose = close(opened.state, { closeFee: CLOSE_FEE - 1n });
  expect("a closing fee one unit short is refused", !lowClose.ok && /closing fee understated/.test(lowClose.error), why(lowClose));
  const highClose = close(opened.state, { closeFee: CLOSE_FEE + 1n });
  expect("a closing fee one unit over is refused", !highClose.ok && /closing fee overstated/.test(highClose.error), why(highClose));
  const lowBorrow = close(opened.state, { borrowFee: BORROW_FEE - 1n });
  expect("a borrow fee one unit short is refused", !lowBorrow.ok && /borrow fee understated/.test(lowBorrow.error), why(lowBorrow));
  const highBorrow = close(opened.state, { borrowFee: BORROW_FEE + 1n });
  expect("a borrow fee one unit over is refused", !highBorrow.ok && /borrow fee overstated/.test(highBorrow.error), why(highBorrow));

  // Naming the close time early would shrink the borrow fee: at most the
  // slack is tolerated.
  const backdated = close(opened.state, { closeTime: T1 - CLOCK_SLACK, borrowFee: borrowFeeOf(SIZE, HELD - CLOCK_SLACK) });
  expect("a close time older than the slack is refused", !backdated.ok && /too far in the past/.test(backdated.error), why(backdated));
  const ahead = close(opened.state, { closeTime: T1 + 1n, borrowFee: borrowFeeOf(SIZE, HELD + 1n) });
  expect("a close time in the future is refused", !ahead.ok && /in the future/.test(ahead.error), why(ahead));
  const beforeOpen = close(opened.state, { time: T0, closeTime: T0 - 1n, borrowFee: 0n });
  expect("a close time before the open is refused", !beforeOpen.ok && /before the open/.test(beforeOpen.error), why(beforeOpen));
  const instant = close(opened.state, { time: T0, closeTime: T0, borrowFee: 0n });
  expect("a position closed in the second it opened owes no borrow fee", instant.ok && paidTo(instant, TREASURY) === OPEN_FEE + CLOSE_FEE, why(instant));
}

// ── A stale price ───────────────────────────────────────────────────────────

console.log("\n  stale price\n");
{
  const STALE = PRICE_TIME + MAX_PRICE_AGE;
  const lastGood = openCall(TRADER, pooled, coin(COLLATERAL), SIZE, true, OWNER_SECRET, SALT, { time: STALE - 1n, openTime: STALE - 1n });
  expect("an open with a price just inside its age limit is accepted", lastGood.ok, why(lastGood));
  const staleOpen = openCall(TRADER, pooled, coin(COLLATERAL), SIZE, true, OWNER_SECRET, SALT, { time: STALE, openTime: STALE });
  expect("an open with a stale price is refused", !staleOpen.ok && /price is stale/.test(staleOpen.error), why(staleOpen));
  const staleClose = close(opened.state, { time: STALE, closeTime: STALE, borrowFee: borrowFeeOf(SIZE, STALE - T0) });
  expect("a close with a stale price is refused", !staleClose.ok && /price is stale/.test(staleClose.error), why(staleClose));
  const refreshed = callAt(STALE, DEPLOYER, opened.state, "setPrice", PRICE, STALE, ADMIN_SECRET);
  const afterReport = close(refreshed.state, { time: STALE, closeTime: STALE, borrowFee: borrowFeeOf(SIZE, STALE - T0) });
  expect("once the oracle reports again, the close goes through", afterReport.ok, why(afterReport));
  const pool = callAt(STALE, LP, pooled, "addLiquidity", coin(1_000_000n), 1_000_000n);
  expect("liquidity does not depend on the price, stale or not", pool.ok, why(pool));
}

// ── Solvency ────────────────────────────────────────────────────────────────
{
  expect("a close releases the reservation", flat.ok && reservedOf(ledger(flat.state)) === 0n);

  // 500k pool, 100k per position: four fit (400k < 500k), a fifth does not.
  let state = pooled;
  let accepted = 0;
  let refusal = "";
  for (let i = 0; i < 5; i += 1) {
    const r = openCall(TRADER, state, coin(COLLATERAL), SIZE, true, OWNER_SECRET, belowField(bytes32(0xa0 + i)));
    if (r.ok) {
      accepted += 1;
      state = r.state;
    } else refusal = r.error;
  }
  expect("four 100k reservations fit a 500k pool", accepted === 4, `${accepted} accepted`);
  expect("the fifth is refused while reserved would reach the pool", /no room/.test(refusal), refusal);
  expect("reserved is positions × maxPayout", reservedOf(ledger(state)) === 4n * MAX_PAYOUT);

  // Price ×10: the raw profit (9 × size ≈ 111k) exceeds the 100k cap.
  const moon = at(30_000_000_000n);
  const raw = floorDiv(SIZE * 27_000_000_000n, PRICE);
  expect("(the raw profit here is above the cap)", raw > MAX_PAYOUT);
  const uncapped = close(moon, { pnl: raw });
  expect("a profit above the cap is refused", !uncapped.ok && /payout cap/.test(uncapped.error), why(uncapped));
  const underCap = close(moon, { pnl: MAX_PAYOUT - 1n });
  expect("less than the cap is refused when the cap binds", !underCap.ok && /understated/.test(underCap.error), why(underCap));
  const capped = close(moon, { pnl: MAX_PAYOUT });
  expect("the capped profit is paid — an enforced take-profit", capped.ok, why(capped));
  if (capped.ok) {
    expect("the recipient gets collateral less fees plus exactly the cap", paidTo(capped, RECIPIENT) === KEEP + MAX_PAYOUT);
    expect("the treasury gets the fees", paidTo(capped, TREASURY) === FEES);
    expect("the pool pays exactly the cap", ledger(capped.state).poolValue === after.poolValue - MAX_PAYOUT);
    expect("the reservation is released", reservedOf(ledger(capped.state)) === 0n);
  }
}

// Price up 10%: profit = floor(size × 300 / 3000), paid by the pool.
{
  const up = at(3_300_000_000n);
  const profit = floorDiv(SIZE * 300_000_000n, PRICE);
  const over = close(up, { pnl: profit + 1n });
  expect("an overstated profit is refused", !over.ok && /overstated/.test(over.error), why(over));
  const under = close(up, { pnl: profit - 1n });
  expect("an understated profit is refused", !under.ok && /understated/.test(under.error), why(under));
  const wrongCap = close(up, { pnl: profit, capacity: capOf(after.poolValue - profit) + 1n });
  expect("a close that moves the pool must give its new slot capacity", !wrongCap.ok && /capacity overstated/.test(wrongCap.error), why(wrongCap));
  const win = close(up, { pnl: profit });
  expect("a winning long closes", win.ok, why(win));
  if (win.ok) {
    expect(
      "the recipient gets collateral less fees plus profit",
      paidTo(win, RECIPIENT) === KEEP + profit,
      `${paidTo(win, RECIPIENT)} vs ${KEEP + profit}`
    );
    expect("the treasury gets the fees", paidTo(win, TREASURY) === FEES);
    expect("the pool pays exactly the profit, fees aside", ledger(win.state).poolValue === after.poolValue - profit);
    expect("the pool keeps its change", toContract(win).some((o) => o.coinInfo.value === after.poolValue - profit));
  }
}

// Price down 5%: loss = ceil(size × 150 / 3000), kept by the pool.
let afterLoss;
{
  const down = at(2_850_000_000n);
  const loss = ceilDiv(SIZE * 150_000_000n, PRICE);
  const low = close(down, { pnl: loss - 1n });
  expect("an understated loss is refused", !low.ok && /loss understated/.test(low.error), why(low));
  const lose = close(down, { pnl: loss });
  expect("a losing long closes", lose.ok, why(lose));
  if (lose.ok) {
    expect("the recipient gets collateral minus loss and fees", paidTo(lose, RECIPIENT) === KEEP - loss);
    expect("the treasury gets the fees", paidTo(lose, TREASURY) === FEES);
    expect("the pool gains exactly the loss, no fees", ledger(lose.state).poolValue === after.poolValue + loss);
    afterLoss = lose.state;
  }
}

// Price down 20% at ~10x: the loss exceeds the collateral.
{
  const crash = at(2_400_000_000n);
  const loss = ceilDiv(SIZE * 600_000_000n, PRICE);
  const wiped = close(crash, { pnl: loss });
  expect("a wiped-out long closes", wiped.ok, why(wiped));
  if (wiped.ok) {
    expect("the recipient gets nothing", paidTo(wiped, RECIPIENT) === 0n);
    expect("the treasury gets the opening fee only: the others are forgiven", paidTo(wiped, TREASURY) === OPEN_FEE);
    expect("the pool gains the whole collateral, no more", ledger(wiped.state).poolValue === after.poolValue + COLLATERAL);
  }
}

// ── Liquidation ─────────────────────────────────────────────────────────────

console.log("\n  liquidation\n");

const KEEPER = key(0x4b);
const LIQ_FEE = ceilDiv(SIZE * LIQUIDATION_FEE_BPS, 10_000n);
/** Liquidates `p` (default: the long) at the state's price, as the keeper. No owner secret. */
const liquidate = (state, overrides = {}) => {
  const o = {
    position,
    path: ledger(state).positions.findPathForLeaf(pureCircuits.positionCommitment(overrides.position ?? position)),
    coin: qualified,
    pnl: 0n,
    closeFee: CLOSE_FEE,
    borrowFee: BORROW_FEE,
    liquidationFee: LIQ_FEE,
    closeTime: T1,
    time: T1,
    caller: KEEPER,
    ...overrides,
  };
  o.capacity ??= closeCapacity(state, o);
  return callAt(
    o.time, o.caller, state, "liquidatePosition",
    o.position, o.path, o.coin, o.pnl, o.closeFee, o.borrowFee, o.liquidationFee, o.closeTime, o.capacity
  );
};
const lossAt = (price) => ceilDiv(SIZE * (PRICE - price), PRICE);
{
  const healthy = liquidate(opened.state);
  expect("a healthy position cannot be liquidated", !healthy.ok && /above maintenance/.test(healthy.error), why(healthy));

  const up = 3_150_000_000n;
  const inProfit = liquidate(at(up), { pnl: floorDiv(SIZE * (up - PRICE), PRICE) });
  expect("a position in profit cannot be liquidated", !inProfit.ok && /in profit/.test(inProfit.error), why(inProfit));

  // A 7% drop: equity 30% of collateral less fees, still above 2.5% of a 10x size.
  const near = 2_790_000_000n;
  const almost = liquidate(at(near), { pnl: lossAt(near) });
  expect("just above maintenance it cannot be liquidated", !almost.ok && /above maintenance/.test(almost.error), why(almost));

  // An 8% drop: equity 20% of collateral less fees, below maintenance.
  const low = 2_760_000_000n;
  const state = at(low);
  const loss = lossAt(low);
  const equity = COLLATERAL - loss - CLOSE_FEE - BORROW_FEE;
  const liq = liquidate(state, { pnl: loss });
  expect("below maintenance the keeper liquidates without the owner secret", liq.ok, why(liq));
  if (liq.ok) {
    const l = ledger(liq.state);
    expect("the trader's payTo gets the equity less the liquidation fee", paidTo(liq, TRADER) === equity - LIQ_FEE, `${paidTo(liq, TRADER)} vs ${equity - LIQ_FEE}`);
    expect("the treasury gets the three fees and the liquidation fee", paidTo(liq, TREASURY) === FEES + LIQ_FEE, `${paidTo(liq, TREASURY)} vs ${FEES + LIQ_FEE}`);
    expect("the keeper is paid nothing directly", paidTo(liq, KEEPER) === 0n);
    expect("the pool gains the loss", l.poolValue === ledger(state).poolValue + loss);
    expect("no slot stays reserved", reservedOf(l) === 0n, String(reservedOf(l)));
    expect("the position's nullifier is spent", l.closed.member(pureCircuits.positionNullifier(SALT)));
    const late = close(liq.state, { pnl: loss });
    expect("the trader cannot close it afterwards", !late.ok && /already closed/.test(late.error), why(late));
    const again = liquidate(liq.state, { pnl: loss });
    expect("nor can it be liquidated twice", !again.ok && /already closed/.test(again.error), why(again));

    const liqHaystack = [liq.state.toString(), render(liq.transcript)].join("\n").toLowerCase();
    const inLiq = (needles) => needles.some((x) => liqHaystack.includes(x.toLowerCase()));
    expect("control: the liquidation's nullifier is visible", inLiq([hex(pureCircuits.positionNullifier(SALT))]));
    expect("liquidation: the payout key is not published", !inLiq([hex(TRADER.bytes)]));
    expect("liquidation: size is not published", !inLiq(encodings(SIZE)));
    expect("liquidation: the trader's equity is not published", !inLiq(encodings(equity - LIQ_FEE)));
  }
  const closedFirst = close(state, { pnl: loss });
  expect("the trader can still close an underwater position first", closedFirst.ok, why(closedFirst));
  if (closedFirst.ok) {
    const beaten = liquidate(closedFirst.state, { pnl: loss });
    expect("and then it cannot be liquidated", !beaten.ok && /already closed/.test(beaten.error), why(beaten));
  }

  const lowFee = liquidate(state, { pnl: loss, liquidationFee: LIQ_FEE - 1n });
  expect("an understated liquidation fee is refused", !lowFee.ok && /understated/.test(lowFee.error), why(lowFee));
  const highFee = liquidate(state, { pnl: loss, liquidationFee: LIQ_FEE + 1n });
  expect("an overstated liquidation fee is refused", !highFee.ok && /overstated/.test(highFee.error), why(highFee));
  const sneaky = close(state, { pnl: loss });
  expect("a close charges no liquidation fee", sneaky.ok && paidTo(sneaky, TREASURY) === FEES, why(sneaky));
  const forged = liquidate(state, { pnl: loss, position: { ...position, payTo: KEEPER } });
  expect("the keeper cannot redirect the equity", !forged.ok, why(forged));

  // A 15% drop: the loss exceeds the collateral, nothing is left for anyone but the pool.
  const crash = 2_550_000_000n;
  const wiped = liquidate(at(crash), { pnl: lossAt(crash) });
  expect("a wiped-out position liquidates", wiped.ok, why(wiped));
  if (wiped.ok) {
    expect("the trader gets nothing", paidTo(wiped, TRADER) === 0n);
    expect("the treasury gets only the opening fee", paidTo(wiped, TREASURY) === OPEN_FEE, `${paidTo(wiped, TREASURY)} vs ${OPEN_FEE}`);
    expect("the pool keeps the whole collateral", ledger(wiped.state).poolValue === ledger(at(crash)).poolValue + COLLATERAL);
  }
}

// ── Trigger orders: stop loss and take profit ───────────────────────────────

console.log("\n  trigger orders\n");

{
  const STOP = 2_901_234_567n; // distinctive, to search the transcripts for
  const { salt: ORDER_SALT, ephemeral: ORDER_EPHEMERAL } = await deriveOrder(OWNER_SECRET, SALT, 0);
  const stopLoss = { position: commitment, price: STOP, above: firesAbove(true, "stopLoss"), salt: ORDER_SALT };
  const stopNote = sealOrderNote(pureCircuits, LIQUIDATOR_KEY, SALT, stopLoss, ORDER_EPHEMERAL);
  const place = (state, overrides = {}) => {
    const o = { position, secret: OWNER_SECRET, order: stopLoss, note: stopNote, caller: TRADER, time: T0, ...overrides };
    return callAt(o.time, o.caller, state, "placeOrder", o.position, o.secret, o.order, o.note);
  };
  const priced = (state, price) => {
    const r = call(DEPLOYER, state, "setPrice", price, T0, ADMIN_SECRET);
    if (!r.ok) throw new Error(r.error);
    return r.state;
  };
  const execute = (state, order, overrides = {}) => {
    const o = {
      position,
      path: ledger(state).positions.findPathForLeaf(commitment),
      order,
      orderPath: ledger(state).orders.findPathForLeaf(pureCircuits.orderCommitment(order)),
      coin: qualified,
      pnl: 0n,
      closeFee: CLOSE_FEE,
      borrowFee: BORROW_FEE,
      closeTime: T1,
      time: T1,
      caller: KEEPER,
      ...overrides,
    };
    o.capacity ??= closeCapacity(state, o);
    return callAt(
      o.time, o.caller, state, "executeOrder",
      o.position, o.path, o.order, o.orderPath, o.coin, o.pnl, o.closeFee, o.borrowFee, o.closeTime, o.capacity
    );
  };

  expect("(a long's stop loss fires at or below its level)", stopLoss.above === false && orderReached(stopLoss, STOP) && !orderReached(stopLoss, STOP + 1n));

  const stranger = place(opened.state, { secret: bytes32(0x4b), caller: KEEPER });
  expect("the keeper cannot place an order on someone's position", !stranger.ok && /not the owner/.test(stranger.error), why(stranger));
  const elsewhere = place(opened.state, { order: { ...stopLoss, position: bytes32(0x99) } });
  expect("an order must name the position it is placed with", !elsewhere.ok && /another position/.test(elsewhere.error), why(elsewhere));
  const zero = place(opened.state, { order: { ...stopLoss, price: 0n } });
  expect("an order at a zero price is refused", !zero.ok && /positive/.test(zero.error), why(zero));

  const placed = place(opened.state);
  expect("the owner places a stop loss", placed.ok, why(placed));
  if (placed.ok) {
    const l = ledger(placed.state);
    expect("its commitment is in the orders tree", l.orders.findPathForLeaf(pureCircuits.orderCommitment(stopLoss)) !== undefined);
    expect("its note is stored", l.orderNotes.size() === 1n);

    const [note] = [...l.orderNotes];
    const seen = openOrderNote(pureCircuits, note, LIQUIDATOR_SECRET);
    expect(
      "the keeper's secret opens the note: position salt, level, direction, order salt",
      hex(seen.positionSalt) === hex(SALT) && seen.price === STOP && seen.above === false && hex(seen.salt) === hex(ORDER_SALT)
    );
    let otherKey = true;
    try {
      openOrderNote(pureCircuits, note, LIQUIDATOR_SECRET - 1n);
      otherKey = false;
    } catch {}
    expect("another key does not open it", otherKey);
    const mine = findOwnOrderNote(pureCircuits, l.orderNotes, LIQUIDATOR_KEY, ORDER_EPHEMERAL);
    expect("the trader finds and reads their own note again from the derived scalar", mine !== null && mine.price === STOP && hex(mine.salt) === hex(ORDER_SALT));
    expect("a scalar for another index finds nothing", findOwnOrderNote(pureCircuits, l.orderNotes, LIQUIDATOR_KEY, (await deriveOrder(OWNER_SECRET, SALT, 1)).ephemeral) === null);

    const placeHaystack = [placed.state.toString(), render(placed.transcript)].join("\n").toLowerCase();
    const inPlace = (needles) => needles.some((x) => placeHaystack.includes(x.toLowerCase()));
    // (Not the commitment: the tree stores a hash of each leaf.)
    expect("control: the order's note is visible", inPlace(encodings(stopNote.fields[0])));
    expect("placing: the level is not published", !inPlace(encodings(STOP)));
    expect("placing: the position's commitment is not published", !inPlace([hex(commitment)]));
    expect("placing: the order salt is not published", !inPlace([hex(ORDER_SALT)]));

    const early = execute(priced(placed.state, STOP + 1n), stopLoss, { pnl: lossAt(STOP + 1n) });
    expect("above its level the stop loss cannot be executed", !early.ok && /not been reached/.test(early.error), why(early));

    const hit = STOP - 1_000_000n;
    const state = priced(placed.state, hit);
    const loss = lossAt(hit);
    const ran = execute(state, stopLoss, { pnl: loss });
    expect("at or below its level the keeper executes it, without the owner secret", ran.ok, why(ran));
    if (ran.ok) {
      const after2 = ledger(ran.state);
      const keep = COLLATERAL - loss - CLOSE_FEE - BORROW_FEE;
      expect("the trader's payTo gets the collateral less the loss and fees", paidTo(ran, TRADER) === keep, `${paidTo(ran, TRADER)} vs ${keep}`);
      expect("the treasury gets the three fees, no liquidation fee", paidTo(ran, TREASURY) === FEES, `${paidTo(ran, TREASURY)} vs ${FEES}`);
      expect("the keeper is paid nothing", paidTo(ran, KEEPER) === 0n);
      expect("the pool gains the loss", after2.poolValue === ledger(state).poolValue + loss);
      expect("the position's nullifier is spent", after2.closed.member(pureCircuits.positionNullifier(SALT)));
      const late = close(ran.state, { pnl: loss });
      expect("the trader cannot close it afterwards", !late.ok && /already closed/.test(late.error), why(late));
      const twice = execute(ran.state, stopLoss, { pnl: loss });
      expect("nor can the order fire twice", !twice.ok && /already closed/.test(twice.error), why(twice));

      const runHaystack = [ran.state.toString(), render(ran.transcript)].join("\n").toLowerCase();
      const inRun = (needles) => needles.some((x) => runHaystack.includes(x.toLowerCase()));
      expect("executing: the level is not published", !inRun(encodings(STOP)));
      expect("executing: the payout key is not published", !inRun([hex(TRADER.bytes)]));
      expect("executing: size is not published", !inRun(encodings(SIZE)));
    }

    const forged = execute(state, stopLoss, { pnl: loss, position: { ...position, payTo: KEEPER } });
    expect("the keeper cannot redirect the payout", !forged.ok, why(forged));
    const moved = execute(state, { ...stopLoss, price: hit + 5_000_000_000n }, {
      orderPath: ledger(state).orders.findPathForLeaf(pureCircuits.orderCommitment(stopLoss)),
    });
    expect("the keeper cannot fire it at a level the trader did not set", !moved.ok && /different order/.test(moved.error), why(moved));
    const wrongPnl = execute(state, stopLoss, { pnl: loss - 1n });
    expect("the loss is pinned as in a close", !wrongPnl.ok && /loss understated/.test(wrongPnl.error), why(wrongPnl));

    const strangerCancel = callAt(T0, KEEPER, placed.state, "cancelOrder", position, bytes32(0x4b), stopLoss);
    expect("only the owner can cancel", !strangerCancel.ok && /not the owner/.test(strangerCancel.error), why(strangerCancel));
    const cancelled = callAt(T0, TRADER, placed.state, "cancelOrder", position, OWNER_SECRET, stopLoss);
    expect("the owner cancels it", cancelled.ok, why(cancelled));
    if (cancelled.ok) {
      const dead = execute(priced(cancelled.state, hit), stopLoss, { pnl: loss });
      expect("a cancelled order cannot fire", !dead.ok && /cancelled/.test(dead.error), why(dead));
      const cancelHaystack = [cancelled.state.toString(), render(cancelled.transcript)].join("\n").toLowerCase();
      expect("cancelling publishes the nullifier, not the order's commitment", cancelHaystack.includes(hex(pureCircuits.orderNullifier(ORDER_SALT))) && !cancelHaystack.includes(hex(pureCircuits.orderCommitment(stopLoss))));
      const manual = close(priced(cancelled.state, hit), { pnl: loss });
      expect("the trader can still close it themselves", manual.ok, why(manual));
    }
  }

  // A take profit on the long: the same circuit, firing from below.
  const { salt: TP_SALT, ephemeral: TP_EPHEMERAL } = await deriveOrder(OWNER_SECRET, SALT, 1);
  const TP = 3_120_000_000n;
  const takeProfit = { position: commitment, price: TP, above: firesAbove(true, "takeProfit"), salt: TP_SALT };
  const tpPlaced = place(opened.state, { order: takeProfit, note: sealOrderNote(pureCircuits, LIQUIDATOR_KEY, SALT, takeProfit, TP_EPHEMERAL) });
  expect("the owner places a take profit", tpPlaced.ok, why(tpPlaced));
  if (tpPlaced.ok) {
    const below = execute(priced(tpPlaced.state, TP - 1n), takeProfit, { pnl: floorDiv(SIZE * (TP - 1n - PRICE), PRICE) });
    expect("below its level a long's take profit cannot fire", !below.ok && /not been reached/.test(below.error), why(below));
    const up = TP + 10_000_000n;
    const profit = floorDiv(SIZE * (up - PRICE), PRICE);
    const upState = priced(tpPlaced.state, up);
    const tp = execute(upState, takeProfit, { pnl: profit });
    expect("at or above it the keeper takes the profit for the trader", tp.ok && paidTo(tp, TRADER) === KEEP + profit, tp.ok ? `${paidTo(tp, TRADER)} vs ${KEEP + profit}` : why(tp));
    if (tp.ok) {
      expect("the treasury gets the three fees from a take profit", paidTo(tp, TREASURY) === FEES, `${paidTo(tp, TREASURY)} vs ${FEES}`);
      expect("the keeper is paid nothing for it", paidTo(tp, KEEPER) === 0n);
      expect("the pool pays exactly the profit", ledger(tp.state).poolValue === ledger(upState).poolValue - profit);
      expect("the reservation is released", reservedOf(ledger(tp.state)) === 0n);
      expect("the take profit spends the position's nullifier", ledger(tp.state).closed.member(pureCircuits.positionNullifier(SALT)));
    }
    const greedy = execute(upState, takeProfit, { pnl: profit + 1n });
    expect("the keeper cannot overstate a take profit's profit", !greedy.ok && /overstated/.test(greedy.error), why(greedy));
  }

  // The keeper's view of the ledger (core/perp.ts): which orders it watches.
  {
    const keeperView = { module: { pureCircuits } };
    const watching = (state) => {
      const l = ledger(state);
      return watchedOrders(keeperView, l, LIQUIDATOR_SECRET, watchedPositions(keeperView, l, LIQUIDATOR_SECRET));
    };
    expect("with no order placed the keeper watches none", watching(opened.state).length === 0);
    if (placed.ok && tpPlaced.ok) {
      const [w] = watching(placed.state);
      expect(
        "the keeper rebuilds the placed order exactly from its note",
        w !== undefined && hex(pureCircuits.orderCommitment(w.order)) === hex(pureCircuits.orderCommitment(stopLoss)) && w.position.commitment === hex(commitment)
      );
      expect("another key watches nothing", watchedOrders(keeperView, ledger(placed.state), LIQUIDATOR_SECRET - 1n, watchedPositions(keeperView, ledger(placed.state), LIQUIDATOR_SECRET)).length === 0);
      expect("orderFires: not above the stop", w !== undefined && !orderFires(ledger(priced(placed.state, STOP + 1n)), w));
      expect("orderFires: at the stop", w !== undefined && orderFires(ledger(priced(placed.state, STOP)), w));
      const cancelled = callAt(T0, TRADER, placed.state, "cancelOrder", position, OWNER_SECRET, stopLoss);
      expect("a cancelled order is no longer watched", cancelled.ok && watching(cancelled.state).length === 0, why(cancelled));
      const hitState = priced(placed.state, STOP);
      const ran = execute(hitState, stopLoss, { pnl: lossAt(STOP) });
      expect("an executed order is no longer watched", ran.ok && watching(ran.state).length === 0, why(ran));
      const closed = close(hitState, { pnl: lossAt(STOP) });
      expect("nor is an order whose position the trader closed", closed.ok && watching(closed.state).length === 0, why(closed));
    }
  }

  // A take profit whose profit is above the payout cap: a 20x long of 10,000
  // pUSDC and a 60% rise, raw profit 120k against a 100k cap.
  {
    const BIG = 10_000_000_000n;
    const bigCoin = coin(BIG);
    const bigSize = BIG * 20n;
    const big = {
      ...position,
      size: bigSize,
      collateral: BIG,
      openFee: openFeeOf(bigSize),
      collateralNonce: bigCoin.nonce,
      salt: bytes32(0x5c),
    };
    const bigCommitment = pureCircuits.positionCommitment(big);
    const openedBig = openCall(TRADER, pooled, bigCoin, bigSize, true, OWNER_SECRET, big.salt);
    const { salt, ephemeral } = await deriveOrder(OWNER_SECRET, big.salt, 0);
    const bigTp = { position: bigCommitment, price: 4_500_000_000n, above: firesAbove(true, "takeProfit"), salt };
    const bigPlaced = openedBig.ok
      ? place(openedBig.state, { position: big, order: bigTp, note: sealOrderNote(pureCircuits, LIQUIDATOR_KEY, big.salt, bigTp, ephemeral) })
      : openedBig;
    expect("a take profit is placed on a 20x long", bigPlaced.ok, why(bigPlaced));
    if (bigPlaced.ok) {
      const moon = priced(bigPlaced.state, 4_800_000_000n);
      const fees = { closeFee: closeFeeOf(bigSize), borrowFee: borrowFeeOf(bigSize, HELD) };
      const run = (pnl) =>
        execute(moon, bigTp, { position: big, path: ledger(moon).positions.findPathForLeaf(bigCommitment), coin: held(bigCoin, bigSize), pnl, ...fees });
      const raw = run(floorDiv(bigSize * 1_800_000_000n, PRICE));
      expect("a take profit above the cap cannot pay the raw profit", !raw.ok && /payout cap/.test(raw.error), why(raw));
      const capped = run(MAX_PAYOUT);
      expect(
        "it pays exactly the cap",
        capped.ok && paidTo(capped, TRADER) === BIG - fees.closeFee - fees.borrowFee + MAX_PAYOUT,
        capped.ok ? String(paidTo(capped, TRADER)) : why(capped)
      );
      if (capped.ok) expect("the pool pays exactly the cap", ledger(capped.state).poolValue === ledger(moon).poolValue - MAX_PAYOUT);
    }
  }
}

// ── Shorts ──────────────────────────────────────────────────────────────────

console.log("\n  shorts\n");

const shortCoin = coin(COLLATERAL);
const SHORT_SALT = bytes32(0x5a);
const shortPosition = { ...position, isLong: false, collateralNonce: shortCoin.nonce, salt: SHORT_SALT };
const shortCommitment = pureCircuits.positionCommitment(shortPosition);
const shortOpened = openCall(TRADER, pooled, shortCoin, SIZE, false, OWNER_SECRET, SHORT_SALT);
expect("a 10x short opens", shortOpened.ok, why(shortOpened));

{
  const tooMuch = openCall(TRADER, pooled, coin(COLLATERAL), COLLATERAL * 21n, false, OWNER_SECRET, SALT);
  expect("a 21x short is refused", !tooMuch.ok && /leverage above/.test(tooMuch.error), why(tooMuch));
  const l = ledger(shortOpened.state);
  expect("a short reserves the same maxPayout as a long", reservedOf(l) === MAX_PAYOUT);
  expect("the short's opening is in the tree", l.positions.findPathForLeaf(shortCommitment) !== undefined);
  expect(
    "a short's commitment differs from the same long's",
    hex(shortCommitment) !== hex(pureCircuits.positionCommitment({ ...shortPosition, isLong: true }))
  );

  // Direction privacy: the same open as a long and as a short must leave the
  // same public footprint, except for values derived from the commitment.
  const sameCoin = { ...shortCoin };
  // Each open draws a fresh ephemeral scalar, as real clients do. With the
  // same one, the two liquidator notes would differ by exactly the direction.
  const asLong = openCall(TRADER, pooled, sameCoin, SIZE, true, OWNER_SECRET, SHORT_SALT, { ephemeral: EPHEMERAL + 11n });
  const asShort = openCall(TRADER, pooled, sameCoin, SIZE, false, OWNER_SECRET, SHORT_SALT, { ephemeral: EPHEMERAL + 12n });
  const ta = asLong.transcript.map((op) => render(op));
  const tb = asShort.transcript.map((op) => render(op));
  const differing = ta.flatMap((op, i) => (op === tb[i] ? [] : [op]));
  expect("long and short opens publish the same number of operations", ta.length === tb.length, `${ta.length} vs ${tb.length}`);
  // The values that may differ: the new leaf, 32 bytes derived from the
  // commitment, and the liquidator note, twelve field elements of ciphertext
  // under a fresh ephemeral key. A third differing operation would tell the
  // directions apart.
  const isLeaf = (op) => /bytes,length:32/.test(op);
  // Field elements render without leading zeros, so count the array's items.
  const isLiquidatorNote = (op) => (op.match(/value:\[([^\]]*)\]/)?.[1].split(",").length ?? 0) === 12;
  expect(
    "they differ in two operations only: the 32-byte leaf and the liquidator note",
    differing.length === 2 && differing.some(isLeaf) && differing.some(isLiquidatorNote),
    differing.join("\n")
  );
  const outsA = asLong.zswap.outputs.map((o) => render(o)).join();
  const outsB = asShort.zswap.outputs.map((o) => render(o)).join();
  expect("their coin outputs are identical", outsA === outsB);
}

const shortAt = (price) => {
  const r = call(DEPLOYER, shortOpened.state, "setPrice", price, T0, ADMIN_SECRET);
  if (!r.ok) throw new Error(r.error);
  return r.state;
};
const closeShort = (state, overrides = {}) => {
  const o = {
    position: shortPosition,
    secret: OWNER_SECRET,
    coin: held(shortCoin, SIZE),
    pnl: 0n,
    closeFee: CLOSE_FEE,
    borrowFee: BORROW_FEE,
    closeTime: T1,
    time: T1,
    ...overrides,
  };
  o.path =
    ledger(state).positions.findPathForLeaf(pureCircuits.positionCommitment(o.position)) ??
    ledger(state).positions.findPathForLeaf(shortCommitment);
  o.capacity ??= closeCapacity(state, o);
  return callAt(o.time, TRADER, state, "closePosition", ...closeArgs(o));
};
const shortPool = ledger(shortOpened.state).poolValue;

{
  const flatShort = closeShort(shortOpened.state);
  expect("a short at an unchanged price returns the collateral less fees", flatShort.ok && paidTo(flatShort, RECIPIENT) === KEEP, why(flatShort));
  const asLong = closeShort(shortOpened.state, { position: { ...shortPosition, isLong: true } });
  expect("a short cannot be closed as a long", !asLong.ok, why(asLong));
}

// Price down 10%: the short wins floor(size × 300 / 3000).
{
  const down = shortAt(2_700_000_000n);
  const profit = floorDiv(SIZE * 300_000_000n, PRICE);
  const over = closeShort(down, { pnl: profit + 1n });
  expect("a short's overstated profit is refused", !over.ok && /overstated/.test(over.error), why(over));
  const under = closeShort(down, { pnl: profit - 1n });
  expect("a short's understated profit is refused", !under.ok && /understated/.test(under.error), why(under));
  const win = closeShort(down, { pnl: profit });
  expect("a short wins when the price falls", win.ok, why(win));
  if (win.ok) {
    expect("the recipient gets collateral less fees plus profit", paidTo(win, RECIPIENT) === KEEP + profit);
    expect("the pool pays exactly the profit", ledger(win.state).poolValue === shortPool - profit);
    expect("the short's reservation is released", reservedOf(ledger(win.state)) === 0n);
  }
}

// Price up 5%: the short loses ceil(size × 150 / 3000).
{
  const up = shortAt(3_150_000_000n);
  const loss = ceilDiv(SIZE * 150_000_000n, PRICE);
  const greedy = closeShort(up, { pnl: 1n });
  expect("a short cannot claim a profit when the price rose", !greedy.ok, why(greedy));
  const low = closeShort(up, { pnl: loss - 1n });
  expect("a short's understated loss is refused", !low.ok && /loss understated/.test(low.error), why(low));
  const lose = closeShort(up, { pnl: loss });
  expect("a short loses when the price rises", lose.ok, why(lose));
  if (lose.ok) {
    expect("the recipient gets collateral minus loss and fees", paidTo(lose, RECIPIENT) === KEEP - loss);
    expect("the pool gains exactly the loss", ledger(lose.state).poolValue === shortPool + loss);
  }
}

// Price up 20% at ~10x: the short's loss exceeds its collateral.
{
  const squeeze = shortAt(3_600_000_000n);
  const wiped = closeShort(squeeze, { pnl: ceilDiv(SIZE * 600_000_000n, PRICE) });
  expect("a wiped-out short closes", wiped.ok, why(wiped));
  if (wiped.ok) {
    expect("the recipient gets nothing", paidTo(wiped, RECIPIENT) === 0n);
    expect("the treasury gets the opening fee only", paidTo(wiped, TREASURY) === OPEN_FEE);
    expect("the pool gains the whole collateral, no more", ledger(wiped.state).poolValue === shortPool + COLLATERAL);
  }
}

// A 20x short of 10,000 pUSDC and a 60% fall: raw profit 120k, cap 100k.
{
  const BIG = 10_000_000_000n;
  const bigCoin = coin(BIG);
  const bigSize = BIG * 20n;
  const big = {
    ...shortPosition,
    size: bigSize,
    collateral: BIG,
    openFee: openFeeOf(bigSize),
    collateralNonce: bigCoin.nonce,
    salt: bytes32(0x5b),
  };
  const opened20 = openCall(TRADER, pooled, bigCoin, bigSize, false, OWNER_SECRET, big.salt);
  expect("a 20x short opens", opened20.ok, why(opened20));
  const crash = call(DEPLOYER, opened20.state, "setPrice", 1_200_000_000n, T0, ADMIN_SECRET).state;
  const closeBig = (pnl) => {
    const o = {
      position: big,
      secret: OWNER_SECRET,
      path: ledger(crash).positions.findPathForLeaf(pureCircuits.positionCommitment(big)),
      coin: held(bigCoin, bigSize),
      pnl,
      closeFee: closeFeeOf(bigSize),
      borrowFee: borrowFeeOf(bigSize, HELD),
      closeTime: T1,
    };
    o.capacity = closeCapacity(crash, o);
    return callAt(T1, TRADER, crash, "closePosition", ...closeArgs(o));
  };
  const raw = closeBig(floorDiv(bigSize * 1_800_000_000n, PRICE));
  expect("a short's profit above the cap is refused", !raw.ok && /payout cap/.test(raw.error), why(raw));
  const capped = closeBig(MAX_PAYOUT);
  expect(
    "a short's capped profit is paid",
    capped.ok && paidTo(capped, RECIPIENT) === BIG - closeFeeOf(bigSize) - borrowFeeOf(bigSize, HELD) + MAX_PAYOUT,
    why(capped)
  );
}

// Trigger orders on the short: the directions flip. Its stop loss fires on a
// rise, its take profit on a fall.
{
  const STOP = 3_090_000_000n; // 3% above the entry
  const TAKE = 2_850_000_000n; // 5% below it
  const order = async (kind, price, index) => {
    const { salt, ephemeral } = await deriveOrder(OWNER_SECRET, SHORT_SALT, index);
    const o = { position: shortCommitment, price, above: firesAbove(false, kind), salt };
    return { order: o, note: sealOrderNote(pureCircuits, LIQUIDATOR_KEY, SHORT_SALT, o, ephemeral) };
  };
  const placeShort = (state, { order: o, note }) =>
    callAt(T0, TRADER, state, "placeOrder", shortPosition, OWNER_SECRET, o, note);
  const executeShort = (state, o, pnl) => {
    const args = {
      position: shortPosition,
      coin: held(shortCoin, SIZE),
      pnl,
      closeFee: CLOSE_FEE,
      borrowFee: BORROW_FEE,
    };
    const capacity = closeCapacity(state, args);
    const l = ledger(state);
    return callAt(
      T1, KEEPER, state, "executeOrder",
      shortPosition, l.positions.findPathForLeaf(shortCommitment), o, l.orders.findPathForLeaf(pureCircuits.orderCommitment(o)),
      args.coin, pnl, CLOSE_FEE, BORROW_FEE, T1, capacity
    );
  };
  const lossAt = (price) => ceilDiv(SIZE * (price - PRICE), PRICE);
  const profitAt = (price) => floorDiv(SIZE * (PRICE - price), PRICE);

  const sl = await order("stopLoss", STOP, 0);
  const tp = await order("takeProfit", TAKE, 1);
  expect("a short's stop loss fires at or above its level", sl.order.above === true && orderReached(sl.order, STOP) && !orderReached(sl.order, STOP - 1n));
  expect("a short's take profit fires at or below its level", tp.order.above === false && orderReached(tp.order, TAKE) && !orderReached(tp.order, TAKE + 1n));

  const slPlaced = placeShort(shortOpened.state, sl);
  expect("the owner places a stop loss on the short", slPlaced.ok, why(slPlaced));
  if (slPlaced.ok) {
    const below = shortAt(STOP - 1n);
    const early = executeShort(callAt(T0, TRADER, below, "placeOrder", shortPosition, OWNER_SECRET, sl.order, sl.note).state, sl.order, lossAt(STOP - 1n));
    expect("below its level a short's stop loss cannot fire", !early.ok && /not been reached/.test(early.error), why(early));
    const falling = executeShort(placeShort(shortAt(TAKE), sl).state, sl.order, profitAt(TAKE));
    expect("nor when the price falls, in the short's favour", !falling.ok && /not been reached/.test(falling.error), why(falling));

    const hit = STOP + 5_000_000n;
    const state = placeShort(shortAt(hit), sl).state;
    const loss = lossAt(hit);
    const ran = executeShort(state, sl.order, loss);
    expect("at or above its level the keeper executes a short's stop loss", ran.ok, why(ran));
    if (ran.ok) {
      expect("the trader gets the collateral less the loss and fees", paidTo(ran, TRADER) === KEEP - loss, `${paidTo(ran, TRADER)} vs ${KEEP - loss}`);
      expect("the treasury gets the three fees", paidTo(ran, TREASURY) === FEES);
      expect("the pool gains the short's loss", ledger(ran.state).poolValue === ledger(state).poolValue + loss);
      expect("the short's nullifier is spent", ledger(ran.state).closed.member(pureCircuits.positionNullifier(SHORT_SALT)));
    }
    const asProfit = executeShort(state, sl.order, 1n);
    expect("the keeper cannot book a short's stop loss as a profit", !asProfit.ok, why(asProfit));
  }

  const tpPlaced = placeShort(shortOpened.state, tp);
  expect("the owner places a take profit on the short", tpPlaced.ok, why(tpPlaced));
  if (tpPlaced.ok) {
    const early = executeShort(placeShort(shortAt(TAKE + 1n), tp).state, tp.order, profitAt(TAKE + 1n));
    expect("above its level a short's take profit cannot fire", !early.ok && /not been reached/.test(early.error), why(early));
    const rising = executeShort(placeShort(shortAt(STOP), tp).state, tp.order, lossAt(STOP));
    expect("nor when the price rises, against the short", !rising.ok && /not been reached/.test(rising.error), why(rising));

    const hit = TAKE - 5_000_000n;
    const state = placeShort(shortAt(hit), tp).state;
    const profit = profitAt(hit);
    const ran = executeShort(state, tp.order, profit);
    expect("at or below its level the keeper takes a short's profit", ran.ok, why(ran));
    if (ran.ok) {
      expect("the trader gets the collateral less fees plus the profit", paidTo(ran, TRADER) === KEEP + profit, `${paidTo(ran, TRADER)} vs ${KEEP + profit}`);
      expect("the treasury gets the three fees", paidTo(ran, TREASURY) === FEES);
      expect("the keeper is paid nothing", paidTo(ran, KEEPER) === 0n);
      expect("the pool pays exactly the short's profit", ledger(ran.state).poolValue === ledger(state).poolValue - profit);
    }
    const greedy = executeShort(state, tp.order, profit + 1n);
    expect("the keeper cannot overstate a short's take profit", !greedy.ok && /overstated/.test(greedy.error), why(greedy));
  }
}

// ── core/math.ts against the circuit ────────────────────────────────────────

// The services, scripts and frontend compute fees, PnL and payouts with
// core/math.ts. Over a grid of exit prices, for a long and a short, the
// circuit must accept exactly those numbers and pay exactly that settlement.

console.log("\n  core/math.ts against the circuit\n");

{
  const l0 = ledger(opened.state);
  expect(
    "math.ts gives the fees the circuit demands",
    m.openFeeOf(SIZE, OPEN_FEE_BPS) === OPEN_FEE &&
      m.closeFeeOf(SIZE, l0.closeFeeBps) === CLOSE_FEE &&
      m.borrowFeeOf(SIZE, l0.borrowRate, HELD) === BORROW_FEE &&
      m.liquidationFeeOf(SIZE, l0.liquidationFeeBps) === LIQ_FEE
  );
  let sameCapacity = true;
  for (const v of [0n, 1n, MAX_PAYOUT - 1n, MAX_PAYOUT, MAX_PAYOUT + 1n, 4n * MAX_PAYOUT + 1n, 123_456_789_012n]) {
    if (m.capacityOf(v, MAX_PAYOUT) !== capOf(v)) sameCapacity = false;
  }
  expect("math.ts gives the slot capacity the circuit pins", sameCapacity);
  expect("and the reserved liquidity", m.reservedOf(l0) === reservedOf(l0));

  // A loss leaving less than the closing and borrow fees: the fee shortfall.
  const thinMove = ceilDiv((COLLATERAL - 5n * 1_000_000n) * PRICE, SIZE);
  const moves = [0n, 1n, 2n, 999n, 12_345_679n, 30_000_000n, 150_000_000n, 210_000_000n, 233_000_000n, 240_000_000n, thinMove, 450_000_000n];
  const cases = [];
  for (const isLong of [true, false]) {
    for (const move of moves) {
      for (const sign of move === 0n ? [1n] : [1n, -1n]) cases.push({ isLong, exit: PRICE + sign * move });
    }
  }
  // The exact price where math.ts flips to liquidatable, and a unit either side.
  for (const isLong of [true, false]) {
    const p = isLong ? position : shortPosition;
    const l = ledger(opened.state);
    const sick = (exit) => m.isLiquidatable(p, { ...l, markPrice: exit }, T1);
    let [healthy, liquidatable] = isLong ? [PRICE, PRICE / 2n] : [PRICE, PRICE * 2n];
    while ((healthy > liquidatable ? healthy - liquidatable : liquidatable - healthy) > 1n) {
      const mid = (healthy + liquidatable) / 2n;
      if (sick(mid)) liquidatable = mid;
      else healthy = mid;
    }
    const away = isLong ? -1n : 1n;
    for (const exit of [healthy, liquidatable, liquidatable + away]) cases.push({ isLong, exit });
  }
  const mismatches = { close: [], liquidate: [], refused: [] };
  let shortfalls = 0;
  let liquidations = 0;
  for (const { isLong, exit } of cases) {
    const p = isLong ? position : shortPosition;
    const state = isLong ? at(exit) : shortAt(exit);
    const l = ledger(state);
    const pnl = m.positionPnl(isLong, SIZE, PRICE, exit, l.maxPayout);
    const closeFee = m.closeFeeOf(SIZE, l.closeFeeBps);
    const borrowFee = m.borrowFeeOf(SIZE, l.borrowRate, HELD);
    const label = `${isLong ? "long" : "short"} exit ${exit}`;
    const expected = (r, s) =>
      r.ok &&
      paidTo(r, TRADER) === s.toTrader &&
      paidTo(r, TREASURY) === s.toTreasury &&
      ledger(r.state).poolValue === l.poolValue + s.toPool - s.fromPool;

    const s = m.settlement(p, pnl, closeFee, borrowFee);
    if (s.toTreasury < p.openFee + closeFee + borrowFee) shortfalls += 1;
    const closed = isLong
      ? close(state, { pnl: pnl.pnl, closeFee, borrowFee })
      : closeShort(state, { pnl: pnl.pnl, closeFee, borrowFee });
    if (!expected(closed, s)) mismatches.close.push(`${label}: ${closed.ok ? `trader ${paidTo(closed, TRADER)} vs ${s.toTrader}` : closed.error}`);

    const coin = isLong ? qualified : held(shortCoin, SIZE);
    const liquidationFee = m.liquidationFeeOf(SIZE, l.liquidationFeeBps);
    const predicted = m.isLiquidatable(p, l, T1);
    const liq = liquidate(state, { position: p, coin, pnl: pnl.pnl, closeFee, borrowFee, liquidationFee });
    if (liq.ok !== predicted) mismatches.refused.push(`${label}: math.ts says ${predicted}, the circuit ${liq.ok ? "liquidated" : liq.error}`);
    if (liq.ok) {
      liquidations += 1;
      const sl = m.settlement(p, pnl, closeFee, borrowFee, liquidationFee);
      if (!expected(liq, sl)) mismatches.liquidate.push(`${label}: trader ${paidTo(liq, TRADER)} vs ${sl.toTrader}`);
    }
  }
  expect(`(${cases.length} exits, ${liquidations} liquidatable, ${shortfalls} with a fee shortfall)`, liquidations > 0 && shortfalls > 0);
  expect("every close: the circuit accepts math.ts's PnL and fees, and pays its settlement", mismatches.close.length === 0, mismatches.close.join("\n        "));
  expect("isLiquidatable agrees with the circuit at every exit", mismatches.refused.length === 0, mismatches.refused.join("\n        "));
  expect("every liquidation pays math.ts's settlement", mismatches.liquidate.length === 0, mismatches.liquidate.join("\n        "));

  // liquidationPrice is for display, but should sit where the circuit flips.
  for (const [name, p, priceAt] of [["long", position, at], ["short", shortPosition, shortAt]]) {
    const lp = m.liquidationPrice(p, ledger(opened.state), T1);
    const step = 100_000n; // $0.10
    const worse = p.isLong ? lp - step : lp + step;
    const better = p.isLong ? lp + step : lp - step;
    const tryAt = (price) => {
      const state = priceAt(price);
      const l = ledger(state);
      const pnl = m.positionPnl(p.isLong, SIZE, PRICE, price, l.maxPayout);
      return liquidate(state, { position: p, coin: p.isLong ? qualified : held(shortCoin, SIZE), pnl: pnl.pnl }).ok;
    };
    expect(`the circuit liquidates a ${name} $0.10 past its liquidationPrice, not $0.10 before`, tryAt(worse) && !tryAt(better), String(lp));
  }
}

// ── core/perp.ts's order functions against the circuit ──────────────────────

// placeOrder and cancelOrder run as the trader's client does, through a
// handle whose callTx runs the circuit here instead of proving and submitting.
// What that skips — proving, balancing, the wallet, the indexer — the devnet
// script (npm run stoploss) covers. executeOrder's transport needs the SDK and
// the indexer; the arguments it passes, from executeOrderCall, are checked here.

console.log("\n  core/perp.ts order functions against the circuit\n");

{
  /** A ContractHandle on `state`: readLedger reads it, callTx runs circuits on it. */
  const simulated = (state, caller = TRADER, time = T0) => {
    const sim = { state, txs: 0 };
    sim.handle = {
      address: hex(bytes32(0x51)),
      module: { pureCircuits, ledger },
      providers: { publicDataProvider: { queryContractState: async () => ({ data: sim.state }) } },
      deployed: {
        callTx: new Proxy({}, {
          get: (_target, circuit) => async (...args) => {
            const r = callAt(time, caller, sim.state, circuit, ...args);
            if (!r.ok) throw new Error(r.error);
            sim.state = r.state;
            sim.txs += 1;
            return { public: { txHash: `sim-${sim.txs}` } };
          },
        }),
      },
    };
    return sim;
  };
  /** The record the client saves at an open (core/positions.ts). */
  const recordOf = (p, status = "open", secret = OWNER_SECRET) => ({
    status,
    contractAddress: hex(bytes32(0x51)),
    networkId: "undeployed",
    commitment: hex(pureCircuits.positionCommitment(p)),
    opening: {
      ownerSecret: hex(secret),
      isLong: p.isLong,
      size: String(p.size),
      collateral: String(p.collateral),
      openFee: String(p.openFee),
      entryPrice: String(p.entryPrice),
      openTime: String(p.openTime),
      collateralNonce: hex(p.collateralNonce),
      salt: hex(p.salt),
      payTo: hex(p.payTo.bytes),
    },
    createdAt: "",
  });
  const rejects = async (f, pattern) => {
    try {
      await f();
      return false;
    } catch (error) {
      return pattern.test(String(error instanceof Error ? error.message : error));
    }
  };
  const keeperView = { module: { pureCircuits } };
  const watching = (state) => {
    const l = ledger(state);
    return watchedOrders(keeperView, l, LIQUIDATOR_SECRET, watchedPositions(keeperView, l, LIQUIDATOR_SECRET));
  };

  const longRecord = recordOf(position);
  const shortRecord = recordOf(shortPosition);
  const sim = simulated(opened.state);
  expect("positionOf rebuilds the long from its record, commitment and all", hex(pureCircuits.positionCommitment(positionOf(sim.handle, longRecord))) === hex(commitment));
  expect("and the short", hex(pureCircuits.positionCommitment(positionOf(sim.handle, shortRecord))) === hex(shortCommitment));
  expect("(the ledger's liquidator key is the keeper's)", hex(ledger(opened.state).liquidator.x.toString(16)) === hex(LIQUIDATOR_KEY.x.toString(16)));

  const STOP = 2_910_000_000n;
  const TAKE = 3_150_000_000n;
  const stop = await placeOrder(sim.handle, longRecord, "stopLoss", STOP);
  expect("placeOrder places a long's stop loss", sim.txs === 1 && stop.index === 0 && stop.order.above === false && stop.order.price === STOP);
  expect("its commitment is in the orders tree", ledger(sim.state).orders.findPathForLeaf(pureCircuits.orderCommitment(stop.order)) !== undefined);
  const [seen] = watching(sim.state);
  expect(
    "the keeper rebuilds the order placeOrder sealed",
    seen !== undefined && hex(pureCircuits.orderCommitment(seen.order)) === hex(pureCircuits.orderCommitment(stop.order))
  );
  const take = await placeOrder(sim.handle, longRecord, "takeProfit", TAKE, 1);
  expect("a second order takes index 1: a long's take profit fires from below", take.order.above === true && take.index === 1);
  expect("the keeper watches both", watching(sim.state).length === 2);
  const recovered = findOwnOrderNote(pureCircuits, ledger(sim.state).orderNotes, LIQUIDATOR_KEY, (await deriveOrder(OWNER_SECRET, SALT, 1)).ephemeral);
  expect("the trader recovers the take profit from the record alone", recovered !== null && recovered.price === TAKE && hex(recovered.salt) === hex(take.order.salt));

  expect(
    "placeOrder refuses a position that is not open, before any transaction",
    (await rejects(() => placeOrder(sim.handle, recordOf(position, "closed"), "stopLoss", STOP, 2), /is closed/)) && sim.txs === 2
  );
  // The owner key is derived from the secret, so a wrong secret rebuilds a
  // position whose commitment is not the order's.
  expect(
    "the circuit refuses a record with the wrong owner secret",
    await rejects(() => placeOrder(sim.handle, recordOf(position, "open", bytes32(0x4b)), "stopLoss", STOP, 2), /another position/)
  );

  const beforeCancel = sim.state;
  const cancelled = await cancelOrder(sim.handle, longRecord, stop.order);
  expect("cancelOrder cancels it", cancelled === "sim-3" && ledger(sim.state).cancelledOrders.member(pureCircuits.orderNullifier(stop.order.salt)));
  const left = watching(sim.state);
  expect("the keeper now watches only the take profit", left.length === 1 && left[0].order.price === TAKE);

  const shortSim = simulated(shortOpened.state);
  const shortStop = await placeOrder(shortSim.handle, shortRecord, "stopLoss", 3_090_000_000n);
  const shortTake = await placeOrder(shortSim.handle, shortRecord, "takeProfit", 2_850_000_000n, 1);
  expect("on a short, placeOrder flips both directions", shortStop.order.above === true && shortTake.order.above === false);

  // executeOrderCall: the arguments executeOrder submits, run through the circuit.
  const runCall = (state, w, label) => {
    const l = ledger(state);
    const c = executeOrderCall(pureCircuits, l, w, USDC, 0n, T1);
    const r = callAt(T1, KEEPER, state, "executeOrder", ...c.args);
    expect(`${label}: the circuit accepts executeOrderCall's arguments`, r.ok, why(r));
    if (r.ok) {
      expect(
        `${label}: and pays what it predicted`,
        paidTo(r, TRADER) === c.settled.toTrader &&
          paidTo(r, TREASURY) === c.settled.toTreasury &&
          ledger(r.state).poolValue === l.poolValue + c.settled.toPool - c.settled.fromPool,
        `trader ${paidTo(r, TRADER)} vs ${c.settled.toTrader}`
      );
    }
    return c;
  };
  const priced = (state, price) => call(DEPLOYER, state, "setPrice", price, T0, ADMIN_SECRET).state;
  const watched = (state, order) => watching(state).find((w) => hex(w.order.salt) === hex(order.salt));

  const stopState = priced(beforeCancel, STOP - 3_000_000n);
  const longStop = runCall(stopState, watched(stopState, stop.order), "long stop loss");
  expect("(a loss)", !longStop.profit && longStop.pnl > 0n);
  const takeState = priced(beforeCancel, TAKE + 3_000_000n);
  const longTake = runCall(takeState, watched(takeState, take.order), "long take profit");
  expect("(a profit)", longTake.profit && longTake.pnl > 0n);
  const shortStopState = priced(shortSim.state, 3_100_000_000n);
  runCall(shortStopState, watched(shortStopState, shortStop.order), "short stop loss");
  const shortTakeState = priced(shortSim.state, 2_800_000_000n);
  runCall(shortTakeState, watched(shortTakeState, shortTake.order), "short take profit");

  const notPlaced = { ...watched(stopState, stop.order), order: { ...stop.order, price: STOP + 1n } };
  let refused = false;
  try {
    executeOrderCall(pureCircuits, ledger(stopState), notPlaced, USDC, 0n, T1);
  } catch (error) {
    refused = /not in the tree/.test(error.message);
  }
  expect("executeOrderCall refuses an order that was never placed", refused);
}

// ── Limit orders ────────────────────────────────────────────────────────────

console.log("\n  limit orders\n");

{
  const LIMIT_SECRET = bytes32(0x1d);
  const LIMIT_SALT = belowField(bytes32(0x5a));
  const LIMIT_COLLATERAL = 2_345_678_901n; // distinctive
  const LIMIT_SIZE = 23_456_789_012n; //      ~10x
  const LIMIT_FEE = openFeeOf(LIMIT_SIZE);
  const BUY_AT = 2_876_543_210n; //           a long's limit, below the $3,000 mark
  const limitCoin = coin(LIMIT_COLLATERAL + LIMIT_FEE);
  limitCoin.nonce = belowField(limitCoin.nonce);
  const longLimit = {
    owner: pureCircuits.ownerKey(LIMIT_SECRET),
    isLong: true,
    size: LIMIT_SIZE,
    collateral: LIMIT_COLLATERAL,
    openFee: LIMIT_FEE,
    price: BUY_AT,
    expiry: 0n,
    collateralNonce: limitCoin.nonce,
    salt: LIMIT_SALT,
    payTo: TRADER,
    payToEnc: TRADER_ENC,
  };
  const limitHash = pureCircuits.limitCommitment(longLimit);
  const keeperNote = sealLimitNote(pureCircuits, LIQUIDATOR_KEY, longLimit, EPHEMERAL);
  const place = (state, overrides = {}) => {
    const o = { coin: limitCoin, order: longLimit, secret: LIMIT_SECRET, note: keeperNote, caller: TRADER, time: T0, ...overrides };
    const x = o.order;
    return callAt(o.time, o.caller, state, "placeLimitOrder", o.coin, x.size, x.isLong, x.openFee, x.price, x.expiry, o.secret, x.salt, x.payToEnc, NOTE, o.note);
  };
  const priced = (state, price, time = T0) => {
    const r = callAt(time, DEPLOYER, state, "setPrice", price, time, ADMIN_SECRET);
    if (!r.ok) throw new Error(r.error);
    return r.state;
  };
  const fill = (state, overrides = {}) => {
    const o = { order: longLimit, openTime: T1, time: T1, caller: KEEPER, ephemeral: EPHEMERAL, payTo: TRADER.bytes, enc: TRADER_ENC, ...overrides };
    o.path ??= ledger(state).limitOrders.findPathForLeaf(pureCircuits.limitCommitment(o.order));
    return callAt(o.time, o.caller, state, "executeLimitOrder", o.order, o.path, o.openTime, o.ephemeral, ...halves(o.payTo), ...halves(o.enc));
  };
  const cancel = (state, overrides = {}) => {
    const o = { order: longLimit, secret: LIMIT_SECRET, coin: { ...limitCoin, mt_index: 0n }, caller: TRADER, time: T1, ...overrides };
    o.path ??= ledger(state).limitOrders.findPathForLeaf(pureCircuits.limitCommitment(o.order));
    return callAt(o.time, o.caller, state, "cancelLimitOrder", o.order, o.secret, o.path, o.coin);
  };

  // Placing.
  const wrongToken = place(pooled, { coin: { ...limitCoin, color: OTHER_TOKEN } });
  expect("a limit order's collateral must be pUSDC", !wrongToken.ok && /must be pUSDC/.test(wrongToken.error), why(wrongToken));
  const zero = place(pooled, { order: { ...longLimit, price: 0n } });
  expect("a limit at a zero price is refused", !zero.ok && /positive/.test(zero.error), why(zero));
  const tooBig = place(pooled, { order: { ...longLimit, size: LIMIT_COLLATERAL * 21n, openFee: openFeeOf(LIMIT_COLLATERAL * 21n) } });
  expect("the leverage cap applies when it is placed", !tooBig.ok && /fee exceeds|leverage above/.test(tooBig.error), why(tooBig));
  const cheap = place(pooled, { order: { ...longLimit, openFee: LIMIT_FEE - 1n } });
  expect("and the opening fee is pinned", !cheap.ok && /fee understated/.test(cheap.error), why(cheap));

  const placed = place(pooled);
  expect("the trader places a long limit order", placed.ok, why(placed));
  if (!placed.ok) throw new Error("cannot continue the limit order tests");
  const l0 = ledger(placed.state);
  expect("its commitment is in the limit orders tree", l0.limitOrders.findPathForLeaf(limitHash) !== undefined);
  expect("its notes are stored", l0.limitNotes.size() === 1n && l0.notes.size() === ledger(pooled).notes.size() + 1n);
  expect("the contract holds the coin", toContract(placed).some((o) => o.coinInfo.value === LIMIT_COLLATERAL + LIMIT_FEE));
  expect("no position is open yet, and no slot is taken", l0.openPositions === ledger(pooled).openPositions && l0.freeSlots === ledger(pooled).freeSlots);

  const limitHaystack = [placed.state.toString(), render(placed.transcript)].join("\n").toLowerCase();
  const visible = (needles) => needles.some((s) => limitHaystack.includes(s.toLowerCase()));
  expect("control: the token type is visible", visible([hex(USDC)]));
  expect("its limit price is not on chain", !visible(encodings(BUY_AT)));
  expect("nor its size, collateral or coin value", !visible([...encodings(LIMIT_SIZE), ...encodings(LIMIT_COLLATERAL), ...encodings(LIMIT_COLLATERAL + LIMIT_FEE)]));
  expect("nor its owner secret, salt or coin nonce", !visible([hex(LIMIT_SECRET), hex(LIMIT_SALT), hex(limitCoin.nonce)]));

  const [note] = [...l0.limitNotes];
  const seen = openLimitNote(pureCircuits, note, LIQUIDATOR_SECRET);
  expect("the keeper's secret opens its note to the whole order", hex(pureCircuits.limitCommitment(seen)) === hex(limitHash));
  let otherKey = true;
  try {
    openLimitNote(pureCircuits, note, LIQUIDATOR_SECRET - 1n);
    otherKey = false;
  } catch {}
  expect("another secret does not", otherKey);
  expect("a trigger order's note is not a limit note", (() => { try { decodeLimitPlaintext(orderPlaintext(SALT, { position: bytes32(1), price: 1n, above: true, salt: SALT })); return false; } catch { return true; } })());

  // Filling.
  const t1 = (state) => priced(state, ledger(state).markPrice, T1);
  const notYet = fill(t1(placed.state));
  expect("a long limit does not fill above its price", !notYet.ok && /not been reached/.test(notYet.error), why(notYet));
  const reached = priced(placed.state, BUY_AT - 7_000_000n, T1);
  expect("(limitReached agrees)", limitReached(longLimit, BUY_AT) && limitReached(longLimit, BUY_AT - 1n) && !limitReached(longLimit, BUY_AT + 1n));
  const stale = fill(placed.state, { time: T0 + MAX_PRICE_AGE + 100n, openTime: T0 + MAX_PRICE_AGE + 100n });
  expect("nor on a stale price", !stale.ok && /stale/.test(stale.error), why(stale));
  const future = fill(reached, { openTime: T1 + 1n });
  expect("its open time may not be in the future", !future.ok && /in the future/.test(future.error), why(future));
  const backdated = fill(reached, { openTime: T1 - CLOCK_SLACK });
  expect("nor trail the block by the slack", !backdated.ok && /too far in the past/.test(backdated.error), why(backdated));
  const badPay = fill(reached, { payTo: THIEF.bytes });
  expect("the payout key halves must be the order's", !badPay.ok && /payout key halves/.test(badPay.error), why(badPay));
  const badEnc = fill(reached, { enc: bytes32(0x77) });
  expect("and the encryption key halves", !badEnc.ok && /encryption key halves/.test(badEnc.error), why(badEnc));
  const forged = fill(reached, { order: { ...longLimit, size: LIMIT_SIZE * 2n }, path: ledger(reached).limitOrders.findPathForLeaf(limitHash) });
  expect("the keeper cannot change the order", !forged.ok && /different limit order/.test(forged.error), why(forged));
  const never = fill(reached, { order: { ...longLimit, price: BUY_AT + 1n }, path: undefined });
  expect("nor fill one that was never placed", !never.ok, why(never));

  const filled = fill(reached);
  expect("the keeper fills it once the mark is at or below the limit", filled.ok, why(filled));
  if (!filled.ok) throw new Error("cannot continue the limit order tests");
  const l1 = ledger(filled.state);
  const nullifier = pureCircuits.limitNullifier(LIMIT_SALT);
  const entry = BUY_AT - 7_000_000n;
  const opened1 = filledPosition(longLimit, { entryPrice: entry, openTime: T1 });
  const filledHash = pureCircuits.positionCommitment(opened1);
  expect("it opens the position at the mark, below the limit", l1.positions.findPathForLeaf(filledHash) !== undefined);
  expect("one slot taken, one position opened", l1.freeSlots === ledger(reached).freeSlots - 1n && l1.openPositions === ledger(reached).openPositions + 1n);
  expect("no coin moves", filled.zswap.outputs.length === 0 && filled.zswap.inputs.length === 0);
  const f = l1.limitFills.lookup(nullifier);
  expect("the fill's entry and time are published under its nullifier", f.entryPrice === entry && f.openTime === T1);
  const liqNotes = [...l1.liquidatorNotes].filter((n) => !ledger(reached).liquidatorNotes.member(n));
  const asSeen = liqNotes.length === 1 && decodeLiquidatorPlaintext(pureCircuits.openLiquidatorNote(liqNotes[0], LIQUIDATOR_SECRET));
  expect(
    "and writes the position's liquidator note, so it can be liquidated",
    asSeen && hex(pureCircuits.positionCommitment(asSeen.position)) === hex(filledHash) && hex(asSeen.payToEnc) === hex(TRADER_ENC)
  );
  expect("the keeper now watches the position", watchedPositions({ module: { pureCircuits } }, l1, LIQUIDATOR_SECRET).some((w) => w.commitment === hex(filledHash)));
  const twice = fill(filled.state);
  expect("it fills once", !twice.ok && /already filled/.test(twice.error), why(twice));
  const late = cancel(filled.state);
  expect("and cannot be cancelled once filled", !late.ok && /already filled/.test(late.error), why(late));
  const fillHaystack = render(filled.transcript).toLowerCase();
  expect("the fill does not publish the limit price or size", ![...encodings(BUY_AT), ...encodings(LIMIT_SIZE)].some((s) => fillHaystack.includes(s)));

  // The filled position is an ordinary one: its owner closes it with the order's coin.
  const later = priced(filled.state, entry, T1 + HELD);
  const closeTime = T1 + HELD;
  const closed = callAt(
    closeTime, TRADER, later, "closePosition",
    opened1, LIMIT_SECRET, ledger(later).positions.findPathForLeaf(filledHash), { ...limitCoin, mt_index: 0n },
    0n, closeFeeOf(LIMIT_SIZE), borrowFeeOf(LIMIT_SIZE, HELD), closeTime, capOf(ledger(later).poolValue)
  );
  expect("the owner closes the filled position, spending the order's coin", closed.ok, why(closed));
  if (closed.ok) {
    expect(
      "and gets the collateral back less the closing and borrow fees",
      paidTo(closed, TRADER) === LIMIT_COLLATERAL - closeFeeOf(LIMIT_SIZE) - borrowFeeOf(LIMIT_SIZE, HELD)
    );
  }

  // Cancelling.
  const stranger = cancel(placed.state, { secret: bytes32(0x4b), caller: KEEPER });
  expect("only the owner cancels", !stranger.ok && /not the owner/.test(stranger.error), why(stranger));
  const otherCoin = cancel(placed.state, { coin: { ...limitCoin, value: limitCoin.value + 1n, mt_index: 0n } });
  expect("a cancel must name the order's coin", !otherCoin.ok && /value does not match/.test(otherCoin.error), why(otherCoin));
  const cancelled = cancel(placed.state);
  expect("the owner cancels a waiting order", cancelled.ok, why(cancelled));
  if (cancelled.ok) {
    expect("the whole coin goes back to payTo", paidTo(cancelled, TRADER) === LIMIT_COLLATERAL + LIMIT_FEE, `${paidTo(cancelled, TRADER)}`);
    expect("nothing to the treasury", paidTo(cancelled, TREASURY) === 0n);
    const gone = fill(priced(cancelled.state, BUY_AT, T1));
    expect("a cancelled order cannot fill", !gone.ok && /already filled or was cancelled/.test(gone.error), why(gone));
    expect("and is not watched", watchedLimits({ module: { pureCircuits } }, ledger(cancelled.state), LIQUIDATOR_SECRET).length === 0);
    expect("no fill is published for it", !ledger(cancelled.state).limitFills.member(nullifier));
  }

  // A short.
  const SELL_AT = 3_123_456_789n;
  const shortCoin2 = coin(LIMIT_COLLATERAL + LIMIT_FEE);
  shortCoin2.nonce = belowField(shortCoin2.nonce);
  const shortLimit = { ...longLimit, isLong: false, price: SELL_AT, collateralNonce: shortCoin2.nonce, salt: belowField(bytes32(0x5b)) };
  const shortPlaced = place(pooled, { coin: shortCoin2, order: shortLimit, note: sealLimitNote(pureCircuits, LIQUIDATOR_KEY, shortLimit, EPHEMERAL) });
  expect("the trader places a short limit order", shortPlaced.ok, why(shortPlaced));
  if (shortPlaced.ok) {
    const below = fill(priced(shortPlaced.state, SELL_AT - 1n, T1), { order: shortLimit });
    expect("a short limit does not fill below its price", !below.ok && /not been reached/.test(below.error), why(below));
    const atLevel = priced(shortPlaced.state, SELL_AT, T1);
    const shortFilled = fill(atLevel, { order: shortLimit });
    expect("it fills at its price", shortFilled.ok, why(shortFilled));
    if (shortFilled.ok) {
      const p = filledPosition(shortLimit, { entryPrice: SELL_AT, openTime: T1 });
      expect("as a short", ledger(shortFilled.state).positions.findPathForLeaf(pureCircuits.positionCommitment(p)) !== undefined);
    }
  }

  // A full pool: the order waits.
  {
    let full = placed.state;
    for (let i = 0; ledger(full).freeSlots > 0n; i++) {
      const r = openCall(TRADER, full, coin(MIN_COLLATERAL), MIN_COLLATERAL, true, bytes32(0x60 + i), belowField(bytes32(0x70 + i)));
      if (!r.ok) throw new Error(r.error);
      full = r.state;
    }
    const noRoom = fill(priced(full, BUY_AT, T1));
    expect("a full pool makes the order wait", !noRoom.ok && /no room/.test(noRoom.error), why(noRoom));
  }

  // core/perp.ts: the keeper's view and the call it submits.
  const keeperView = { module: { pureCircuits } };
  const [w] = watchedLimits(keeperView, ledger(reached), LIQUIDATOR_SECRET);
  expect("watchedLimits finds the waiting order", w !== undefined && w.commitment === hex(limitHash));
  expect("limitFires: at the reached price, not at the old one", limitFires(ledger(reached), w) && !limitFires(ledger(placed.state), w));
  const c = executeLimitCall(pureCircuits, ledger(reached), w, T1, EPHEMERAL);
  const run = callAt(T1, KEEPER, reached, "executeLimitOrder", ...c.args);
  expect("the circuit accepts executeLimitCall's arguments", run.ok, why(run));
  expect("and opens the position it predicted", run.ok && ledger(run.state).positions.findPathForLeaf(Uint8Array.from(Buffer.from(c.commitment, "hex"))) !== undefined);
  const record = {
    status: "waiting", contractAddress: "", networkId: "", commitment: hex(limitHash), createdAt: "",
    order: {
      ownerSecret: hex(LIMIT_SECRET), isLong: true, size: String(LIMIT_SIZE), collateral: String(LIMIT_COLLATERAL),
      openFee: String(LIMIT_FEE), price: String(BUY_AT), expiry: "0", collateralNonce: hex(limitCoin.nonce), salt: hex(LIMIT_SALT),
      payTo: hex(TRADER.bytes), payToEnc: hex(TRADER_ENC),
    },
  };
  const handle = { module: { pureCircuits } };
  expect("limitOf rebuilds the order from its record", hex(pureCircuits.limitCommitment(limitOf(handle, record))) === hex(limitHash));
  expect("limitFillOf: nothing while it waits", limitFillOf(handle, ledger(reached), record) === null);
  const rec = run.ok && limitFillOf(handle, ledger(run.state), record);
  expect(
    "limitFillOf: the filled position's record, ready to close",
    rec && rec.status === "open" && rec.commitment === c.commitment && rec.opening.entryPrice === String(entry) && rec.opening.openTime === String(T1)
  );
  expect("which positionOf rebuilds", rec && hex(pureCircuits.positionCommitment(positionOf(handle, rec))) === c.commitment);

  // Expiry.
  const EXPIRY = T1 + 60n;
  const expCoin = coin(LIMIT_COLLATERAL + LIMIT_FEE);
  expCoin.nonce = belowField(expCoin.nonce);
  const expiring = { ...longLimit, expiry: EXPIRY, collateralNonce: expCoin.nonce, salt: belowField(bytes32(0x5c)) };
  const expPlaced = place(pooled, { coin: expCoin, order: expiring, note: sealLimitNote(pureCircuits, LIQUIDATOR_KEY, expiring, EPHEMERAL) });
  expect("the trader places a limit order with an expiry", expPlaced.ok, why(expPlaced));
  if (expPlaced.ok) {
    const expHaystack = [expPlaced.state.toString(), render(expPlaced.transcript)].join("\n").toLowerCase();
    expect("its expiry is not on chain", !encodings(EXPIRY).some((e) => expHaystack.includes(e.toLowerCase())));
    const [expNote] = [...ledger(expPlaced.state).limitNotes];
    expect("the keeper's note carries the expiry", openLimitNote(pureCircuits, expNote, LIQUIDATOR_SECRET).expiry === EXPIRY);
    const atLimit = priced(expPlaced.state, BUY_AT, T1);
    const inTime = fill(atLimit, { order: expiring, time: EXPIRY - 1n, openTime: EXPIRY - 1n });
    expect("it fills before its expiry", inTime.ok, why(inTime));
    const tooLate = fill(atLimit, { order: expiring, time: EXPIRY, openTime: EXPIRY });
    expect("and not from its expiry on", !tooLate.ok && /expired/.test(tooLate.error), why(tooLate));
    if (inTime.ok) {
      const fillHay = render(inTime.transcript).toLowerCase();
      expect("a fill does not publish the expiry", !encodings(EXPIRY).some((e) => fillHay.includes(e.toLowerCase())));
    }
    const expCancel = cancel(atLimit, { order: expiring, coin: { ...expCoin, mt_index: 0n }, time: EXPIRY + 1000n });
    expect("an expired order is cancelled, its whole coin back", expCancel.ok && paidTo(expCancel, TRADER) === LIMIT_COLLATERAL + LIMIT_FEE, why(expCancel));
    const [we] = watchedLimits(keeperView, ledger(atLimit), LIQUIDATOR_SECRET);
    expect("limitFires: reached before the expiry, not after", limitFires(ledger(atLimit), we, EXPIRY - 1n) && !limitFires(ledger(atLimit), we, EXPIRY));
    expect("(limitExpired agrees; 0 never expires)", limitExpired(expiring, EXPIRY) && !limitExpired(expiring, EXPIRY - 1n) && !limitExpired(longLimit, 1n << 62n));
  }
}

// ── Fees beyond the collateral ──────────────────────────────────────────────

console.log("\n  fees beyond the collateral\n");

// Held about 2.3 days at 10^-6 of size per second: the borrow fee (~2,469
// pUSDC) exceeds the ~1,235 collateral.
{
  const LONG_HOLD = 200_000n;
  const T2 = T0 + LONG_HOLD;
  const borrow = borrowFeeOf(SIZE, LONG_HOLD);
  expect("(the closing and borrow fees exceed the collateral)", CLOSE_FEE + borrow > COLLATERAL);
  const late = (state, pnl) => close(state, { time: T2, closeTime: T2, borrowFee: borrow, pnl });
  // Days later, the oracle has reported since.
  const reported = (price) => callAt(T2, DEPLOYER, opened.state, "setPrice", price, T2, ADMIN_SECRET).state;

  const idle = late(reported(PRICE), 0n);
  expect("a position whose fees exceed its collateral still closes", idle.ok, why(idle));
  if (idle.ok) {
    expect("the trader gets nothing", paidTo(idle, RECIPIENT) === 0n);
    expect("the treasury gets the opening fee and all the collateral", paidTo(idle, TREASURY) === OPEN_FEE + COLLATERAL);
    expect("the pool is untouched", ledger(idle.state).poolValue === after.poolValue);
  }

  // Price up 25%: the profit (~3,086) covers the shortfall (~1,247), which
  // stays in the pool; the trader gets the rest of the profit.
  const up = reported(3_750_000_000n);
  const profit = floorDiv(SIZE * 750_000_000n, PRICE);
  const shortfall = CLOSE_FEE + borrow - COLLATERAL;
  const win = late(up, profit);
  expect("a profit pays the fees the collateral could not", win.ok, why(win));
  if (win.ok) {
    expect("the trader gets the profit less the shortfall", paidTo(win, RECIPIENT) === profit - shortfall, `${paidTo(win, RECIPIENT)} vs ${profit - shortfall}`);
    expect("the treasury still gets only what the coin held", paidTo(win, TREASURY) === OPEN_FEE + COLLATERAL);
    expect("the pool pays out only profit less shortfall", ledger(win.state).poolValue === after.poolValue - (profit - shortfall));
  }
}

// ── Fee epoch ───────────────────────────────────────────────────────────────

console.log("\n  fee epoch\n");

{
  const DEPOSIT = 7_000_000n;
  const paid = call(DEPLOYER, pooled, "depositFees", coin(DEPOSIT));
  expect("the treasury can pay fees into the pool", paid.ok, why(paid));
  if (paid.ok) {
    const before = ledger(pooled);
    const l = ledger(paid.state);
    expect("the pool grows by exactly the deposit", l.poolValue === before.poolValue + DEPOSIT && l.pool.value === before.poolValue + DEPOSIT);
    expect("no shares are minted for it", l.lpSupply === before.lpSupply);
    const SHARES = 100_000_000_000n;
    expect("each zLP share now redeems for more", floorDiv(SHARES * l.poolValue, l.lpSupply) > SHARES);
  }
  const other = call(DEPLOYER, pooled, "depositFees", coin(DEPOSIT, OTHER_TOKEN));
  expect("a deposit that is not pUSDC is refused", !other.ok && /paid in pUSDC/.test(other.error), why(other));
  const nobody = call(DEPLOYER, genesis, "depositFees", coin(DEPOSIT));
  expect("a deposit with no LPs to pay is refused", !nobody.ok && /no LPs/.test(nobody.error), why(nobody));
}

// ── Withdrawing liquidity ───────────────────────────────────────────────────

console.log("\n  withdrawing liquidity\n");

const zlp = (state, shares) => coin(shares, ledger(state).lpToken);
const withdraw = (state, shares, amount) => call(LP, state, "removeLiquidity", zlp(state, shares), amount);
const pusdcToContract = (r) => toContract(r).filter((o) => hex(o.coinInfo.color) === hex(USDC));
const redeemable = (state, shares) => {
  const l = ledger(state);
  return floorDiv(shares * l.poolValue, l.lpSupply);
};

{
  // An idle pool, value = supply = 500k: one share is one unit.
  const SHARES = 100_000_000_000n;
  const part = withdraw(pooled, SHARES, SHARES);
  expect("an LP redeems shares for their pro-rata pUSDC", part.ok, why(part));
  if (part.ok) {
    const l = ledger(part.state);
    expect("the LP is paid exactly that amount", paidTo(part, LP) === SHARES, String(paidTo(part, LP)));
    expect("the pool shrinks by it", l.poolValue === 400_000_000_000n && l.pool.value === 400_000_000_000n);
    expect("the shares are retired", l.lpSupply === 400_000_000_000n);
    expect(
      "the pool keeps its change as one coin",
      pusdcToContract(part).length === 1 && pusdcToContract(part)[0].coinInfo.value === 400_000_000_000n
    );
    const retired = toContract(part).filter((o) => hex(o.coinInfo.color) === hex(l.lpToken));
    expect("the zLP goes to the contract", retired.length === 1 && retired[0].coinInfo.value === SHARES);
    const again = withdraw(part.state, SHARES, SHARES);
    expect("a later withdrawal still prices shares correctly", again.ok && ledger(again.state).poolValue === 300_000_000_000n, why(again));
  }

  const greedy = withdraw(pooled, SHARES, SHARES + 1n);
  expect("more pUSDC than the shares are worth is refused", !greedy.ok && /too much/.test(greedy.error), why(greedy));
  const shy = withdraw(pooled, SHARES, SHARES - 1n);
  expect("less than the shares are worth is refused", !shy.ok && /too little/.test(shy.error), why(shy));
  const fake = call(LP, pooled, "removeLiquidity", coin(SHARES), SHARES);
  expect("pUSDC is not accepted as shares", !fake.ok && /only zLP/.test(fake.error), why(fake));
  const inflated = withdraw(pooled, 500_000_000_001n, 500_000_000_001n);
  expect("more shares than exist are refused", !inflated.ok && /more shares than exist/.test(inflated.error), why(inflated));
  const none = call(LP, genesis, "removeLiquidity", coin(1n, bytes32(0)), 1n);
  expect("nothing can be withdrawn from an empty pool", !none.ok && /no shares/.test(none.error), why(none));

  // Every share redeemed, nothing open: the pool empties and can start over.
  const all = withdraw(pooled, 500_000_000_000n, 500_000_000_000n);
  expect("the last LP may empty an idle pool", all.ok, why(all));
  if (all.ok) {
    const l = ledger(all.state);
    expect("the LP gets the whole pool", paidTo(all, LP) === 500_000_000_000n);
    expect("the pool is empty, with no coin left behind", l.poolValue === 0n && l.lpSupply === 0n && l.pool.value === 0n && pusdcToContract(all).length === 0);
    const reopen = call(LP, all.state, "addLiquidity", coin(1_000n), 1_000n);
    expect("an emptied pool takes a fresh first deposit", reopen.ok && ledger(reopen.state).poolValue === 1_000n, why(reopen));
  }
}

{
  // One open position reserves 100k of the 500k pool: 400k may leave, but
  // the pool must stay above the reservation, so not all of it.
  const toEdge = withdraw(opened.state, 400_000_000_000n, 400_000_000_000n);
  expect(
    "a withdrawal down to the reservation is refused",
    !toEdge.ok && /reserved for open positions/.test(toEdge.error),
    why(toEdge)
  );
  const underEdge = withdraw(opened.state, 399_999_999_999n, 399_999_999_999n);
  expect("a withdrawal that leaves more than the reservation is accepted", underEdge.ok, why(underEdge));
  if (underEdge.ok) {
    const l = ledger(underEdge.state);
    expect("the reservation still fits the pool", l.poolValue > reservedOf(l), `${l.poolValue} vs ${reservedOf(l)}`);
    const trader = close(underEdge.state);
    expect("the open position still closes afterwards", trader.ok, why(trader));
  }
  const all = withdraw(opened.state, 500_000_000_000n, 500_000_000_000n);
  expect("a pool with an open position cannot be emptied", !all.ok && /reserved/.test(all.error), why(all));
}

if (afterLoss) {
  // A trader's loss raised the pool's value above its share supply, so each
  // share now redeems for more than one unit — rounded down, for the pool.
  const SHARES = 3n;
  const amount = redeemable(afterLoss, SHARES);
  expect("(a trader's loss made each share worth more than a unit)", ledger(afterLoss).poolValue > ledger(afterLoss).lpSupply);
  const win = withdraw(afterLoss, 100_000_000_000n, redeemable(afterLoss, 100_000_000_000n));
  expect("LPs share the trader's loss pro rata", win.ok && paidTo(win, LP) > 100_000_000_000n, why(win));
  const exact = withdraw(afterLoss, SHARES, amount);
  const over = withdraw(afterLoss, SHARES, amount + 1n);
  expect("a small redemption rounds down", exact.ok && !over.ok, `${why(exact)} / ${why(over)}`);
}

console.log(failures ? `\n${failures} failure(s)\n` : "\nall passed\n");
process.exit(failures ? 1 : 0);
