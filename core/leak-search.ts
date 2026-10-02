// SPDX-License-Identifier: Apache-2.0

/**
 * Searching public bytes for private values.
 *
 * A search that finds nothing only proves the value is absent IN THE FORMS
 * SEARCHED. So every number is searched in each form it might take:
 *
 *   · length-tagged little-endian: one byte 0x40 + n, then the value's n
 *     minimal bytes, least significant first. This is how a contract's public
 *     transcript carries a number — measured by `probe-leak.ts`, and on
 *     zkperp's own closes, where every copy of the public pool value is
 *     tagged this way;
 *   · SCALE compact encoding, which the node's transaction format uses for
 *     integers and which shifts the bits (value << 2 | mode), so the plain
 *     bytes never appear;
 *   · decimal ASCII, as hex, in case anything is rendered as text;
 *   · plain big- and little-endian bytes, untagged, for anything framed some
 *     other way.
 *
 * The plain forms are short — a fee is three bytes — and a 40 KB transaction
 * is mostly random proof bytes, so they turn up by chance: a fee once
 * matched, big-endian, inside a hash. A plain match is therefore reported as a
 * possible chance match for review (`findNumberLoose`), not as a leak; the
 * others are long enough that a chance match is negligible, and a match is a
 * leak (`findNumber`). Every match must start on a byte boundary.
 *
 * Coverage is checked, not assumed: `probe-leak.ts` deliberately discloses
 * values from a contract and requires `findNumber` to find them.
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
  /** Long or specific enough that a match is not chance. */
  certain: boolean;
}

/** One byte 0x40 + length, then the minimal little-endian bytes. */
export function taggedLittleEndian(n: bigint): string {
  const le = reverseBytes(hexOf(n));
  return (0x40 + le.length / 2).toString(16).padStart(2, "0") + le;
}

export function encodings(n: bigint): Encoding[] {
  const be = hexOf(n);
  const scale = scaleCompact(n);
  return [
    { form: "length-tagged little-endian", hex: taggedLittleEndian(n), certain: true },
    { form: "SCALE compact", hex: scale, certain: scale.length >= 8 },
    { form: "decimal text", hex: Buffer.from(n.toString(), "ascii").toString("hex"), certain: n >= 1000n },
    { form: "plain big-endian", hex: be, certain: false },
    { form: "plain little-endian", hex: reverseBytes(be), certain: false },
  ];
}

/** Whether `needle` occurs in `haystack` starting on a byte boundary. */
function includesAligned(haystack: string, needle: string): boolean {
  for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + 1)) {
    if (i % 2 === 0) return true;
  }
  return false;
}

/** The forms of `n` that occur and cannot be chance: a leak. Empty means none. */
export function findNumber(haystackHex: string, n: bigint): string[] {
  const h = haystackHex.toLowerCase();
  return encodings(n)
    .filter((e) => e.certain && includesAligned(h, e.hex))
    .map((e) => e.form);
}

/** The forms of `n` that occur but may be chance: for review, not a verdict. */
export function findNumberLoose(haystackHex: string, n: bigint): string[] {
  const h = haystackHex.toLowerCase();
  return encodings(n)
    .filter((e) => !e.certain && includesAligned(h, e.hex))
    .map((e) => e.form);
}

export function findBytes(haystackHex: string, bytes: Uint8Array | string): boolean {
  const needle = typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("hex");
  return includesAligned(haystackHex.toLowerCase(), needle.toLowerCase());
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
