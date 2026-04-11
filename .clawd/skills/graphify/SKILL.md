---
name: graphify
description: Build a knowledge graph of the current codebase using Graphify, then enable the Graphify MCP server for graph queries.
triggers: [graphify, graph, codebase graph, knowledge graph]
argument-hint: "[path]"
allowed-tools: [bash]
---

# Graphify — Build Codebase Knowledge Graph

Build a knowledge graph of the project using `graphify`, then activate the MCP server so agents can query it.

## Steps

1. **Check uv is available**
   ```bash
   which uv || (echo "uv not found — install from https://docs.astral.sh/uv/" && exit 1)
   ```

2. **Build the graph** (installs graphifyy via uvx, runs the pipeline)
   ```bash
   uvx graphifyy "$PROJECT_ROOT" 2>&1
   ```
   - First run downloads the `graphifyy` package (~30s) and analyzes the codebase
   - Subsequent runs are incremental (only changed files)
   - Output goes to `graphify-out/` in the project root

3. **Report to the user**
   - Show the stats summary from stdout (node/edge counts, community count)
   - Mention that the **Graphify MCP server** (`graphify` catalog entry) can now be enabled via Settings → MCP Servers → Browse to let agents call `query_graph`, `get_node`, `get_neighbors`, `get_community`, `god_nodes`, `graph_stats`, `shortest_path`

## Notes
- The PyPI package is `graphifyy` (double y) — this is the current published name
- `uvx` installs into an isolated environment; no global pip install needed
- If `$PROJECT_ROOT` is not set, use the directory of the current channel's project
- The MCP server reads `graphify-out/graph.json` — always build first before enabling the MCP server
