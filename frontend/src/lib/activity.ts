// SPDX-License-Identifier: Apache-2.0

/**
 * The contract's public history, from the indexer: every call, in chain order,
 * and the ledger after any one of them.
 *
 * The calls come from the indexer's `contractActions` subscription, replayed
 * from the deployment once per session and extended on later reads. Each
 * carries only its entry point, transaction and block, so the replay is light;
 * a ledger (about 20 KB of state) is read only for the calls that need one,
 * and cached for the session. Fine at preview scale; a busy deployment would
 * want to start the replay closer to now.
 */

import { ContractState } from "@midnight-ntwrk/compact-runtime";
import { bytes } from "./bytes";
import type { AppConfig } from "./config";

export type Module = { pureCircuits: any; ledger: (state: any) => any };

export interface Action {
  hash: string;
  /** The circuit called, "deploy", or "update": a maintenance transaction (setup adding a verifier key). */
  entryPoint: string;
  /** For an update: the circuits whose verifier keys it added. */
  circuits?: string[];
  height: number;
  /** Milliseconds since the epoch. */
  timestamp: number;
}

const ACTION_FIELDS = "__typename transaction { hash block { height timestamp } } ... on ContractCall { entryPoint }";

const scanned = new Map<string, { actions: Action[]; seen: Set<string>; height: number }>();
const pending = new Map<string, Promise<Action[]>>();
const states = new Map<string, Promise<ContractState>>();

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

async function readActions(config: AppConfig, address: string): Promise<Action[]> {
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
    entry = { actions: [], seen: new Set(), height: deployHeight };
    scanned.set(address, entry);
  }
  if (entry.seen.has(latest.transaction.hash)) return entry.actions;
  for (const a of await replay(config, address, entry.height, latest.transaction.hash)) {
    const hash: string = a.transaction.hash;
    if (entry.seen.has(hash)) continue;
    entry.seen.add(hash);
    entry.height = Math.max(entry.height, a.transaction.block.height);
    const previous = entry.actions[entry.actions.length - 1];
    const action: Action = {
      hash,
      entryPoint: a.entryPoint ?? (a.__typename === "ContractUpdate" ? "update" : "deploy"),
      height: a.transaction.block.height,
      timestamp: Number(a.transaction.block.timestamp),
    };
    if (action.entryPoint === "update" && previous) action.circuits = await addedCircuits(config, address, previous.hash, hash);
    entry.actions.push(action);
  }
  return entry.actions;
}

/** Every call on `address` so far, oldest first. Concurrent reads share one replay. */
export function contractActions(config: AppConfig, address: string): Promise<Action[]> {
  const running = pending.get(address);
  if (running) return running;
  const p = readActions(config, address).finally(() => pending.delete(address));
  pending.set(address, p);
  return p;
}

/** The contract's state right after the action in transaction `hash`, cached for the session. */
function stateAfter(config: AppConfig, address: string, hash: string): Promise<ContractState> {
  const cached = states.get(hash);
  if (cached) return cached;
  const p = query(
    config,
    "query ($address: HexEncoded!, $hash: HexEncoded!) { contractAction(address: $address, offset: { transactionOffset: { hash: $hash } }) { state } }",
    { address, hash }
  ).then((data) => {
    const state = data.contractAction?.state;
    if (!state) throw new Error(`no contract state for transaction ${hash.slice(0, 12)}…`);
    return ContractState.deserialize(bytes(state));
  });
  p.catch(() => states.delete(hash));
  states.set(hash, p);
  return p;
}

/** The contract's ledger right after the call in transaction `hash`. */
export async function ledgerAfter(config: AppConfig, module: Module, address: string, hash: string): Promise<any> {
  return module.ledger((await stateAfter(config, address, hash)).data);
}

/** The circuits with a verifier key after transaction `hash` that had none after `before`. */
async function addedCircuits(config: AppConfig, address: string, before: string, hash: string): Promise<string[]> {
  try {
    const [a, b] = await Promise.all([stateAfter(config, address, before), stateAfter(config, address, hash)]);
    const had = new Set(a.operations().map(String));
    return b.operations().map(String).filter((id) => !had.has(id));
  } catch {
    return [];
  }
}

export interface PricePoint {
  /** Milliseconds since the epoch: the block that set it. */
  at: number;
  price: bigint;
}

/** The mark price set by each of the last `limit` `setPrice` calls, oldest first. */
export async function priceHistory(config: AppConfig, module: Module, address: string, limit = 48): Promise<PricePoint[]> {
  const sets = (await contractActions(config, address)).filter((a) => a.entryPoint === "setPrice").slice(-limit);
  const after = await Promise.all(sets.map((a) => ledgerAfter(config, module, address, a.hash)));
  return sets.map((a, i) => ({ at: a.timestamp, price: after[i].markPrice as bigint }));
}

/** Calls that move the pool's value or its share supply. */
const POOL_CALLS = new Set(["addLiquidity", "removeLiquidity", "closePosition", "liquidatePosition", "depositFees"]);

/**
 * The zLP share price (pool value per share, 6 decimals) after each call that
 * changed it, oldest first: the LPs' actual return, trader PnL and fees included.
 */
export async function sharePriceHistory(config: AppConfig, module: Module, address: string, limit = 96): Promise<PricePoint[]> {
  const calls = (await contractActions(config, address)).filter((a) => POOL_CALLS.has(a.entryPoint)).slice(-limit);
  const after = await Promise.all(calls.map((a) => ledgerAfter(config, module, address, a.hash)));
  return calls
    .map((a, i) => ({ at: a.timestamp, l: after[i] }))
    .filter(({ l }) => l.lpSupply > 0n)
    .map(({ at, l }) => ({ at, price: (l.poolValue * 1_000_000n) / l.lpSupply }));
}
