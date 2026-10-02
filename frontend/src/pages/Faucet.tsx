// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { fmt6, parse6 } from "../lib/bytes";
import { useConfig } from "../lib/hooks";
import { mintPusdc } from "../lib/trading";
import { balanceOf, useWallet } from "../lib/wallet";
import { NeedsWallet } from "../components/WalletButton";

export default function FaucetPage() {
  const w = useWallet();
  const config = useConfig();
  const [amount, setAmount] = useState("10000");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const value = parse6(amount);
  const pusdc = config ? balanceOf(w.shieldedBalances, config.usdcToken) : 0n;

  async function mint() {
    if (!value) return;
    setBusy(true);
    try {
      setStatus("Minting: proving…");
      const txHash = await mintPusdc(await w.contract("pusdc"), value);
      setStatus(`Minted ${fmt6(value)} pUSDC (${txHash.slice(0, 12)}…). It shows in your wallet in a few seconds.`);
      void w.refresh();
    } catch (e: any) {
      setStatus(`Mint failed: ${e?.message ?? e}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Faucet</h1>
      <p className="lead">
        pUSDC is a <b>mock</b> stablecoin: anyone can mint any amount. It is shielded, so your balance is private.
      </p>
      <section className="card">
        {!w.api ? (
          <NeedsWallet what="mint pUSDC" />
        ) : (
          <>
            <p>
              Your wallet holds <b>{fmt6(pusdc)} pUSDC</b>
              {w.dust !== null && <> and has DUST for fees{w.dust === 0n && <b className="bad"> — none yet</b>}</>}.
            </p>
            <div className="row">
              <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
              <button className="primary" disabled={busy || !value} onClick={mint}>
                Mint pUSDC
              </button>
            </div>
          </>
        )}
        {status && <p className={/failed/.test(status) ? "bad" : "muted"}>{status}</p>}
        <p className="muted">
          Fees are paid in DUST, which your wallet generates from NIGHT. On the local devnet, fund the wallet from the dev
          wallet; on preview, use the official faucet and register your NIGHT for DUST in the wallet.
        </p>
      </section>
    </>
  );
}
