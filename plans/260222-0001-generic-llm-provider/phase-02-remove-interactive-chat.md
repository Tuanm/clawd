# Phase 2: Remove Interactive Chat Mode Code

## Overview
- **Priority**: High
- **Status**: completed
- **Description**: Remove the unused interactive chat mode (readline-based CLI) from the codebase. This is dead code for the desktop app use case.

## Context Links
- [Phase 1: Analyze Dependencies](phase-01-analyze-dependencies.md)

## Key Insights

The `interactiveChat` function (lines 1587-1658 in `src/agent/src/index.ts`) is:
- CLI-only feature using node:readline
- Only invoked when `--chat` flag is passed or when resuming without prompt
- NOT used by the desktop app which uses WebSocket/UI communication

## Requirements

### Functional Requirements
1. Remove `interactiveChat` function entirely
2. Remove `--chat` CLI argument handling
3. Remove related readline imports
4. Update help text to remove chat mode mention
5. Keep single-prompt and serve modes functional

### Code to Remove
- `interactiveChat` function definition (lines 1587-1658)
- `-c, --chat` argument in `Args` interface and `parseArgs()`
- Chat mode help text in `showHelp()`
- Readline import (if only used for chat)

## Related Code Files

### Files to Modify
- `src/agent/src/index.ts`

### Code Sections to Remove

1. **Args interface** - Remove `chat: boolean` property
2. **parseArgs()** - Remove `-c, --chat` case
3. **showHelp()** - Remove chat mode from help text
4. **interactiveChat function** - Remove entire function (1587-1658)
5. **main()** - Update condition `if (args.chat || args.resume)` - chat mode no longer applies

## Implementation Steps

1. [ ] Remove `chat: boolean` from Args interface
2. [ ] Remove `-c, --chat` case in parseArgs()
3. [ ] Remove chat mode from showHelp()
4. [ ] Remove entire interactiveChat function
5. [ ] Update main() logic - remove chat condition
6. [ ] Verify no readline imports remain (or only if needed elsewhere)

## Todo List

- [ ] Remove chat from Args interface
- [ ] Remove -c, --chat from parseArgs
- [ ] Remove chat from showHelp
- [ ] Remove interactiveChat function
- [ ] Update main() logic
- [ ] Verify no compilation errors

## Risk Assessment

- **Low Risk**: CLI mode only, desktop app unaffected
- Only removes unused code paths
- Single-prompt mode remains fully functional

## Success Criteria

- [ ] `interactiveChat` function completely removed
- [ ] No --chat flag in CLI
- [ ] Single prompt mode works correctly
- [ ] Proxy server mode works correctly
- [ ] No compilation errors
