// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { createPasskey, lockPositionKey, passkeysSupported, unlockWithPasskey, usePositionKey } from "../lib/positionKey";

/**
 * Unlocks the position key with the trader's passkey, or creates the passkey
 * the first time. Opening needs the key; so does finding positions opened on
 * another device.
 */
export function PositionKeyPanel({ compact = false }: { compact?: boolean }) {
  const key = usePositionKey();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setCreating(false);
    } catch (e: any) {
      // The browser's own dialog was dismissed: nothing to explain.
      if (e?.name === "NotAllowedError") setError("The passkey request was cancelled or timed out.");
      else setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  if (key) {
    return compact ? null : (
      <div className="banner ok row">
        <span style={{ flex: 1 }}>Position key unlocked. Positions opened with it are found on any device with this passkey.</span>
        <button className="ghost" onClick={lockPositionKey}>
          Lock
        </button>
      </div>
    );
  }

  if (!passkeysSupported()) {
    return <div className="banner bad">This browser does not support passkeys, which zkperp uses to keep your positions.</div>;
  }

  return (
    <section className="card">
      <h2>Your position key</h2>
      <p className="muted">
        Each position is stored on chain encrypted to a key from your passkey. With the passkey and your wallet you can see and
        close your positions on any device. Your wallet pays and receives; the passkey only unlocks the records.
      </p>
      <div className="row">
        <button className="primary" disabled={busy} onClick={() => run(() => unlockWithPasskey())}>
          {busy && !creating ? "Waiting for passkey…" : "Unlock with passkey"}
        </button>
        {!creating && (
          <button className="ghost" disabled={busy} onClick={() => setCreating(true)}>
            First time? Create a passkey
          </button>
        )}
      </div>
      {creating && (
        <div className="warn">
          Create a passkey <b>only once</b>. A second passkey is a second key, and positions opened with one are not found with
          the other. Save it to a synced manager (Google Password Manager, iCloud Keychain) or your phone to use it on other
          devices.{" "}
          <button disabled={busy} onClick={() => run(createPasskey)}>
            {busy ? "Waiting for passkey…" : "Create passkey"}
          </button>{" "}
          <button className="ghost" disabled={busy} onClick={() => setCreating(false)}>
            Cancel
          </button>
        </div>
      )}
      {error && <p className="bad">{error}</p>}
    </section>
  );
}
