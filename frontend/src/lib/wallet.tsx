// SPDX-License-Identifier: Apache-2.0

/**
 * The connected wallet, through the DApp Connector API.
 *
 * Wallets inject themselves under their own key in `window.midnight`, and
 * sometimes late, so detection polls for a few seconds. The network is the
 * deployment's (config.json), never a choice in the UI: a wallet on another
 * network is told to switch rather than silently talking to the wrong chain.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ConnectedAPI, InitialAPI } from "@midnight-ntwrk/dapp-connector-api";
import { loadConfig } from "./config";
import { keyBytes } from "./bytes";
import { connectContract, walletCanProve, type ContractHandle } from "./providers";

export interface Detected {
  key: string;
  api: InitialAPI;
}

interface WalletState {
  detected: Detected[];
  api: ConnectedAPI | null;
  name: string | null;
  canProve: boolean;
  coinPublicKey: Uint8Array | null;
  shieldedBalances: Record<string, bigint>;
  dust: bigint | null;
  connecting: boolean;
  error: string | null;
  connect: (d: Detected) => Promise<void>;
  disconnect: () => void;
  refresh: () => Promise<void>;
  /** A contract callable through this wallet; built once per connection. */
  contract: (name: "zkperp" | "pusdc") => Promise<ContractHandle>;
}

const Ctx = createContext<WalletState | null>(null);

function installed(): Detected[] {
  return Object.entries(window.midnight ?? {})
    .filter(([, api]) => api && typeof (api as InitialAPI).connect === "function")
    .map(([key, api]) => ({ key, api: api as InitialAPI }));
}

/** A shielded balance by token type, whatever key format the wallet uses. */
export function balanceOf(balances: Record<string, bigint>, tokenHex: string): bigint {
  const t = tokenHex.toLowerCase();
  for (const [k, v] of Object.entries(balances)) {
    if (k.toLowerCase().replace(/^0x/, "").endsWith(t)) return BigInt(v);
  }
  return 0n;
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [detected, setDetected] = useState<Detected[]>([]);
  const [api, setApi] = useState<ConnectedAPI | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [coinPublicKey, setCoinPublicKey] = useState<Uint8Array | null>(null);
  const [shieldedBalances, setShielded] = useState<Record<string, bigint>>({});
  const [dust, setDust] = useState<bigint | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [handles] = useState(() => new Map<string, Promise<ContractHandle>>());

  useEffect(() => {
    let tries = 0;
    const scan = () => setDetected(installed());
    scan();
    const timer = setInterval(() => {
      scan();
      if (++tries >= 10) clearInterval(timer);
    }, 500);
    return () => clearInterval(timer);
  }, []);

  const refresh = useCallback(async () => {
    if (!api) return;
    const [s, d] = await Promise.all([api.getShieldedBalances(), api.getDustBalance().catch(() => null)]);
    setShielded(s as Record<string, bigint>);
    setDust(d ? BigInt((d as any).balance) : null);
  }, [api]);

  useEffect(() => {
    if (!api) return;
    void refresh();
    const timer = setInterval(() => void refresh().catch(() => {}), 10_000);
    return () => clearInterval(timer);
  }, [api, refresh]);

  const connect = useCallback(
    async (d: Detected) => {
      setConnecting(true);
      setError(null);
      try {
        const config = await loadConfig();
        const connected = await d.api.connect(config.network.networkId);
        const wallet = await connected.getConfiguration();
        if (wallet.networkId !== config.network.networkId) {
          throw new Error(`The wallet is on "${wallet.networkId}"; this deployment runs on "${config.network.networkId}".`);
        }
        const shielded = await connected.getShieldedAddresses();
        handles.clear();
        setCoinPublicKey(keyBytes(shielded.shieldedCoinPublicKey));
        setApi(connected);
        setName(d.api.name ?? d.key);
      } catch (cause: any) {
        const reason = cause?.reason ?? cause?.message ?? String(cause);
        setError(
          cause?.code === "PermissionRejected"
            ? "The wallet declined the connection."
            : `Could not connect: ${reason}. Is the wallet set to the "${(await loadConfig()).network.networkId}" network?`
        );
      } finally {
        setConnecting(false);
      }
    },
    [handles]
  );

  const disconnect = useCallback(() => {
    setApi(null);
    setName(null);
    setCoinPublicKey(null);
    setShielded({});
    setDust(null);
    handles.clear();
  }, [handles]);

  const contract = useCallback(
    (which: "zkperp" | "pusdc") => {
      if (!api) return Promise.reject(new Error("Connect a wallet first."));
      if (!handles.has(which)) {
        const p = connectContract(api, which);
        p.catch(() => handles.delete(which));
        handles.set(which, p);
      }
      return handles.get(which)!;
    },
    [api, handles]
  );

  const value = useMemo<WalletState>(
    () => ({
      detected,
      api,
      name,
      canProve: api ? walletCanProve(api) : false,
      coinPublicKey,
      shieldedBalances,
      dust,
      connecting,
      error,
      connect,
      disconnect,
      refresh,
      contract,
    }),
    [detected, api, name, coinPublicKey, shieldedBalances, dust, connecting, error, connect, disconnect, refresh, contract]
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet(): WalletState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWallet outside WalletProvider");
  return v;
}
