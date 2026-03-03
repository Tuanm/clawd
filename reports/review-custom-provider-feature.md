# Code Review: Custom Provider Feature

**Date:** 2025-06-05  
**Scope:** `git diff --cached` — custom provider feature  
**Files reviewed:**
- `src/api/agents.ts` (+17 lines, validation logic)
- `src/agent/src/api/provider-config.ts` (+93 lines, `resolveProviderBaseType`, `listConfiguredProviders`, cache)
- `src/agent/src/api/factory.ts` (+40 lines, `createProvider` dispatch)
- `src/agent/src/api/providers.ts` (+30 lines, `BUILTIN_PROVIDERS`, `Config.providers` type)
- `packages/ui/src/AgentDialog.tsx` (+65 lines, provider dropdown)

**Total LOC changed:** ~245 additions, ~55 deletions

---

## Overall Assessment

The custom provider feature is architecturally sound — the factory dispatch chain, config resolution, and UI dropdown are well designed. However there is **one blocking functional bug**: the API validation layer was not updated alongside the factory layer, meaning custom provider names are rejected at the HTTP boundary before they ever reach the correctly-updated factory code. Additionally, one new TypeScript error is introduced and the config cache has no invalidation path, which will bite users who add providers to `config.json` without restarting.

---

## Critical Issues

### 1. `addAgent` and `updateAgent` reject custom provider names — feature is broken end-to-end

**File:** `src/api/agents.ts` lines 412–422 and 508–518

Both endpoints still hardcode a `validProviders` allowlist that was not updated as part of this change:

```typescript
// agents.ts line 413 — unchanged, copied to line 509
const validProviders = ["copilot", "openai", "anthropic", "ollama", "cpa"];
const agentProvider = (provider || "copilot").toLowerCase();
if (!validProviders.includes(agentProvider)) {
  return json({ ok: false, error: `Invalid provider: ${provider}. Must be one of: copilot, openai, anthropic, ollama, cpa` }, 400);
}
```

The UI dropdown now correctly shows custom providers (e.g., "groq") sourced from `/api/app.providers.list`. When the user selects "groq" and adds an agent, the POST hits this validation and returns 400. The factory layer and provider-config layer are fully ready for custom names — only this gate blocks them.

**Fix:** Accept any provider name that passes `resolveProviderBaseType()`, which already validates the name has a known base type:

```typescript
import { resolveProviderBaseType } from "../agent/src/api/provider-config";

// In addAgent and updateAgent:
const agentProvider = (provider || "copilot").toLowerCase();
if (!resolveProviderBaseType(agentProvider)) {
  return json({
    ok: false,
    error: `Invalid provider: "${agentProvider}". Must be a built-in provider or a custom provider configured in config.json.`
  }, 400);
}
```

This reuses the exact same resolution logic the factory uses, making the validation and execution layers consistent. Note that `resolveProviderBaseType` calls `loadConfig()` which is cached — this is a negligible read.

---

## High Priority

### 2. Silent fallback to Copilot for unknown/misconfigured custom providers

**File:** `src/agent/src/api/factory.ts` lines 77–95

```typescript
const baseType = resolveProviderBaseType(selectedType) ?? ("copilot" as ProviderType);
const isCustom = baseType !== selectedType;
```

If `resolveProviderBaseType` returns `undefined` (unknown name, config entry deleted, typo), the code silently falls back to Copilot and continues. The agent will make Copilot API calls instead of the intended provider with no visible error to the user. This could:
- Consume unintended Copilot quota
- Expose agent context to a different provider than configured
- Mask misconfiguration indefinitely (no error, just wrong provider)

**Fix:** Throw or return an error response instead of silently substituting:

```typescript
const baseType = resolveProviderBaseType(selectedType);
if (!baseType) {
  throw new Error(
    `Unknown provider "${selectedType}". Check config.json — custom providers need a "type" field matching a built-in provider.`
  );
}
```

The worker loop's `executePrompt` already wraps in a try/catch that posts the error to chat, so this will surface clearly.

### 3. New TypeScript error introduced — `config.providers?.copilot?.token`

**File:** `src/agent/src/api/provider-config.ts` line 335  
**Confirmed by:** `bun x tsc --noEmit` output

```
src/agent/src/api/provider-config.ts(335,37): error TS2339: Property 'token' does not exist on type 'ProviderConfig | CopilotProviderConfig | OllamaProviderConfig'.
```

Cause: `Config.providers` was widened from a typed object with known keys to `Record<string, ProviderConfig | CopilotProviderConfig | OllamaProviderConfig>`. Now `config.providers?.copilot` returns the union type, and `token` only exists on `CopilotProviderConfig`. The cast in `getCopilotTokensFromConfig` (line 301) is correct but `getCopilotToken()` at line 335 uses the raw accessor without a cast.

**Fix:**

```typescript
export function getCopilotToken(): string | null {
  ensureKeyPoolInitialized();
  const token = keyPool.peekToken("agent");
  if (token) return token;
  // Fallback: legacy single token from config
  const config = loadConfig();
  const copilot = config.providers?.copilot as (CopilotProviderConfig & { token?: string }) | undefined;
  return copilot?.token || null;
}
```

(Identical pattern to the cast already used in `getCopilotTokensFromConfig` on line 301.)

### 4. Config cache has no TTL and no production invalidation path

**File:** `src/agent/src/api/provider-config.ts` lines 28–65

`loadConfig()` uses a module-level `cachedConfig` with no expiry:

```typescript
let cachedConfig: Config | null = null;
// ...
if (cachedConfig && cachedConfigPath === filePath) {
  return cachedConfig;  // permanent cache
}
```

`clearConfigCache()` is exported but never called from any production code path — it appears only in test contexts. When a user adds a custom provider to `~/.clawd/config.json` while the server is running, `listConfiguredProviders()` will continue returning the stale list until restart. The UI dropdown will not show the new provider. This contradicts the dynamic nature of the feature.

**Option A — TTL-based (low risk):** Add a short TTL (e.g., 30s) to auto-expire the cache:

```typescript
let cacheExpiresAt = 0;
const CACHE_TTL_MS = 30_000;

export function loadConfig(configPath?: string): Config {
  const now = Date.now();
  if (cachedConfig && cachedConfigPath === filePath && now < cacheExpiresAt) {
    return cachedConfig;
  }
  // ... load file ...
  cacheExpiresAt = now + CACHE_TTL_MS;
}
```

**Option B — Explicit reload endpoint (explicit):** Add `POST /api/app.config.reload` that calls `clearConfigCache()`. Document this in the README.

**Option C — `fs.watch` (reactive):** Watch the config file for changes and call `clearConfigCache()` on modification. Most robust but adds complexity.

---

## Medium Priority

### 5. `validProviders` hardcoded array duplicated in two places, diverging from `BUILTIN_PROVIDERS`

**File:** `src/api/agents.ts` lines 413 and 509

The same literal array `["copilot", "openai", "anthropic", "ollama", "cpa"]` appears twice and is now a third definition alongside `BUILTIN_PROVIDERS` in `providers.ts`. As providers are added, all three must be updated manually.

**Fix:** After applying the fix in issue #1, this becomes moot. If the builtin-only allowlist is intentionally kept (i.e., custom providers are NOT supported by design for DB storage), the array should at minimum be imported from `BUILTIN_PROVIDERS`:

```typescript
import { BUILTIN_PROVIDERS } from "../agent/src/api/providers";
// ...
if (!BUILTIN_PROVIDERS.includes(agentProvider as any)) { ... }
```

### 6. `getModelForProvider` returns the literal string `"default"` as model name

**File:** `src/agent/src/api/provider-config.ts` line 246

```typescript
return defaultModels[providerName as ProviderType] ?? "default";
```

If `providerName` is not a key in `defaultModels` and has no config entry (or custom provider resolution fails), the function returns the string `"default"` as the model name. All LLM APIs will reject this with a 400/404, producing a confusing error. Should return a sensible hardcoded fallback or throw:

```typescript
// Option: hardcoded safe fallback
return defaultModels[providerName as ProviderType] ?? "gpt-4o";

// Option: make the failure explicit
throw new Error(`No default model for provider "${providerName}". Set models.default in config.json.`);
```

### 7. `/api/app.providers.list` has no authentication

**File:** `src/api/agents.ts` line 603, `src/index.ts` routing

The new endpoint is reachable by any client that can reach the server. The response doesn't expose API keys (confirmed: `listConfiguredProviders()` returns only `name`, `type`, `is_custom`), but it does reveal which AI providers are configured on the host (e.g., that "groq", "openai", and "anthropic" are all set up).

This matches the existing pattern for `/api/app.agents.list`, `/api/app.models.list`, etc. — none have auth gates, consistent with the assumption that the server is localhost-only or behind a firewall. The default bind is `0.0.0.0` per `src/index.ts` line 41, which may expose these endpoints externally in some deployments.

**Note:** No credential leak in the response. Information exposure risk is low if running in trusted-network deployments, but worth documenting.

---

## Low Priority

### 8. `AgentDialog.tsx`: read-only field shows display label, not raw value

**File:** `packages/ui/src/AgentDialog.tsx` lines 370–375

```tsx
value={(() => {
  const name = selectedAgent.provider || "copilot";
  const found = providers.find((p) => p.name === name);
  return found?.is_custom ? `${name} (${found.type})` : name;
})()}
```

The read-only field for an existing agent shows `"groq (openai)"`. If a user screenshots or copies this field, they might paste `"groq (openai)"` as a provider name in another context. Minor UX confusion — the raw name `"groq"` in a tooltip or `title` attribute would clarify this.

### 9. `AgentDialog.tsx`: no loading state for provider fetch

**File:** `packages/ui/src/AgentDialog.tsx` lines 119–144

The `<select>` dropdown renders immediately when the dialog opens. If the providers fetch takes >100ms, the dropdown briefly shows the static fallback list before switching to API-sourced data. A user could select a fallback option before the API response arrives and have their selection reset by the `setNewProvider` logic. Consider a loading state or disabling the select until the fetch resolves.

---

## `createProvider` Chain Verification (Question 2 — CONFIRMED WORKING)

Traced: `createProvider("groq")` →
1. `selectedType = "groq"`
2. `resolveProviderBaseType("groq")`: "groq" not in `BUILTIN_PROVIDERS` → reads `config.providers["groq"]` → finds `{ type: "openai", base_url: "...", api_key: "..." }` → returns `"openai"` ✅
3. `baseType = "openai"`, `isCustom = true`, `providerName = "groq"`
4. `switch("openai")` → `createOpenAIProvider(undefined, "groq")`
5. `getBaseUrlForProvider("groq")` → `getProviderConfig("groq")` → returns groq's config entry → `base_url` ✅
6. `getApiKeyForProvider("groq")` → `getProviderConfig("groq")` → `api_key` ✅
7. `getModelForProvider("groq")` → `models.default` from groq config, or fallback to `getModelForProvider("openai")` ✅

**Chain is correctly implemented**, subject to the gate bug in issue #1 preventing it from ever being reached.

## Worker Pass-Through Verification (Question 3 — CONFIRMED CORRECT)

`worker-loop.ts` line 550: `createProvider(provider, model)` where `provider` is sourced verbatim from `this.config.provider` which is set from the DB record's `provider` column. The provider name flows as-is from DB → WorkerLoopConfig → `createProvider()`. No transformation or stripping. ✅

## `/api/app.providers.list` Security Verification (Question 4 — CONFIRMED SAFE)

`listConfiguredProviders()` iterates `config.providers` and returns only `{ name, type, is_custom }`. API keys (`api_key`, `api_keys`), tokens, `base_url`, and `models` config are not included in the output. No credential leak. ✅

---

## Summary of Required Actions

| Priority | Issue | File | Action |
|----------|-------|------|--------|
| 🔴 Critical | Custom provider names rejected at API gateway | `src/api/agents.ts:413,509` | Replace hardcoded `validProviders` with `resolveProviderBaseType()` check |
| 🟠 High | Silent Copilot fallback on unknown provider | `src/agent/src/api/factory.ts:77` | Throw on `undefined` from `resolveProviderBaseType` |
| 🟠 High | TS error `token` property on widened union type | `src/agent/src/api/provider-config.ts:335` | Add cast identical to line 301 in same file |
| 🟠 High | Config cache never invalidated at runtime | `src/agent/src/api/provider-config.ts:28` | Add TTL or reload endpoint |
| 🟡 Medium | `validProviders` duplicated, diverges from `BUILTIN_PROVIDERS` | `src/api/agents.ts:413,509` | Consolidate after critical fix |
| 🟡 Medium | `getModelForProvider` returns `"default"` string | `src/agent/src/api/provider-config.ts:246` | Use real fallback or throw |
| 🟡 Medium | `/api/app.providers.list` unauthenticated | `src/api/agents.ts:603` | Document; consider auth for network-exposed deployments |
| 🔵 Low | Read-only provider field shows display label | `packages/ui/src/AgentDialog.tsx:370` | Add `title` attribute with raw name |
| 🔵 Low | No loading state for provider dropdown fetch | `packages/ui/src/AgentDialog.tsx:119` | Disable select or show spinner during fetch |

---

## Positive Observations

- **`resolveProviderBaseType` is well-designed** — clean single-responsibility function that correctly handles both builtin and custom names, with proper BUILTIN_PROVIDERS guard before config reads.
- **`BUILTIN_PROVIDERS` constant** is a good addition; it creates a single authoritative source of truth for the built-in set.
- **`listConfiguredProviders` correctly excludes credentials** — the API response shape is intentionally minimal.
- **`keyRotationCounters` type widened correctly** from `Partial<Record<ProviderType, number>>` to `Record<string, number>`, avoiding a subtle key-miss bug for custom providers.
- **`getCopilotTokensFromConfig` cast** is the correct pattern for dealing with the widened `providers` record type.
- **Factory dispatch is correct** — the `providerName`/`customProviderName` parameter threading through all four provider constructors is clean and doesn't break the built-in providers.
- **UI fallback list** in `AgentDialog.tsx` catch block provides graceful degradation if the providers endpoint is unavailable.
