/**
 * MCP Server Config Validation
 *
 * Shared validation utilities for MCP server configurations.
 * Used by config loader (alias merge at startup) and import endpoint.
 */

import dns from "node:dns";
import type { CCMcpServerConfig, MCPServerConfig } from "./agent/api/providers";

// ============================================================================
// Constants
// ============================================================================

/** Commands allowed for stdio MCP servers */
export const ALLOWED_COMMANDS = ["npx", "node", "bun", "python3", "python", "uvx", "docker", "mcp-language-server"];

/** Env keys blocked for security (injection vectors) */
const BLOCKED_ENV_KEYS = new Set([
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "NODE_OPTIONS",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "DYLD_FALLBACK_LIBRARY_PATH",
  "PYTHONPATH",
  "NODE_PATH",
  "PYTHONSTARTUP",
  "JAVA_TOOL_OPTIONS",
  "_JAVA_OPTIONS",
  "GIT_SSH_COMMAND",
  "GIT_PROXY_COMMAND",
  "PERL5OPT",
  "NPM_CONFIG_globalconfig",
]);

/** SSRF-blocked hostname/IP patterns */
const SSRF_BLOCKED: RegExp[] = [
  /^localhost$/i,
  /^127\.\d+\.\d+\.\d+$/,
  /^10\.\d+\.\d+\.\d+$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,
  /^192\.168\.\d+\.\d+$/,
  /^169\.254\.\d+\.\d+$/,
  /^(::1|\[::1\])$/,
  /^0\.0\.0\.0$/,
  /^f[cd][0-9a-f]{2}:/i, // ULA fc00::/7 (covers both fc::/8 and fd::/8)
  /^fe[89ab][0-9a-f]:/i, // Link-local fe80::/10
  /^::ffff:(10|127|172\.(1[6-9]|2\d|3[01])|192\.168)\./i, // IPv4-mapped private
];

function isBlockedHost(host: string): boolean {
  // Strip brackets from IPv6 addresses (e.g. [fe80::1] → fe80::1) for pattern matching
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return SSRF_BLOCKED.some((p) => p.test(bare) || p.test(host));
}

// ============================================================================
// Sync validation (no DNS — safe to call in synchronous config loader)
// ============================================================================

/**
 * Validate a single MCP server config synchronously.
 * Returns an error message string on failure, or null if valid.
 */
export function validateServerConfigSync(name: string, config: MCPServerConfig): string | null {
  const isHttp = config.transport === "http" || (config.url != null && !config.command);

  if (isHttp) {
    if (!config.url) return `HTTP server "${name}" requires a url`;

    let parsed: URL;
    try {
      parsed = new URL(config.url);
    } catch {
      return `Server "${name}" has an invalid URL: ${config.url}`;
    }

    if (parsed.protocol === "file:") {
      return `Server "${name}" uses a blocked file:// URL`;
    }

    const hostname = parsed.hostname;
    if (isBlockedHost(hostname)) {
      return `Server "${name}" URL points to a blocked/private address: ${hostname}`;
    }
  } else {
    // stdio
    if (!config.command) return `Stdio server "${name}" requires a command`;

    // Extract the base executable name (strip paths)
    const baseCmd = config.command.split(/[/\\]/).pop() ?? config.command;
    if (!ALLOWED_COMMANDS.includes(baseCmd)) {
      return `Server "${name}" uses a disallowed command "${baseCmd}". Allowed: ${ALLOWED_COMMANDS.join(", ")}`;
    }
  }

  // Check env key blocklist
  if (config.env) {
    for (const key of Object.keys(config.env)) {
      if (BLOCKED_ENV_KEYS.has(key) || key.startsWith("DYLD_")) {
        return `Server "${name}" sets a blocked environment variable: ${key}`;
      }
    }
  }

  return null;
}

// ============================================================================
// Async validation (includes DNS rebinding defense)
// ============================================================================

/**
 * Fully validate a single MCP server config (sync checks + DNS rebinding defense).
 * Throws an Error with a descriptive message on failure.
 */
export async function validateServerConfig(name: string, config: MCPServerConfig): Promise<void> {
  const syncErr = validateServerConfigSync(name, config);
  if (syncErr) throw new Error(syncErr);

  // DNS rebinding defense for HTTP servers
  const isHttp = config.transport === "http" || (config.url != null && !config.command);
  if (isHttp && config.url) {
    const parsed = new URL(config.url); // already validated above
    const hostname = parsed.hostname;

    // Only resolve non-IP hostnames
    const isIpv4 = /^\d+\.\d+\.\d+\.\d+$/.test(hostname);
    const isIpv6 = hostname.startsWith("[") || hostname.includes(":");
    if (!isIpv4 && !isIpv6) {
      const [v4result, v6result] = await Promise.allSettled([
        new Promise<string[]>((resolve, reject) =>
          dns.resolve4(hostname, (err, addrs) => (err ? reject(err) : resolve(addrs))),
        ),
        new Promise<string[]>((resolve, reject) =>
          dns.resolve6(hostname, (err, addrs) => (err ? reject(err) : resolve(addrs))),
        ),
      ]);
      const allAddrs = [
        ...(v4result.status === "fulfilled" ? v4result.value : []),
        ...(v6result.status === "fulfilled" ? v6result.value : []),
      ];

      // Fail-closed: if DNS completely failed, block as precaution
      if (allAddrs.length === 0) {
        console.warn(`[mcp-validation] DNS resolution failed for ${hostname} — blocking as precaution`);
        throw new Error(`DNS resolution failed for hostname: ${hostname}`);
      }

      for (const addr of allAddrs) {
        // Bracket IPv6 addresses for isBlockedHost pattern matching
        const hostToCheck = addr.includes(":") ? `[${addr}]` : addr;
        if (isBlockedHost(hostToCheck) || isBlockedHost(addr)) {
          throw new Error(`Server "${name}" URL resolves to a blocked/private address: ${addr}`);
        }
      }
    }
  }
}

// ============================================================================
// CC Format Conversion
// ============================================================================

/**
 * Convert Claude Desktop / CC SDK `mcpServers` format to Claw'd internal MCPServerConfig.
 *
 * Field mapping:
 *   command / args / env  → direct (stdio)
 *   url / headers / env   → direct (http)
 *   type: "http"          → transport: "http"  (CC SDK style)
 *
 * Detects HTTP by: explicit type:"http", or url present without command.
 */
export function convertCCFormatToInternal(
  mcpServers: Record<string, CCMcpServerConfig>,
): Record<string, MCPServerConfig> {
  const result: Record<string, MCPServerConfig> = {};

  for (const [name, entry] of Object.entries(mcpServers)) {
    if (!entry || typeof entry !== "object") continue;

    const isHttp = entry.type === "http" || (entry.url != null && !entry.command && entry.type !== "stdio");

    if (isHttp) {
      const cfg: MCPServerConfig = { transport: "http", url: entry.url };
      if (entry.headers) cfg.headers = entry.headers;
      if (entry.env) cfg.env = entry.env;
      result[name] = cfg;
    } else {
      const cfg: MCPServerConfig = { transport: "stdio", command: entry.command };
      if (entry.args?.length) cfg.args = entry.args;
      if (entry.env) cfg.env = entry.env;
      result[name] = cfg;
    }
  }

  return result;
}
