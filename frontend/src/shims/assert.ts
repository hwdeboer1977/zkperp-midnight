// Copyright 2026 Henk Wim de Boer
// SPDX-License-Identifier: Apache-2.0

/**
 * Node's `assert`, as used by @subsquid's scale codecs deep inside the indexer
 * provider. Vite externalises it for the browser, which leaves an import that
 * throws on first call rather than at build time.
 *
 * The real module's failure behaviour is all that is needed here: throw when
 * the condition is falsy, do nothing otherwise.
 */
function assert(value: unknown, message?: string): asserts value {
  if (!value) throw new Error(message ?? "Assertion failed");
}

assert.ok = assert;
assert.strictEqual = (actual: unknown, expected: unknown, message?: string) => {
  if (actual !== expected) {
    throw new Error(message ?? `Expected ${String(expected)}, got ${String(actual)}`);
  }
};

export default assert;
export { assert };
