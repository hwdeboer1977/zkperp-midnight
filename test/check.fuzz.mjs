// SPDX-License-Identifier: Apache-2.0

/**
 * Fuzzes zkperp's circuits through the proof server's `/check` — no chain.
 *
 *   npm run proof:up                      # a proof server on :6300
 *   npm run build && node test/check.fuzz.mjs [cases] [seed]
 *
 * Why: a proof evaluates EVERY branch of an `if`, and keeps only the taken
 * branch's effects; the JavaScript runtime runs only the taken branch. A value
 * that is out of range in an untaken branch (a negative change, a default coin
 * read) breaks the proof while every local test passes. The first loss close
 * on the devnet failed exactly this way. `/check` runs a call's inputs and
 * transcript against the circuit's constraints without the expensive proof,
 * so it catches the class cheaply.
 *
 * How: each case deploys the contract locally with random parameters, then
 * walks a random life through every circuit — deposits, opens, price moves,
 * closes, liquidations, stop losses and take profits, limit orders, fee
 * deposits, withdrawals — biased to the edges (flat price, a profit at and
 * above the payout cap, a wipe-out, maximum leverage, minimum collateral, a
 * borrow fee larger than the equity left, share-price and capacity
 * boundaries). Every call the runtime accepts is turned into the transaction
 * the SDK would build and sent to `/check`. A call the runtime accepts and
 * `/check` refuses is a failure. Calls the runtime refuses are counted, not
 * checked: the fuzzer means to stay on valid inputs.
 *
 * Reproduce a failure with the seed it prints; `PROOF_SERVER_URL` picks
 * another proof server.
 */

import fs from "fs";
import { createCircuitContext, createConstructorContext, sampleContractAddress } from "@midnight-ntwrk/compact-runtime";
import {
  ChargedState, ContractCallPrototype, ContractState, CostModel, Intent, LedgerParameters, PreTranscript,
  QueryContext, StateValue, Transaction, communicationCommitmentRandomness, createCheckPayload,
  parseCheckResult, partitionTranscripts,
} from "@midnight-ntwrk/ledger-v8";
import { Contract, ledger, pureCircuits } from "../contracts/managed/zkperp/contract/index.js";
import { JUBJUB_ORDER, belowField } from "../dist/core/liquidatorNote.js";
import { oracleSecrets, rotationMessage, sign as schnorrSign, signedPriceArgs, signerKeys } from "../dist/core/oracle.js";
import { firesAbove, sealOrderNote } from "../dist/core/orders.js";
import { sealLimitNote } from "../dist/core/limits.js";
import * as m from "../dist/core/math.js";

const CASES = Number(process.argv[2] ?? process.env.FUZZ_CASES ?? 20);
const SEED = Number(process.argv[3] ?? process.env.FUZZ_SEED ?? Date.now() % 2 ** 31);
const PROOF_SERVER = (process.env.PROOF_SERVER_URL ?? "http://127.0.0.1:6300").replace(/\/$/, "");
const ZKIR = new URL("../contracts/managed/zkperp/zkir/", import.meta.url);

// ── Randomness, seeded so a failure can be replayed ─────────────────────────

let rngState = SEED >>> 0;
/** mulberry32: a uniform 32-bit integer. */
function u32() {
  rngState = (rngState + 0x6d2b79f5) >>> 0;
  let t = rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (t ^ (t >>> 14)) >>> 0;
}
const chance = (p) => u32() / 2 ** 32 < p;
const pick = (xs) => xs[u32() % xs.length];
/** Uniform in [lo, hi]. */
function between(lo, hi) {
  if (hi <= lo) return lo;
  const span = hi - lo + 1n;
  let r = 0n;
  for (let bits = 0n; bits < BigInt(span.toString(2).length) + 32n; bits += 32n) r = (r << 32n) | BigInt(u32());
  return lo + (r % span);
}
/** Spread over orders of magnitude in [lo, hi], with the ends drawn often. */
function logBetween(lo, hi) {
  if (hi <= lo) return lo;
  if (chance(0.1)) return lo;
  if (chance(0.1)) return hi;
  const bits = BigInt(between(BigInt(lo.toString(2).length), BigInt(hi.toString(2).length)));
  const top = 1n << bits;
  return between(lo, hi < top ? hi : top);
}
function randomBytes32() {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 4) new DataView(out.buffer).setUint32(i, u32());
  return out;
}
const scalar = () => between(1n, JUBJUB_ORDER - 1n);

// ── Constants ───────────────────────────────────────────────────────────────

const hex = (b) => Buffer.from(b).toString("hex");
const bytes32 = (byte) => new Uint8Array(32).fill(byte);
const key = (byte) => ({ bytes: bytes32(byte) });
const halves = (b) => [b.slice(0, 16), b.slice(16, 32)];
const ceilDiv = (a, b) => (a + b - 1n) / b;

const USDC = bytes32(0xc0);
const DEPLOYER = key(0x10);
const LP = key(0x20);
const TRADER = key(0x30);
const KEEPER = key(0x4b);
const TREASURY = key(0x7e);
const NOTE = Uint8Array.from({ length: 128 }, (_, i) => (i * 53 + 7) & 0xff);
const LIQUIDATOR_SECRET = JUBJUB_ORDER - 0x1234_5678_9abcn;
const LIQUIDATOR_KEY = pureCircuits.liquidatorPublicKey(LIQUIDATOR_SECRET);
const SIGNERS = oracleSecrets("ab".repeat(32));
const SIGNER_KEYS = signerKeys(pureCircuits, SIGNERS);
const PAIRS = [[0, 1], [0, 2], [1, 2]];
const U64_MAX = 2n ** 64n - 1n;
const ADDRESS = sampleContractAddress();
const contract = new Contract({});

// ── /check ──────────────────────────────────────────────────────────────────

const irs = new Map();
const irOf = (circuit) => {
  if (!irs.has(circuit)) irs.set(circuit, fs.readFileSync(new URL(`${circuit}.bzkir`, ZKIR)));
  return irs.get(circuit);
};

function asLedgerQueryContext(qc) {
  const l = new QueryContext(new ChargedState(StateValue.decode(qc.state.state.encode())), qc.address);
  l.block = qc.block;
  l.effects = qc.effects;
  return l;
}

/**
 * The call as midnight-js would build it (see `createUnprovenLedgerCallTx`),
 * proven with a provider that stops after `/check`: `ok` when the proof
 * server accepted the inputs, `error` with its answer when not.
 */
async function check(circuit, wrapper, before, r) {
  const pre = new PreTranscript(
    Array.from(r.context.currentQueryContext.comIndices).reduce((q, e) => q.insertCommitment(...e), asLedgerQueryContext(before)),
    r.proofData.publicTranscript
  );
  const parts = partitionTranscripts([pre], LedgerParameters.initialParameters());
  if (parts.length !== 1) throw new Error(`expected one transcript partition, got ${parts.length}`);
  const [guaranteed, fallible] = parts[0];
  const op = ContractState.deserialize(wrapper.serialize()).operation(circuit);
  const intent = Intent.new(new Date(Date.now() + 3_600_000)).addCall(
    new ContractCallPrototype(
      ADDRESS, circuit, op, guaranteed, fallible, r.proofData.privateTranscriptOutputs,
      r.proofData.input, r.proofData.output, communicationCommitmentRandomness(), circuit
    )
  );
  const tx = Transaction.fromParts("undeployed", undefined, undefined, intent);

  let verdict;
  const provider = {
    async check(preimage, keyLocation) {
      const res = await fetch(`${PROOF_SERVER}/check`, {
        method: "POST",
        body: createCheckPayload(preimage, irOf(keyLocation)),
        headers: { "Content-Type": "application/octet-stream" },
      });
      if (!res.ok) {
        verdict = { ok: false, error: `${res.status}: ${(await res.text()).slice(0, 300)}` };
        throw new Error("refused");
      }
      verdict = { ok: true };
      return parseCheckResult(new Uint8Array(await res.arrayBuffer()));
    },
    async prove() {
      throw new Error("checked; not proving");
    },
  };
  try {
    await tx.prove(provider, CostModel.initialCostModel());
  } catch (cause) {
    if (!verdict) return { ok: false, error: `no /check reached: ${cause?.message ?? cause}` };
  }
  return verdict;
}

// ── One case: a contract with random parameters ─────────────────────────────

function randomParams() {
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

const stats = { checked: {}, refusedLocally: {}, failures: [] };
const bump = (o, k) => (o[k] = (o[k] ?? 0) + 1);

async function runCase(index) {
  const p = randomParams();
  const T0 = 1_800_000_000n;
  let now = T0;
  const deploy = () =>
    contract.initialState(
      createConstructorContext({}, hex(DEPLOYER.bytes)),
      USDC, SIGNER_KEYS, p.price, T0 - 10n, 1n, p.maxLeverage, p.minCollateral, p.maxPayout,
      p.openFeeBps, p.closeFeeBps, p.borrowRate, TREASURY, p.clockSlack, p.maxPriceAge, p.maintenanceBps,
      p.liquidationFeeBps, LIQUIDATOR_KEY
    ).currentContractState;
  let state = deploy().data;
  const L = () => ledger(state);
  const capOf = (value) => m.capacityOf(value, p.maxPayout);

  /** Runs `circuit` locally at `now`; if accepted, checks it and keeps its state. */
  async function run(label, caller, circuit, ...args) {
    const wrapper = deploy();
    wrapper.data = state;
    const ctx = createCircuitContext(ADDRESS, hex(caller.bytes), wrapper, {}, undefined, undefined, Number(now));
    const before = ctx.currentQueryContext;
    let r;
    try {
      r = contract.impureCircuits[circuit](ctx, ...args);
    } catch (cause) {
      bump(stats.refusedLocally, `${circuit}: ${String(cause?.message ?? cause).slice(0, 60)}`);
      return null;
    }
    const v = await check(circuit, wrapper, before, r);
    bump(stats.checked, circuit);
    if (!v.ok) {
      stats.failures.push({ seed: SEED, case: index, label, circuit, error: v.error, params: p });
      console.error(`  FAIL  case ${index}, ${label}: /check refused ${circuit}\n        ${v.error}`);
    }
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
        sealLimitNote(pureCircuits, LIQUIDATOR_KEY, order, scalar())
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
    const note = sealOrderNote(pureCircuits, LIQUIDATOR_KEY, o.position.salt, order, scalar());
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

// ── Controls, then the cases ────────────────────────────────────────────────

console.log(`\ncheck fuzz: ${CASES} cases, seed ${SEED}, proof server ${PROOF_SERVER}\n`);

try {
  await fetch(`${PROOF_SERVER}/version`);
} catch {
  console.error(`No proof server at ${PROOF_SERVER}. Start one: npm run proof:up`);
  process.exit(2);
}

// A positive and a negative control: an honest deposit passes, and the same
// deposit with its inputs altered after the run must be refused, or an empty
// failure list means `/check` is not checking.
{
  const wrapper = contract.initialState(
    createConstructorContext({}, hex(DEPLOYER.bytes)), USDC, SIGNER_KEYS, 3_000_000_000n,
    1n, 1n, 20n, 1n, 1_000_000n, 10n, 10n, 0n, TREASURY, 600n, 3_900n, 250n, 50n, LIQUIDATOR_KEY
  ).currentContractState;
  const runDeposit = () => {
    const ctx = createCircuitContext(ADDRESS, hex(LP.bytes), wrapper, {}, undefined, undefined, 1_800_000_000);
    return { before: ctx.currentQueryContext, r: contract.impureCircuits.addLiquidity(ctx, { nonce: bytes32(1), color: USDC, value: 5_000_000n }, 5_000_000n, 4n) };
  };
  const honest = runDeposit();
  const good = await check("addLiquidity", wrapper, honest.before, honest.r);
  const forged = runDeposit();
  const capacity = forged.r.proofData.input.value;
  capacity[capacity.length - 1] = Uint8Array.of(5); // claims 5 slots; the constraints say 4
  const bad = await check("addLiquidity", wrapper, forged.before, forged.r);
  console.log(`  ${good.ok ? "ok" : "FAIL"}  control: an honest call passes /check${good.ok ? "" : `\n        ${good.error}`}`);
  console.log(`  ${!bad.ok ? "ok" : "FAIL"}  control: a forged input is refused by /check`);
  if (!good.ok || bad.ok) process.exit(1);
}

const started = Date.now();
for (let i = 0; i < CASES; i++) {
  try {
    await runCase(i);
  } catch (cause) {
    stats.failures.push({ seed: SEED, case: i, label: "fuzzer", error: String(cause?.stack ?? cause) });
    console.error(`  FAIL  case ${i}: the fuzzer itself threw\n        ${cause?.stack ?? cause}`);
  }
  if ((i + 1) % 5 === 0 || i + 1 === CASES) {
    const n = Object.values(stats.checked).reduce((a, b) => a + b, 0);
    console.log(`  ${i + 1}/${CASES} cases, ${n} calls checked, ${stats.failures.length} failures, ${((Date.now() - started) / 1000).toFixed(0)} s`);
  }
}

console.log("\n  checked by the proof server:");
for (const [c, n] of Object.entries(stats.checked).sort()) console.log(`    ${c.padEnd(20)} ${n}`);
console.log("\n  refused by the runtime (not checked):");
for (const [c, n] of Object.entries(stats.refusedLocally).sort()) console.log(`    ${String(n).padStart(4)}  ${c}`);

if (stats.failures.length) {
  const file = `check-fuzz-failures-${SEED}.json`;
  fs.writeFileSync(file, JSON.stringify(stats.failures, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  console.error(`\n${stats.failures.length} failure(s), seed ${SEED}; details in ${file}\n`);
  process.exit(1);
}
console.log(`\nall checked calls passed (seed ${SEED})\n`);
