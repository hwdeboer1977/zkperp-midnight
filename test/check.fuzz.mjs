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
import { createCircuitContext, createConstructorContext } from "@midnight-ntwrk/compact-runtime";
import {
  ChargedState, ContractCallPrototype, ContractState, CostModel, Intent, LedgerParameters, PreTranscript,
  QueryContext, StateValue, Transaction, communicationCommitmentRandomness, createCheckPayload,
  parseCheckResult, partitionTranscripts,
} from "@midnight-ntwrk/ledger-v8";
import { ADDRESS, DEPLOYER, KEEPER_KEYS, LP, SIGNER_KEYS, TREASURY, USDC, bytes32, contract, hex, reseed, runLife } from "./life.mjs";

const CASES = Number(process.argv[2] ?? process.env.FUZZ_CASES ?? 20);
const SEED = Number(process.argv[3] ?? process.env.FUZZ_SEED ?? Date.now() % 2 ** 31);
const PROOF_SERVER = (process.env.PROOF_SERVER_URL ?? "http://127.0.0.1:6300").replace(/\/$/, "");
const ZKIR = new URL("../contracts/managed/zkperp/zkir/", import.meta.url);
reseed(SEED);

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

const stats = { checked: {}, refusedLocally: {}, failures: [] };
const bump = (o, k) => (o[k] = (o[k] ?? 0) + 1);

/** One random life (test/life.mjs), each call the runtime accepts sent to /check. */
const runCase = (index) =>
  runLife(index, {
    refused: (circuit, error) => bump(stats.refusedLocally, `${circuit}: ${error.slice(0, 60)}`),
    accepted: async ({ label, circuit, wrapper, before, r, params }) => {
      const v = await check(circuit, wrapper, before, r);
      bump(stats.checked, circuit);
      if (!v.ok) {
        stats.failures.push({ seed: SEED, case: index, label, circuit, error: v.error, params });
        console.error(`  FAIL  case ${index}, ${label}: /check refused ${circuit}\n        ${v.error}`);
      }
    },
  });

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
    1n, 1n, 20n, 1n, 1_000_000n, 10n, 10n, 0n, TREASURY, 600n, 3_900n, 250n, 50n, KEEPER_KEYS
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
