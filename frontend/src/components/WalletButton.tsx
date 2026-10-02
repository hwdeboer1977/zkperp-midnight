// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useWallet } from "../lib/wallet";

export function WalletButton() {
  const w = useWallet();
  const [open, setOpen] = useState(false);

  if (w.api) {
    return (
      <div className="wallet">
        <span className="pill ok" title={w.canProve ? "proves in this tab" : "proves on a local proof server"}>
          {w.name} {w.canProve ? "· proves in-tab" : "· local prover"}
        </span>
        <button className="ghost" onClick={w.disconnect}>
          Disconnect
        </button>
      </div>
    );
  }
  return (
    <div className="wallet">
      <button onClick={() => setOpen(!open)} disabled={w.connecting}>
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
    <div className="card muted">
      Connect a wallet to {what}. 1AM proves in this tab, so your position never leaves the browser; Lace needs a proof
      server on this machine.
    </div>
  );
}
