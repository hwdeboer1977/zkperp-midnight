// SPDX-License-Identifier: Apache-2.0

/**
 * The position key: from the trader's password, optionally remembered on this
 * device with a passkey. See docs/privacy.md.
 *
 * Every position opened here leaves an encrypted note on chain (core/notes.ts).
 * The key that opens those notes must be reproducible on any computer with
 * nothing to carry. The wallet cannot supply it: the DApp connector exposes no
 * seed and no decrypt, and 1AM's `signData` is randomized. So the root comes
 * from a password, salted with the wallet account's coin key
 * (core/password.ts): wallet + password, anywhere.
 *
 * A passkey is only a convenience. Its PRF output (WebAuthn hmac-secret) wraps
 * the password-derived root, and the wrapped root is kept in this browser's
 * storage, so the trader taps instead of typing. Losing the passkey or the
 * storage loses nothing: the password still works.
 *
 * The key is bound to the account it was derived for, and reads as locked
 * while another account is connected. It lives only in this page's memory.
 */

import { useSyncExternalStore } from "react";
import { positionKey, type PositionKey } from "@core/notes";
import { passwordRoot } from "@core/password";
import { bytes, hex } from "./bytes";
import { useWallet } from "./wallet";

interface Unlocked {
  key: PositionKey;
  root: Uint8Array;
  /** hex coin public key the root was derived for. */
  account: string;
}

let current: Unlocked | null = null;
const listeners = new Set<() => void>();

function set(next: Unlocked | null): void {
  current = next;
  listeners.forEach((l) => l());
}

function useUnlocked(): Unlocked | null {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => void listeners.delete(l)),
    () => current
  );
}

/** The position key for the connected account, or null if locked or derived for another account. */
export function usePositionKey(): PositionKey | null {
  const unlocked = useUnlocked();
  const { coinPublicKey } = useWallet();
  if (!unlocked || !coinPublicKey || unlocked.account !== hex(coinPublicKey)) return null;
  return unlocked.key;
}

export const lockPositionKey = () => set(null);

async function unlockWithRoot(root: Uint8Array, coinPublicKey: Uint8Array): Promise<PositionKey> {
  const key = await positionKey(root);
  set({ key, root, account: hex(coinPublicKey) });
  return key;
}

/** Derives the key from `password` for the account with `coinPublicKey`. Takes about a second. */
export async function unlockWithPassword(password: string, coinPublicKey: Uint8Array): Promise<PositionKey> {
  return unlockWithRoot(await passwordRoot(password, coinPublicKey), coinPublicKey);
}

// ── Passkey: remembering the root on this device ─────────────────────────────

export const passkeysSupported = () => typeof window.PublicKeyCredential === "function" && !!navigator.credentials;

/** The PRF input. Part of the wrapping key: changing it forgets every remembered root. */
const PRF_INPUT = new TextEncoder().encode("zkperp/root-wrap/v1");
const STORE = (account: string) => `zkperp.passkey-root.v1.${account}`;

interface Remembered {
  credentialId: string;
  iv: string;
  wrapped: string;
}

function readRemembered(account: string): Remembered | null {
  try {
    const raw = localStorage.getItem(STORE(account));
    return raw ? (JSON.parse(raw) as Remembered) : null;
  } catch {
    return null;
  }
}

/** Whether this browser holds a passkey-wrapped root for the account. */
export function hasRememberedRoot(coinPublicKey: Uint8Array | null): boolean {
  return !!coinPublicKey && readRemembered(hex(coinPublicKey)) !== null;
}

export function forgetRememberedRoot(coinPublicKey: Uint8Array): void {
  try {
    localStorage.removeItem(STORE(hex(coinPublicKey)));
  } catch {
    // Storage blocked: nothing was remembered.
  }
}

const NO_PRF =
  "This passkey cannot derive a key: its authenticator does not support the WebAuthn PRF extension. " +
  "Keep using your password, or try a passkey saved in Google Password Manager, iCloud Keychain, or on a phone.";

const prf = { prf: { eval: { first: PRF_INPUT } } } as AuthenticationExtensionsClientInputs;

function prfResult(credential: Credential | null): Uint8Array | null {
  const results = (credential as PublicKeyCredential | null)?.getClientExtensionResults() as any;
  const first: BufferSource | undefined = results?.prf?.results?.first;
  if (!first) return null;
  return ArrayBuffer.isView(first) ? new Uint8Array(first.buffer, first.byteOffset, first.byteLength) : new Uint8Array(first);
}

async function prfFrom(credentialId: Uint8Array): Promise<Uint8Array> {
  const credential = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      userVerification: "required",
      allowCredentials: [{ type: "public-key", id: credentialId as BufferSource }],
      extensions: prf,
    },
  });
  const out = prfResult(credential);
  if (!out) throw new Error(NO_PRF);
  return out;
}

/** AES-GCM key from a PRF output; the account is the associated data at use. */
async function wrapKey(prfOutput: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", prfOutput as BufferSource, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode("zkperp/root-wrap-key/v1") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * Creates a passkey and stores the unlocked root, wrapped by it, in this
 * browser. Needs the key unlocked for the connected account.
 */
export async function rememberWithPasskey(coinPublicKey: Uint8Array): Promise<void> {
  const account = hex(coinPublicKey);
  if (!current || current.account !== account) throw new Error("Unlock with your password first.");
  const credential = (await navigator.credentials.create({
    publicKey: {
      rp: { name: "zkperp" },
      user: {
        // Random: the passkey identifies nothing about the trader or the wallet.
        id: crypto.getRandomValues(new Uint8Array(16)),
        name: "zkperp on this device",
        displayName: "zkperp on this device",
      },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: { userVerification: "required" },
      extensions: prf,
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("No passkey was created.");
  if (!(credential.getClientExtensionResults() as any).prf?.enabled) throw new Error(NO_PRF);
  const id = new Uint8Array(credential.rawId);
  // A few authenticators evaluate the PRF at creation; most only on a get().
  const output = prfResult(credential) ?? (await prfFrom(id));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: coinPublicKey as BufferSource },
      await wrapKey(output),
      current.root as BufferSource
    )
  );
  const entry: Remembered = { credentialId: hex(id), iv: hex(iv), wrapped: hex(wrapped) };
  localStorage.setItem(STORE(account), JSON.stringify(entry));
}

/** Unwraps the remembered root with the passkey. */
export async function unlockWithPasskey(coinPublicKey: Uint8Array): Promise<PositionKey> {
  const entry = readRemembered(hex(coinPublicKey));
  if (!entry) throw new Error("No passkey is remembered for this wallet account in this browser.");
  const output = await prfFrom(bytes(entry.credentialId));
  let root: Uint8Array;
  try {
    root = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bytes(entry.iv) as BufferSource, additionalData: coinPublicKey as BufferSource },
        await wrapKey(output),
        bytes(entry.wrapped) as BufferSource
      )
    );
  } catch {
    throw new Error("The passkey did not open the remembered key. Unlock with your password, then remember it again.");
  }
  return unlockWithRoot(root, coinPublicKey);
}
