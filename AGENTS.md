# Agent Instructions

## Skill Table

| Domain | Skill Path |
|--------|-----------|
| Caveman (always load) | `.opencode/skills/caveman/SKILL.md` |
| Paseo (subagent creation) | `.opencode/skills/paseo/SKILL.md` |

## Global Rules

- Never cross-import domains — load only the skill matching the current task's domain.
- Never run heavy checks (lint, typecheck, build, full test suite) — reference `.opencode/hooks/policy.json` for the blocklist.
- Use targeted verification only (single-file or minimal scope).
- **Paseo for all agent work. NO task() for agent creation.** task() is banned completely — never use it with category or subagent_type. Every subagent must use `paseo_create_agent(provider="opencode/ai-gateway/free", relationship={kind:"subagent"}, workspace={kind:"current"})`.

## FIRST ACTION

1. **Step 0**: Read `.sisyphus/rules/agent-constraints.md` — hard constraints (task() banned, Paseo mandatory).
2. Load caveman skill always (`load skill caveman`).
3. Load domain skill matching the task (e.g., `load skill paseo` for subagent work).
