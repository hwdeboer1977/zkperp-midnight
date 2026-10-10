// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { fmt6 } from "../lib/bytes";
import { cancelLimitOrder, isExpired, type OwnLimit } from "../lib/limits";
import { useNow } from "../lib/hooks";
import { proverLabel, useWallet } from "../lib/wallet";

const leverageOf = (o: OwnLimit) => Number((o.size * 10n) / o.collateral) / 10;

/**
 * A trader's limit orders as a table: the waiting ones with a cancel button,
 * and, with `done`, the filled and cancelled ones after them.
 */
export function LimitOrdersTable({ orders, ledger, done = false, onChanged }: { orders: OwnLimit[]; ledger: any; done?: boolean; onChanged?: () => void }) {
  const shown = done ? orders : orders.filter((o) => o.status === "waiting");
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th></th>
            <th title="A long fills at or below it, a short at or above, at the mark price of the moment">Limit</th>
            <th>Size</th>
            <th title="Posted now, opening fee included; returned in full on cancel">Posted</th>
            <th>{done ? "Status" : "Distance"}</th>
            <th>Placed</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {shown.map((o) => (
            <LimitRow key={o.id} order={o} ledger={ledger} onChanged={onChanged} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LimitRow({ order: o, ledger, onChanged }: { order: OwnLimit; ledger: any; onChanged?: () => void }) {
  const w = useWallet();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const now = useNow(15_000);
  const expired = isExpired(o, now);
  // How far the mark price still has to move, in the direction that fills it.
  const distance = ledger ? (Number(o.isLong ? ledger.markPrice - o.price : o.price - ledger.markPrice) / Number(ledger.markPrice)) * 100 : null;

  async function cancel() {
    setBusy(true);
    setStatus(`Proving on ${proverLabel(w.prover)}${w.walletProves ? ", through your wallet" : ""}…`);
    try {
      const perp = await w.contract("zkperp");
      await cancelLimitOrder(perp, o);
      setStatus(null);
      void w.refresh();
      onChanged?.();
    } catch (e: any) {
      setStatus(`Failed: ${e?.message ?? e}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr>
      <td className={`text ${o.isLong ? "long" : "short"}`}>
        {o.isLong ? "Long" : "Short"} <small className="muted">{leverageOf(o)}×</small>
      </td>
      <td>${fmt6(o.price)}</td>
      <td>{fmt6(o.size)}</td>
      <td>{fmt6(o.collateral + o.openFee)}</td>
      <td className="text">
        {expired ? (
          <span className="chip warn" title="It no longer fills; cancel it to get the coin back">expired</span>
        ) : o.status === "waiting" ? (
          distance === null ? (
            "…"
          ) : distance <= 0 ? (
            <span className="chip warn" title="The keeper fills it on its next check (every 15 s); proving and landing take about a minute more">
              reached · keeper next
            </span>
          ) : (
            <span className="muted">{distance.toFixed(2)}% away</span>
          )
        ) : o.status === "filled" ? (
          <span className="chip good">filled at ${fmt6(o.fill!.entryPrice)}</span>
        ) : (
          <span className="chip">cancelled</span>
        )}
      </td>
      <td className="text muted">
        {new Date(Number(o.placedAt) * 1000).toLocaleString()}
        {o.expiry > 0n && o.status === "waiting" && !expired && (
          <div>
            <small>expires {new Date(Number(o.expiry) * 1000).toLocaleString()}</small>
          </div>
        )}
      </td>
      <td>
        {o.status === "waiting" &&
          (w.api ? (
            <button className="small" disabled={busy} onClick={() => void cancel()}>
              {busy ? "Cancelling…" : "Cancel"}
            </button>
          ) : (
            <small className="muted">connect to cancel</small>
          ))}
        {status && <div className={status.startsWith("Failed") ? "bad" : "muted"}>{status}</div>}
      </td>
    </tr>
  );
}
