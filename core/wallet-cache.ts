// Adapted from midnight-polisZK (Copyright 2026 Henk Wim de Boer)
// SPDX-License-Identifier: Apache-2.0

import fs from "fs";
import path from "path";
import { createHash } from "crypto";
function dataPath(...parts: string[]): string {
  const target = path.join(process.cwd(), ...parts);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  return target;
}

/**
 * Cached wallet sync state.
 *
 * A first sync on a remote network replays the whole chain — on preview that is
 * ~115k indices for the shielded and dust wallets and takes many minutes. The
 * SDK can serialize each wallet's state and resume from it, so subsequent runs
 * only fetch the delta. Without this, every command (deploy, then assign, then
 * set payroll) pays the full sync again.
 *
 * The file holds sync state, not keys, but it still describes a specific
 * wallet's coins — so it is written 0600 and gitignored.
 */
const DIR = ".wallet-state";

/** Bumped when the shape below changes, so old files are ignored not misread. */
const VERSION = 1;

export interface CachedWalletState {
  version: number;
  networkId: string;
  fingerprint: string;
  savedAt: string;
  shielded: string;
  unshielded: string;
  dust: string;
}

/**
 * Identifies the wallet without storing anything that could reconstruct it:
 * a hash over the master seed and network, never the seed.
 */
function fingerprint(masterSeedHex: string, networkId: string): string {
  return createHash("sha256")
    .update(`midnight-wallet-state:${networkId}:${masterSeedHex}`)
    .digest("hex")
    .slice(0, 16);
}

function filePath(masterSeedHex: string, networkId: string): string {
  return dataPath(DIR, `${networkId}-${fingerprint(masterSeedHex, networkId)}.json`);
}

export function loadWalletState(
  masterSeedHex: string,
  networkId: string
): CachedWalletState | null {
  const file = filePath(masterSeedHex, networkId);
  if (!fs.existsSync(file)) return null;

  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as CachedWalletState;
    // A state from another wallet, network, or format is not an error — it just
    // means there is nothing to resume from, so sync from scratch instead.
    if (
      parsed.version !== VERSION ||
      parsed.networkId !== networkId ||
      parsed.fingerprint !== fingerprint(masterSeedHex, networkId) ||
      typeof parsed.shielded !== "string" ||
      typeof parsed.unshielded !== "string" ||
      typeof parsed.dust !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function saveWalletState(
  masterSeedHex: string,
  networkId: string,
  sections: { shielded: string; unshielded: string; dust: string }
): void {
  const file = filePath(masterSeedHex, networkId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload: CachedWalletState = {
    version: VERSION,
    networkId,
    fingerprint: fingerprint(masterSeedHex, networkId),
    savedAt: new Date().toISOString(),
    ...sections,
  };
  fs.writeFileSync(file, JSON.stringify(payload), { mode: 0o600 });
}

export function walletStateAge(
  masterSeedHex: string,
  networkId: string
): string | null {
  const cached = loadWalletState(masterSeedHex, networkId);
  return cached ? cached.savedAt : null;
}
