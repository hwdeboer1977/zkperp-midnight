// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState } from "react";
import { hex } from "./bytes";
import { contractModule } from "./contracts";
import { describeClosings } from "./history";
import { useConfig, useLedger } from "./hooks";
import type { AppConfig } from "./config";
import { allPositions, deletePosition, type PositionRecord } from "./positions";
import { lockPositionKey, usePositionKey } from "./positionKey";
import { recoverPositions, recoverableCommitments, settleClosed } from "./recover";
import type { PositionKey } from "@core/notes";
import { watchPositions } from "./notices";

/** Fired when records are removed outside the hook, so every page reloads them. */
const CHANGED = "zkperp:positions-changed";

/**
 * Lock, and delete this browser's cached records that the chain can rebuild
 * (a note under `key` opens to them). Records only this browser holds stay.
 * Returns how many were deleted and how many kept on this deployment.
 */
export async function lockAndClear(config: AppConfig, ledger: any, key: PositionKey, coinPublicKey: Uint8Array) {
  const module = await contractModule("zkperp");
  const address = config.contracts.zkperp;
  const rebuildable = await recoverableCommitments(module, ledger, key, address, config.network.networkId, hex(coinPublicKey));
  let deleted = 0;
  let kept = 0;
  for (const r of await allPositions()) {
    if (r.contractAddress !== address) continue;
    if (rebuildable.has(r.commitment)) {
      await deletePosition(r.commitment);
      deleted += 1;
    } else kept += 1;
  }
  lockPositionKey();
  window.dispatchEvent(new Event(CHANGED));
  return { deleted, kept };
}
import { useWallet } from "./wallet";

/**
 * This trader's positions on the current deployment, kept in step with the
 * chain: on every ledger poll, positions found from their notes under the
 * position key, closes made elsewhere, and how each closed position ended.
 */
export function usePositions() {
  const w = useWallet();
  const config = useConfig();
  const { ledger } = useLedger();
  const key = usePositionKey();
  const [records, setRecords] = useState<PositionRecord[]>([]);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [rebuildable, setRebuildable] = useState<Set<string> | null>(null);
  const reload = useCallback(() => void allPositions().then(setRecords), []);
  useEffect(reload, [reload]);
  useEffect(() => {
    window.addEventListener(CHANGED, reload);
    return () => window.removeEventListener(CHANGED, reload);
  }, [reload]);

  // Which records a note rebuilds, once per key and number of notes: the rest
  // exist only in this browser.
  const notes = ledger ? Number(ledger.notes.size()) : 0;
  useEffect(() => {
    setRebuildable(null);
    if (!ledger || !config || !key || !w.coinPublicKey) return;
    let live = true;
    void contractModule("zkperp")
      .then((module) =>
        recoverableCommitments(module, ledger, key, config.contracts.zkperp, config.network.networkId, hex(w.coinPublicKey!))
      )
      .then((set) => live && setRebuildable(set), () => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, key, w.coinPublicKey, notes]);

  useEffect(() => {
    if (!ledger || !config) return;
    let live = true;
    void (async () => {
      const module = await contractModule("zkperp");
      const address = config.contracts.zkperp;
      let changed = await settleClosed(module, ledger, address);
      if (key && w.coinPublicKey) {
        changed += await recoverPositions(module, ledger, key, address, config.network.networkId, hex(w.coinPublicKey));
      }
      if (live && changed > 0) reload();
      // How each closed position ended; a slower lookup, so after the rest shows.
      if (!live) return;
      if ((await describeClosings(config, module, address)) > 0 && live) reload();
    })().then(
      () => live && setSyncError(null),
      (e) => live && setSyncError(String(e?.message ?? e))
    );
    return () => {
      live = false;
    };
  }, [ledger, config, key, w.coinPublicKey, reload]);

  const mine = config ? records.filter((r) => r.contractAddress === config.contracts.zkperp) : [];
  useEffect(() => watchPositions(mine), [records, config]); // eslint-disable-line react-hooks/exhaustive-deps
  return {
    open: mine.filter((r) => r.status === "open"),
    history: mine.filter((r) => r.status !== "open").sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    pending: mine.filter((r) => r.status === "pending"),
    /** Open records no note rebuilds: lost if this browser's storage is. Empty while locked. */
    localOnly: rebuildable ? mine.filter((r) => r.status === "open" && !rebuildable.has(r.commitment)) : [],
    syncError,
    reload,
  };
}
