// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { proverLabel, useWallet } from "../lib/wallet";
import { WhyDocker } from "./ProverSetup";

export function WalletButton() {
  const w = useWallet();
  const [open, setOpen] = useState(false);

  if (w.api) {
    return (
      <div className="wallet">
        <span
          className={`pill ${w.proverIsLocal ? "ok" : "bad"}`}
          title={
            (w.walletProves
              ? "This app's proof server is not answering, so your wallet proves each trade, on the proof server in its settings: "
              : "Each trade is proven on this app's proof server, and your wallet only adds the fees and signs: ") +
            `${w.prover}. Whoever runs it sees the trade's size, direction and collateral.` +
            (w.walletProves ? " Start the local one (Docker) and press Check again on the page." : "")
          }
        >
          {w.name} · prover {proverLabel(w.prover)}
          {!w.proverIsLocal && " — not on this machine, it sees your positions"}
        </span>
        <button className="ghost" onClick={w.disconnect}>
          Disconnect
        </button>
      </div>
    );
  }
  return (
    <div className="wallet">
      <button className="primary" style={{ padding: "8px 16px" }} onClick={() => setOpen(!open)} disabled={w.connecting}>
        {w.connecting ? "Connecting…" : "Connect wallet"}
      </button>
      {open && (
        <div className="menu">
          {w.detected.length === 0 && <p>No Midnight wallet found. Install 1AM (recommended) or Lace.</p>}
          {w.detected.map((d) => (
            <button
              key={d.key}
              onClick={() => {
                setOpen(false);
                void w.connect(d);
              }}
            >
              {d.api.icon && <img src={d.api.icon} alt="" />} {d.api.name ?? d.key}
            </button>
          ))}
        </div>
      )}
      {w.error && <div className="menu error">{w.error}</div>}
    </div>
  );
}

/** Shown in place of a page's actions until a wallet is connected. */
export function NeedsWallet({ what }: { what: string }) {
  return (
    <div className="card flat muted" style={{ lineHeight: 1.6, fontSize: 14 }}>
      Connect a wallet to {what}. Every trade is proven by a proof server, which sees its size, direction and collateral.
      This app uses the one on your machine (Docker) and lets the wallet only add fees and sign; if that one is down,
      1AM proves on the one in its own settings. The wallet button shows which one is in use. <WhyDocker />
    </div>
  );
}
