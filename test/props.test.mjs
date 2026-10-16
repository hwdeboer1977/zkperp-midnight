// SPDX-License-Identifier: Apache-2.0

/**
 * Property tests of the money: invariants over many random cases, rather than
 * hand-worked examples (docs/roadmap.md, step 1a). No chain, no proof server.
 *
 *   npm run build && node test/props.test.mjs [cases] [lives] [seed]   # 50,000 and 30 by default
 *   npm run test:props                                                # a long run: 500,000 and 500
 *
 * Two layers:
 *
 *   · MATH. core/math.ts on its own, over many thousands of random positions,
 *     prices and hold times: settlement conserves value; a loss never exceeds
 *     the collateral nor a profit the payout cap; fees never exceed the equity
 *     left; a position in profit is never liquidatable; `liquidationPrice`
 *     lands next to where `isLiquidatable` flips; share-price rounding favours
 *     the pool.
 *
 *   · CIRCUIT. Random lives of the contract (test/life.mjs, the same walker
 *     as the /check fuzzer) through its JavaScript runtime. After every call:
 *     reserved liquidity never exceeds the pool; the pool's coin holds its
 *     value. After every close, liquidation and executed order: what the
 *     circuit paid each party equals core/math.ts's `settlement`, so the two
 *     cannot drift. Before every close: the circuit accepts `liquidatePosition`
 *     exactly when `isLiquidatable` says so.
 *
 * A failure prints its seed; rerun with it to replay.
 */

import { fork } from "child_process";
import { fileURLToPath } from "url";
import { createCircuitContext } from "@midnight-ntwrk/compact-runtime";
import { ledger } from "../contracts/managed/zkperp/contract/index.js";
import * as m from "../dist/core/math.js";
import {
  ADDRESS, KEEPER, LP, TRADER, TREASURY, between, chance, contract, hex, logBetween, pick, reseed, runLife,
} from "./life.mjs";

const CASES = Number(process.argv[2] ?? process.env.PROP_CASES ?? 50_000);
const LIVES = Number(process.argv[3] ?? process.env.PROP_LIVES ?? 30);
const SEED = Number(process.argv[4] ?? process.env.PROP_SEED ?? Date.now() % 2 ** 31);
reseed(SEED);
// A child process running lives [from, to) of a longer run; see the end.
const RANGE = process.env.PROP_RANGE?.split(":").map(Number);
// The runtime's WASM memory runs out after a few hundred lives in one
// process, slowing down first: longer runs go in batches, each its own
// process.
const BATCH = 40;

// ── A property: counts its cases, keeps its first counterexample ────────────

const props = new Map();
function holds(name, ok, example) {
  const p = props.get(name) ?? { cases: 0, failures: 0, example: undefined };
  props.set(name, p);
  p.cases += 1;
  if (!ok) {
    p.failures += 1;
    p.example ??= example?.();
  }
}
const show = (o) => JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
function report(section) {
  console.log(`\n  ${section}\n`);
  for (const [name, p] of props) {
    if (p.failures) console.error(`  FAIL  ${name}: ${p.failures} of ${p.cases} cases\n        e.g. ${typeof p.example === "string" ? p.example : show(p.example)}`);
    else console.log(`  ok  ${name} (${p.cases} cases)`);
  }
  const failed = [...props.values()].filter((p) => p.failures).length;
  props.clear();
  return failed;
}

if (!RANGE) console.log(`\nproperties: ${CASES} math cases, ${LIVES} contract lives, seed ${SEED}`);

// ── Math ────────────────────────────────────────────────────────────────────

/** Random terms within what a deploy can set (as test/life.mjs draws them). */
function randomTerms() {
  return {
    maxPayout: logBetween(1_000_000n, 1_000_000_000_000n),
    closeFeeBps: pick([0n, 1n, 10n, 100n, between(0n, 10_000n)]),
    borrowRate: pick([0n, 1n, 27_778n, 1_000_000n, between(0n, 100_000_000n)]),
    maintenanceBps: pick([1n, 250n, 1000n, between(1n, 9_999n)]),
    liquidationFeeBps: pick([0n, 50n, 500n, between(0n, 10_000n)]),
    openFeeBps: pick([1n, 10n, 100n, between(1n, 10_000n)]),
  };
}
function randomPosition(t) {
  const collateral = logBetween(1n, 10n ** 12n);
  const leverage = pick([1n, 2n, 20n, 100n, between(1n, 255n)]);
  const size = between(collateral, collateral * leverage);
  return {
    isLong: chance(0.5),
    size,
    collateral,
    openFee: m.openFeeOf(size, t.openFeeBps),
    entryPrice: logBetween(1_000n, 100_000_000_000n),
    openTime: 1_800_000_000n,
  };
}

let failed = 0;
for (let i = 0; i < (RANGE ? 0 : CASES); i++) {
  const t = randomTerms();
  const p = randomPosition(t);
  const exit = chance(0.1) ? p.entryPrice : between(1n, p.entryPrice * 3n);
  const held = pick([0n, 1n, 3_600n, between(0n, 3n * 365n * 86_400n)]);
  const pnl = m.positionPnl(p.isLong, p.size, p.entryPrice, exit, t.maxPayout);
  const closeFee = m.closeFeeOf(p.size, t.closeFeeBps);
  const borrowFee = m.borrowFeeOf(p.size, t.borrowRate, held);
  const liquidationFee = chance(0.5) ? m.liquidationFeeOf(p.size, t.liquidationFeeBps) : 0n;
  const s = m.settlement(p, pnl, closeFee, borrowFee, liquidationFee);
  const ex = () => ({ t, p, exit, held, pnl, closeFee, borrowFee, liquidationFee, s });

  holds(
    "settlement conserves value: pool + treasury + keeper + trader = collateral + opening fee + profit from the pool",
    s.toPool + s.toTreasury + s.toKeeper + s.toTrader === p.collateral + p.openFee + s.fromPool,
    ex
  );
  holds("no party receives a negative amount", [s.toPool, s.toTreasury, s.toKeeper, s.toTrader, s.fromPool].every((x) => x >= 0n), ex);
  holds("a loss never exceeds the collateral", s.toPool <= p.collateral, ex);
  holds("the pool never pays more than maxPayout per position", s.fromPool <= t.maxPayout, ex);
  holds("a position pays out only in profit, and takes nothing from the pool in a loss", pnl.profit || s.fromPool === 0n, ex);
  holds(
    "fees never exceed the equity left after the loss",
    s.toTreasury - p.openFee + s.toKeeper <= p.collateral - s.toPool,
    ex
  );
  const terms = { ...t, markPrice: exit };
  const liquidatable = m.isLiquidatable(p, terms, p.openTime + held);
  holds("a position in profit is never liquidatable", !(pnl.profit && pnl.pnl > 0n && liquidatable), ex);
  const plain = m.settlement(p, pnl, closeFee, borrowFee);
  holds(
    "isLiquidatable holds exactly when the equity after fees is below maintenance and the position is not in profit",
    liquidatable === (!(pnl.profit && pnl.pnl > 0n) && plain.equity * 10_000n < p.size * t.maintenanceBps),
    ex
  );

  // Where liquidation starts: the price at which `isLiquidatable` flips,
  // found by bisection (equity only falls as the price moves against the
  // position), against `liquidationPrice`'s estimate.
  const at = (price) => m.isLiquidatable(p, { ...t, markPrice: price }, p.openTime + held);
  const estimate = m.liquidationPrice(p, t, p.openTime + held);
  if (!at(p.entryPrice) && estimate > 1n && estimate < p.entryPrice * 3n) {
    // Long: liquidatable at and below `flip`. Short: at and above it.
    let lo, hi;
    if (p.isLong) {
      lo = 0n;
      hi = p.entryPrice;
      if (at(1n)) {
        while (hi - lo > 1n) {
          const mid = (lo + hi) / 2n;
          if (at(mid)) lo = mid;
          else hi = mid;
        }
        holds("liquidationPrice lands within one price unit of where isLiquidatable flips (long)", estimate - lo <= 1n && lo - estimate <= 1n, () => ({ ...ex(), estimate, flip: lo }));
      }
    } else {
      lo = p.entryPrice;
      hi = p.entryPrice * 3n;
      if (at(hi)) {
        while (hi - lo > 1n) {
          const mid = (lo + hi) / 2n;
          if (at(mid)) hi = mid;
          else lo = mid;
        }
        holds("liquidationPrice lands within one price unit of where isLiquidatable flips (short)", estimate - hi <= 1n && hi - estimate <= 1n, () => ({ ...ex(), estimate, flip: hi }));
      }
    }
  }

  // Share price, as the circuits pin it: shares = floor(amount × supply / value)
  // on deposit, amount = floor(shares × value / supply) on withdrawal.
  const value = logBetween(1n, 10n ** 15n);
  const supply = chance(0.3) ? value : logBetween(1n, 10n ** 15n);
  const deposit = logBetween(1n, 10n ** 15n);
  const shares = (deposit * supply) / value;
  const value1 = value + deposit;
  const supply1 = supply + shares;
  const back = (shares * value1) / supply1;
  const lx = () => ({ value, supply, deposit, shares, back });
  holds("a deposit followed by a withdrawal never returns more than was deposited", back <= deposit, lx);
  holds("a deposit never lowers the share price for the other LPs", value1 * supply >= value * supply1, lx);
  const burn = between(1n, supply);
  const paid = (burn * value) / supply;
  holds(
    "a withdrawal never lowers the share price for the LPs who stay",
    supply === burn || (value - paid) * supply >= value * (supply - burn),
    () => ({ value, supply, burn, paid })
  );
}
if (!RANGE) failed += report("math");

// ── The circuit, through random lives ───────────────────────────────────────

const paidTo = (r, who) =>
  r.context.currentZswapLocalState.outputs
    .filter((o) => o.recipient.is_left && hex(o.recipient.left.bytes) === hex(who.bytes))
    .reduce((sum, o) => sum + o.coinInfo.value, 0n);
const SETTLING = new Set(["closePosition", "liquidatePosition", "executeOrder"]);
const refusals = {};

/** Runs `liquidatePosition` for `pos` on the state before `r`, as a keeper would. */
function probeLiquidation({ wrapper, stateBefore, now, params }, pos, path, coin) {
  const l = ledger(stateBefore);
  const pnl = m.positionPnl(pos.isLong, pos.size, pos.entryPrice, l.markPrice, params.maxPayout);
  const closeFee = m.closeFeeOf(pos.size, params.closeFeeBps);
  const borrowFee = m.borrowFeeOf(pos.size, params.borrowRate, now - pos.openTime);
  const liquidationFee = m.liquidationFeeOf(pos.size, params.liquidationFeeBps);
  const s = m.settlement(pos, pnl, closeFee, borrowFee, liquidationFee);
  wrapper.data = stateBefore;
  try {
    contract.impureCircuits.liquidatePosition(
      createCircuitContext(ADDRESS, hex(KEEPER.bytes), wrapper, {}, undefined, undefined, Number(now)),
      pos, path, coin, pnl.pnl, closeFee, borrowFee, liquidationFee, now,
      m.capacityOf(l.poolValue + s.toPool - s.fromPool, params.maxPayout)
    );
    return { ok: true };
  } catch (cause) {
    return { ok: false, error: String(cause?.message ?? cause) };
  }
}

const hooks = (life) => ({
  refused: (circuit, error, { params, stateBefore, now, args }) => {
    const k = `${circuit}: ${error.slice(0, 60)}`;
    refusals[k] = (refusals[k] ?? 0) + 1;
    // The walker liquidates only what core/math.ts calls liquidatable.
    if (circuit === "liquidatePosition") {
      holds(
        "the circuit accepts liquidatePosition whenever isLiquidatable says so",
        !/above maintenance|in profit/.test(error),
        () => ({ life, error, params, now, position: args[0], markPrice: ledger(stateBefore).markPrice })
      );
    }
  },
  accepted: (call) => {
    const { circuit, args, r, stateBefore, params, now } = call;
    const before = ledger(stateBefore);
    const after = ledger(r.context.currentQueryContext.state);
    const ex = (extra = {}) => () => ({ life, circuit, label: call.label, params, ...extra });

    holds(
      "reserved liquidity never exceeds the pool",
      (after.slotCapacity - after.freeSlots) * params.maxPayout <= after.poolValue,
      ex({ slotCapacity: after.slotCapacity, freeSlots: after.freeSlots, poolValue: after.poolValue })
    );
    holds("free slots never exceed the slot capacity", after.freeSlots <= after.slotCapacity, ex());
    holds(
      "the slot capacity is the pool's, as core/math.ts computes it",
      after.slotCapacity === m.capacityOf(after.poolValue, params.maxPayout),
      ex({ slotCapacity: after.slotCapacity, poolValue: after.poolValue })
    );
    holds(
      "the pool's coin holds exactly the pool's value",
      after.poolValue === 0n || after.pool.value === after.poolValue,
      ex({ coin: after.pool.value, poolValue: after.poolValue })
    );

    if (circuit === "addLiquidity" || circuit === "removeLiquidity" || circuit === "depositFees") {
      holds(
        "no liquidity call lowers the share price",
        before.lpSupply === 0n || after.lpSupply === 0n || after.poolValue * before.lpSupply >= before.poolValue * after.lpSupply,
        ex({ before: [before.poolValue, before.lpSupply], after: [after.poolValue, after.lpSupply] })
      );
    }
    if (circuit === "removeLiquidity") {
      const shares = args[0].value;
      holds(
        "a withdrawal pays at most the shares' pro-rata value",
        paidTo(r, LP) * before.lpSupply <= shares * before.poolValue,
        ex({ shares, paid: paidTo(r, LP) })
      );
    }

    if (!SETTLING.has(circuit)) return;
    // closePosition(pos, secret, path, coin, pnl, closeFee, borrowFee, time, capacity)
    // liquidatePosition(pos, path, coin, pnl, closeFee, borrowFee, liquidationFee, time, capacity)
    // executeOrder(pos, path, order, orderPath, coin, pnl, closeFee, borrowFee, time, capacity)
    const pos = args[0];
    const [path, coin, pnlAmount, closeFee, borrowFee, liquidationFee] =
      circuit === "closePosition" ? [args[2], args[3], args[4], args[5], args[6], 0n]
      : circuit === "liquidatePosition" ? [args[1], args[2], args[3], args[4], args[5], args[6]]
      : [args[1], args[4], args[5], args[6], args[7], 0n];
    const pnl = m.positionPnl(pos.isLong, pos.size, pos.entryPrice, before.markPrice, params.maxPayout);
    const s = m.settlement(pos, pnl, closeFee, borrowFee, liquidationFee);
    const got = {
      trader: paidTo(r, TRADER),
      treasury: paidTo(r, TREASURY),
      keeper: circuit === "liquidatePosition" ? paidTo(r, KEEPER) : 0n,
      poolChange: after.poolValue - before.poolValue,
    };
    const want = { trader: s.toTrader, treasury: s.toTreasury, keeper: s.toKeeper, poolChange: s.toPool - s.fromPool };
    holds(
      "the circuit pays each party what core/math.ts's settlement says",
      pnlAmount === pnl.pnl &&
        got.trader === want.trader && got.treasury === want.treasury && got.keeper === want.keeper && got.poolChange === want.poolChange,
      ex({ got, want })
    );
    holds(
      "the circuit's settlement conserves value",
      got.trader + got.treasury + got.keeper + got.poolChange === pos.collateral + pos.openFee,
      ex({ got, collateral: pos.collateral, openFee: pos.openFee })
    );
    holds("the pool never loses more than maxPayout on one position", -got.poolChange <= params.maxPayout, ex({ got }));
    holds("the pool never gains more than the collateral from one position", got.poolChange <= pos.collateral, ex({ got }));

    // The margin test both ways: before a close, a keeper's liquidation of the
    // same position must succeed exactly when core/math.ts calls it due.
    if (circuit !== "liquidatePosition") {
      const due = m.isLiquidatable(pos, { ...params, markPrice: before.markPrice }, now);
      const probe = probeLiquidation(call, pos, path, coin);
      holds(
        "the circuit accepts liquidatePosition exactly when isLiquidatable says so",
        due ? probe.ok : !probe.ok && /above maintenance|in profit/.test(probe.error),
        ex({ due, probe, markPrice: before.markPrice, position: pos })
      );
    }
  },
});

/** Lives [from, to), each seeded on its own (SEED + life), so one replays alone. */
async function runLives(from, to) {
  const started = Date.now();
  for (let life = from; life < to; life++) {
    reseed((SEED + life) >>> 0);
    try {
      await runLife(life, hooks(life));
    } catch (cause) {
      holds("the walker itself runs", false, () => ({ life, error: String(cause?.stack ?? cause).slice(0, 500) }));
    }
    if (!RANGE && ((life + 1) % 25 === 0 || life + 1 === to)) console.log(`  ${life + 1}/${to} lives, ${((Date.now() - started) / 1000).toFixed(0)} s`);
  }
}

if (RANGE) {
  // A batch: run it, hand the counts to the parent, and stop.
  await runLives(RANGE[0], RANGE[1]);
  const out = [...props].map(([name, p]) => [name, { ...p, example: p.example === undefined ? undefined : show(p.example) }]);
  process.send({ props: out, refusals }, () => process.exit(0));
  await new Promise(() => {});
} else if (LIVES <= BATCH) {
  await runLives(0, LIVES);
} else {
  // Batches of BATCH lives, four processes at a time; their counts merged.
  const self = fileURLToPath(import.meta.url);
  const batches = [];
  for (let from = 0; from < LIVES; from += BATCH) batches.push([from, Math.min(from + BATCH, LIVES)]);
  const started = Date.now();
  let done = 0;
  const runBatch = ([from, to]) =>
    new Promise((resolve) => {
      const child = fork(self, [], { env: { ...process.env, PROP_RANGE: `${from}:${to}`, PROP_SEED: String(SEED) } });
      let got = false;
      child.on("message", (msg) => {
        got = true;
        for (const [name, p] of msg.props) {
          const q = props.get(name) ?? { cases: 0, failures: 0, example: undefined };
          props.set(name, q);
          q.cases += p.cases;
          q.failures += p.failures;
          q.example ??= p.example;
        }
        for (const [k, n] of Object.entries(msg.refusals)) refusals[k] = (refusals[k] ?? 0) + n;
      });
      child.on("exit", (code) => {
        if (!got) holds("the walker itself runs", false, () => ({ lives: `${from}-${to}`, exit: code }));
        done += to - from;
        console.log(`  ${done}/${LIVES} lives, ${((Date.now() - started) / 1000).toFixed(0)} s`);
        resolve();
      });
    });
  const queue = [...batches];
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length) await runBatch(queue.shift());
  }));
}
failed += report("the circuit, through random lives");
console.log("\n  refused by the runtime (the walker stays near valid inputs; for information):");
for (const [k, n] of Object.entries(refusals).sort()) console.log(`    ${String(n).padStart(5)}  ${k}`);

if (failed) {
  console.error(`\n${failed} propert${failed === 1 ? "y" : "ies"} failed (seed ${SEED})\n`);
  process.exit(1);
}
console.log(`\nall properties hold (seed ${SEED})\n`);
