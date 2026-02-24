# Phase 4: Implement Provider Config Loader

## Overview
- **Priority**: High
- **Status**: completed
- **Description**: Implement config loading from `~/.clawd/config.json` to select and configure LLM providers at runtime.

## Context Links
- [Phase 3: Create Provider Interface](phase-03-create-provider-interface.md)

## Key Insights

The config file already exists at `~/.clawd/config.json` with the following structure:
```json
{
  "providers": {
    "anthropic": {
      "base_url": "https://api.minimax.io/anthropic",
      "api_key": "sk-...",
      "models": { "default": "MiniMax-M2.1", "sonnet": "MiniMax-M2.1", "opus": "MiniMax-M2.1" }
    },
    "openai": {
      "base_url": "https://api.openai.com/v1",
      "api_key": "your-api-key",
      "models": { "default": "gpt-4o" }
    },
    "copilot": {
      "token": "github_pat_..."
    }
  }
}
```

## Requirements

### Functional Requirements
1. Load config from `~/.clawd/config.json`
2. Parse provider configurations
3. Support provider selection via environment variable or config
4. Provide default fallback if config missing

### Config Loading Strategy
1. Check `CLAWD_PROVIDER` env var for explicit selection
2. Fall back to config file's default provider
3. Default to "anthropic" if no config

## Architecture

### Config Types
```typescript
interface ProviderConfig {
  // Common
  api_key?: string;
  base_url?: string;
  models?: {
    default?: string;
    sonnet?: string;
    opus?: string;
    [key: string]: string | undefined;
  };
}

interface Config {
  providers: {
    anthropic?: ProviderConfig;
    openai?: ProviderConfig;
    copilot?: { token?: string };
  };
  defaultProvider?: string;
}
```

### Loading Flow
```
Load config → Select provider → Instantiate provider → Return to caller
```

## Related Code Files

### Files to Create
- `src/agent/src/api/provider-config.ts` - Config loading utilities

### Files to Modify
- None in this phase

## Implementation Steps

1. [ ] Create `src/agent/src/api/provider-config.ts`
2. [ ] Define config types
3. [ ] Implement `loadConfig()` function
4. [ ] Implement `getProviderConfig()` function
5. [ ] Add environment variable override support

## Todo List

- [ ] Create config types
- [ ] Implement loadConfig function
- [ ] Add env var override support
- [ ] Export for provider instantiation

## Risk Assessment

- **Low Risk**: New file, no breaking changes
- Config loading only, no API calls

## Success Criteria

- [ ] Config loads from ~/.clawd/config.json
- [ ] Provider selection works
- [ ] Environment variable override works
- [ ] Graceful fallback when config missing
