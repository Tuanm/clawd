/**
 * Agentic Loop - Core loop logic shared between Agent and SubAgent
 *
 * Handles:
 * - Iteration management with max iterations
 * - Message array for LLM context
 * - Tool execution abstraction
 * - Plugin lifecycle hooks
 * - Abort/interrupt handling
 */

import { EventEmitter } from "node:events";
import type { CompletionResponse, Message, ToolCall, ToolDefinition } from "../api/client";
import type { ToolResult } from "../tools/definitions";
import { isDebugEnabled } from "../utils/debug";

// ============================================================================
// Types
// ============================================================================

export type LoopStatus = "idle" | "running" | "waiting" | "completed" | "failed" | "aborted";

export interface LoopConfig {
  /** Maximum iterations before stopping */
  maxIterations: number;
  /** Model to use for completions */
  model: string;
  /** System prompt */
  systemPrompt: string;
  /** Enable verbose logging */
  verbose?: boolean;
  /**
   * Enable parallel execution of read-only tool calls within a single turn.
   * Read-only tools (marked with readOnly: true) will be executed concurrently
   * via Promise.all. Write/state-changing tools are always executed sequentially.
   * Default: true
   */
  parallelTools?: boolean;
}

export interface LoopResult {
  success: boolean;
  content?: string;
  error?: string;
  iterations: number;
  toolCalls: number;
}

export interface ToolExecutionResult {
  tool_call_id: string;
  content: string;
  success: boolean;
}

/**
 * Abstraction for LLM completion - allows streaming or non-streaming
 */
export interface CompletionProvider {
  complete(
    messages: Message[],
    tools: ToolDefinition[],
    model: string,
  ): Promise<{ message: Message; response?: CompletionResponse }>;
}

/**
 * Abstraction for tool execution
 */
export interface ToolExecutor {
  /** Get available tool definitions */
  getTools(): ToolDefinition[];
  /** Execute a tool call, return result */
  execute(toolCall: ToolCall): Promise<ToolExecutionResult>;
}

/**
 * Plugin hooks for the agentic loop
 */
export interface LoopPluginHooks {
  onStart?(task: string): Promise<void>;
  onIteration?(iteration: number): Promise<void>;
  onToolCalls?(toolCalls: ToolCall[]): Promise<void>;
  onToolResult?(toolName: string, result: ToolExecutionResult): Promise<void>;
  onResponse?(content: string): Promise<void>;
  onComplete?(result: LoopResult): Promise<void>;
  onAbort?(): Promise<void>;
  /** Check for interrupt, return message to inject if interrupted */
  checkInterrupt?(): Promise<string | null>;
}

// ============================================================================
// Agentic Loop
// ============================================================================

export class AgenticLoop extends EventEmitter {
  private config: LoopConfig;
  private completionProvider: CompletionProvider;
  private toolExecutor: ToolExecutor;
  private hooks: LoopPluginHooks;

  private status: LoopStatus = "idle";
  private iterations = 0;
  private toolCallCount = 0;
  private aborted = false;
  private messages: Message[] = [];

  constructor(
    config: LoopConfig,
    completionProvider: CompletionProvider,
    toolExecutor: ToolExecutor,
    hooks: LoopPluginHooks = {},
  ) {
    super();
    this.config = config;
    this.completionProvider = completionProvider;
    this.toolExecutor = toolExecutor;
    this.hooks = hooks;
  }

  // ============================================================================
  // Getters
  // ============================================================================

  getStatus(): LoopStatus {
    return this.status;
  }

  getIterations(): number {
    return this.iterations;
  }

  getToolCallCount(): number {
    return this.toolCallCount;
  }

  getMessages(): Message[] {
    return [...this.messages];
  }

  isAborted(): boolean {
    return this.aborted;
  }

  // ============================================================================
  // Control
  // ============================================================================

  abort(): void {
    this.aborted = true;
  }

  // ============================================================================
  // Run Loop
  // ============================================================================

  async run(task: string): Promise<LoopResult> {
    this.status = "running";
    this.iterations = 0;
    this.toolCallCount = 0;
    this.aborted = false;
    this.emit("status", this.status);

    // Initialize messages
    this.messages = [
      { role: "system", content: this.config.systemPrompt },
      { role: "user", content: task },
    ];

    // Notify start
    await this.hooks.onStart?.(task);

    try {
      let lastContent = "";

      while (this.iterations < this.config.maxIterations && !this.aborted) {
        this.iterations++;
        this.emit("iteration", this.iterations);

        // Notify iteration
        await this.hooks.onIteration?.(this.iterations);

        // Check abort before LLM call
        if (this.aborted) break;

        // Check for interrupt
        const interrupt = await this.hooks.checkInterrupt?.();
        if (interrupt) {
          // Inject interrupt as new user message (truncate to prevent context overflow)
          const intMarker = "\n\n[TRUNCATED — interrupt message too long]";
          const truncatedInterrupt =
            interrupt.length > 10000
              ? (() => {
                  let cp = 10000 - intMarker.length;
                  if (
                    cp > 0 &&
                    cp < interrupt.length &&
                    interrupt.charCodeAt(cp - 1) >= 0xd800 &&
                    interrupt.charCodeAt(cp - 1) <= 0xdbff
                  )
                    cp--;
                  return interrupt.slice(0, cp) + intMarker;
                })()
              : interrupt;
          this.messages.push({ role: "user", content: truncatedInterrupt });
        }

        // Get tools
        const tools = this.toolExecutor.getTools();

        // Call LLM
        const { message: assistantMessage } = await this.completionProvider.complete(
          this.messages,
          tools,
          this.config.model,
        );

        // Debug: Log LLM response
        if (isDebugEnabled()) {
          console.log(`[LLM] Response:`, JSON.stringify(assistantMessage, null, 2));
        }

        // Check abort after LLM call
        if (this.aborted) break;

        // Add assistant message to context
        this.messages.push(assistantMessage);

        // Check for tool calls
        if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
          this.status = "waiting";
          this.emit("status", this.status);

          // Notify tool calls
          await this.hooks.onToolCalls?.(assistantMessage.tool_calls);

          // Execute tools — parallel for read-only, sequential for write tools
          const parallelEnabled = this.config.parallelTools !== false;
          if (parallelEnabled && assistantMessage.tool_calls.length > 1) {
            // Split tool calls into read-only and write groups (preserving order)
            const toolDefs = new Map(tools.map((t) => [t.function.name, t]));
            const readOnlyCalls: typeof assistantMessage.tool_calls = [];
            const writeCalls: typeof assistantMessage.tool_calls = [];

            for (const tc of assistantMessage.tool_calls) {
              const def = toolDefs.get(tc.function.name);
              if (def?.readOnly) {
                readOnlyCalls.push(tc);
              } else {
                writeCalls.push(tc);
              }
            }

            // Execute read-only tools in parallel
            const readOnlyResults = await Promise.all(
              readOnlyCalls.map(async (toolCall) => {
                const result = await this.toolExecutor.execute(toolCall);
                this.toolCallCount++;
                await this.hooks.onToolResult?.(toolCall.function.name, result);
                return { toolCall, result };
              }),
            );

            // Execute write tools sequentially
            const writeResults: Array<{
              toolCall: (typeof assistantMessage.tool_calls)[0];
              result: ToolExecutionResult;
            }> = [];
            for (const toolCall of writeCalls) {
              const result = await this.toolExecutor.execute(toolCall);
              this.toolCallCount++;
              await this.hooks.onToolResult?.(toolCall.function.name, result);
              writeResults.push({ toolCall, result });
            }

            // Add results to messages in original call order (important for LLM context)
            const allResults = new Map([
              ...readOnlyResults.map(({ toolCall, result }) => [toolCall.id, result] as const),
              ...writeResults.map(({ toolCall, result }) => [toolCall.id, result] as const),
            ]);
            for (const toolCall of assistantMessage.tool_calls) {
              const result = allResults.get(toolCall.id)!;
              this.messages.push({
                role: "tool",
                content: result.content,
                tool_call_id: result.tool_call_id,
              });
            }
          } else {
            // Sequential execution (single tool or parallel disabled)
            for (const toolCall of assistantMessage.tool_calls) {
              const result = await this.toolExecutor.execute(toolCall);
              this.toolCallCount++;

              // Notify tool result
              await this.hooks.onToolResult?.(toolCall.function.name, result);

              // Add tool result to messages
              this.messages.push({
                role: "tool",
                content: result.content,
                tool_call_id: result.tool_call_id,
              });
            }
          }

          this.status = "running";
          this.emit("status", this.status);
        } else {
          // No tool calls = task complete
          lastContent = assistantMessage.content || "";

          // Notify response
          if (lastContent) {
            await this.hooks.onResponse?.(lastContent);
          }
          break;
        }
      }

      // Determine final status
      if (this.aborted) {
        this.status = "aborted";
        await this.hooks.onAbort?.();
      } else {
        this.status = "completed";
      }
      this.emit("status", this.status);

      const result: LoopResult = {
        success: !this.aborted,
        content: lastContent,
        iterations: this.iterations,
        toolCalls: this.toolCallCount,
      };

      await this.hooks.onComplete?.(result);
      return result;
    } catch (error: unknown) {
      this.status = "failed";
      this.emit("status", this.status);

      const result: LoopResult = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        iterations: this.iterations,
        toolCalls: this.toolCallCount,
      };

      await this.hooks.onComplete?.(result);
      return result;
    }
  }

  // ============================================================================
  // Message Management
  // ============================================================================

  /**
   * Add a message to the context (for external injection)
   */
  addMessage(message: Message): void {
    this.messages.push(message);
  }

  /**
   * Replace messages (for context truncation)
   */
  setMessages(messages: Message[]): void {
    this.messages = messages;
  }
}

// ============================================================================
// Utility: Parse Tool Arguments
// ============================================================================

export function parseToolArguments(argsString: string | undefined): { args: Record<string, any>; error?: string } {
  try {
    const args = JSON.parse(argsString || "{}");
    return { args };
  } catch (err: unknown) {
    return { args: {}, error: `Failed to parse arguments: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ============================================================================
// Utility: Format Tool Result
// ============================================================================

export function formatToolResult(result: ToolResult): string {
  if (result.success) {
    return result.output;
  }
  return `Error: ${result.error || "Unknown error"}`;
}
