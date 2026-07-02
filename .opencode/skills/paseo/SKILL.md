# Paseo Skill

## Purpose
Subagent creation using Paseo. Replaces task()-based agent spawning.

## Usage
For EVERY subagent, use:
```
paseo_create_agent(
  provider="opencode/ai-gateway/free",
  relationship={kind: "subagent"},
  workspace={kind: "current"}
)
```

## Constraints
- NEVER use task() with category or subagent_type.
- NEVER consult Metis/oracle — Sisyphus must not spawn consultant agents via task().
- Reference `.opencode/hooks/policy.json` for blocked commands — never repeat them inline.
- No API keys in this file.

## Rules
- Only use Paseo for agent creation.
- Verify provider is always `opencode/ai-gateway/free`.
- No contradictory rules across files.
- No duplicated rules.
