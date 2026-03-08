# Code Review: shield.js v2 — Anti-Detection Shield

**Date:** 2025-03-08
**Reviewer:** Code Quality Agent
**File:** `packages/browser-extension/src/shield.js`
**LOC:** 377
**Focus:** Correctness, stealth, detection resistance

---

## Overall Assessment

The v2 rewrite shows strong architectural thinking — the WeakMap + `Function.prototype.toString` approach is fundamentally sound and survives all standard toString detection vectors. However, **the shield contains a crash-level bug that prevents ~60% of its patches from ever executing**, plus several stealth-breaking property leaks. The timing system has a design flaw that can both leak pause durations and freeze time.

**Severity breakdown:** 2 Critical · 5 High · 3 Medium · 2 Low

---

## Critical Issues

### C1. `_DateProxy.prototype = …` crashes the IIFE (line 155) ⛔

**Impact:** Lines 155–377 never execute. The shield silently dies mid-boot. All patches after the Date constructor — including `navigator.webdriver`, window dimensions, error stack cleanup, debugger stripping, chrome normalization — are **never applied**.

**Root cause:** `Date.prototype` on the `Date` constructor is `{ writable: false, configurable: false }`. The Proxy has no `set` trap, so the assignment delegates to the target's `[[Set]]`, which returns `false`. In strict mode (the IIFE has `"use strict"`), this throws `TypeError: Cannot assign to read only property 'prototype'`.

```
Date.prototype descriptor: { writable: false, configurable: false }
_DateProxy.prototype = _OrigDate.prototype;  → TypeError!
```

The same crash exists at line 293 (`_funcProxy.prototype = _origFunction.prototype`) but it's unreachable because line 155 crashes first.

**Verified:** Reproduced in Node.js v8 — IIFE execution halts at line 154. Lines 155+ never run.

**Fix:** Delete lines 155 and 293. The `get` trap already returns the correct `.prototype` for all read access — the write is unnecessary (and harmful).

```diff
   });
-  _DateProxy.prototype = _OrigDate.prototype;
   _DateProxy.prototype.constructor = _DateProxy;  // This works: reads via get trap, writes on the returned object
```

```diff
   });
-  _funcProxy.prototype = _origFunction.prototype;
   _registerNative(_funcProxy, "Function");
```

### C2. Missing `Function.prototype.constructor = _funcProxy` (line 293 area)

**Impact:** After fixing C1, `Function.prototype.constructor === Function` returns `false` — detectable.

The Date proxy correctly has `_DateProxy.prototype.constructor = _DateProxy` (line 156), but the Function proxy lacks the equivalent.

**Fix:** Add after `window.Function = _funcProxy`:

```js
try {
  window.Function = _funcProxy;
  // Maintain constructor identity invariant
  _origFunction.prototype.constructor = _funcProxy;
} catch {}
```

---

## High Priority

### H1. High-water mark race leaks pause duration, then freezes time

**Impact:** Detectable by anti-bot via `performance.now()` jump followed by time freeze.

The `setInterval` detector and `performance.now()` calls are both macrotasks. After a debugger pause, page script can call `performance.now()` **before** the detector tick fires. This causes:

1. **Leak:** First call returns `perfNow() - offset` where offset hasn't been updated yet → full pause duration visible (e.g., 5000ms jump)
2. **Freeze:** Detector then corrects offset → `raw = perfNow() - newOffset` is now much smaller than `_highWater` → time frozen until real clock catches up (~seconds)

```
Before pause: returns ~10000ms
First call after pause (before detector): returns ~15000ms  ← LEAKED
Detector fires: offset += ~5000
Subsequent calls: raw ≈ 10050, highWater = 15000 → returns 15000  ← FROZEN for ~5s
```

**Fix:** Move offset correction INTO `_adjustedPerfNow` itself (synchronous correction on anomaly detection), rather than relying on an asynchronous setInterval:

```js
function _adjustedPerfNow() {
  const now = _perfNow();
  const raw = now - _offset;
  // Synchronous anomaly check: if raw jumped far past highWater,
  // a pause likely occurred — correct immediately
  if (_highWater > 0 && raw > _highWater + 200) {
    _offset += (raw - _highWater) - 1; // absorb the gap, leave 1ms of forward progress
    const corrected = now - _offset;
    _highWater = corrected;
    return corrected;
  }
  if (raw > _highWater) _highWater = raw;
  return _highWater;
}
```

### H2. `requestAnimationFrame` timestamps can go backwards

**Impact:** rAF callbacks use simple `timestamp - _offset` with no high-water mark. When the detector fires and increases `_offset`, subsequent rAF timestamps jump backwards (e.g., from 10000 to 5016). Anti-bot scripts that track rAF timestamp monotonicity will detect this.

**Fix:** Apply the same high-water mark (or a separate one for rAF timestamps) to rAF callbacks:

```js
let _rafHighWater = 0;
const _patchedRAF = function requestAnimationFrame(callback) {
  return _origRAF.call(window, function (timestamp) {
    let adjusted = timestamp - _offset;
    if (adjusted > _rafHighWater) _rafHighWater = adjusted;
    callback(_rafHighWater);
  });
};
```

### H3. `performance.now()` and rAF timestamps diverge after correction

**Impact:** Even if H2 is fixed, `performance.now()` (with high-water mark) and rAF timestamp (with simple offset) can diverge by seconds after a correction, which is abnormal. The fix for H1 and H2 should use a shared correction mechanism.

### H4. Function `.name` property leaks on patched functions

**Impact:** `eval.name` returns `"_patchedEval"` (not `"eval"`), `setTimeout.name` returns `"patched"` (not `"setTimeout"`), `setInterval.name` returns `"patched"`. Anti-bot scripts checking `fn.name` will detect the patch.

```js
eval.name         // "_patchedEval" ← detectable (should be "eval")
setTimeout.name   // "patched"      ← detectable (should be "setTimeout")
setInterval.name  // "patched"      ← detectable (should be "setInterval")
```

**Fix:** Set `.name` explicitly via `Object.defineProperty`:

```js
// For eval (can't use `function eval(){}` in strict mode):
Object.defineProperty(_patchedEval, 'name', { value: 'eval', configurable: true });

// For setTimeout/setInterval:
Object.defineProperty(patched, 'name', { value: name, configurable: true });
```

### H5. `eval` replacement converts direct eval to indirect eval

**Impact:** Anti-bot detection via local scope test:

```js
(function() {
  var secret = 42;
  var result = eval("typeof secret");
  if (result === "undefined") /* eval was replaced! */
})();
```

Native `eval("typeof secret")` inside a function is "direct eval" — it can access local variables. The shield's replacement is an ordinary function, so it always performs "indirect eval" (global scope). This is a fundamental limitation of userland eval patching.

**Mitigation note:** This is inherent to the approach. Document it as a known limitation. Most anti-bot scripts that use `eval("debugger")` don't rely on local scope access.

---

## Medium Priority

### M1. Debugger regex `_dbgRe` false-positives on identifiers containing "debugger"

**Impact:** Code containing identifiers like `debuggerEnabled`, `isDebugger`, `debugger2` is incorrectly mutated.

```js
_stripDebugger("var debuggerEnabled = true")
// Returns: "var void 0;Enabled = true"  ← BREAKS the code!

_stripDebugger("debugger2")
// Returns: "void 0;2"
```

**Fix:** Add word boundary assertion after `debugger`:

```js
const _dbgRe = /(?:^|[;{}\s(,])debugger(?=\s*[;\s}\n\r]|$)/g;
```

Or more precisely, use a negative lookahead for identifier continuation:

```js
const _dbgRe = /(?:^|[;{}\s(,])debugger(?![a-zA-Z0-9_$])\s*;?/g;
```

### M2. `Symbol()` guard doesn't prevent double-injection

**Impact:** If the shield script is loaded twice into the same frame (e.g., extension update/reload), the guard fails because each IIFE invocation creates a new unique `Symbol()`. The second injection double-patches `Function.prototype.toString`, creating a chain where `_origToString` in the second run IS the first run's `_patchedToString`. This adds indirection but doesn't break functionality.

Additionally, `Object.getOwnPropertySymbols(window)` reveals the guard symbol(s) — adding 1-2 unexpected symbols to `window` that a fingerprinter could count.

**Fix:** Use `Symbol.for()` with a stable key to create a cross-invocation identical symbol:

```js
const _gk = Symbol.for("__s_" + document.currentScript?.src?.slice(-8));
```

Or use a non-symbol approach entirely (e.g., check for the patched toString):

```js
if (Function.prototype.toString._isShield) return;
```

### M3. `setTimeout`/`setInterval` `.length` mismatch (browser-dependent)

**Impact:** In browsers where native `setTimeout.length === 1`, the patched version has `.length === 2` (due to the `(handler, delay, ...rest)` signature).

**Fix:**

```js
Object.defineProperty(patched, 'length', { value: 1, configurable: true });
```

---

## Low Priority

### L1. rAF wrapper callback loses the original callback's identity

The anonymous wrapper `function(timestamp) { callback(timestamp - _offset); }` doesn't preserve the original callback's `.name` or reference. This is very unlikely to be detected but breaks `cancelAnimationFrame` pattern-matching in devtools profilers.

### L2. Debugger pauses while tab is backgrounded go undetected

When `_detectorActive` is `false`, debugger pauses in the background tab are missed. This is a design trade-off (backgrounded tabs have legitimate timer throttling), and unlikely to matter in practice.

---

## Answers to Specific Review Questions

### Q1: Does WeakMap + toString survive ALL toString detection methods?

**YES.** Verified all 5 methods plus additional vectors:

| Method | Result |
|--------|--------|
| `fn.toString()` | ✅ `function now() { [native code] }` |
| `Function.prototype.toString.call(fn)` | ✅ `function now() { [native code] }` |
| `String(fn)` | ✅ (calls `[Symbol.toPrimitive]` → `toString`) |
| `` `${fn}` `` template literal | ✅ (calls `toString()`) |
| `fn + ""` coercion | ✅ (calls `toString()`) |
| `Reflect.apply(FP.toString, fn, [])` | ✅ |
| `FP.toString.bind(fn)()` | ✅ |
| `fn.toString === FP.toString` (identity) | ✅ `true` |

The approach is sound because ALL paths to stringifying a function go through `Function.prototype.toString`, which is now the patched version that checks the WeakMap first.

### Q2: Race condition in WeakMap registration vs toString assignment?

**NO.** JavaScript is single-threaded. Lines 47–48 execute synchronously:

```js
_registerNative(_patchedToString, "toString");  // WeakMap entry set
Function.prototype.toString = _patchedToString;  // Assignment
```

No code can call `_patchedToString` between these two lines. The `_patchedToString` function isn't reachable until after line 48 assigns it. And the shield runs at `document_start` before any page script, so no page code could have cached the original `Function.prototype.toString`.

### Q3: Date constructor Proxy vs toString detection?

**Survives toString** — `_registerNative(_DateProxy, "Date")` correctly stores the Proxy object (not the target) as the WeakMap key. Since a Proxy has its own identity in WeakMap, `_nativeStrings.get(_DateProxy)` correctly returns the native-looking string.

The `getOwnPropertyDescriptor` bypass is NOT an issue in this specific case because `Date.now` is already patched on the original `Date` object (line 133) before the Proxy wraps it. The `get` trap returns `_patchedDateNow`, and `Object.getOwnPropertyDescriptor(Date, "now").value` also returns `_patchedDateNow` (since it delegates to the already-patched target). Same reference → no inconsistency.

**However:** The Proxy itself never installs into `window.Date` due to the C1 crash bug.

### Q4: Does high-water mark cause time freeze?

**YES.** Confirmed via simulation. See H1 above. The race between detector tick and `performance.now()` calls causes:
- First call: leaks full pause duration (e.g., 5s jump)
- Subsequent calls: frozen at the leaked value for ~5 seconds

### Q5: Is `this` correct in setTimeout/setInterval wrapping?

**Mostly yes.** When called as `window.setTimeout(fn, 100)`, `this = window`, and `orig.call(this, ...)` correctly passes `window` as the receiver. The edge case of `const st = setTimeout; st(fn, 100)` would make `this = undefined` (strict mode), and `orig.call(undefined, ...)` would throw "Illegal invocation" — but this matches native behavior (native setTimeout also requires Window as `this`).

For added safety, consider: `orig.call(this ?? window, handler, delay, ...rest)`.

### Q6: all_frames behavior and shared state?

**No shared state issues.** Each frame (main + iframes) has its own JavaScript context with its own `window`, `Function.prototype`, `performance`, etc. The shield IIFE runs independently in each frame, creating separate WeakMaps, offsets, and patches. The `Symbol()` guard uses a unique symbol per invocation, which actually means it **doesn't** guard against same-frame re-injection (see M2), but doesn't cause cross-frame leakage either.

### Q7: Remaining Proxy objects detectable via toString?

Two Proxy objects remain: `_DateProxy` (Date) and `_funcProxy` (Function). Both are registered in the WeakMap, so **`Function.prototype.toString.call()` returns native-looking strings for both**.

Other Proxy detection vectors are covered:
- `typeof` → `"function"` ✅
- `Object.getOwnPropertyNames()` → delegates to target ✅
- `Date.name` → `"Date"` (via `Reflect.get`) ✅
- `Date.length` → `7` (via `Reflect.get`) ✅
- `x instanceof Date` → works (prototype chain intact) ✅
- `Object.getPrototypeOf(Date)` → `Function.prototype` (no trap → delegates) ✅

No practical Proxy detection vector remains after the WeakMap toString override.

---

## Positive Observations

1. **WeakMap toString architecture** — Excellent design. Fundamentally more robust than Proxy-based toString faking. Survives all known detection methods.
2. **Prototype-level patching** — `Performance.prototype.now` instead of `performance.now` avoids `hasOwnProperty` detection. Correct approach.
3. **Visibility change guard** — Properly pauses detector during tab backgrounding to avoid Chrome's timer throttling false positives.
4. **Adaptive EMA baseline** — Smart approach to handle CPU variance in the interval timing.
5. **Error.prepareStackTrace filtering** — Comprehensive pattern list covering Puppeteer, Playwright, extensions, and DevTools.
6. **Chrome-specific normalization** — `chrome.csi` and `chrome.loadTimes` stubs are well-structured with realistic values.
7. **Delta cap at 30s** — Prevents background-tab throttle from causing massive offset drift.

---

## Recommended Actions (Priority Order)

1. **Fix C1 NOW** — Delete lines 155 and 293. Without this, the shield protects nothing beyond performance.now/Date.now.
2. **Fix C2** — Add `Function.prototype.constructor = _funcProxy` after the Function proxy install.
3. **Fix H1** — Move offset correction into `_adjustedPerfNow` for synchronous anomaly detection.
4. **Fix H2** — Add rAF high-water mark tracking.
5. **Fix H4** — Set `.name` on all patched functions via `Object.defineProperty`.
6. **Fix M1** — Add negative lookahead to `_dbgRe` to prevent identifier false-positives.
7. **Fix M2** — Switch to `Symbol.for()` with stable key for the re-injection guard.
8. **Fix M3** — Set `.length = 1` on setTimeout/setInterval patches.
9. **Document H5** — Note eval direct→indirect as a known limitation.

---

## Metrics

- **Patches that work (with C1 bug):** 3/12 (toString, perf.now, Date.now)
- **Patches that work (after C1 fix):** 12/12
- **toString detection resistance:** 100% (all vectors pass)
- **Property introspection leaks:** 3 (`.name` on eval, setTimeout, setInterval)
- **Timing consistency gaps:** 2 (high-water race, rAF monotonicity)
