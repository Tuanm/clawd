# Phase 7: Update Worker Loop

## Overview
- **Priority**: High
- **Status**: completed
- **Description**: Update the worker loop to use the new generic provider system instead of directly using getToken() and creating Agent manually.

## Context Links
- [Phase 6: Update Agent Class](phase-06-update-agent-class.md)

## Key Insights

Current worker-loop.ts (lines 382-411):
```typescript
// Get GitHub token
const token = getToken();
if (!token) {
  this.log("No GitHub token found");
  return { success: false, output: "No GitHub token found..." };
}

// Create agent config
const agentConfig: AgentConfig = {
  model,
  // ...
};

// Create agent
let agent: Agent | null = null;
try {
  agent = new Agent(token, agentConfig);
  // ...
}
```

## Requirements

### Functional Requirements
1. Load provider config from `~/.clawd/config.json`
2. Create appropriate provider instance
3. Pass provider to Agent constructor
4. Maintain same authentication flow

### Changes Needed
- Import provider creation utilities
- Replace `getToken()` with provider instantiation
- Update Agent constructor call

## Architecture

### Integration Flow
```
worker-loop.ts
  → loadProviderConfig() or createProvider()
  → new Agent(provider, config)
  → agent.run()
```

## Related Code Files

### Files to Modify
- `src/worker-loop.ts`

### Key Changes
1. Import provider factory
2. Remove `getToken` import from client.ts
3. Create provider instance
4. Pass provider to Agent

## Implementation Steps

1. [ ] Import provider factory from new modules
2. [ ] Remove getToken import (if not used elsewhere)
3. [ ] Add provider creation before Agent instantiation
4. [ ] Update Agent constructor call
5. [ ] Handle config loading errors gracefully

## Todo List

- [ ] Update imports
- [ ] Add provider creation
- [ ] Pass provider to Agent
- [ ] Test worker loop
- [ ] Verify authentication flow

## Risk Assessment

- **Medium Risk**: Changes worker loop initialization
- Must maintain same authentication behavior
- Desktop app uses this for all agent execution

## Success Criteria

- [ ] Worker loop creates provider correctly
- [ ] Agent receives provider instance
- [ ] Same authentication behavior as before
- [ ] No breaking changes to agent execution
