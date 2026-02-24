---
title: "Generic LLM Provider System & Dead Code Removal"
description: "Refactor codebase to support generic LLM providers and remove unused interactive chat code"
status: completed
priority: P1
effort: 8h
branch: main
tags: [refactor, llm, providers, cleanup]
created: 2026-02-22
---

# Plan Summary

This plan implements a generic LLM provider abstraction to replace the hardcoded Copilot API, and removes unused interactive chat code from the CLI module.

## Key Changes

1. **Remove dead code**: `interactiveChat` function in `src/agent/src/index.ts` (lines 1587-1658) - CLI-only feature not needed for desktop app
2. **Create generic provider interface**: Abstract LLM client that supports multiple providers
3. **Implement provider implementations**: OpenAI-compatible, Anthropic-compatible, Copilot
4. **Read config from `~/.clawd/config.json`**: Use existing provider configurations
5. **Update Agent class**: Use generic provider instead of hardcoded CopilotClient
6. **Update Worker Loop**: Use new provider system

## Phases

- [Phase 1: Analyze Codebase for Dead Code & Dependencies](phase-01-analyze-dependencies.md)
- [Phase 2: Remove Interactive Chat Mode Code](phase-02-remove-interactive-chat.md)
- [Phase 3: Create Generic LLM Provider Interface](phase-03-create-provider-interface.md)
- [Phase 4: Implement Provider Config Loader](phase-04-implement-config-loader.md)
- [Phase 5: Implement Provider Implementations](phase-05-implement-providers.md)
- [Phase 6: Update Agent Class](phase-06-update-agent-class.md)
- [Phase 7: Update Worker Loop](phase-07-update-worker-loop.md)
- [Phase 8: Testing & Validation](phase-08-testing.md)

## Dependencies

- Phase 1 (analyze) must complete before Phase 2 (remove)
- Phase 3-5 can run in parallel
- Phase 6 depends on Phase 3-5
- Phase 7 depends on Phase 6
- Phase 8 depends on all previous phases

## Success Criteria

1. All existing functionality preserved (Agent runs with new provider system)
2. Config loaded from `~/.clawd/config.json` for provider selection
3. Supports anthropic (MiniMax-compatible), openai, and copilot providers
4. No compilation errors after refactoring
5. Desktop app runs correctly with new provider system

---

# Plan Files

| Phase | File | Description |
|-------|------|-------------|
| 1 | [phase-01-analyze-dependencies.md](phase-01-analyze-dependencies.md) | Analyze codebase for dead code & dependencies |
| 2 | [phase-02-remove-interactive-chat.md](phase-02-remove-interactive-chat.md) | Remove unused interactive chat mode code |
| 3 | [phase-03-create-provider-interface.md](phase-03-create-provider-interface.md) | Create generic LLM provider interface |
| 4 | [phase-04-implement-config-loader.md](phase-04-implement-config-loader.md) | Implement config loader from ~/.clawd/config.json |
| 5 | [phase-05-implement-providers.md](phase-05-implement-providers.md) | Implement provider implementations |
| 6 | [phase-06-update-agent-class.md](phase-06-update-agent-class.md) | Update Agent class to use generic provider |
| 7 | [phase-07-update-worker-loop.md](phase-07-update-worker-loop.md) | Update worker loop to use new provider |
| 8 | [phase-08-testing.md](phase-08-testing.md) | Testing & validation |
