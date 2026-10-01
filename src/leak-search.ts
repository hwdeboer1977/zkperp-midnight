// SPDX-License-Identifier: Apache-2.0

/**
 * Searching public bytes for private values.
 *
 * A search that finds nothing only proves the value is absent IN THE FORMS
 * SEARCHED. So every number is searched in each form it might take:
 *
 *   · minimal big- and little-endian bytes. Every zero-padded fixed width —
 *     u64, u128, a 32-byte field element — contains these as a substring, so
 *     this covers them all;
 *   · SCALE compact encoding, which the node's transaction format uses for
 *     integers and which shifts the bits (value << 2 | mode), so the plain
 *     bytes never appear;
 *   · decimal ASCII, as hex, in case anything is rendered as text.
 *
 * Coverage is checked, not assumed: `probe-leak.ts` deliberately discloses
 * values from a contract and requires this search to find them.
 */

export function hexOf(n: bigint): string {
  let h = n.toString(16);
  if (h.length % 2) h = `0${h}`;
  return h;
}

const reverseBytes = (h: string) => h.match(/../g)!.reverse().join("");

/** SCALE compact encoding of an unsigned integer, as hex. */
export function scaleCompact(n: bigint): string {
  if (n < 1n << 6n) return hexOf((n << 2n) | 0n).padStart(2, "0");
  if (n < 1n << 14n) return reverseBytes(hexOf((n << 2n) | 1n).padStart(4, "0"));
  if (n < 1n << 30n) return reverseBytes(hexOf((n << 2n) | 2n).padStart(8, "0"));
  const body = reverseBytes(hexOf(n));
  const len = body.length / 2;
  return hexOf(BigInt(((len - 4) << 2) | 3)) + body;
}

export interface Encoding {
  form: string;
  hex: string;
}

export function encodings(n: bigint): Encoding[] {
  const be = hexOf(n);
  return [
    { form: "big-endian", hex: be },
    { form: "little-endian", hex: reverseBytes(be) },
    { form: "SCALE compact", hex: scaleCompact(n) },
    { form: "decimal text", hex: Buffer.from(n.toString(), "ascii").toString("hex") },
  ];
}

/** Which encodings of `n` occur in `haystackHex`. Empty means none found. */
export function findNumber(haystackHex: string, n: bigint): string[] {
  const h = haystackHex.toLowerCase();
  return encodings(n)
    .filter((e) => h.includes(e.hex))
    .map((e) => e.form);
}

export function findBytes(haystackHex: string, bytes: Uint8Array | string): boolean {
  const needle = typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("hex");
  return haystackHex.toLowerCase().includes(needle.toLowerCase());
}

/** The raw bytes of a transaction, hex, from the indexer. */
export async function rawTransaction(indexer: string, hash: string): Promise<string> {
  const query = `query T($hash: HexEncoded!) {
    transactions(offset: { hash: $hash }) { ... on RegularTransaction { raw } }
  }`;
  const response = await fetch(indexer, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables: { hash } }),
  });
  const body: any = await response.json();
  if (body.errors?.length) throw new Error(body.errors[0].message);
  const raw = body.data?.transactions?.[0]?.raw;
  if (!raw) throw new Error(`The indexer has no raw bytes for ${hash}`);
  return String(raw);
}
