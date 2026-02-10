#!/usr/bin/env bun
/**
 * Claw'd Squad - Assemble your Claw'd agents, conquer together
 *
 * Usage: clawds --id <agent-name> [--caps "cap1,cap2"] [clawd options...]
 *
 * Thin wrapper that spawns `clawd` with the agent-bus plugin configured,
 * enabling peer discovery and inter-agent communication within a project.
 * All unknown flags are passed through to clawd directly.
 *
 * Modes:
 *   --chat    Interactive mode (user provides input via terminal)
 *   --auto    Autonomous mode (agent loops, listening for bus messages)
 *   --prompt  One-shot mode (run a single prompt, then exit)
 *
 * At least one agent in the squad should use --chat to receive user input.
 * Other agents can use --auto to run autonomously, reacting to bus messages.
 *
 * Examples:
 *   clawds --id leader --caps "planning" --yolo --chat
 *   clawds --id backend --caps "db,api" --yolo --auto
 *   clawds --id tester --caps "testing,e2e" --debug -p "Run all tests"
 */

export {}; // Module marker for top-level await

// ============================================================================
// Argument Parsing
// ============================================================================

const argv = process.argv.slice(2);

// Extract clawds-specific args, collect the rest for passthrough
let agentId: string | undefined;
let capabilities: string[] = [];
let autoMode = false;
let showHelp = false;
const passthroughArgs: string[] = [];

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];

  switch (arg) {
    case "--id":
    case "-i":
      agentId = argv[++i];
      break;
    case "--caps":
    case "--capabilities":
    case "-c":
      if (argv[i + 1]) {
        capabilities = argv[++i]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      }
      break;
    case "--auto":
    case "-a":
      autoMode = true;
      break;
    case "--help":
    case "-h":
      showHelp = true;
      break;
    default:
      passthroughArgs.push(arg);
      break;
  }
}

// ============================================================================
// Help
// ============================================================================

if (showHelp) {
  console.log(`Claw'd Squad - Assemble your Claw'd agents, conquer together

Usage: clawds --id <agent-name> [--caps "cap1,cap2"] [clawd options...]

Launch a Claw'd agent on the shared agent bus, enabling peer discovery
and inter-agent communication within the same project.

Squad Options:
  -i, --id <name>             Agent name on the bus (required)
  -c, --caps <capabilities>   Comma-separated capabilities (optional)
  -a, --auto                  Autonomous mode (loop, listen for bus messages)
  -h, --help                  Show this help message

Claw'd Options (passed through):
  -p, --prompt <text>         Run with a prompt
  -m, --model <model>         AI model to use
  -s, --session <name>        Named session
  --chat                      Interactive chat mode
  --yolo                      Auto-approve tool calls
  --debug                     Enable debug logging
  --plugin <json>             Additional plugins (can stack multiple)
  --max-iterations <n>        Max tool call iterations
  ... and all other Claw'd flags

Modes:
  --chat    User provides input via terminal (at least one agent needs this)
  --auto    Agent runs autonomously, polling inbox for messages from squad
  --prompt  One-shot: run a single prompt, then exit

Examples:
  clawds --id leader --caps "planning" --yolo --chat
  clawds --id backend --caps "db,api" --yolo --auto
  clawds --id tester --caps "testing" -p "Run all tests"
  clawds --id backend -m claude-sonnet-4 -p "Optimize queries"

Agents on the same project auto-discover each other via the shared bus
and can exchange messages using agent_send, agent_discover, and more.
`);
  process.exit(0);
}

// ============================================================================
// Validation
// ============================================================================

if (!agentId) {
  console.error("Error: --id is required");
  console.error('Usage: clawds --id <agent-name> [--caps "cap1,cap2"] [clawd options...]');
  console.error("Run 'clawds --help' for more information.");
  process.exit(1);
}

// ============================================================================
// Build plugin config and spawn clawd
// ============================================================================

const pluginConfig = JSON.stringify({
  type: "clawd-agent-bus",
  agent: agentId,
  capabilities,
});

if (autoMode) {
  await runAutoMode(agentId, pluginConfig, passthroughArgs);
} else {
  await runNormalMode(agentId, pluginConfig, passthroughArgs);
}

// ============================================================================
// Normal Mode -- pass-through to clawd (--chat, --prompt, etc.)
// ============================================================================

async function runNormalMode(agent: string, plugin: string, extraArgs: string[]) {
  const clawdArgs = ["--plugin", plugin, ...extraArgs];

  console.log(`[clawds] Agent: ${agent}`);
  if (capabilities.length > 0) {
    console.log(`[clawds] Capabilities: ${capabilities.join(", ")}`);
  }
  console.log(`[clawds] Spawning: clawd --plugin '${plugin}' ${extraArgs.join(" ")}`);
  console.log("");

  const proc = Bun.spawn(["clawd", ...clawdArgs], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["inherit", "inherit", "inherit"],
  });

  const exitCode = await proc.exited;
  process.exit(exitCode);
}

// ============================================================================
// Auto Mode -- autonomous loop, listening for bus messages
// ============================================================================

const AUTO_POLL_INTERVAL = 3000; // 3s between polls when idle
const AUTO_BUSY_INTERVAL = 500; // 0.5s between polls when processing
const AUTO_MAX_IDLE_CYCLES = 0; // 0 = run forever

async function runAutoMode(agent: string, plugin: string, extraArgs: string[]) {
  // Filter out --chat and --prompt from passthrough (auto mode manages its own prompts)
  const filteredArgs = filterAutoArgs(extraArgs);

  console.log(`[clawds] Agent: ${agent} (auto mode)`);
  if (capabilities.length > 0) {
    console.log(`[clawds] Capabilities: ${capabilities.join(", ")}`);
  }
  console.log(`[clawds] Listening for bus messages...`);
  console.log(`[clawds] Press Ctrl+C to stop`);
  console.log("");

  // Handle graceful shutdown
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[clawds] Shutting down auto agent "${agent}"...`);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Session name persists across auto-loop iterations for context continuity
  const sessionName = `auto-${agent}`;
  let idleCycles = 0;

  // Auto loop: spawn clawd with a prompt that checks inbox and acts
  while (!shuttingDown) {
    const autoPrompt = buildAutoPrompt(agent, idleCycles === 0);

    const clawdArgs = ["--plugin", plugin, "--prompt", autoPrompt, "--session", sessionName, ...filteredArgs];

    try {
      const proc = Bun.spawn(["clawd", ...clawdArgs], {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["inherit", "inherit", "inherit"],
      });

      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        console.error(`[clawds] Agent exited with code ${exitCode}, restarting in 5s...`);
        await sleep(5000);
      }
    } catch (err: any) {
      console.error(`[clawds] Error spawning agent: ${err.message}`);
      await sleep(5000);
    }

    if (shuttingDown) break;

    // Wait before next poll
    idleCycles++;
    await sleep(AUTO_POLL_INTERVAL);
  }
}

// ============================================================================
// Auto Mode Helpers
// ============================================================================

function buildAutoPrompt(agent: string, isFirstRun: boolean): string {
  if (isFirstRun) {
    return [
      `You are "${agent}", running in AUTO mode on the Claw'd Squad agent bus.`,
      ``,
      `Your job:`,
      `1. Call agent_discover() to see who else is on the bus`,
      `2. Call agent_receive() to check your inbox for messages`,
      `3. If you have messages, process each one and respond using agent_send()`,
      `4. If you have no messages, just report "No messages" and exit`,
      ``,
      `You are autonomous -- no human is watching. Act on messages from your squad.`,
      `When done processing, exit cleanly. You will be restarted to check again.`,
    ].join("\n");
  }

  return [
    `You are "${agent}" in AUTO mode. Check for new messages:`,
    `1. Call agent_receive() to check your inbox`,
    `2. If messages exist, process them and respond via agent_send()`,
    `3. If no messages, just say "No messages" and exit`,
    ``,
    `Act on any requests from your squad members. When done, exit cleanly.`,
  ].join("\n");
}

function filterAutoArgs(args: string[]): string[] {
  const filtered: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    // Skip --chat (auto mode doesn't use interactive input)
    if (arg === "--chat" || arg === "-c") continue;
    // Skip --prompt / -p and its value (auto mode provides its own prompt)
    if (arg === "--prompt" || arg === "-p") {
      i++; // skip the value too
      continue;
    }
    filtered.push(arg);
  }
  return filtered;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
