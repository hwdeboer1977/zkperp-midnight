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
const MAX_PAYOUT = 100_000_000_000n; // 100,000 pUSDC: a 500k pool holds 4 positions

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
    MAX_PAYOUT
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
  const early = call(TRADER, genesis, "openPosition", coin(100_000_000n), 1_000_000_000n, true, bytes32(1), bytes32(2));
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
  const tooMuch = call(TRADER, pooled, "openPosition", coin(COLLATERAL), COLLATERAL * 51n, true, OWNER_SECRET, SALT);
  expect("51x is refused", !tooMuch.ok && /leverage above/.test(tooMuch.error), why(tooMuch));
  const atCap = call(TRADER, pooled, "openPosition", coin(COLLATERAL), COLLATERAL * 50n, true, OWNER_SECRET, SALT);
  expect("50x is accepted", atCap.ok, why(atCap));
  const under = call(TRADER, pooled, "openPosition", coin(COLLATERAL), COLLATERAL - 1n, true, OWNER_SECRET, SALT);
  expect("under 1x is refused", !under.ok && /under 1x/.test(under.error), why(under));
  const small = call(TRADER, pooled, "openPosition", coin(MIN_COLLATERAL - 1n), MIN_COLLATERAL, true, OWNER_SECRET, SALT);
  expect("collateral below the minimum is refused", !small.ok && /below the minimum/.test(small.error), why(small));
  const other = call(TRADER, pooled, "openPosition", coin(COLLATERAL, OTHER_TOKEN), SIZE, true, OWNER_SECRET, SALT);
  expect("collateral that is not pUSDC is refused", !other.ok && /must be pUSDC/.test(other.error), why(other));
}

const collateralCoin = coin(COLLATERAL);
const opened = call(TRADER, pooled, "openPosition", collateralCoin, SIZE, true, OWNER_SECRET, SALT);
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
  expect("an open reserves exactly maxPayout", after.reserved === MAX_PAYOUT, String(after.reserved));
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


// ── Closing ─────────────────────────────────────────────────────────────────

console.log("\n  closing\n");

const RECIPIENT = key(0x77);
const qualified = { ...collateralCoin, mt_index: 0n };
const pathFor = (state) => ledger(state).positions.findPathForLeaf(commitment);
const at = (price) => {
  const r = call(DEPLOYER, opened.state, "setPrice", price, ADMIN_SECRET);
  if (!r.ok) throw new Error(r.error);
  return r.state;
};
const close = (state, overrides = {}) => {
  const o = { position, secret: OWNER_SECRET, coin: qualified, pnl: 0n, to: RECIPIENT, ...overrides };
  return call(TRADER, state, "closePosition", o.position, o.secret, pathFor(state), o.coin, o.pnl, o.to);
};
const paidTo = (r, who) =>
  r.zswap.outputs
    .filter((o) => o.recipient.is_left && hex(o.recipient.left.bytes) === hex(who.bytes))
    .reduce((sum, o) => sum + o.coinInfo.value, 0n);
const toContract = (r) => r.zswap.outputs.filter((o) => !o.recipient.is_left);
const floorDiv = (a, b) => a / b;
const ceilDiv = (a, b) => (a + b - 1n) / b;

// Unchanged price: the custody test. Full collateral back, pool untouched.
const flat = close(opened.state);
expect("close at an unchanged price is accepted", flat.ok, why(flat));
if (flat.ok) {
  const l = ledger(flat.state);
  expect("the whole collateral goes to the recipient", paidTo(flat, RECIPIENT) === COLLATERAL, String(paidTo(flat, RECIPIENT)));
  expect("nothing else is created", flat.zswap.outputs.length === 1);
  expect("the pool is untouched", l.poolValue === after.poolValue);
  expect("the close is counted", l.closedPositions === 1n);
  expect(
    "the nullifier is recorded",
    l.closed.member(pureCircuits.positionNullifier(OWNER_SECRET, SALT))
  );
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
}

// ── Solvency ────────────────────────────────────────────────────────────────
{
  expect("a close releases the reservation", flat.ok && ledger(flat.state).reserved === 0n);

  // 500k pool, 100k per position: four fit (400k < 500k), a fifth does not.
  let state = pooled;
  let accepted = 0;
  let refusal = "";
  for (let i = 0; i < 5; i += 1) {
    const r = call(TRADER, state, "openPosition", coin(COLLATERAL), SIZE, true, OWNER_SECRET, bytes32(0xa0 + i));
    if (r.ok) {
      accepted += 1;
      state = r.state;
    } else refusal = r.error;
  }
  expect("four 100k reservations fit a 500k pool", accepted === 4, `${accepted} accepted`);
  expect("the fifth is refused while reserved would reach the pool", /no room/.test(refusal), refusal);
  expect("reserved is positions × maxPayout", ledger(state).reserved === 4n * MAX_PAYOUT);

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
    expect("the recipient gets collateral plus exactly the cap", paidTo(capped, RECIPIENT) === COLLATERAL + MAX_PAYOUT);
    expect("the pool pays exactly the cap", ledger(capped.state).poolValue === after.poolValue - MAX_PAYOUT);
    expect("the reservation is released", ledger(capped.state).reserved === 0n);
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
  const win = close(up, { pnl: profit });
  expect("a winning long closes", win.ok, why(win));
  if (win.ok) {
    expect(
      "the recipient gets collateral plus profit",
      paidTo(win, RECIPIENT) === COLLATERAL + profit,
      `${paidTo(win, RECIPIENT)} vs ${COLLATERAL + profit}`
    );
    expect("the pool pays exactly the profit", ledger(win.state).poolValue === after.poolValue - profit);
    expect("the pool keeps its change", toContract(win).length === 1 && toContract(win)[0].coinInfo.value === after.poolValue - profit);
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
    expect("the recipient gets collateral minus loss", paidTo(lose, RECIPIENT) === COLLATERAL - loss);
    expect("the pool gains exactly the loss", ledger(lose.state).poolValue === after.poolValue + loss);
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
    expect("the pool gains the whole collateral, no more", ledger(wiped.state).poolValue === after.poolValue + COLLATERAL);
  }
}

// ── Shorts ──────────────────────────────────────────────────────────────────

console.log("\n  shorts\n");

const shortCoin = coin(COLLATERAL);
const SHORT_SALT = bytes32(0x5a);
const shortPosition = { ...position, isLong: false, collateralNonce: shortCoin.nonce, salt: SHORT_SALT };
const shortCommitment = pureCircuits.positionCommitment(shortPosition);
const shortOpened = call(TRADER, pooled, "openPosition", shortCoin, SIZE, false, OWNER_SECRET, SHORT_SALT);
expect("a 10x short opens", shortOpened.ok, why(shortOpened));

{
  const tooMuch = call(TRADER, pooled, "openPosition", coin(COLLATERAL), COLLATERAL * 51n, false, OWNER_SECRET, SALT);
  expect("a 51x short is refused", !tooMuch.ok && /leverage above/.test(tooMuch.error), why(tooMuch));
  const l = ledger(shortOpened.state);
  expect("a short reserves the same maxPayout as a long", l.reserved === MAX_PAYOUT);
  expect("the short's opening is in the tree", l.positions.findPathForLeaf(shortCommitment) !== undefined);
  expect(
    "a short's commitment differs from the same long's",
    hex(shortCommitment) !== hex(pureCircuits.positionCommitment({ ...shortPosition, isLong: true }))
  );

  // Direction privacy: the same open as a long and as a short must leave the
  // same public footprint, except for values derived from the commitment.
  const sameCoin = { ...shortCoin };
  const asLong = call(TRADER, pooled, "openPosition", sameCoin, SIZE, true, OWNER_SECRET, SHORT_SALT);
  const asShort = call(TRADER, pooled, "openPosition", sameCoin, SIZE, false, OWNER_SECRET, SHORT_SALT);
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
    coin: { ...shortCoin, mt_index: 0n },
    pnl: 0n,
    to: RECIPIENT,
    ...overrides,
  };
  const path = ledger(state).positions.findPathForLeaf(pureCircuits.positionCommitment(o.position)) ??
    ledger(state).positions.findPathForLeaf(shortCommitment);
  return call(TRADER, state, "closePosition", o.position, o.secret, path, o.coin, o.pnl, o.to);
};
const shortPool = ledger(shortOpened.state).poolValue;

{
  const flatShort = closeShort(shortOpened.state);
  expect("a short at an unchanged price returns the whole collateral", flatShort.ok && paidTo(flatShort, RECIPIENT) === COLLATERAL, why(flatShort));
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
    expect("the recipient gets collateral plus profit", paidTo(win, RECIPIENT) === COLLATERAL + profit);
    expect("the pool pays exactly the profit", ledger(win.state).poolValue === shortPool - profit);
    expect("the short's reservation is released", ledger(win.state).reserved === 0n);
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
    expect("the recipient gets collateral minus loss", paidTo(lose, RECIPIENT) === COLLATERAL - loss);
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
    expect("the pool gains the whole collateral, no more", ledger(wiped.state).poolValue === shortPool + COLLATERAL);
  }
}

// A 50x short of 10,000 pUSDC and a 50% fall: raw profit 250k, cap 100k.
{
  const BIG = 10_000_000_000n;
  const bigCoin = coin(BIG);
  const big = { ...shortPosition, size: BIG * 50n, collateral: BIG, collateralNonce: bigCoin.nonce, salt: bytes32(0x5b) };
  const opened50 = call(TRADER, pooled, "openPosition", bigCoin, big.size, false, OWNER_SECRET, big.salt);
  expect("a 50x short opens", opened50.ok, why(opened50));
  const crash = call(DEPLOYER, opened50.state, "setPrice", 1_500_000_000n, ADMIN_SECRET).state;
  const bigPath = ledger(crash).positions.findPathForLeaf(pureCircuits.positionCommitment(big));
  const closeBig = (pnl) =>
    call(TRADER, crash, "closePosition", big, OWNER_SECRET, bigPath, { ...bigCoin, mt_index: 0n }, pnl, RECIPIENT);
  const raw = closeBig(floorDiv(big.size * 1_500_000_000n, PRICE));
  expect("a short's profit above the cap is refused", !raw.ok && /payout cap/.test(raw.error), why(raw));
  const capped = closeBig(MAX_PAYOUT);
  expect("a short's capped profit is paid", capped.ok && paidTo(capped, RECIPIENT) === BIG + MAX_PAYOUT, why(capped));
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
    expect("the reservation still fits the pool", l.poolValue > l.reserved, `${l.poolValue} vs ${l.reserved}`);
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
