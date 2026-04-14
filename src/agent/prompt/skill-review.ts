/**
 * Skill Review Prompts — Structured prompts for review sub-agents
 */

// ── Constants ─────────────────────────────────────────────────────────────────

export const PERIODIC_REVIEW_PROMPT = `You are analyzing an ongoing conversation to identify reusable skills.

## Your Task
Review the recent conversation and identify patterns worth capturing as skills.

## What to Look For

### High-Value Patterns (Create skills)
1. **Repeated tool chains**: grep → view → edit used 3+ times for similar tasks
2. **User corrections**: "don't use X", "always do Y" — these are rules worth encoding
3. **Project conventions**: File organization, naming, patterns specific to this codebase
4. **Complex workflows**: Multi-step processes that work well and are repeatable
5. **Debug strategies**: Systematic approaches to finding/fixing bugs

### Medium-Value Patterns (Suggest skills)
- Useful but one-off patterns
- Partial workflows that could be completed
- Context-dependent approaches

### Never Create Skills For
- Secrets, credentials, or security-sensitive content
- User-specific personal information
- One-time data or ephemeral state

## Output Format

Return a JSON array of skill objects:

\`\`\`json
[
  {
    "name": "descriptive-skill-name",
    "description": "One sentence (<200 chars) describing what this skill does",
    "triggers": ["trigger1", "trigger2", "trigger3"],
    "rationale": "Why this pattern is worth keeping as a skill",
    "confidence": "high|medium",
    "skillContent": "# Skill Title\n\nDetailed markdown content..."
  }
]
\`\`\`

Return an empty array if no valuable patterns found. Max 3 skills.
Return ONLY the JSON array, no explanation.`;

export const COMPACTION_REVIEW_PROMPT = `Context is being truncated. Analyze what is about to be lost and identify:

1. **Critical decisions** made in this conversation
2. **Project-specific rules** discovered
3. **Important technical details** not documented elsewhere
4. **User preferences** expressed

Return JSON array of memory-worthy items:

\`\`\`json
[
  {
    "type": "decision|preference|rule|detail",
    "content": "What to remember",
    "priority": "high|medium",
    "rememberAs": "skill|memory|both"
  }
]
\`\`\``;

export const SESSION_SUMMARY_PROMPT = `Create a brief session summary for future reference.

Return JSON:
\`\`\`json
{
  "summary": "2-3 sentence overview",
  "keyDecisions": ["decision 1", "decision 2"],
  "skillsCreated": ["skill-name"],
  "patternsLearned": ["pattern 1", "pattern 2"],
  "userPreferences": ["preference 1"]
}
\`\`\``;
