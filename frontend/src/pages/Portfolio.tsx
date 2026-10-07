// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState } from "react";
import { fmt6 } from "../lib/bytes";
import { contractModule } from "../lib/contracts";
import { useConfig, useLedger, useNow } from "../lib/hooks";
import { allPositions, backupFile, restoreBackup, type PositionRecord } from "../lib/positions";
import { usePositionKey } from "../lib/positionKey";
import { recoverPositions, settleClosed } from "../lib/recover";
import { PriceMovedError, closePosition, quoteClose } from "../lib/trading";
import { useWallet } from "../lib/wallet";
import { PositionKeyPanel } from "../components/PositionKey";
import { NeedsWallet } from "../components/WalletButton";

type Quote = Awaited<ReturnType<typeof quoteClose>>;

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
      setStatus(w.canProve ? "Proving in your wallet…" : "Proving on the local proof server…");
      await closePosition(perp, record, w.coinPublicKey, expected);
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
      <td>${fmt6(BigInt(o.entryPrice))}</td>
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

function Backup() {
  const [pass, setPass] = useState("");
  const [restorePass, setRestorePass] = useState("");
  const [note, setNote] = useState<string | null>(null);

  async function download() {
    if (pass.length < 8) return setNote("Use a passphrase of at least 8 characters.");
    const url = URL.createObjectURL(await backupFile(pass));
    const a = document.createElement("a");
    a.href = url;
    a.download = `zkperp-positions-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setNote("Backup downloaded. Keep the file and the passphrase apart.");
  }

  async function restore(file: File) {
    try {
      const n = await restoreBackup(await file.text(), restorePass);
      setNote(`Restored: ${n} record(s) added or updated.`);
    } catch (e: any) {
      setNote(`Restore failed: ${e?.message ?? e}`);
    }
  }

  return (
    <section className="card">
      <h2>Backup</h2>
      <p className="muted">
        Positions opened with your passkey are recovered from the chain. Positions opened without one (by the CLI, or before
        passkeys) exist only in this browser: clear the site data and their collateral is stuck. The backup holds every
        record here, encrypted with your passphrase.
      </p>
      <div className="row">
        <input type="password" placeholder="passphrase" value={pass} onChange={(e) => setPass(e.target.value)} />
        <button onClick={download}>Download backup</button>
      </div>
      <div className="row">
        <input type="password" placeholder="passphrase of the backup" value={restorePass} onChange={(e) => setRestorePass(e.target.value)} />
        <label className="file">
          Restore from file…
          <input type="file" accept="application/json" onChange={(e) => e.target.files?.[0] && restore(e.target.files[0])} />
        </label>
      </div>
      {note && <p className="muted">{note}</p>}
    </section>
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
      if (key) changed += await recoverPositions(module, ledger, key, address, config.network.networkId);
      if (live && changed > 0) reload();
    })().then(
      () => live && setSyncError(null),
      (e) => live && setSyncError(String(e?.message ?? e))
    );
    return () => {
      live = false;
    };
  }, [ledger, config, key, reload]);

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
            {key ? "No open positions." : "No open positions in this browser. Unlock your passkey to find positions opened elsewhere."}
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
      <Backup />
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
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {history.map((r) => (
                <tr key={r.commitment}>
                  <td>{new Date(r.createdAt).toLocaleString()}</td>
                  <td className={r.opening.isLong ? "long" : "short"}>{r.opening.isLong ? "Long" : "Short"}</td>
                  <td>{fmt6(BigInt(r.opening.size))}</td>
                  <td>${fmt6(BigInt(r.opening.entryPrice))}</td>
                  <td>{r.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}
