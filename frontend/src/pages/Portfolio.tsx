// SPDX-License-Identifier: Apache-2.0

import { Fragment, useEffect, useState } from "react";
import { fmt6 } from "../lib/bytes";
import { contractModule } from "../lib/contracts";
import { useLedger, useNow } from "../lib/hooks";
import { backupFile, type PositionRecord } from "../lib/positions";
import { usePositionKey } from "../lib/positionKey";
import { usePositions } from "../lib/usePositions";
import { circuitNow, liquidationPrice, positionPnl } from "@core/math";
import { PriceMovedError, closePosition, quoteClose } from "../lib/trading";
import { proverLabel, useWallet } from "../lib/wallet";
import { PositionKeyPanel } from "../components/PositionKey";
import { NeedsWallet } from "../components/WalletButton";
import { Stat } from "../components/Market";

type Quote = Awaited<ReturnType<typeof quoteClose>>;

const liquidationView = (o: PositionRecord["opening"]) => ({
  isLong: o.isLong,
  size: BigInt(o.size),
  collateral: BigInt(o.collateral),
  entryPrice: BigInt(o.entryPrice),
  openTime: BigInt(o.openTime),
});

const signed = (v: bigint, decimals = 2) => `${v >= 0n ? "+" : "−"}${fmt6(v >= 0n ? v : -v, decimals)}`;
/** The coin posted at open: collateral plus the opening fee. */
const postedOf = (r: PositionRecord) => BigInt(r.opening.collateral) + BigInt(r.opening.openFee);
const pct = (num: bigint, den: bigint) => (den === 0n ? 0 : Number((num * 10_000n) / den) / 100);
const leverageOf = (o: PositionRecord["opening"]) => Number((BigInt(o.size) * 10n) / BigInt(o.collateral)) / 10;

/** A live close quote for `record`, and the close action with its states. */
function useClose(record: PositionRecord, ledger: any, onClosed: () => void) {
  const w = useWallet();
  const now = useNow(10_000);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [moved, setMoved] = useState<PriceMovedError | null>(null);

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

  const pnl = quote ? (quote.profit ? quote.pnl : -quote.pnl) : null;
  const liq = ledger?.maintenanceBps !== undefined ? liquidationPrice(liquidationView(record.opening), ledger, circuitNow()) : null;
  return { w, quote, pnl, liq, busy, status, moved, close };
}

function CloseControls({ c, ledger, label = "Close" }: { c: ReturnType<typeof useClose>; ledger: any; label?: string }) {
  return (
    <>
      {c.w.api ? (
        <button className="small" disabled={c.busy || !ledger} onClick={() => c.close(ledger.markPrice)}>
          {c.busy ? "Closing…" : label}
        </button>
      ) : (
        <small className="muted">connect to close</small>
      )}
      {c.status && <div className={c.status.startsWith("Failed") ? "bad" : "muted"}>{c.status}</div>}
      {c.moved && (
        <div className="warn">
          Price moved to ${fmt6(c.moved.now)}. <button onClick={() => c.close(c.moved!.now)}>Close at ${fmt6(c.moved.now)}</button>
        </div>
      )}
    </>
  );
}

/** An open position as a table row (the Trade page's compact list). */
export function OpenRow({ record, ledger, onClosed }: { record: PositionRecord; ledger: any; onClosed: () => void }) {
  const c = useClose(record, ledger, onClosed);
  const o = record.opening;
  return (
    <tr>
      <td className={`text ${o.isLong ? "long" : "short"}`}>{o.isLong ? "Long" : "Short"}</td>
      <td>{fmt6(BigInt(o.size))}</td>
      <td>{fmt6(BigInt(o.collateral))}</td>
      <td>
        ${fmt6(BigInt(o.entryPrice))}
        {c.liq !== null && (
          <div>
            <small className="muted" title="Below this price (above, for a short) the keeper may liquidate the position">
              liq. ≈ ${fmt6(c.liq)}
            </small>
          </div>
        )}
      </td>
      <td className={c.pnl === null ? "" : c.pnl >= 0n ? "good" : "bad"}>
        {c.pnl === null ? "…" : signed(c.pnl)}
        {c.quote?.capped && <small> capped</small>}
      </td>
      <td>{c.quote ? fmt6(c.quote.closeFee + c.quote.borrowFee, 4) : "…"}</td>
      <td>
        <b>{c.quote ? fmt6(c.quote.settled.toTrader) : "…"}</b>
      </td>
      <td>
        <CloseControls c={c} ledger={ledger} />
      </td>
    </tr>
  );
}

/** An open position as a card: the Portfolio's main view. */
function OpenCard({ record, ledger, onClosed }: { record: PositionRecord; ledger: any; onClosed: () => void }) {
  const c = useClose(record, ledger, onClosed);
  const o = record.opening;
  const net = c.quote ? c.quote.settled.toTrader - postedOf(record) : null;
  const distance = c.liq !== null && ledger ? (Math.abs(Number(ledger.markPrice - c.liq)) / Number(ledger.markPrice)) * 100 : null;
  return (
    <div className={`pos-card ${o.isLong ? "long" : "short"}`}>
      <div className="pos-head">
        <span className="pos-market">ETH-USD</span>
        <span className={`chip plain ${o.isLong ? "good" : "bad"}`}>
          {o.isLong ? "LONG" : "SHORT"} {leverageOf(o)}×
        </span>
        <span className="chip accent">private</span>
        <span className="muted pos-age">opened {new Date(record.createdAt).toLocaleString()}</span>
      </div>
      <div className="pos-grid">
        <div className="kv">
          <span>Size</span>
          <b>{fmt6(BigInt(o.size))}</b>
        </div>
        <div className="kv">
          <span>Collateral</span>
          <b>{fmt6(BigInt(o.collateral))}</b>
        </div>
        <div className="kv">
          <span>Entry</span>
          <b>${fmt6(BigInt(o.entryPrice))}</b>
        </div>
        <div className="kv">
          <span>Mark</span>
          <b>{ledger ? `$${fmt6(ledger.markPrice)}` : "…"}</b>
        </div>
        <div className="kv" title="The keeper may liquidate once equity falls below the maintenance margin">
          <span>Liquidation</span>
          <b className="warn-text">
            {c.liq !== null ? `≈ $${fmt6(c.liq)}` : "…"}
            {distance !== null && <small className="muted"> {distance.toFixed(1)}% away</small>}
          </b>
        </div>
      </div>
      <div className="pos-foot">
        <div className="kv">
          <span>Unrealised PnL</span>
          <b className={`pos-pnl ${c.pnl === null ? "" : c.pnl >= 0n ? "good" : "bad"}`}>
            {c.pnl === null ? "…" : `${signed(c.pnl)} pUSDC`}
            {c.quote?.capped && <small> capped</small>}
          </b>
        </div>
        <div className="kv" title="What a close now pays out, and that less everything posted at open (collateral + opening fee)">
          <span>If closed now</span>
          <b>
            {c.quote ? `${fmt6(c.quote.settled.toTrader)} back` : "…"}
            {net !== null && <small className={net >= 0n ? "good" : "bad"}> · net {signed(net)}</small>}
          </b>
        </div>
        <div className="kv">
          <span>Fees to close</span>
          <b>{c.quote ? fmt6(c.quote.closeFee + c.quote.borrowFee, 4) : "…"}</b>
        </div>
        <div className="pos-action">
          <CloseControls c={c} ledger={ledger} label="Close position" />
        </div>
      </div>
    </div>
  );
}

/** A finished position, with an expandable breakdown of where the money went. */
function HistoryRow({ record }: { record: PositionRecord }) {
  const [open, setOpen] = useState(false);
  const o = record.opening;
  const c = record.closing;
  const posted = postedOf(record);
  const net = c ? BigInt(c.received) - posted : null;
  const approx = c && !c.exact ? "≈ " : "";
  const outcome = record.status !== "closed" ? record.status : !c ? "closed" : c.by === "liquidation" ? "liquidated" : "closed";
  return (
    <Fragment>
      <tr className={c ? "expandable" : ""} onClick={() => c && setOpen(!open)}>
        <td className="text">{new Date(record.createdAt).toLocaleString()}</td>
        <td className={`text ${o.isLong ? "long" : "short"}`}>
          {o.isLong ? "Long" : "Short"} <small className="muted">{leverageOf(o)}×</small>
        </td>
        <td>{fmt6(BigInt(o.size))}</td>
        <td>
          ${fmt6(BigInt(o.entryPrice))}
          <span className="muted"> → </span>
          {c ? `$${fmt6(BigInt(c.exitPrice))}` : record.status === "closed" ? "…" : "—"}
        </td>
        <td className={net === null ? "" : net >= 0n ? "good" : "bad"} title="Paid out at close, less everything posted at open; all fees included">
          {net === null ? "" : `${approx}${signed(net)}`}
        </td>
        <td className={net === null ? "" : net >= 0n ? "good" : "bad"} title={`Net PnL on the ${fmt6(posted)} pUSDC posted`}>
          {net === null ? "" : `${net >= 0n ? "+" : "−"}${pct(net >= 0n ? net : -net, posted).toFixed(2)}%`}
        </td>
        <td>
          <span className={`chip ${c?.by === "liquidation" ? "bad" : record.status === "failed" ? "warn" : c ? "good" : ""}`}>{outcome}</span>
        </td>
        <td className="text muted">{c ? (open ? "▾" : "▸") : ""}</td>
      </tr>
      {open && c && (
        <tr className="details">
          <td colSpan={8}>
            <div className="ledger-lines">
              <dl>
                <dt>Posted at open</dt>
                <dd>{fmt6(posted, 6)}</dd>
                <dt className="sub">collateral</dt>
                <dd>{fmt6(BigInt(o.collateral), 6)}</dd>
                <dt className="sub">opening fee</dt>
                <dd>{fmt6(BigInt(o.openFee), 6)}</dd>
                <dt>Price PnL</dt>
                <dd className={BigInt(c.pnl) >= 0n ? "good" : "bad"}>{signed(BigInt(c.pnl), 6)}</dd>
                <dt>Fees taken at close</dt>
                <dd>
                  {approx}−{fmt6(BigInt(c.fees), 6)}
                </dd>
                {c.closeFee !== undefined && (
                  <>
                    <dt className="sub">closing fee</dt>
                    <dd>{fmt6(BigInt(c.closeFee), 6)}</dd>
                    <dt className="sub">borrow fee</dt>
                    <dd>
                      {approx}
                      {fmt6(BigInt(c.borrowFee ?? "0"), 6)}
                    </dd>
                    {c.by === "liquidation" && (
                      <>
                        <dt className="sub">liquidation fee</dt>
                        <dd>{fmt6(BigInt(c.liquidationFee ?? "0"), 6)}</dd>
                      </>
                    )}
                  </>
                )}
                <dt>Paid out</dt>
                <dd>
                  <b>
                    {approx}
                    {fmt6(BigInt(c.received), 6)}
                  </b>
                </dd>
                <dt>Net PnL</dt>
                <dd className={net! >= 0n ? "good" : "bad"}>
                  <b>
                    {approx}
                    {signed(net!, 6)}
                  </b>
                </dd>
              </dl>
              <dl>
                <dt>Closed</dt>
                <dd className="text">
                  {new Date(Number(c.closeTime) * 1000).toLocaleString()} {c.by === "liquidation" ? "by the keeper" : "by you"}
                </dd>
                <dt>Held</dt>
                <dd>{((Number(c.closeTime) - Number(o.openTime)) / 3600).toFixed(1)} h</dd>
                {record.txHash && (
                  <>
                    <dt>Open tx</dt>
                    <dd title={record.txHash}>{record.txHash.slice(0, 16)}…</dd>
                  </>
                )}
                {record.closeTxHash && (
                  <>
                    <dt>Close tx</dt>
                    <dd title={record.closeTxHash}>{record.closeTxHash.slice(0, 16)}…</dd>
                  </>
                )}
              </dl>
              {!c.exact && (
                <p className="muted">
                  ≈ Rebuilt from the closing transaction: the close time is its block's, so the borrow fee, and with it what
                  was paid out, may differ slightly from the exact amounts.
                </p>
              )}
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  );
}

/** Where a trader's positions live, and how to get them back. */
function StorageCard({ localOnly }: { localOnly: PositionRecord[] }) {
  const [passphrase, setPassphrase] = useState("");
  return (
    <details className="card inspector">
      <summary>
        <h2>Where your positions live</h2>
        <span className="muted">and how to get them back on another computer</span>
      </summary>
      <div className="inspect">
        <div>
          <b>On chain</b>
          <p>A commitment per position, a note encrypted to your position key, and one to the keeper. Your note holds everything needed to close.</p>
        </div>
        <div>
          <b>In this browser</b>
          <p>A cache of the decoded records, owner secrets included, so the page loads fast. "Lock and clear" removes the ones the chain can rebuild.</p>
        </div>
        <div>
          <b>In memory only</b>
          <p>Your position key, derived from your password. Lock, closing the tab or reloading forgets it.</p>
        </div>
        <div>
          <b>On a new computer</b>
          <p>
            Connect the <b>same wallet account</b> and enter your <b>password</b>: open positions and history come back from
            the chain. Without the password they cannot be closed, and it cannot be reset. A passkey is only a shortcut.
          </p>
        </div>
      </div>
      {localOnly.length > 0 && (
        <div className="warn" style={{ marginTop: 12 }}>
          <p style={{ marginTop: 0 }}>
            {localOnly.length} open position record(s) in this browser have no note on chain (opened from the command line,
            or before notes existed). Only this browser can close them: keep an encrypted backup.
          </p>
          <div className="row" style={{ margin: 0 }}>
            <input type="password" placeholder="Backup passphrase (8+ characters)" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
            <button
              disabled={passphrase.length < 8}
              onClick={async () => {
                const url = URL.createObjectURL(await backupFile(passphrase));
                const a = document.createElement("a");
                a.href = url;
                a.download = `zkperp-positions-${new Date().toISOString().slice(0, 10)}.json`;
                a.click();
                URL.revokeObjectURL(url);
              }}
            >
              Download backup
            </button>
          </div>
        </div>
      )}
    </details>
  );
}

export default function PortfolioPage() {
  const w = useWallet();
  const { ledger } = useLedger();
  const key = usePositionKey();
  const { open, history, pending, syncError, reload, localOnly } = usePositions();

  const atRisk = open.reduce((sum, r) => sum + BigInt(r.opening.collateral), 0n);
  const unrealised =
    ledger && open.length > 0
      ? open.reduce((sum, r) => {
          const o = r.opening;
          const pnl = positionPnl(o.isLong, BigInt(o.size), BigInt(o.entryPrice), ledger.markPrice, ledger.maxPayout);
          return sum + (pnl.profit ? pnl.pnl : -pnl.pnl);
        }, 0n)
      : 0n;
  const settled = history.filter((r) => r.closing);
  const realised = settled.reduce((sum, r) => sum + BigInt(r.closing!.received) - postedOf(r), 0n);
  const postedTotal = settled.reduce((sum, r) => sum + postedOf(r), 0n);
  const liquidated = settled.filter((r) => r.closing!.by === "liquidation").length;

  return (
    <>
      <p className="eyebrow">Your positions</p>
      <h1>Portfolio</h1>
      <p className="lead">
        Rebuilt from your encrypted notes on chain with your position key. With this wallet account and your password they
        come back on any computer. The public sees commitments and nullifiers, not these rows.
      </p>
      {(open.length > 0 || settled.length > 0) && (
        <section className="stats">
          <Stat label="Open positions" value={String(open.length)} sub={`${fmt6(atRisk)} pUSDC collateral at risk`} />
          <Stat
            label="Unrealised PnL"
            value={<span className={unrealised >= 0n ? "good" : "bad"}>{signed(unrealised)}</span>}
            unit="pUSDC"
            sub="price move at the mark price, before fees"
          />
          <Stat
            label="Net realised PnL"
            value={<span className={realised >= 0n ? "good" : "bad"}>{signed(realised)}</span>}
            unit="pUSDC"
            sub={`paid out less posted, all fees included · ${pct(realised, postedTotal).toFixed(1)}% on ${fmt6(postedTotal)} posted · ${settled.length} closed${liquidated ? `, ${liquidated} liquidated` : ""}`}
          />
        </section>
      )}
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
        <div className="card-head">
          <h2>Open positions</h2>
          <span className="muted">execution at the on-chain mark price</span>
        </div>
        {open.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            {key ? "No open positions." : "No open positions in this browser. Unlock your position key to find positions opened elsewhere."}
          </p>
        ) : (
          <div className="pos-list">
            {open.map((r) => (
              <OpenCard key={r.commitment} record={r} ledger={ledger} onClosed={reload} />
            ))}
          </div>
        )}
      </section>
      {history.length > 0 && (
        <section className="card">
          <div className="card-head">
            <h2>History</h2>
            <span className="muted">click a row for the breakdown</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Opened</th>
                  <th>Side</th>
                  <th>Size</th>
                  <th>Entry → Exit</th>
                  <th title="Paid out at close, less everything posted at open; all fees included">Net PnL</th>
                  <th title="Net PnL on the collateral and opening fee posted">ROI</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {history.map((r) => (
                  <HistoryRow key={r.commitment} record={r} />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <StorageCard localOnly={localOnly} />
    </>
  );
}
