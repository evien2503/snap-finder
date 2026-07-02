# Caveman Skill

## Purpose
Minimal agent profile. Prevents loading agent-spawning skills that could trigger paid model usage.

## Constraints
- Never load agent-spawning skills — only read domain skills.
- Never use task() for subagent creation.
- Always use paseo_create_agent for subagent work.

## Rules
- Reference `.opencode/hooks/policy.json` — never duplicate "never run X" inline.
- No API keys allowed in any skill file.
- No contradictory rules across files.
- No duplicated rules.
