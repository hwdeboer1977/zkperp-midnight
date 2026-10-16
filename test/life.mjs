// SPDX-License-Identifier: Apache-2.0

/**
 * Random lives of zkperp, shared by the /check fuzzer (test/check.fuzz.mjs)
 * and the property tests (test/props.test.mjs): each deploys the contract
 * locally with random parameters and walks a random life through every
 * circuit — deposits, opens, price moves, closes, liquidations, stop losses
 * and take profits, limit orders, fee deposits, withdrawals — biased to the
 * edges (flat price, a profit at and above the payout cap, a wipe-out,
 * maximum leverage, minimum collateral, a borrow fee larger than the equity
 * left, share-price and capacity boundaries). Seeded, so a failure replays.
 */

import { createCircuitContext, createConstructorContext, sampleContractAddress } from "@midnight-ntwrk/compact-runtime";
import { Contract, ledger, pureCircuits } from "../contracts/managed/zkperp/contract/index.js";
import { JUBJUB_ORDER, belowField } from "../dist/core/liquidatorNote.js";
import { keeperRotationMessage, oracleSecrets, rotationMessage, sign as schnorrSign, signedPriceArgs, signerKeys } from "../dist/core/oracle.js";
import { firesAbove, sealOrderNote } from "../dist/core/orders.js";
import { sealLimitNote } from "../dist/core/limits.js";
import * as m from "../dist/core/math.js";

// ── Randomness, seeded so a failure can be replayed ─────────────────────────

let rngState = 0;
/** Starts the sequence again from `seed`. */
export function reseed(seed) {
  rngState = seed >>> 0;
}
/** mulberry32: a uniform 32-bit integer. */
export function u32() {
  rngState = (rngState + 0x6d2b79f5) >>> 0;
  let t = rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (t ^ (t >>> 14)) >>> 0;
}
export const chance = (p) => u32() / 2 ** 32 < p;
export const pick = (xs) => xs[u32() % xs.length];
/** Uniform in [lo, hi]. */
export function between(lo, hi) {
  if (hi <= lo) return lo;
  const span = hi - lo + 1n;
  let r = 0n;
  for (let bits = 0n; bits < BigInt(span.toString(2).length) + 32n; bits += 32n) r = (r << 32n) | BigInt(u32());
  return lo + (r % span);
}
/** Spread over orders of magnitude in [lo, hi], with the ends drawn often. */
export function logBetween(lo, hi) {
  if (hi <= lo) return lo;
  if (chance(0.1)) return lo;
  if (chance(0.1)) return hi;
  const bits = BigInt(between(BigInt(lo.toString(2).length), BigInt(hi.toString(2).length)));
  const top = 1n << bits;
  return between(lo, hi < top ? hi : top);
}
export function randomBytes32() {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 4) new DataView(out.buffer).setUint32(i, u32());
  return out;
}
export const scalar = () => between(1n, JUBJUB_ORDER - 1n);

// ── Constants ───────────────────────────────────────────────────────────────

export const hex = (b) => Buffer.from(b).toString("hex");
export const bytes32 = (byte) => new Uint8Array(32).fill(byte);
export const key = (byte) => ({ bytes: bytes32(byte) });
export const halves = (b) => [b.slice(0, 16), b.slice(16, 32)];
export const ceilDiv = (a, b) => (a + b - 1n) / b;

export const USDC = bytes32(0xc0);
export const DEPLOYER = key(0x10);
export const LP = key(0x20);
export const TRADER = key(0x30);
export const KEEPER = key(0x4b);
export const TREASURY = key(0x7e);
export const NOTE = Uint8Array.from({ length: 128 }, (_, i) => (i * 53 + 7) & 0xff);
export const KEEPER_SECRETS = [JUBJUB_ORDER - 0x1234_5678_9abcn, JUBJUB_ORDER - 0x2222_2222n, JUBJUB_ORDER - 0x3333_3333n];
export const KEEPER_KEYS = KEEPER_SECRETS.map((x) => pureCircuits.liquidatorPublicKey(x));
export const SIGNERS = oracleSecrets("ab".repeat(32));
export const SIGNER_KEYS = signerKeys(pureCircuits, SIGNERS);
export const PAIRS = [[0, 1], [0, 2], [1, 2]];
export const U64_MAX = 2n ** 64n - 1n;
export const ADDRESS = sampleContractAddress();
export const contract = new Contract({});

// ── One case: a contract with random parameters ─────────────────────────────

export function randomParams() {
  const price = logBetween(1_000n, 100_000_000_000n);
  return {
    price,
    maxLeverage: pick([1n, 2n, 5n, 10n, 20n, 50n, 100n, between(1n, 255n)]),
    minCollateral: logBetween(1n, 100_000_000n),
    maxPayout: logBetween(1_000_000n, 1_000_000_000_000n),
    openFeeBps: pick([1n, 10n, 100n, 1000n, between(1n, 10_000n)]),
    closeFeeBps: pick([0n, 1n, 10n, 100n, between(0n, 10_000n)]),
    borrowRate: pick([0n, 1n, 1_000_000n, between(0n, 100_000_000n)]),
    clockSlack: pick([1n, 600n, 3_600n]),
    maxPriceAge: 3_900n,
    maintenanceBps: pick([1n, 250n, 1000n, between(1n, 9_999n)]),
    liquidationFeeBps: pick([0n, 50n, 500n, between(0n, 10_000n)]),
  };
}

/**
 * One random life of a fresh contract, through every circuit. Each call the
 * runtime accepts goes to `hooks.accepted` (awaited) before its state is kept;
 * each it refuses to `hooks.refused`.
 *
 *   accepted({ label, circuit, caller, args, wrapper, before, r, stateBefore, params, now })
 */
export async function runLife(index, hooks, p = randomParams()) {
  const T0 = 1_800_000_000n;
  let now = T0;
  const deploy = () =>
    contract.initialState(
      createConstructorContext({}, hex(DEPLOYER.bytes)),
      USDC, SIGNER_KEYS, p.price, T0 - 10n, 1n, p.maxLeverage, p.minCollateral, p.maxPayout,
      p.openFeeBps, p.closeFeeBps, p.borrowRate, TREASURY, p.clockSlack, p.maxPriceAge, p.maintenanceBps,
      p.liquidationFeeBps, KEEPER_KEYS
    ).currentContractState;
  let state = deploy().data;
  const L = () => ledger(state);
  const capOf = (value) => m.capacityOf(value, p.maxPayout);

  /** Runs `circuit` locally at `now`; if accepted, hands it to the hooks and keeps its state. */
  async function run(label, caller, circuit, ...args) {
    const wrapper = deploy();
    wrapper.data = state;
    const ctx = createCircuitContext(ADDRESS, hex(caller.bytes), wrapper, {}, undefined, undefined, Number(now));
    const before = ctx.currentQueryContext;
    let r;
    try {
      r = contract.impureCircuits[circuit](ctx, ...args);
    } catch (cause) {
      hooks.refused?.(circuit, String(cause?.message ?? cause), { label, args, stateBefore: state, params: p, now });
      return null;
    }
    await hooks.accepted?.({ label, circuit, caller, args, wrapper, before, r, stateBefore: state, params: p, now });
    state = r.context.currentQueryContext.state;
    return r;
  }

  // Every pair of signers, and sometimes a rotated key, so each slot's branch is checked.
  const signers = [...SIGNERS];
  const setPrice = async (price, label = "setPrice") => {
    const report = { round: L().priceRound + 1n, price: price < 1n ? 1n : price > U64_MAX ? U64_MAX : price, updatedAt: now };
    const [i, j] = pick(PAIRS);
    const args = signedPriceArgs(pureCircuits, ADDRESS, report, new Map([[i, signers[i]], [j, signers[j]]]));
    const r = await run(`${label} by ${i + 1}+${j + 1}`, DEPLOYER, "setPrice", ...args);
    if (!r) throw new Error(`setPrice ${price} refused`);
  };
  if (index % 3 === 0) {
    const slot = Number(between(0n, 2n));
    const [i, j] = pick(PAIRS);
    const fresh = JUBJUB_ORDER - between(1n, 1n << 64n);
    const key = pureCircuits.signerPublicKey(fresh);
    const msg = rotationMessage(pureCircuits, ADDRESS, L().signerEpoch, slot, key);
    const r = await run(`rotateSigner ${slot + 1} by ${i + 1}+${j + 1}`, DEPLOYER, "rotateSigner", BigInt(slot), key, BigInt(i), BigInt(j),
      schnorrSign(pureCircuits, signers[i], msg), schnorrSign(pureCircuits, signers[j], msg));
    if (!r) throw new Error("rotateSigner refused");
    signers[slot] = fresh;
  }
  // And sometimes a keeper's key, so later opens seal to a rotated set.
  if (index % 3 === 1) {
    const slot = Number(between(0n, 2n));
    const [i, j] = pick(PAIRS);
    const key = pureCircuits.liquidatorPublicKey(JUBJUB_ORDER - between(1n, 1n << 64n));
    const msg = keeperRotationMessage(pureCircuits, ADDRESS, L().keeperEpoch, slot, key);
    const r = await run(`rotateKeeper ${slot + 1} by ${i + 1}+${j + 1}`, DEPLOYER, "rotateKeeper", BigInt(slot), key, BigInt(i), BigInt(j),
      schnorrSign(pureCircuits, signers[i], msg), schnorrSign(pureCircuits, signers[j], msg));
    if (!r) throw new Error("rotateKeeper refused");
  }
  const advance = async (seconds) => {
    now += seconds;
    await setPrice(L().markPrice, "setPrice (refresh)");
  };

  // ── Liquidity: a first deposit, sometimes a second ──
  const deposit = async (value, label) => {
    const l = L();
    const shares = l.lpSupply === 0n ? value : (value * l.lpSupply) / l.poolValue;
    return run(label, LP, "addLiquidity", { nonce: randomBytes32(), color: USDC, value }, shares, capOf(l.poolValue + value));
  };
  const slots = pick([1n, 2n, 4n, between(1n, 20n)]);
  const firstValue = p.maxPayout * slots + between(1n, p.maxPayout);
  if (firstValue > U64_MAX / 4n) return;
  await deposit(firstValue, "first deposit");
  if (chance(0.5)) await deposit(logBetween(1n, firstValue), "second deposit");

  // ── Positions: open a few, at the edges of size and leverage ──
  const open = [];
  const limits = [];
  const positionsToOpen = Number(between(1n, 3n));
  for (let i = 0; i < positionsToOpen; i++) {
    const l = L();
    const isLong = chance(0.5);
    const collateral = chance(0.3) ? p.minCollateral : logBetween(p.minCollateral, p.minCollateral * 1_000_000n);
    const lev = chance(0.3) ? p.maxLeverage : chance(0.3) ? 1n : between(1n, p.maxLeverage);
    const size = chance(0.5) ? collateral * lev : between(collateral, collateral * lev);
    const openFee = m.openFeeOf(size, p.openFeeBps);
    if (collateral + openFee > U64_MAX) continue;
    const secret = randomBytes32();
    const salt = belowField(randomBytes32());
    const nonce = belowField(randomBytes32());

    if (chance(0.3)) {
      // A limit order instead, filled later if the price comes to it.
      const price = chance(0.3) ? l.markPrice : between(1n, l.markPrice * 2n);
      const order = {
        owner: pureCircuits.ownerKey(secret), isLong, size, collateral, openFee, price,
        expiry: chance(0.3) ? now + between(1n, 7_200n) : 0n,
        collateralNonce: nonce, salt, payTo: TRADER, payToEnc: randomBytes32(),
      };
      const r = await run(
        `limit ${i}`, TRADER, "placeLimitOrder", { nonce, color: USDC, value: collateral + openFee },
        size, isLong, openFee, price, order.expiry, secret, salt, order.payToEnc, NOTE,
        sealLimitNote(pureCircuits, L().keepers, order, scalar())
      );
      if (r) limits.push({ order, secret });
      continue;
    }

    const enc = randomBytes32();
    const r = await run(
      `open ${i} (${isLong ? "long" : "short"} ${size}/${collateral})`, TRADER, "openPosition",
      { nonce, color: USDC, value: collateral + openFee }, size, isLong, openFee, now, secret, salt, NOTE,
      chance(0.1) ? JUBJUB_ORDER - 1n : scalar(), ...halves(TRADER.bytes), ...halves(enc)
    );
    if (!r) continue;
    const position = {
      owner: pureCircuits.ownerKey(secret), isLong, size, collateral, openFee, entryPrice: l.markPrice,
      openTime: now, collateralNonce: nonce, salt, payTo: TRADER,
    };
    if (!L().positions.findPathForLeaf(pureCircuits.positionCommitment(position))) {
      throw new Error("the rebuilt position is not in the tree: the fuzzer's Position is wrong");
    }
    open.push({ position, secret, orders: [] });
  }

  // ── Orders on open positions ──
  for (const o of open) {
    if (!chance(0.6)) continue;
    const kind = chance(0.5) ? "stopLoss" : "takeProfit";
    const commitment = pureCircuits.positionCommitment(o.position);
    const order = {
      position: commitment,
      price: between(1n, o.position.entryPrice * 2n),
      above: firesAbove(o.position.isLong, kind),
      salt: belowField(randomBytes32()),
    };
    const note = sealOrderNote(pureCircuits, L().keepers, o.position.salt, order, scalar());
    if (await run(`place ${kind}`, TRADER, "placeOrder", o.position, o.secret, order, note)) o.orders.push(order);
    if (o.orders.length && chance(0.2)) {
      const cancelled = o.orders.pop();
      await run("cancel order", TRADER, "cancelOrder", o.position, o.secret, cancelled);
    }
  }

  // ── Time passes; sometimes long enough for the borrow fee to eat the equity ──
  await advance(pick([0n, 1n, 3_600n, between(0n, 30n * 86_400n), between(0n, 3n * 365n * 86_400n)]));

  // ── The price moves, to an edge of some position ──
  const target = open.length ? pick(open).position : null;
  const entry = target?.entryPrice ?? L().markPrice;
  let exit;
  const edge = target ? pick(["flat", "tick", "cap", "aboveCap", "wipeout", "random", "liquidation"]) : "random";
  const sign = (up) => (up ? 1n : -1n);
  switch (edge) {
    case "flat": exit = entry; break;
    case "tick": exit = entry + (chance(0.5) ? 1n : -1n); break;
    case "cap": exit = entry + sign(target.isLong) * ceilDiv(p.maxPayout * entry, target.size); break;
    case "aboveCap": exit = entry + sign(target.isLong) * (ceilDiv(p.maxPayout * entry, target.size) * between(2n, 10n)); break;
    case "wipeout": exit = entry - sign(target.isLong) * ceilDiv((target.collateral + between(0n, target.collateral)) * entry, target.size); break;
    case "liquidation": {
      const l = L();
      exit = m.liquidationPrice(target, l, now) + (chance(0.5) ? 0n : sign(!target.isLong) * between(0n, 3n));
      break;
    }
    default: exit = between(entry / 4n + 1n, entry * 4n);
  }
  await setPrice(exit, `setPrice (${edge})`);

  // ── Limit orders: fill the ones the price reached; cancel some of the rest ──
  for (const lo of limits) {
    const l = L();
    const reached = lo.order.isLong ? l.markPrice <= lo.order.price : l.markPrice >= lo.order.price;
    const path = l.limitOrders.findPathForLeaf(pureCircuits.limitCommitment(lo.order));
    if (reached && chance(0.8)) {
      const r = await run(
        "fill limit", KEEPER, "executeLimitOrder", lo.order, path, now, scalar(),
        ...halves(lo.order.payTo.bytes), ...halves(lo.order.payToEnc)
      );
      if (r) {
        const position = { ...lo.order, entryPrice: l.markPrice, openTime: now };
        delete position.price; delete position.expiry; delete position.payToEnc;
        open.push({ position, secret: lo.secret, orders: [], filled: true });
      }
    } else if (chance(0.7)) {
      await run(
        "cancel limit", TRADER, "cancelLimitOrder", lo.order, lo.secret, path,
        { nonce: lo.order.collateralNonce, color: USDC, value: lo.order.collateral + lo.order.openFee, mt_index: 0n }
      );
    }
  }

  // ── Settle every position: liquidate, execute an order, or close ──
  for (const o of open) {
    const l = L();
    const pos = o.position;
    const commitment = pureCircuits.positionCommitment(pos);
    const path = l.positions.findPathForLeaf(commitment);
    const coin = { nonce: pos.collateralNonce, color: USDC, value: pos.collateral + pos.openFee, mt_index: 0n };
    const pnl = m.positionPnl(pos.isLong, pos.size, pos.entryPrice, l.markPrice, p.maxPayout);
    const closeFee = m.closeFeeOf(pos.size, p.closeFeeBps);
    const borrowFee = m.borrowFeeOf(pos.size, p.borrowRate, now - pos.openTime);
    const tag = `${pos.isLong ? "long" : "short"} ${edge}${o.filled ? " (from limit)" : ""}`;

    if (m.isLiquidatable(pos, l, now) && chance(0.7)) {
      const liquidationFee = m.liquidationFeeOf(pos.size, p.liquidationFeeBps);
      const s = m.settlement(pos, pnl, closeFee, borrowFee, liquidationFee);
      await run(
        `liquidate ${tag}`, KEEPER, "liquidatePosition", pos, path, coin, pnl.pnl, closeFee, borrowFee,
        liquidationFee, now, capOf(l.poolValue + s.toPool - s.fromPool)
      );
      continue;
    }
    const s = m.settlement(pos, pnl, closeFee, borrowFee);
    const capacity = capOf(l.poolValue + s.toPool - s.fromPool);
    const firing = o.orders.find((ord) => (ord.above ? l.markPrice >= ord.price : l.markPrice <= ord.price));
    if (firing && chance(0.8)) {
      const orderPath = l.orders.findPathForLeaf(pureCircuits.orderCommitment(firing));
      await run(
        `execute order ${tag}`, KEEPER, "executeOrder", pos, path, firing, orderPath, coin, pnl.pnl,
        closeFee, borrowFee, now, capacity
      );
      continue;
    }
    await run(`close ${tag}`, TRADER, "closePosition", pos, o.secret, path, coin, pnl.pnl, closeFee, borrowFee, now, capacity);
  }

  // ── Fees in, then liquidity out, at share-price and capacity edges ──
  if (chance(0.5) && L().lpSupply > 0n) {
    const value = logBetween(1n, p.maxPayout * 3n);
    await run("deposit fees", DEPLOYER, "depositFees", { nonce: randomBytes32(), color: USDC, value }, capOf(L().poolValue + value));
  }
  for (let i = 0; i < 2; i++) {
    const l = L();
    if (l.lpSupply === 0n) break;
    const shares = pick([l.lpSupply, 1n, logBetween(1n, l.lpSupply)]);
    const amount = (shares * l.poolValue) / l.lpSupply;
    await run(
      `withdraw ${shares === l.lpSupply ? "all" : shares}`, LP, "removeLiquidity",
      { nonce: randomBytes32(), color: l.lpToken, value: shares }, amount, capOf(l.poolValue - amount)
    );
  }
}
