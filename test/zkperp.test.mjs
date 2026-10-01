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
const MAX_LEVERAGE = 20n;
const MIN_COLLATERAL = 10_000_000n; // 10 pUSDC
const MAX_PAYOUT = 100_000_000_000n; // 100,000 pUSDC: a 500k pool holds 4 positions
const OPEN_FEE_BPS = 10n; // 0.10%
const CLOSE_FEE_BPS = 10n;
const BORROW_RATE = 1_000_000n; // 10^-6 of size per second
const CLOCK_SLACK = 600n;
const TREASURY = key(0x7e);

// Block times: positions open at T0 and close an hour later at T1.
const T0 = 1_800_000_000n;
const HELD = 3_600n;
const T1 = T0 + HELD;

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
    MAX_LEVERAGE,
    MIN_COLLATERAL,
    MAX_PAYOUT,
    OPEN_FEE_BPS,
    CLOSE_FEE_BPS,
    BORROW_RATE,
    TREASURY,
    CLOCK_SLACK
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
  return callAt(o.time, caller, state, "openPosition", posted, size, isLong, o.fee, o.openTime, secret, salt);
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
const SALT = Uint8Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 0xff);

{
  const tooMuch = openCall(TRADER, pooled, coin(COLLATERAL), COLLATERAL * 21n, true, OWNER_SECRET, SALT);
  expect("21x is refused", !tooMuch.ok && /leverage above/.test(tooMuch.error), why(tooMuch));
  const atCap = openCall(TRADER, pooled, coin(COLLATERAL), COLLATERAL * 20n, true, OWNER_SECRET, SALT);
  expect("20x of the collateral net of the fee is accepted", atCap.ok, why(atCap));
  // The fee comes out of the coin first, so 20x of the whole coin is too much.
  const grossTooBig = callAt(T0, TRADER, pooled, "openPosition", coin(COLLATERAL), COLLATERAL * 20n, true, openFeeOf(COLLATERAL * 20n), T0, OWNER_SECRET, SALT);
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
};
const commitment = pureCircuits.positionCommitment(position);
{
  expect("one position is counted", after.openPositions === 1n);
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
expect("the owner key is not on chain", !found([hex(position.owner)]));
expect("the salt is not on chain", !found([hex(SALT)]));
expect("the collateral coin nonce is not on chain", !found([hex(collateralCoin.nonce)]));


// ── Closing ─────────────────────────────────────────────────────────────────

console.log("\n  closing\n");

const RECIPIENT = key(0x77);
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
  const r = call(DEPLOYER, opened.state, "setPrice", price, ADMIN_SECRET);
  if (!r.ok) throw new Error(r.error);
  return r.state;
};
const closeArgs = (o) => [o.position, o.secret, o.path, o.coin, o.pnl, o.closeFee, o.borrowFee, o.closeTime, o.to, o.capacity];

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
    to: RECIPIENT,
    ...overrides,
  };
  o.capacity ??= closeCapacity(state, o);
  return callAt(o.time, TRADER, state, "closePosition", ...closeArgs(o));
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
    l.closed.member(pureCircuits.positionNullifier(OWNER_SECRET, SALT))
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
    inClose([hex(pureCircuits.positionNullifier(OWNER_SECRET, SALT))])
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

// ── Solvency ────────────────────────────────────────────────────────────────
{
  expect("a close releases the reservation", flat.ok && reservedOf(ledger(flat.state)) === 0n);

  // 500k pool, 100k per position: four fit (400k < 500k), a fifth does not.
  let state = pooled;
  let accepted = 0;
  let refusal = "";
  for (let i = 0; i < 5; i += 1) {
    const r = openCall(TRADER, state, coin(COLLATERAL), SIZE, true, OWNER_SECRET, bytes32(0xa0 + i));
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
  const asLong = openCall(TRADER, pooled, sameCoin, SIZE, true, OWNER_SECRET, SHORT_SALT);
  const asShort = openCall(TRADER, pooled, sameCoin, SIZE, false, OWNER_SECRET, SHORT_SALT);
  const ta = asLong.transcript.map((op) => render(op));
  const tb = asShort.transcript.map((op) => render(op));
  const differing = ta.flatMap((op, i) => (op === tb[i] ? [] : [op]));
  expect("long and short opens publish the same number of operations", ta.length === tb.length, `${ta.length} vs ${tb.length}`);
  // The one value that may differ is the new leaf, 32 bytes derived from the
  // commitment. A second differing operation would tell the directions apart.
  expect(
    "they differ in one operation only: the 32-byte leaf",
    differing.length === 1 && /bytes,length:32/.test(differing[0]),
    differing.join("\n")
  );
  const outsA = asLong.zswap.outputs.map((o) => render(o)).join();
  const outsB = asShort.zswap.outputs.map((o) => render(o)).join();
  expect("their coin outputs are identical", outsA === outsB);
}

const shortAt = (price) => {
  const r = call(DEPLOYER, shortOpened.state, "setPrice", price, ADMIN_SECRET);
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
    to: RECIPIENT,
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
  const crash = call(DEPLOYER, opened20.state, "setPrice", 1_200_000_000n, ADMIN_SECRET).state;
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
      to: RECIPIENT,
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

  const idle = late(opened.state, 0n);
  expect("a position whose fees exceed its collateral still closes", idle.ok, why(idle));
  if (idle.ok) {
    expect("the trader gets nothing", paidTo(idle, RECIPIENT) === 0n);
    expect("the treasury gets the opening fee and all the collateral", paidTo(idle, TREASURY) === OPEN_FEE + COLLATERAL);
    expect("the pool is untouched", ledger(idle.state).poolValue === after.poolValue);
  }

  // Price up 25%: the profit (~3,086) covers the shortfall (~1,247), which
  // stays in the pool; the trader gets the rest of the profit.
  const up = at(3_750_000_000n);
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
