// SPDX-License-Identifier: Apache-2.0

import { bech32m } from "@scure/base";

export const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export function bytes(h: string): Uint8Array {
  const clean = h.replace(/^0x/, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export const random32 = () => crypto.getRandomValues(new Uint8Array(32));

/**
 * A key from the wallet, Bech32m (`mn_shield-cpk_…`) as the connector hands it
 * out, or hex — as the 32 raw bytes a circuit argument needs.
 */
export function keyBytes(key: string): Uint8Array {
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(key)) return bytes(key);
  const { words } = bech32m.decode(key as `${string}1${string}`, 1023);
  return Uint8Array.from(bech32m.fromWords(words));
}

/** pUSDC and prices: 6 decimals. */
export function fmt6(minor: bigint, decimals = 2): string {
  const sign = minor < 0n ? "-" : "";
  const m = minor < 0n ? -minor : minor;
  const whole = (m / 1_000_000n).toLocaleString("en-US");
  const frac = (m % 1_000_000n).toString().padStart(6, "0").slice(0, decimals);
  return decimals > 0 ? `${sign}${whole}.${frac}` : `${sign}${whole}`;
}

/** "1,234.56" → 1234560000n; undefined if not a number. */
export function parse6(text: string): bigint | undefined {
  const t = text.replace(/,/g, "").trim();
  if (!/^\d+(\.\d{0,6})?$/.test(t)) return undefined;
  const [w, f = ""] = t.split(".");
  return BigInt(w) * 1_000_000n + BigInt(f.padEnd(6, "0"));
}
