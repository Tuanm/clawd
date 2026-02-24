# Phase 5: Implement Provider Implementations

## Overview
- **Priority**: High
- **Status**: completed
- **Description**: Implement the concrete provider classes that implement the LLMProvider interface for OpenAI-compatible, Anthropic-compatible, and Copilot APIs.

## Context Links
- [Phase 3: Create Provider Interface](phase-03-create-provider-interface.md)
- [Phase 4: Implement Config Loader](phase-04-implement-config-loader.md)

## Key Insights

The existing `CopilotClient` in `src/agent/src/api/client.ts` already implements most of what's needed. We will:
1. Refactor existing client to implement the new interface
2. Create factory function for provider selection

## Requirements

### Provider Implementations

#### 1. CopilotProvider
- Uses existing CopilotClient logic (HTTP/2)
- Requires GitHub token
- API URL: `https://api.githubcopilot.com`

#### 2. OpenAIProvider (or Anthropic-compatible)
- Uses HTTP/1.1 fetch
- Requires API key
- Base URL from config (e.g., `https://api.minimax.io/anthropic` for MiniMax)
- Supports OpenAI-compatible chat completions

#### 3. AnthropicProvider
- Native Anthropic API format
- Requires API key
- Uses Anthropic's Messages API

### Factory Function
```typescript
function createProvider(
  providerType: "openai" | "anthropic" | "copilot",
  config: ProviderConfig
): LLMProvider;
```

## Architecture

### Implementation Strategy
- **CopilotProvider**: Refactor existing CopilotClient to implement LLMProvider
- **OpenAIProvider**: New implementation using fetch
- **AnthropicProvider**: New implementation using fetch with Anthropic format

### Shared Logic
- Rate limiting (429 handling with retry)
- Streaming support
- Error handling

## Related Code Files

### Files to Modify
- `src/agent/src/api/client.ts` - Refactor to implement LLMProvider

### Files to Create
- `src/agent/src/api/factory.ts` - Provider factory function

## Implementation Steps

1. [ ] Refactor CopilotClient to implement LLMProvider interface
2. [ ] Create OpenAIProvider class
3. [ ] Create AnthropicProvider class
4. [ ] Create provider factory function
5. [ ] Update exports

## Todo List

- [ ] Refactor CopilotClient to LLMProvider
- [ ] Create OpenAIProvider
- [ ] Create AnthropicProvider
- [ ] Create factory function
- [ ] Test provider selection

## Risk Assessment

- **Medium Risk**: Changes existing client implementation
- Must maintain backward compatibility
- Extensive testing required

## Security Considerations
- API keys stored in config file (user's home directory)
- No hardcoded credentials
- Token acquisition remains the same

## Success Criteria

- [ ] All three providers implement LLMProvider
- [ ] Factory function works correctly
- [ ] Streaming works for all providers
- [ ] Rate limiting works correctly
- [ ] No breaking changes to Agent class
