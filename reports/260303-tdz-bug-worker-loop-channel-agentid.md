# TDZ Bug: `ReferenceError: Cannot access 'D' before initialization` in `worker-loop.ts`

**Date:** 2026-03-03  
**Severity:** Critical — blocks all agent execution  
**Status:** Fixed

---

## Executive Summary

Every call to `executePrompt()` in `src/worker-loop.ts` threw `ReferenceError: Cannot access 'D' before initialization` in the compiled binary (`bun build --compile --minify`). The minified variable `D` mapped to `channel` — a `const` re-declaration at line 633 created a Temporal Dead Zone (TDZ) that shadowed the outer destructuring, making `channel` and `agentId` inaccessible for the entire inner `try` block.

---

## Root Cause

**File:** `src/worker-loop.ts`  
**Line:** 633 (before fix)  
**Introduced by commit:** `1e1fd46` (`feat(analytics): track all Copilot API calls`)

### The Exact Bug

```typescript
// Line 496 — outer scope of executePrompt()
const { chatApiUrl, channel, agentId, provider, model, projectRoot } = this.config;

// ...
return runWithAgentContext({ ... }, async () => {
  try {
    // ...

    // Lines 558–629: channel and agentId used extensively here
    const pluginConfig: ClawdChatConfig = {
      channel,   // ← accessed from outer scope
      agentId,   // ← accessed from outer scope
      ...
    };
    // ... scheduler plugin uses channel, agentId
    // ... space plugin uses channel, agentId

    // ⚠️  LINE 633 — THE BUG:
    const { channel, agentId } = this.config;  // re-declares in inner try-block scope!
    const result = await callContext.run({ agentId, channel }, () => agent!.run(...));
```

In JavaScript, a `const` declaration creates a **block-scoped TDZ from the start of the block** — not just from the line it appears on. The `const { channel, agentId }` at line 633 is declared inside the inner `try` block (which starts at line 549). This shadows the outer `channel`/`agentId` and puts them in TDZ for the **entire inner try block** — including all lines 549–632 where they are already being used.

### Why Only the Compiled Binary?

Bun's development-mode TypeScript runner resolves `const` scoping at source level and may silently rename inner declarations. The compiled binary (`--compile --minify`) implements strict JavaScript TDZ semantics and renames block-scoped `const` variables with fresh minified names (`D`, `q`), making the violation explicit:

- Minified inner `channel` → `D`
- `D` is **used** at offset +809 (in `pluginConfig` object)
- `let{channel:D,...}=this.config` **declared** at offset +1977 (same block, after all uses)
- → `ReferenceError: Cannot access 'D' before initialization` every call

### Minified Evidence

**Before fix** — `D` used before declaration:
```javascript
// At +809 (before declaration):
let F={type:"clawd-chat",apiUrl:Q,channel:D,agentId:q,...}

// At +1977 (declaration — too late):
let{channel:D,agentId:q}=this.config
```

**After fix** — `D` used only as result variable:
```javascript
// channel:X throughout (X = outer-scope channel, no shadowing)
let F={type:"clawd-chat",apiUrl:Q,channel:X,agentId:J,...}

// D is now the callContext result, not a shadowed channel:
let D=await z5.run({agentId:J,channel:X},()=>U.run($,Z));
```

---

## Fix Applied

**Removed** the redundant `const { channel, agentId } = this.config;` at line 633.  
`channel` and `agentId` are already available from the outer destructuring at line 496.

```diff
-            // Run the agent with the prompt (wrapped in call context for analytics)
-            const { channel, agentId } = this.config;
-            const result = await callContext.run({ agentId, channel }, () => agent!.run(prompt, sessionName));
+            // Run the agent with the prompt (wrapped in call context for analytics)
+            // NOTE: channel and agentId are already destructured from this.config at line 496;
+            // do NOT re-declare them here — a redundant const { channel, agentId } inside
+            // this try-block would create a TDZ that shadows the outer bindings, causing
+            // "ReferenceError: Cannot access 'channel' before initialization" in Bun's
+            // compiled (--compile --minify) binary every time executePrompt() is called.
+            const result = await callContext.run({ agentId, channel }, () => agent!.run(prompt, sessionName));
```

---

## Investigation Path

1. Identified the suspect commit: `1e1fd46` added `callContext.run()` wrapping inside `executePrompt()`, introducing the inner `const { channel, agentId }` re-declaration.
2. Built non-minified bundle (`bun build --minify`): confirmed `client.ts` has two sections in the bundle (split by analytics.ts evaluation) — no circular import at runtime.
3. Built minified bundle with source maps: found `let{channel:D,agentId:q}=this.config` appearing *after* `channel:D` is used in the same block scope.
4. Confirmed: offset of first `channel:D` use (+809) is before `let{channel:D}` declaration (+1977) in same async callback body.

---

## Import Chain (for completeness)

The `feat(analytics)` commit also introduced a new import chain:

```
worker-loop.ts
  → agent/src/api/factory.ts
    → agent/src/api/client.ts
      → ../../../analytics.ts          ← new import
          → server/database.ts         ← db
          → agent/src/api/key-pool.ts  ← getModelMultiplier
      → ./call-context.ts              ← new import
```

No circular dependencies at runtime. The TDZ is purely from the re-declaration in the same `try` block.

---

## Prevention

- Avoid re-declaring `const`/`let` variables inside inner block scopes when outer-scope bindings with the same names are already in scope — JavaScript TDZ applies from the **start of the block**, not the line of declaration.
- Enable `no-shadow` ESLint rule to catch variable shadowing at lint time.
- Test compiled binary output (`bun build --compile`) in CI, not just dev mode, since Bun's dev-mode transpiler may mask TDZ violations.
