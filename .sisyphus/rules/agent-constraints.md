# HARD CONSTRAINTS — READ AT SESSION START

## ABSOLUTELY FORBIDDEN
- NEVER use task() with category or subagent_type
- NEVER use task() for ANY subagent creation
- NEVER consult Metis — Sisyphus MUST NOT spawn Metis (oracle) agents via task() for any reason
- NEVER modify opencode.json or any OpenCode configuration files

## MANDATORY — ONLY THIS PATTERN
For EVERY subagent, use paseo_create_agent with:
- provider="opencode/ai-gateway/free"
- relationship={kind: "subagent"}
- workspace={kind: "current"}

## Why
- task() spawns Sisyphus-Junior agents on PAID models
- User has ZERO budget for paid models
- This applies to ALL agents, ALL sessions, ALL contexts
