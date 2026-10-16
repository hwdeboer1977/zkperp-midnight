// SPDX-License-Identifier: Apache-2.0

/**
 * Recovery (src/lib/recover.ts): positions rebuilt from their notes on chain.
 * The chain here is the app's own contract module (src/generated/zkperp, from
 * `npm run frontend:config`) run locally: real circuits, real notes, a real
 * ledger, no network. The position store is fake-indexeddb.
 */

import { beforeAll, describe, expect, it, vi } from "vitest";
import { createCircuitContext, createConstructorContext, sampleContractAddress } from "@midnight-ntwrk/compact-runtime";
// @ts-ignore — generated JavaScript, present after npm run frontend:config
import * as zkperp from "../src/generated/zkperp/index.js";
import { borrowFeeOf, capacityOf, closeFeeOf, openFeeOf } from "@core/math";
import { positionKey, sealNote, secretsOf, type PositionKey } from "@core/notes";
import { passwordRoot } from "@core/password";
import { bytes, hex } from "../src/lib/bytes";
import { allPositions, putPosition, type PositionRecord } from "../src/lib/positions";
import { recoverPositions, recoverableCommitments } from "../src/lib/recover";

// lockAndClear loads the contract module the app's way; the wallet is not needed.
vi.mock("../src/lib/contracts", () => ({ contractModule: async () => zkperp }));
vi.mock("../src/lib/wallet", () => ({ useWallet: () => ({}) }));
const { lockAndClear } = await import("../src/lib/usePositions");

const { Contract, ledger: ledgerOf, pureCircuits } = zkperp as any;
const contract = new Contract({});
const ADDRESS: string = sampleContractAddress();
const NETWORK = "undeployed";

const fill = (n: number, byte: number) => new Uint8Array(n).fill(byte);
const halves = (b: Uint8Array) => [b.slice(0, 16), b.slice(16, 32)];
const USDC = fill(32, 0xc0);
const WALLET_A = fill(32, 0x31); // the trader's wallet account (coin public key)
const WALLET_B = fill(32, 0x32); // another account of the same trader
const ENC = fill(32, 0x3e);
const PRICE = 3_000_000_000n;
const T0 = 1_800_000_000n;
const MAX_PAYOUT = 100_000_000_000n;
const OPEN_FEE_BPS = 10n;
const CLOSE_FEE_BPS = 10n;
const BORROW_RATE = 1_000_000n;
const SCALAR = 6554484396890773809930967563523245729705921265872317281365359162392183254199n - 0xbeefn;
const PASSWORD = "correct horse battery staple again";

function deploy() {
  return contract.initialState(
    createConstructorContext({}, hex(fill(32, 0x10))),
    USDC,
    [1n, 2n, 3n].map((i) => pureCircuits.signerPublicKey(SCALAR - i)),
    PRICE, T0 - 10n, 1n, 20n, 10_000_000n, MAX_PAYOUT, OPEN_FEE_BPS, CLOSE_FEE_BPS, BORROW_RATE,
    { bytes: fill(32, 0x7e) }, 600n, 3_900n, 250n, 50n,
    [4n, 5n, 6n].map((i) => pureCircuits.liquidatorPublicKey(SCALAR - i))
  ).currentContractState;
}

let state: any = deploy().data;
function call(time: bigint, caller: Uint8Array, circuit: string, ...args: unknown[]) {
  const wrapper = deploy();
  wrapper.data = state;
  const r = contract.impureCircuits[circuit](
    createCircuitContext(ADDRESS, hex(caller), wrapper, {}, undefined, undefined, Number(time)),
    ...args
  );
  state = r.context.currentQueryContext.state;
}

/** Opens a position the app's way: secrets from a seed under `key`, the opening sealed into the note. */
async function open(key: PositionKey, wallet: Uint8Array, seedByte: number, isLong: boolean, collateral: bigint, size: bigint) {
  const seed = fill(32, seedByte);
  const s = await secretsOf(key, seed);
  const openFee = openFeeOf(size, OPEN_FEE_BPS);
  const note = await sealNote(key, bytes(ADDRESS), { seed, isLong, size, collateral, openFee, entryPrice: PRICE, openTime: T0 });
  call(T0, wallet, "openPosition", { nonce: s.collateralNonce, color: USDC, value: collateral + openFee }, size, isLong, openFee, T0,
    s.ownerSecret, s.salt, note, SCALAR, ...halves(wallet), ...halves(ENC));
  const position = {
    owner: pureCircuits.ownerKey(s.ownerSecret), isLong, size, collateral, openFee, entryPrice: PRICE, openTime: T0,
    collateralNonce: s.collateralNonce, salt: s.salt, payTo: { bytes: wallet },
  };
  return { s, position, commitment: hex(pureCircuits.positionCommitment(position)) };
}

const comparable = (records: PositionRecord[]) => [...records].sort((a, b) => a.commitment.localeCompare(b.commitment));

describe("recovery from notes", () => {
  let key: PositionKey;
  let longA: Awaited<ReturnType<typeof open>>;
  let shortA: Awaited<ReturnType<typeof open>>;
  let closedA: Awaited<ReturnType<typeof open>>;
  let longB: Awaited<ReturnType<typeof open>>;
  let recovered: PositionRecord[];

  beforeAll(async () => {
    key = await positionKey(await passwordRoot(PASSWORD, WALLET_A));
    call(T0, fill(32, 0x20), "addLiquidity", { nonce: fill(32, 1), color: USDC, value: 500n * MAX_PAYOUT }, 500n * MAX_PAYOUT,
      capacityOf(500n * MAX_PAYOUT, MAX_PAYOUT));
    longA = await open(key, WALLET_A, 1, true, 1_000_000_000n, 5_000_000_000n);
    shortA = await open(key, WALLET_A, 2, false, 250_000_000n, 4_000_000_000n);
    closedA = await open(key, WALLET_A, 3, true, 100_000_000n, 1_000_000_000n);
    // The same key, but paid to another wallet account: this one's close could not pay wallet A.
    longB = await open(key, WALLET_B, 4, true, 300_000_000n, 600_000_000n);

    // Close one at the entry price, an hour later.
    const p = closedA.position;
    const l = ledgerOf(state);
    call(T0 + 60n, WALLET_A, "closePosition", p, closedA.s.ownerSecret, l.positions.findPathForLeaf(bytes(closedA.commitment)),
      { nonce: p.collateralNonce, color: USDC, value: p.collateral + p.openFee, mt_index: 0n }, 0n,
      closeFeeOf(p.size, CLOSE_FEE_BPS), borrowFeeOf(p.size, BORROW_RATE, 60n), T0 + 60n, capacityOf(l.poolValue, MAX_PAYOUT));
  });

  it("rebuilds a record for each of this wallet's positions, open and closed", async () => {
    const changed = await recoverPositions(zkperp, ledgerOf(state), key, ADDRESS, NETWORK, hex(WALLET_A));
    expect(changed).toBe(3);
    recovered = comparable(await allPositions());
    expect(recovered.map((r) => r.commitment).sort()).toEqual([longA.commitment, shortA.commitment, closedA.commitment].sort());
    const status = Object.fromEntries(recovered.map((r) => [r.commitment, r.status]));
    expect(status[longA.commitment]).toBe("open");
    expect(status[shortA.commitment]).toBe("open");
    expect(status[closedA.commitment]).toBe("closed");
  });

  it("rebuilds the opening exactly: everything a close needs", () => {
    const r = recovered.find((x) => x.commitment === shortA.commitment)!;
    expect(r.opening).toEqual({
      ownerSecret: hex(shortA.s.ownerSecret),
      isLong: false,
      size: "4000000000",
      collateral: "250000000",
      openFee: openFeeOf(4_000_000_000n, OPEN_FEE_BPS).toString(),
      entryPrice: PRICE.toString(),
      openTime: T0.toString(),
      collateralNonce: hex(shortA.s.collateralNonce),
      salt: hex(shortA.s.salt),
      payTo: hex(WALLET_A),
    });
    expect(r).toMatchObject({ contractAddress: ADDRESS, networkId: NETWORK });
  });

  it("skips a note whose position pays another wallet account", () => {
    expect(recovered.some((r) => r.commitment === longB.commitment)).toBe(false);
  });

  it("finds that position from the other account", async () => {
    const theirs = await recoverableCommitments(zkperp, ledgerOf(state), key, ADDRESS, NETWORK, hex(WALLET_B));
    expect([...theirs]).toEqual([longB.commitment]);
  });

  it("does not open notes under another password's key", async () => {
    const other = await positionKey(await passwordRoot("a different password entirely", WALLET_A));
    expect((await recoverableCommitments(zkperp, ledgerOf(state), other, ADDRESS, NETWORK, hex(WALLET_A))).size).toBe(0);
  });

  it("Lock and clear removes what the chain rebuilds, keeps what only this browser holds, and unlocking restores it all", async () => {
    // A position without a note (opened from the CLI): only this browser has it.
    const localOnly: PositionRecord = { ...recovered[0]!, commitment: "ab".repeat(32), createdAt: "2026-10-15T00:00:00.000Z" };
    await putPosition(localOnly);

    const config = { contracts: { zkperp: ADDRESS }, network: { networkId: NETWORK } } as any;
    const { deleted, kept } = await lockAndClear(config, ledgerOf(state), key, WALLET_A);
    expect({ deleted, kept }).toEqual({ deleted: 3, kept: 1 });
    expect((await allPositions()).map((r) => r.commitment)).toEqual([localOnly.commitment]);

    // Unlock again from the password: a new key object, nothing cached.
    const again = await positionKey(await passwordRoot(PASSWORD, WALLET_A));
    expect(await recoverPositions(zkperp, ledgerOf(state), again, ADDRESS, NETWORK, hex(WALLET_A))).toBe(3);
    const restored = comparable((await allPositions()).filter((r) => r.commitment !== localOnly.commitment));
    expect(restored).toEqual(recovered);
  });
});
