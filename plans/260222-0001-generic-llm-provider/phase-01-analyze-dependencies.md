# Phase 1: Analyze Codebase for Dead Code & Dependencies

## Overview
- **Priority**: High
- **Status**: pending
- **Description**: Analyze the codebase to identify all dependencies on the interactive chat mode and CopilotClient, ensuring complete removal without breaking functionality.

## Key Insights

### Interactive Chat Code Location
The `interactiveChat` function in `src/agent/src/index.ts` (lines 1587-1658) is:
- CLI-only feature (readline-based terminal interaction)
- Called when `--chat` flag is passed or when resuming a session without prompt
- NOT used by the desktop app (which uses WebSocket/UI)

### CopilotClient Dependencies

#### Direct Usage
1. **src/agent/src/agent/agent.ts** - Line 13: Imports `CopilotClient`
   - Line 194: `private client: CopilotClient`
   - Line 214: `this.client = new CopilotClient(token)` in constructor

2. **src/worker-loop.ts** - Line 13: Imports `getToken` from client
   - Line 383: `const token = getToken()` for authentication

3. **src/agent/src/api/config.ts** - Contains hardcoded `COPILOT_API_URL`

### Related Files to Update
- `src/agent/src/api/client.ts` - Contains CopilotClient (will become base for generic provider)
- `src/agent/src/api/config.ts` - Hardcoded API URL (needs refactoring)
- `src/agent/src/agent/agent.ts` - Uses CopilotClient directly
- `src/worker-loop.ts` - Uses `getToken()` helper

### Config File Structure (already exists)
```json
{
  "providers": {
    "anthropic": {
      "base_url": "https://api.minimax.io/anthropic",
      "api_key": "...",
      "models": { "default": "MiniMax-M2.1" }
    },
    "openai": {
      "base_url": "https://api.openai.com/v1",
      "api_key": "your-api-key"
    },
    "copilot": {
      "token": "github_pat_..."
    }
  }
}
```

## Requirements

### Functional Requirements
1. Identify all files that depend on CopilotClient
2. Map all code paths that use interactive chat mode
3. Ensure desktop app workflow is not affected by chat removal

### Non-Functional Requirements
- Complete analysis before implementation
- No breaking changes to desktop app functionality

## Architecture

### Current Architecture
```
Agent class → CopilotClient → HTTP/2 → GitHub Copilot API
```

### Target Architecture
```
Agent class → LLM Provider Interface → Provider Impl (OpenAI/Anthropic/Copilot)
                                   ↓
                           Config Loader → ~/.clawd/config.json
```

## Related Code Files

### Files to Modify
1. `src/agent/src/index.ts` - Remove interactiveChat function and related code
2. `src/agent/src/api/client.ts` - Refactor to provider interface
3. `src/agent/src/api/config.ts` - Add provider config loading
4. `src/agent/src/agent/agent.ts` - Update to use generic provider
5. `src/worker-loop.ts` - Update token/auth handling

### Files to Create
1. `src/agent/src/api/providers.ts` - Generic provider interface
2. `src/agent/src/api/provider-config.ts` - Config loading utilities

## Implementation Steps

1. [ ] Verify all interactiveChat call sites (should only be in index.ts main())
2. [ ] Verify Agent class usage in desktop app (worker-loop.ts)
3. [ ] Map CopilotClient API surface used by Agent class
4. [ ] Document current token acquisition flow
5. [ ] Verify config.json location and format

## Todo List

- [ ] Identify all interactiveChat references
- [ ] Map all CopilotClient usages
- [ ] Document provider config requirements
- [ ] Create dependency graph

## Success Criteria

- [ ] Complete list of files requiring modification
- [ ] No missing dependencies after refactoring
- [ ] Desktop app workflow preserved
