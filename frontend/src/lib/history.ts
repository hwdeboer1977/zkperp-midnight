// SPDX-License-Identifier: Apache-2.0

/**
 * How each closed position ended: closed by its owner or liquidated, at what
 * price, and what the owner received.
 *
 * A close made in this browser records that itself (trading.ts). Anything
 * else — a close on another device, or a liquidation by the keeper — is found
 * on chain. A close and a liquidation both insert the position's nullifier in
 * `closed`, so the closing transaction is the first `closePosition` or
 * `liquidatePosition` call after which that nullifier is a member. The call's
 * entry point says who closed it, its state the exit price, its block the
 * time. The settlement is then recomputed as the circuit does it; the close
 * time is the block's, so the borrow fee is an estimate (`exact: false`).
 *
 * The state after EVERY close and liquidation is read, never just the ones
 * that matter: a binary search, or asking for one transaction by hash, would
 * show the indexer which close is this trader's. The list of calls comes from
 * the indexer's `contractActions` subscription, replayed from the deployment
 * once per session and extended later; states are cached for the session.
 * About 20 KB of state per close: fine at preview scale, not for a busy
 * deployment.
 */

import { ContractState } from "@midnight-ntwrk/compact-runtime";
import { borrowFeeOf, closeFeeOf, liquidationFeeOf, positionPnl, settlement } from "@core/math";
import type { PositionClosing } from "@core/types";
import { bytes } from "./bytes";
import type { AppConfig } from "./config";
import { allPositions, updatePosition, type PositionRecord } from "./positions";

type Module = { pureCircuits: any; ledger: (state: any) => any };

interface Settle {
  hash: string;
  entryPoint: "closePosition" | "liquidatePosition";
  /** Milliseconds since the epoch. */
  timestamp: number;
}

const ACTION_FIELDS = "transaction { hash block { height timestamp } } ... on ContractCall { entryPoint }";

/** Close and liquidate calls seen so far, per contract, in chain order; and the height scanned to. */
const scanned = new Map<string, { settles: Settle[]; seen: Set<string>; height: number }>();
/** The ledger after each close or liquidate call, by transaction hash. */
const ledgers = new Map<string, Promise<any>>();

async function query(config: AppConfig, q: string, variables: Record<string, unknown>): Promise<any> {
  const res = await fetch(config.network.indexer, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: q, variables }),
  });
  const body = await res.json();
  if (body.errors?.length) throw new Error(`indexer: ${body.errors[0].message}`);
  return body.data;
}

/** Every action on `address` from `height` up to and including the one in transaction `until`. */
function replay(config: AppConfig, address: string, height: number, until: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(config.network.indexerWS, "graphql-transport-ws");
    const actions: any[] = [];
    const finish = (error?: Error) => {
      clearTimeout(timer);
      ws.onmessage = ws.onerror = ws.onclose = null;
      ws.close();
      error ? reject(error) : resolve(actions);
    };
    const timer = setTimeout(() => finish(new Error("timed out reading the contract's history")), 60_000);
    ws.onopen = () => ws.send(JSON.stringify({ type: "connection_init" }));
    ws.onerror = () => finish(new Error("could not reach the indexer's websocket"));
    ws.onclose = () => finish(new Error("the indexer closed the history stream"));
    ws.onmessage = (event) => {
      const m = JSON.parse(String(event.data));
      if (m.type === "connection_ack") {
        ws.send(
          JSON.stringify({
            id: "history",
            type: "subscribe",
            payload: {
              query: `subscription ($address: HexEncoded!, $offset: BlockOffset) { contractActions(address: $address, offset: $offset) { ${ACTION_FIELDS} } }`,
              variables: { address, offset: { height } },
            },
          })
        );
      } else if (m.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
      } else if (m.type === "next") {
        if (m.payload?.errors?.length) return finish(new Error(`indexer: ${m.payload.errors[0].message}`));
        const action = m.payload.data.contractActions;
        actions.push(action);
        if (action.transaction.hash === until) finish();
      } else if (m.type === "error") {
        finish(new Error(`indexer: ${JSON.stringify(m.payload)}`));
      }
    };
  });
}

/** The contract's close and liquidate calls up to its latest action. */
async function settles(config: AppConfig, address: string): Promise<Settle[]> {
  const latest = (
    await query(
      config,
      `query ($address: HexEncoded!) { contractAction(address: $address) { ${ACTION_FIELDS} ... on ContractCall { deploy { transaction { block { height } } } } } }`,
      { address }
    )
  ).contractAction;
  if (!latest) return [];
  let entry = scanned.get(address);
  if (!entry) {
    const deployHeight = latest.deploy?.transaction.block.height ?? latest.transaction.block.height;
    entry = { settles: [], seen: new Set(), height: deployHeight };
    scanned.set(address, entry);
  }
  if (entry.seen.has(latest.transaction.hash)) return entry.settles;
  for (const a of await replay(config, address, entry.height, latest.transaction.hash)) {
    const hash: string = a.transaction.hash;
    if (entry.seen.has(hash)) continue;
    entry.seen.add(hash);
    entry.height = Math.max(entry.height, a.transaction.block.height);
    if (a.entryPoint === "closePosition" || a.entryPoint === "liquidatePosition") {
      entry.settles.push({ hash, entryPoint: a.entryPoint, timestamp: Number(a.transaction.block.timestamp) });
    }
  }
  return entry.settles;
}

/** The contract's ledger right after the call in transaction `hash`. */
async function ledgerAfter(config: AppConfig, module: Module, address: string, hash: string): Promise<any> {
  const data = await query(
    config,
    "query ($address: HexEncoded!, $hash: HexEncoded!) { contractAction(address: $address, offset: { transactionOffset: { hash: $hash } }) { state } }",
    { address, hash }
  );
  const state = data.contractAction?.state;
  if (!state) throw new Error(`no contract state for transaction ${hash.slice(0, 12)}…`);
  return module.ledger(ContractState.deserialize(bytes(state)).data);
}

/** The settlement of `record` by `settle`, recomputed from the ledger after it. */
function closingOf(record: PositionRecord, settle: Settle, l: any): PositionClosing {
  const o = record.opening;
  const position = {
    isLong: o.isLong,
    size: BigInt(o.size),
    collateral: BigInt(o.collateral),
    openFee: BigInt(o.openFee),
    entryPrice: BigInt(o.entryPrice),
  };
  const closeTime = BigInt(Math.floor(settle.timestamp / 1000));
  const openTime = BigInt(o.openTime);
  const pnl = positionPnl(position.isLong, position.size, position.entryPrice, l.markPrice, l.maxPayout);
  const closeFee = closeFeeOf(position.size, BigInt(l.closeFeeBps));
  const borrowFee = borrowFeeOf(position.size, BigInt(l.borrowRate), closeTime > openTime ? closeTime - openTime : 0n);
  const liquidated = settle.entryPoint === "liquidatePosition";
  const liquidationFee = liquidated ? liquidationFeeOf(position.size, BigInt(l.liquidationFeeBps)) : 0n;
  const s = settlement(position, pnl, closeFee, borrowFee, liquidationFee);
  return {
    by: liquidated ? "liquidation" : "trader",
    exitPrice: String(l.markPrice),
    closeTime: closeTime.toString(),
    pnl: (pnl.profit ? pnl.pnl : -pnl.pnl).toString(),
    // What the treasury took beyond the opening fee.
    fees: (s.toTreasury - position.openFee).toString(),
    received: s.toTrader.toString(),
    exact: false,
  };
}

/**
 * Fills in `closing` for closed records on `address` that lack it. Returns how
 * many records changed.
 */
export async function describeClosings(config: AppConfig, module: Module, address: string): Promise<number> {
  const todo = (await allPositions()).filter((r) => r.status === "closed" && !r.closing && r.contractAddress === address);
  if (todo.length === 0) return 0;
  const calls = await settles(config, address);
  for (const c of calls) {
    if (!ledgers.has(c.hash)) {
      const l = ledgerAfter(config, module, address, c.hash);
      l.catch(() => ledgers.delete(c.hash));
      ledgers.set(c.hash, l);
    }
  }
  const after = await Promise.all(calls.map((c) => ledgers.get(c.hash)!));

  let changed = 0;
  for (const record of todo) {
    const nullifier = module.pureCircuits.positionNullifier(bytes(record.opening.salt));
    const i = after.findIndex((l) => l.closed.member(nullifier));
    if (i < 0) continue;
    await updatePosition(record.commitment, { closing: closingOf(record, calls[i], after[i]), closeTxHash: calls[i].hash });
    changed += 1;
  }
  return changed;
}
