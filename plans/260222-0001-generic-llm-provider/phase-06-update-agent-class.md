# Phase 6: Update Agent Class to Use Generic Provider

## Overview
- **Priority**: High
- **Status**: completed
- **Description**: Update the Agent class to accept and use the generic LLMProvider interface instead of hardcoded CopilotClient.

## Context Links
- [Phase 3: Create Provider Interface](phase-03-create-provider-interface.md)
- [Phase 5: Implement Providers](phase-05-implement-providers.md)

## Key Insights

Current Agent class (line 194-214):
```typescript
private client: CopilotClient;

constructor(token: string, config: AgentConfig) {
  this.client = new CopilotClient(token);
  // ...
}
```

The Agent class currently:
1. Creates CopilotClient internally with token
2. Calls `client.stream()` and `client.complete()` directly

## Requirements

### Functional Requirements
1. Accept LLMProvider in Agent constructor instead of token
2. Maintain backward compatibility with existing code
3. Support provider selection via model name or explicit provider

### API Changes
```typescript
// New constructor signature
constructor(provider: LLMProvider, config: AgentConfig);

// Or maintain backward compatibility
constructor(token: string, config: AgentConfig, provider?: LLMProvider);
```

### Strategy
- Accept either token (legacy) or provider instance
- If token provided, create default CopilotProvider
- Allow explicit provider override for testing/custom providers

## Architecture

### Integration Points
- `src/agent/src/agent/agent.ts` - Update constructor and client initialization
- Update import statements to use new provider types
- Remove direct CopilotClient import (use interface instead)

## Related Code Files

### Files to Modify
- `src/agent/src/agent/agent.ts`

### Key Changes
1. Import `LLMProvider` from new interface
2. Change `private client: CopilotClient` to `private client: LLMProvider`
3. Update constructor to accept provider
4. Update `this.client.stream()` and `this.client.complete()` calls

## Implementation Steps

1. [ ] Update imports to use LLMProvider interface
2. [ ] Change client type from CopilotClient to LLMProvider
3. [ ] Update constructor signature
4. [ ] Create default provider if token provided
5. [ ] Verify all client method calls work with interface
6. [ ] Update type exports if needed

## Todo List

- [ ] Update imports
- [ ] Change client type
- [ ] Update constructor
- [ ] Test with default provider
- [ ] Verify streaming works

## Risk Assessment

- **Medium Risk**: Changes Agent class constructor
- Must maintain backward compatibility
- Existing code that passes token should work

## Success Criteria

- [ ] Agent accepts LLMProvider
- [ ] Backward compatible with token
- [ ] Streaming works correctly
- [ ] Non-streaming works correctly
- [ ] All tool calls work as before
