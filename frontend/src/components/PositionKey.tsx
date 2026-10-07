// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { generatePassphrase, passwordProblem } from "@core/password";
import { hex } from "../lib/bytes";
import {
  forgetRememberedRoot,
  hasRememberedRoot,
  lockPositionKey,
  passkeysSupported,
  rememberWithPasskey,
  unlockWithPasskey,
  unlockWithPassword,
  usePositionKey,
} from "../lib/positionKey";
import { useWallet } from "../lib/wallet";

const short = (h: string) => `${h.slice(0, 8)}…${h.slice(-6)}`;

/**
 * Unlocks the position key with the trader's password (or a passkey that
 * remembers it on this device). Opening needs the key; so does finding
 * positions opened on another computer.
 */
export function PositionKeyPanel({ compact = false }: { compact?: boolean }) {
  const w = useWallet();
  const key = usePositionKey();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [generated, setGenerated] = useState<string | null>(null);
  const [savedIt, setSavedIt] = useState(false);
  const [, rerender] = useState(0);

  if (!w.coinPublicKey) return null;
  const account = w.coinPublicKey;
  const remembered = hasRememberedRoot(account);

  async function run(label: string, action: () => Promise<unknown>) {
    setBusy(label);
    setError(null);
    try {
      await action();
      setPassword("");
      setGenerated(null);
      setSavedIt(false);
    } catch (e: any) {
      // The browser's own passkey dialog was dismissed: nothing to explain.
      if (e?.name === "NotAllowedError") setError("The passkey request was cancelled or timed out.");
      else setError(e?.message ?? String(e));
    } finally {
      setBusy(null);
      rerender((n) => n + 1);
    }
  }

  if (key) {
    return compact ? null : (
      <div className="banner ok row" style={{ flexWrap: "wrap" }}>
        <span style={{ flex: 1 }}>
          Position key unlocked for wallet account <code>{short(hex(account))}</code>. Positions opened with it can be closed
          from any computer with this wallet and your password.
        </span>
        {passkeysSupported() &&
          (remembered ? (
            <button
              className="ghost"
              title="Removes the passkey shortcut from this browser. Your password keeps working everywhere."
              onClick={() => (forgetRememberedRoot(account), rerender((n) => n + 1))}
            >
              Forget passkey on this device
            </button>
          ) : (
            <button
              className="ghost"
              title="Next time in this browser, unlock with your fingerprint, face or PIN instead of typing the password."
              disabled={!!busy}
              onClick={() => run("passkey", () => rememberWithPasskey(account))}
            >
              {busy === "passkey" ? "Waiting for passkey…" : "Remember on this device with a passkey"}
            </button>
          ))}
        <button
          className="ghost"
          title="Forgets the key in this tab now. Your positions stay safe on chain; unlock again with your password."
          onClick={lockPositionKey}
        >
          Lock
        </button>
        <small className="muted" style={{ flexBasis: "100%" }}>
          {passkeysSupported() &&
            (remembered
              ? "Forget passkey: this browser no longer unlocks with your fingerprint or PIN; the password still works everywhere. "
              : "Remember with a passkey: next time in this browser, unlock with your fingerprint, face or PIN instead of typing the password; on other computers you still use the password. ")}
          Lock: forget the key in this tab now, for example on a shared computer. Your positions stay on chain; closing or
          reloading the tab locks it too.
        </small>
        {error && <p className="bad">{error}</p>}
      </div>
    );
  }

  const problem = password ? passwordProblem(password) : null;

  return (
    <section className="card">
      <h2>Your position key</h2>
      <p className="muted">
        Each position is stored on chain, encrypted to a key from your <b>password</b> and this wallet account (
        <code>{short(hex(account))}</code>). With both you can see and close your positions on any computer. Your wallet pays
        and receives; the password only unlocks the records, and a close always pays the wallet that opened the position.
      </p>

      {remembered && passkeysSupported() && (
        <div className="row">
          <button className="primary" disabled={!!busy} onClick={() => run("passkey", () => unlockWithPasskey(account))}>
            {busy === "passkey" ? "Waiting for passkey…" : "Unlock with passkey"}
          </button>
          <span className="muted">or use your password below.</span>
        </div>
      )}

      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (password && !problem) void run("password", () => unlockWithPassword(password, account));
        }}
      >
        <input
          type="password"
          autoComplete="current-password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={{ flex: 1 }}
        />
        <button className={remembered ? "" : "primary"} disabled={!!busy || !password || !!problem}>
          {busy === "password" ? "Deriving key…" : "Unlock"}
        </button>
      </form>
      {problem && <p className="muted">{problem}</p>}

      {!generated ? (
        <p>
          <button className="ghost" disabled={!!busy} onClick={() => setGenerated(generatePassphrase())}>
            First time? Generate a password
          </button>
        </p>
      ) : (
        <div className="warn">
          <p>
            Your new password, six random words: <code style={{ fontSize: "1.1em" }}>{generated}</code>{" "}
            <button className="ghost" onClick={() => void navigator.clipboard?.writeText(generated)}>
              Copy
            </button>
          </p>
          <p>
            Write it down or put it in your password manager. <b>It cannot be reset or changed</b> for positions you open with
            it: without it, those positions cannot be closed. It is not a wallet recovery phrase; never enter it anywhere but
            here.
          </p>
          <label className="check">
            <input type="checkbox" checked={savedIt} onChange={(e) => setSavedIt(e.target.checked)} /> I have saved this
            password
          </label>
          <button disabled={!savedIt || !!busy} onClick={() => run("password", () => unlockWithPassword(generated, account))}>
            {busy === "password" ? "Deriving key…" : "Use this password"}
          </button>{" "}
          <button className="ghost" disabled={!!busy} onClick={() => setGenerated(null)}>
            Cancel
          </button>
        </div>
      )}
      <p className="muted">
        A wrong password does not fail: it unlocks a different, empty key. If your positions do not appear, check the password
        and that this is the wallet account you opened them with.
      </p>
      {error && <p className="bad">{error}</p>}
    </section>
  );
}
