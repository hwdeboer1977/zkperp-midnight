// SPDX-License-Identifier: Apache-2.0

/**
 * The position key, from a passkey.
 *
 * Every position opened here leaves an encrypted note on chain (core/notes.ts).
 * The key that opens those notes must be reproducible on any device the trader
 * uses, with nothing to carry. The wallet cannot supply it: the DApp connector
 * exposes no seed and no decrypt, and 1AM's `signData` is randomized (measured
 * 2026-10-02; see public/signdata-determinism.html).
 *
 * A passkey can. Its PRF extension (WebAuthn's hmac-secret) returns 32 bytes
 * fixed by the credential and the input, after user verification. A passkey
 * synced by Google Password Manager or iCloud Keychain is the same credential
 * on every device, so every device gets the same root.
 *
 * Limits worth knowing:
 *   · a passkey belongs to one site, this page's host. A deployment on another
 *     domain needs its own passkey, and sees only the notes made under it;
 *   · the authenticator must support PRF. Google Password Manager, iCloud
 *     Keychain, Android phones and recent security keys do; not all do;
 *   · a SECOND passkey is a second key. Positions opened under one are not
 *     found by the other, so the UI asks for one passkey, created once.
 *
 * The derived keys live only in this page's memory: one passkey tap per session.
 */

import { useSyncExternalStore } from "react";
import { positionKey, type PositionKey } from "@core/notes";

/** The PRF input. It is part of the key: changing it hides every position. */
const PRF_INPUT = new TextEncoder().encode("zkperp/position-key/v1");

let current: PositionKey | null = null;
const listeners = new Set<() => void>();

function setKey(key: PositionKey | null): void {
  current = key;
  listeners.forEach((l) => l());
}

export function usePositionKey(): PositionKey | null {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => void listeners.delete(l)),
    () => current
  );
}

export const lockPositionKey = () => setKey(null);

export const passkeysSupported = () => typeof window.PublicKeyCredential === "function" && !!navigator.credentials;

const NO_PRF =
  "This passkey cannot derive a key: its authenticator does not support the WebAuthn PRF extension. " +
  "Use a passkey saved in Google Password Manager or iCloud Keychain, or on a phone.";

function prfResult(credential: Credential | null): Uint8Array | null {
  const results = (credential as PublicKeyCredential | null)?.getClientExtensionResults() as any;
  const first: BufferSource | undefined = results?.prf?.results?.first;
  if (!first) return null;
  return ArrayBuffer.isView(first) ? new Uint8Array(first.buffer, first.byteOffset, first.byteLength) : new Uint8Array(first);
}

const prf = { prf: { eval: { first: PRF_INPUT } } } as AuthenticationExtensionsClientInputs;

/**
 * Asks for a passkey of this site and derives the position key from it. With
 * no `credentialId` the browser offers every passkey it holds for the site.
 */
export async function unlockWithPasskey(credentialId?: BufferSource): Promise<PositionKey> {
  const credential = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      userVerification: "required",
      allowCredentials: credentialId ? [{ type: "public-key", id: credentialId }] : undefined,
      extensions: prf,
    },
  });
  const root = prfResult(credential);
  if (!root) throw new Error(NO_PRF);
  const key = await positionKey(root);
  setKey(key);
  return key;
}

/** Creates the passkey, then unlocks with it. Meant to happen once per trader. */
export async function createPasskey(): Promise<PositionKey> {
  const credential = (await navigator.credentials.create({
    publicKey: {
      rp: { name: "zkperp" },
      user: {
        // Random: the passkey identifies nothing about the trader or the wallet.
        id: crypto.getRandomValues(new Uint8Array(16)),
        name: "zkperp positions",
        displayName: "zkperp positions",
      },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      // Discoverable, so another device can find it without being told its id.
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      extensions: prf,
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("No passkey was created.");
  const results = credential.getClientExtensionResults() as any;
  if (!results.prf?.enabled) throw new Error(NO_PRF);
  // A few authenticators evaluate the PRF at creation; most only on a get().
  const root = prfResult(credential);
  if (!root) return unlockWithPasskey(credential.rawId);
  const key = await positionKey(root);
  setKey(key);
  return key;
}
