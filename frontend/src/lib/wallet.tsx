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
import { connectContract, proverRoute, type ContractHandle, type ProverRoute } from "./providers";

export interface Detected {
  key: string;
  api: InitialAPI;
}

interface WalletState {
  detected: Detected[];
  api: ConnectedAPI | null;
  name: string | null;
  /** Whether the wallet proves the contract calls (only when this app's proof server is down). */
  walletProves: boolean;
  /**
   * The proof server that will see each trade's private inputs: this app's
   * local one when it answers, else the one in the wallet's settings (1AM).
   * Null until connected; "unknown" if the wallet does not say.
   */
  prover: string | null;
  /** Whether `prover` is on this machine. A remote one sees every position. */
  proverIsLocal: boolean;
  coinPublicKey: Uint8Array | null;
  shieldedBalances: Record<string, bigint>;
  dust: bigint | null;
  connecting: boolean;
  error: string | null;
  connect: (d: Detected) => Promise<void>;
  disconnect: () => void;
  refresh: () => Promise<void>;
  /** Looks for this app's proof server again (after starting it), without reconnecting. True if it now proves. */
  recheckProver: () => Promise<boolean>;
  /** A contract callable through this wallet; built once per connection. */
  contract: (name: "zkperp" | "pusdc") => Promise<ContractHandle>;
}

const Ctx = createContext<WalletState | null>(null);

/** Whether `url` points at this machine. */
export function isLocalUrl(url: string | null): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");
  } catch {
    return false;
  }
}

/** A prover URL shortened for display: its host and port. */
export function proverLabel(url: string | null): string {
  if (!url) return "no prover";
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

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
  const [route, setRoute] = useState<ProverRoute | null>(null);
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
        // 1AM refuses the first request after it has been idle ("InternalError:
        // Request failed") and accepts the next: retry once.
        const connected = await d.api.connect(config.network.networkId).catch(async (first: any) => {
          if (first?.code !== "InternalError") throw first;
          await new Promise((r) => setTimeout(r, 1000));
          return d.api.connect(config.network.networkId);
        });
        const wallet = await connected.getConfiguration();
        if (wallet.networkId !== config.network.networkId) {
          throw new Error(`The wallet is on "${wallet.networkId}"; this deployment runs on "${config.network.networkId}".`);
        }
        const shielded = await connected.getShieldedAddresses();
        setRoute(await proverRoute(connected));
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
    setRoute(null);
    setShielded({});
    setDust(null);
    handles.clear();
  }, [handles]);

  const recheckProver = useCallback(async () => {
    if (!api) return false;
    const next = await proverRoute(api);
    handles.clear();
    setRoute(next);
    return !next.walletProves;
  }, [api, handles]);

  const contract = useCallback(
    (which: "zkperp" | "pusdc") => {
      if (!api || !route) return Promise.reject(new Error("Connect a wallet first."));
      if (!handles.has(which)) {
        const p = connectContract(api, which, route);
        p.catch(() => handles.delete(which));
        handles.set(which, p);
      }
      return handles.get(which)!;
    },
    [api, route, handles]
  );

  const value = useMemo<WalletState>(
    () => ({
      detected,
      api,
      name,
      walletProves: api ? (route?.walletProves ?? false) : false,
      prover: api ? (route?.url ?? null) : null,
      proverIsLocal: isLocalUrl(route?.url ?? null),
      coinPublicKey,
      shieldedBalances,
      dust,
      connecting,
      error,
      connect,
      disconnect,
      refresh,
      recheckProver,
      contract,
    }),
    [detected, api, name, route, coinPublicKey, shieldedBalances, dust, connecting, error, connect, disconnect, refresh, recheckProver, contract]
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet(): WalletState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWallet outside WalletProvider");
  return v;
}
