/**
 * Custom error classes for Claw'd.
 *
 * Hierarchy: ClawdError → AgentError / ProviderError / TimeoutError
 */

export class ClawdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClawdError";
  }
}

export class AgentError extends ClawdError {
  constructor(message: string) {
    super(message);
    this.name = "AgentError";
  }
}

export class ProviderError extends ClawdError {
  constructor(
    message: string,
    public provider: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export class TimeoutError extends ClawdError {
  constructor(
    message: string,
    public timeoutMs: number,
  ) {
    super(message);
    this.name = "TimeoutError";
  }
}
