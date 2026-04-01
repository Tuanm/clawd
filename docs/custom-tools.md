# Custom Tools

Custom tools let you extend agents with project-specific capabilities. Each tool is a script (bash, Python, TypeScript, or JavaScript) that receives JSON arguments on stdin and writes results to stdout. Tools run in a sandboxed environment.

---

## Quick Start

### Create a Tool Manually

Create a folder at `{projectRoot}/.clawd/tools/{tool-id}/` with two files:

**`tool.json`** — Tool metadata:

```json
{
  "name": "check-deps",
  "description": "Check for outdated npm dependencies",
  "parameters": {
    "path": {
      "type": "string",
      "description": "Path to package.json"
    }
  },
  "required": ["path"],
  "entrypoint": "check.sh",
  "interpreter": "bash",
  "timeout": 30
}
```

**`check.sh`** — Tool script:

```bash
#!/bin/bash
ARGS=$(cat)
PKG_PATH=$(echo "$ARGS" | jq -r '.path')
cd "$(dirname "$PKG_PATH")" && bun outdated 2>&1 || echo "No outdated deps"
```

Agents in this project automatically discover the tool as `ct_check-deps` on their next session.

### Create a Tool via Chat

Ask any agent in a channel:

> "Create a custom tool called `lint-sql` that takes a `file` parameter and runs sqlfluff lint on it."

The agent uses the built-in `custom_script` management tool to create the folder, `tool.json`, and script for you.

---

## Tool Metadata (tool.json)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `name` | string | Yes | — | Display name (lowercase, alphanumeric, hyphens, underscores, max 64 chars) |
| `description` | string | Yes | — | What the tool does (shown to agents in tool list) |
| `parameters` | object | No | `{}` | Parameter definitions (see below) |
| `required` | string[] | No | `[]` | Required parameter names |
| `entrypoint` | string | Yes | — | Script filename (no path separators) |
| `interpreter` | string | No | auto-detect | `bash`, `sh`, `python3`, `python`, `bun`, or `node` |
| `timeout` | number | No | `30` | Execution timeout in seconds (1–300) |

### Parameter Definition

Each key in `parameters` maps to a parameter object:

```json
{
  "parameters": {
    "query": {
      "type": "string",
      "description": "SQL query to validate"
    },
    "format": {
      "type": "string",
      "description": "Output format",
      "enum": ["json", "text", "csv"]
    },
    "verbose": {
      "type": "boolean",
      "description": "Enable verbose output"
    }
  }
}
```

Supported types: `string`, `number`, `boolean`, `array`, `object`.

---

## Execution Model

1. Agent calls `ct_<tool-id>` with arguments
2. Arguments are serialized as JSON and piped to the script via **stdin**
3. Script writes results to **stdout** (captured as tool output)
4. **stderr** is captured separately (included in error output if script fails)
5. Exit code 0 = success, non-zero = failure

### Reading Arguments in Your Script

**Bash:**

```bash
#!/bin/bash
ARGS=$(cat)
NAME=$(echo "$ARGS" | jq -r '.name')
COUNT=$(echo "$ARGS" | jq -r '.count // 10')
echo "Hello $NAME, count=$COUNT"
```

**Python:**

```python
#!/usr/bin/env python3
import json, sys

args = json.load(sys.stdin)
name = args.get("name", "world")
print(f"Hello {name}")
```

**TypeScript (Bun):**

```typescript
const args = await Bun.stdin.json();
console.log(`Hello ${args.name}`);
```

**JavaScript (Node/Bun):**

```javascript
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const args = JSON.parse(Buffer.concat(chunks).toString());
console.log(`Hello ${args.name}`);
```

---

## Output Limits

| Stream | Limit | Behavior when exceeded |
|--------|-------|----------------------|
| stdout | 64 KB | Truncated with `[OUTPUT TRUNCATED...]` marker |
| stderr | 16 KB | Truncated with `[OUTPUT TRUNCATED...]` marker |

Keep tool output concise. If your tool produces large output, summarize or filter it in the script before printing.

---

## Sandbox Restrictions

Custom tools always run sandboxed:

| Access | Scope |
|--------|-------|
| **Read/Write** | Project root (excluding `.clawd/`), `/tmp` |
| **Read-only** | `.clawd/skills/`, `.clawd/tools/`, `/usr`, `/bin`, `/lib`, `/etc` |
| **Blocked** | Home directory, `.clawd/` config files, network (unless project allows) |

---

## Management via `custom_script`

Agents have a built-in `custom_script` tool with 6 modes:

| Mode | Description |
|------|-------------|
| `list` | Show all custom tools in the project |
| `add` | Create a new tool (tool.json + script) |
| `edit` | Update an existing tool's metadata or script |
| `delete` | Remove a tool and its directory |
| `view` | Display tool metadata and source code |
| `execute` | Run a tool directly (used internally) |

### Validation Rules

- **Name format:** `/^[a-z0-9][a-z0-9_-]{0,63}$/`
- **No collisions:** Cannot use names of built-in tools (76 reserved names)
- **Entrypoint:** Filename only — no path separators (`/`, `\`)
- **Interpreter:** Must be one of: `bash`, `sh`, `python3`, `python`, `bun`, `node`
- **Content size:** Entrypoint script must be ≤ 1 MB

---

## Auto-Detection of Interpreter

If `interpreter` is omitted from `tool.json`, it is inferred from the entrypoint file extension:

| Extension | Interpreter |
|-----------|-------------|
| `.sh` | `bash` |
| `.py` | `python3` |
| `.ts` | `bun` |
| `.js` | `bun` |

---

## Examples

### API Health Checker

```
.clawd/tools/api-health/
├── tool.json
└── check.sh
```

**tool.json:**
```json
{
  "name": "api-health",
  "description": "Check if an API endpoint is responding",
  "parameters": {
    "url": { "type": "string", "description": "API endpoint URL" },
    "method": { "type": "string", "description": "HTTP method", "enum": ["GET", "POST", "HEAD"] }
  },
  "required": ["url"],
  "entrypoint": "check.sh",
  "timeout": 15
}
```

**check.sh:**
```bash
#!/bin/bash
ARGS=$(cat)
URL=$(echo "$ARGS" | jq -r '.url')
METHOD=$(echo "$ARGS" | jq -r '.method // "GET"')
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X "$METHOD" "$URL" --max-time 10)
echo "Status: $HTTP_CODE for $METHOD $URL"
[ "$HTTP_CODE" -ge 200 ] && [ "$HTTP_CODE" -lt 400 ] && echo "OK" || echo "FAILED"
```

### Database Query Tool

```
.clawd/tools/query-db/
├── tool.json
└── query.py
```

**tool.json:**
```json
{
  "name": "query-db",
  "description": "Run a read-only SQL query against the dev database",
  "parameters": {
    "sql": { "type": "string", "description": "SQL SELECT query to execute" },
    "limit": { "type": "number", "description": "Max rows to return" }
  },
  "required": ["sql"],
  "entrypoint": "query.py",
  "interpreter": "python3",
  "timeout": 30
}
```

**query.py:**
```python
#!/usr/bin/env python3
import json, sys, sqlite3

args = json.load(sys.stdin)
sql = args["sql"].strip()
limit = args.get("limit", 50)

if not sql.upper().startswith("SELECT"):
    print("Error: Only SELECT queries allowed", file=sys.stderr)
    sys.exit(1)

conn = sqlite3.connect("dev.db")
conn.row_factory = sqlite3.Row
rows = conn.execute(f"{sql} LIMIT {limit}").fetchall()
print(json.dumps([dict(r) for r in rows], indent=2))
```
