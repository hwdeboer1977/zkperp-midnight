// SPDX-License-Identifier: Apache-2.0

/**
 * The liquidator's note: every position, encrypted by the open circuit to the
 * keeper's key (see `sealLiquidatorNote` in contracts/zkperp.compact).
 *
 * The encryption runs in the circuit, so this side only needs a random
 * ephemeral scalar per open, and the keeper's decoding of what
 * `openLiquidatorNote` returns: ten field elements back into a position.
 * Browser and Node alike.
 */

const MASK64 = (1n << 64n) - 1n;

/**
 * The order of Jubjub's prime subgroup. `ecMul` and `ecMulGenerator` take
 * their scalar as a `Field` but decode it as a Jubjub scalar, and fail on
 * anything at or above this ("failed to decode for built-in type EmbeddedFr"),
 * in the runtime and in the proof alike. It is smaller than the field.
 */
export const JUBJUB_ORDER = 6554484396890773809930967563523245729705921265872317281365359162392183254199n;

/** A non-zero scalar below `JUBJUB_ORDER` from `bytes` (64 of them: the bias of the reduction is below 2^-250). */
export function scalarFrom(bytes: Uint8Array): bigint {
  let n = 0n;
  for (const x of bytes) n = (n << 8n) | BigInt(x);
  const s = n % JUBJUB_ORDER;
  if (s === 0n) throw new Error("the scalar reduces to zero");
  return s;
}

/** A uniformly random non-zero Jubjub scalar: an open's ephemeral scalar, or a keeper secret. */
export function randomScalar(): bigint {
  for (;;) {
    try {
      return scalarFrom(globalThis.crypto.getRandomValues(new Uint8Array(64)));
    } catch {
      // Zero: draw again.
    }
  }
}

/**
 * 32 random bytes made safe for the circuit's `as Field` cast, which refuses
 * values at or above the field size: the top four bits of the last byte (the
 * most significant, little-endian) are cleared, so the value is below 2^252.
 * For the salt and the collateral coin's nonce, which the liquidator's note
 * carries as whole field elements. 252 random bits remain.
 */
export function belowField(bytes: Uint8Array): Uint8Array {
  if (bytes.length !== 32) throw new Error("belowField takes 32 bytes");
  const out = bytes.slice();
  out[31]! &= 0x0f;
  return out;
}

/** A field element back into `n` bytes, little-endian (the circuit's `as Field`). */
function toBytes(f: bigint, n: number): Uint8Array {
  if (f < 0n || f >> BigInt(8 * n) !== 0n) throw new Error("not a plaintext element: the note is not for this key");
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Number((f >> BigInt(8 * i)) & 0xffn);
  return out;
}

function halves(lo: bigint, hi: bigint): Uint8Array {
  const out = new Uint8Array(32);
  out.set(toBytes(lo, 16), 0);
  out.set(toBytes(hi, 16), 16);
  return out;
}

function pair(f: bigint): [bigint, bigint] {
  if (f < 0n || f >> 128n !== 0n) throw new Error("not two packed amounts: the note is not for this key");
  return [f & MASK64, f >> 64n];
}

export interface LiquidatorView {
  /** The circuit's `Position`, ready to rebuild its commitment. */
  position: {
    owner: bigint;
    isLong: boolean;
    size: bigint;
    collateral: bigint;
    openFee: bigint;
    entryPrice: bigint;
    openTime: bigint;
    collateralNonce: Uint8Array;
    salt: Uint8Array;
    payTo: { bytes: Uint8Array };
  };
  /** The trader's encryption key, to address the equity a liquidation returns. */
  payToEnc: Uint8Array;
}

/**
 * Decodes `openLiquidatorNote`'s output (see `liquidatorPlaintext` in the
 * contract for the layout). Throws if the elements cannot be a plaintext,
 * which is what a note under another key decrypts to: ten random field
 * elements, almost surely not all in range. The caller still checks the
 * rebuilt commitment is in the tree.
 */
export function decodeLiquidatorPlaintext(m: readonly bigint[]): LiquidatorView {
  if (m.length !== 10) throw new Error("a liquidator plaintext has 10 elements");
  const [size, collateral] = pair(m[5]!);
  const [openFee, entryPrice] = pair(m[6]!);
  const [openTime, long] = pair(m[7]!);
  if (long > 1n) throw new Error("not a direction: the note is not for this key");
  return {
    position: {
      owner: m[0]!,
      collateralNonce: toBytes(m[1]!, 32),
      salt: toBytes(m[2]!, 32),
      payTo: { bytes: halves(m[3]!, m[4]!) },
      isLong: long === 1n,
      size,
      collateral,
      openFee,
      entryPrice,
      openTime,
    },
    payToEnc: halves(m[8]!, m[9]!),
  };
}
