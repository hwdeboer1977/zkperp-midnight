// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState } from "react";
import { fmt6, hex } from "../lib/bytes";
import { contractModule } from "../lib/contracts";
import { useConfig, useLedger, useNow } from "../lib/hooks";
import { allPositions, type PositionRecord } from "../lib/positions";
import { usePositionKey } from "../lib/positionKey";
import { recoverPositions, settleClosed } from "../lib/recover";
import { describeClosings } from "../lib/history";
import { circuitNow, liquidationPrice } from "@core/math";
import { PriceMovedError, closePosition, quoteClose } from "../lib/trading";
import { proverLabel, useWallet } from "../lib/wallet";
import { PositionKeyPanel } from "../components/PositionKey";
import { NeedsWallet } from "../components/WalletButton";

type Quote = Awaited<ReturnType<typeof quoteClose>>;

const liquidationView = (o: PositionRecord["opening"]) => ({
  isLong: o.isLong,
  size: BigInt(o.size),
  collateral: BigInt(o.collateral),
  entryPrice: BigInt(o.entryPrice),
  openTime: BigInt(o.openTime),
});

function OpenRow({ record, ledger, onClosed }: { record: PositionRecord; ledger: any; onClosed: () => void }) {
  const w = useWallet();
  const now = useNow(10_000);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [moved, setMoved] = useState<PriceMovedError | null>(null);
  const o = record.opening;

  useEffect(() => {
    // A quote needs only the contract module and the public ledger, no wallet.
    void contractModule("zkperp").then((module) =>
      quoteClose({ module } as any, record, ledger).then(setQuote, () => setQuote(null))
    );
  }, [record, ledger, now]);

  async function close(expected: bigint) {
    if (!w.coinPublicKey) return;
    setBusy(true);
    setMoved(null);
    try {
      const perp = await w.contract("zkperp");
      setStatus(`Proving on ${proverLabel(w.prover)}${w.walletProves ? ", through your wallet" : ""}…`);
      await closePosition(perp, record, expected);
      setStatus(null);
      void w.refresh();
      onClosed();
    } catch (e: any) {
      if (e instanceof PriceMovedError) setMoved(e);
      setStatus(e instanceof PriceMovedError ? null : `Failed: ${e?.message ?? e}`);
    } finally {
      setBusy(false);
    }
  }

  const signed = quote ? (quote.profit ? quote.pnl : -quote.pnl) : 0n;
  return (
    <tr>
      <td className={o.isLong ? "long" : "short"}>{o.isLong ? "Long" : "Short"}</td>
      <td>{fmt6(BigInt(o.size))}</td>
      <td>{fmt6(BigInt(o.collateral))}</td>
      <td>
        ${fmt6(BigInt(o.entryPrice))}
        {ledger?.maintenanceBps !== undefined && (
          <div>
            <small className="muted" title="Below this price (above, for a short) the keeper may liquidate the position">
              liq. ≈ ${fmt6(liquidationPrice(liquidationView(o), ledger, circuitNow()))}
            </small>
          </div>
        )}
      </td>
      <td className={signed >= 0n ? "good" : "bad"}>
        {quote ? `${signed >= 0n ? "+" : ""}${fmt6(signed)}` : "…"}
        {quote?.capped && <small> capped</small>}
      </td>
      <td>{quote ? fmt6(quote.closeFee + quote.borrowFee, 4) : "…"}</td>
      <td>
        <b>{quote ? fmt6(quote.settled.toTrader) : "…"}</b>
      </td>
      <td>
        {w.api ? (
          <button disabled={busy || !ledger} onClick={() => close(ledger.markPrice)}>
            {busy ? "Closing…" : "Close"}
          </button>
        ) : (
          <small className="muted">connect to close</small>
        )}
        {status && <div className={status.startsWith("Failed") ? "bad" : "muted"}>{status}</div>}
        {moved && (
          <div className="warn">
            Price moved to ${fmt6(moved.now)}. <button onClick={() => close(moved.now)}>Close at ${fmt6(moved.now)}</button>
          </div>
        )}
      </td>
    </tr>
  );
}

/** A finished position: how it ended and what it returned on the coin posted. */
function HistoryRow({ record }: { record: PositionRecord }) {
  const o = record.opening;
  const c = record.closing;
  // The coin posted at open: collateral plus the opening fee.
  const posted = BigInt(o.collateral) + BigInt(o.openFee);
  const pnl = c ? BigInt(c.pnl) : 0n;
  const net = c ? BigInt(c.received) - posted : 0n;
  const approx = c && !c.exact ? "≈ " : "";
  const signed = (v: bigint) => `${v >= 0n ? "+" : "−"}${fmt6(v >= 0n ? v : -v)}`;
  const outcome =
    record.status !== "closed" ? record.status : !c ? "closed" : c.by === "liquidation" ? "liquidated" : "closed by you";
  return (
    <tr>
      <td>{new Date(record.createdAt).toLocaleString()}</td>
      <td className={o.isLong ? "long" : "short"}>{o.isLong ? "Long" : "Short"}</td>
      <td>{fmt6(BigInt(o.size))}</td>
      <td>${fmt6(BigInt(o.entryPrice))}</td>
      <td>{c ? `$${fmt6(BigInt(c.exitPrice))}` : record.status === "closed" ? "…" : ""}</td>
      <td className={c ? (pnl >= 0n ? "good" : "bad") : ""}>{c ? signed(pnl) : ""}</td>
      <td title="Opening fee + closing, borrow and any liquidation fee">
        {c ? `${approx}${fmt6(BigInt(o.openFee) + BigInt(c.fees), 4)}` : ""}
      </td>
      <td title={c && !c.exact ? "Estimated from the closing block's time; the borrow fee may differ slightly" : undefined}>
        {c ? (
          <b>
            {approx}
            {fmt6(BigInt(c.received))}
          </b>
        ) : (
          ""
        )}
      </td>
      <td className={c ? (net >= 0n ? "good" : "bad") : ""} title={`On the ${fmt6(posted)} pUSDC posted, fees included`}>
        {c ? `${net >= 0n ? "+" : "−"}${(Number((net >= 0n ? net : -net) * 10_000n / posted) / 100).toFixed(2)}%` : ""}
      </td>
      <td className={c?.by === "liquidation" ? "bad" : ""}>{outcome}</td>
    </tr>
  );
}

export default function PortfolioPage() {
  const w = useWallet();
  const config = useConfig();
  const { ledger } = useLedger();
  const [records, setRecords] = useState<PositionRecord[]>([]);
  const key = usePositionKey();
  const [syncError, setSyncError] = useState<string | null>(null);
  const reload = useCallback(() => void allPositions().then(setRecords), []);
  useEffect(reload, [reload]);

  // On every ledger poll: find this key's positions from their notes, and mark
  // closed what was closed elsewhere. Notes already tried are skipped.
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
  const open = mine.filter((r) => r.status === "open");
  const history = mine.filter((r) => r.status !== "open").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const pending = mine.filter((r) => r.status === "pending");

  return (
    <>
      <h1>Portfolio</h1>
      {!w.api && <NeedsWallet what="close positions" />}
      <PositionKeyPanel />
      {syncError && <div className="banner bad">Could not read your positions from the chain: {syncError}</div>}
      {pending.length > 0 && (
        <div className="banner warn">
          {pending.length} position(s) are pending: their open may or may not have landed. They are kept, with everything
          needed to close them.
        </div>
      )}
      <section className="card">
        <h2>Open positions</h2>
        {open.length === 0 ? (
          <p className="muted">
            {key ? "No open positions." : "No open positions in this browser. Unlock your position key to find positions opened elsewhere."}
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th></th>
                <th>Size</th>
                <th>Collateral</th>
                <th>Entry</th>
                <th>PnL now</th>
                <th>Fees to close</th>
                <th>You receive</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {open.map((r) => (
                <OpenRow key={r.commitment} record={r} ledger={ledger} onClosed={reload} />
              ))}
            </tbody>
          </table>
        )}
      </section>
      {history.length > 0 && (
        <section className="card">
          <h2>History</h2>
          <table>
            <thead>
              <tr>
                <th>Opened</th>
                <th></th>
                <th>Size</th>
                <th>Entry</th>
                <th>Exit</th>
                <th>PnL</th>
                <th>Fees</th>
                <th>Received</th>
                <th>Return</th>
                <th>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {history.map((r) => (
                <HistoryRow key={r.commitment} record={r} />
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}
