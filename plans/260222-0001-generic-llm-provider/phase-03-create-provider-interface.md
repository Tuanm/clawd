# Phase 3: Create Generic LLM Provider Interface

## Overview
- **Priority**: High
- **Status**: completed
- **Description**: Create a generic LLM provider interface that abstracts away the specific API implementations, allowing the Agent class to work with any LLM provider.

## Context Links
- [Phase 1: Analyze Dependencies](phase-01-analyze-dependencies.md)

## Key Insights

The current CopilotClient provides:
- `complete(request: CompletionRequest): Promise<CompletionResponse>` - Non-streaming
- `stream(request: CompletionRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent>` - Streaming

These methods must be preserved in the new interface to maintain backward compatibility with the Agent class.

## Requirements

### Functional Requirements
1. Define `LLMProvider` interface with `complete()` and `stream()` methods
2. Support streaming responses with tool calls
3. Support non-streaming responses
4. Maintain same event types as current CopilotClient

### Interface Design

```typescript
// Core types (mirroring current CopilotClient)
interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  };
}

interface CompletionRequest {
  model: string;
  messages: Message[];
  tools?: ToolDefinition[];
  tool_choice?: "auto" | "none" | { type: "function"; function: { name: string } };
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
}

interface CompletionResponse {
  id: string;
  created: number;
  choices: Array<{
    index: number;
    finish_reason: string | null;
    message?: Message;
    delta?: Partial<Message>;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

interface StreamEvent {
  type: "content" | "thinking" | "tool_call" | "done" | "error";
  content?: string;
  toolCall?: ToolCall;
  error?: string;
  response?: CompletionResponse;
}

// Provider interface
interface LLMProvider {
  readonly model: string;

  complete(request: CompletionRequest): Promise<CompletionResponse>;

  stream(request: CompletionRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent>;

  close(): void;
}
```

## Architecture

### Design Pattern
- **Strategy Pattern**: Each provider implementation is a strategy
- Provider selected at runtime based on config
- Same interface for all providers

### Provider Types
1. **OpenAIProvider** - OpenAI-compatible APIs (including MiniMax)
2. **AnthropicProvider** - Anthropic-compatible APIs
3. **CopilotProvider** - GitHub Copilot (HTTP/2)

## Related Code Files

### Files to Create
- `src/agent/src/api/providers.ts` - Generic provider interface

### Files to Modify
- None in this phase

## Implementation Steps

1. [ ] Create `src/agent/src/api/providers.ts`
2. [ ] Define all type interfaces (Message, ToolCall, etc.)
3. [ ] Define `LLMProvider` interface with complete() and stream()
4. [ ] Export types for use by Agent class

## Todo List

- [ ] Create provider types
- [ ] Define LLMProvider interface
- [ ] Export for Agent class consumption

## Risk Assessment

- **Low Risk**: New file, no breaking changes
- Defines interface only, implementations come later

## Success Criteria

- [ ] LLMProvider interface defined
- [ ] All required types exported
- [ ] Compatible with current Agent class usage
