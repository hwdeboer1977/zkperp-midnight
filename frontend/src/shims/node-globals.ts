// Copyright 2026 Henk Wim de Boer
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "buffer";

/**
 * `Buffer`, which the Midnight stack assumes is global.
 *
 * `@midnight-ntwrk/compact-js` and the generated contract module use `Buffer`
 * freely — they were written for Node, where it is global. In a browser it is
 * not, and the failure surfaces deep inside circuit execution as
 *
 *   ReferenceError: Buffer is not defined
 *
 * long after any import that would have hinted at the cause. Vite does not
 * polyfill Node builtins on principle, so the app installs this one itself.
 *
 * Deliberately ONLY Buffer. Defining `process` or `global` alongside it is the
 * obvious next step and a bad one: plenty of libraries branch on
 * `typeof process !== "undefined"` to decide they are running under Node and
 * reach for `fs`. Adding those pre-emptively would risk breaking code paths
 * that currently work by correctly detecting a browser. If something genuinely
 * needs one, it will say so with its own clear ReferenceError.
 *
 * Imported first in main.tsx: ES imports are evaluated in order, so being the
 * first import is what guarantees this runs before anything that needs it.
 * Nothing may be imported above it.
 */
(globalThis as Record<string, unknown>).Buffer ??= Buffer;

export {};
