# Home Assistant Plugin — Agent Guide

This is an OpenClaw plugin that provides Home Assistant integration. The agent should read this file to understand the project structure when working on this codebase.

## Project Structure

```
src/
├── index.ts            # Plugin entry: registers hooks, tools, /ha command
├── ha-client.ts        # HA REST API client with ACL filtering + formatting helpers
├── context-hook.ts     # before_agent_start hook: injects home status into context
├── tools.ts            # Tool definitions: ha_states, ha_call_service, ha_logbook, ha_context_config
└── ha-client.test.ts   # Unit tests + live integration tests

skills/homeassistant/
└── SKILL.md            # Agent-facing skill: bootstrap flow, safety rules, usage patterns

openclaw.plugin.json    # Plugin manifest (id, configSchema, skills)
```

## Architecture

- **`HAClient`** (`ha-client.ts`) wraps all HA REST API calls. It applies ACL filtering (blockedEntities, writableDomains) at the client level, so all consumers are safe by default.
- **Context hook** (`context-hook.ts`) runs on every `before_agent_start` event, fetches entity states via `HAClient`, and returns `{ prependContext }` with a formatted summary.
- **Tools** (`tools.ts`) export factory functions that create tool definitions. The entry point (`index.ts`) wraps these into the `AgentTool` format and registers them.
- **Config** is read from `api.pluginConfig` (user's `openclaw` config) and merged with agent-stored overrides in the plugin state dir.

## Key Types

- `HAEntity` — HA entity state (entity_id, state, attributes, last_changed)
- `HAClientConfig` — url, token, blockedEntities, writableDomains
- `ContextConfig` — enabled, entityPatterns, maxEntities, groupByArea

## Testing

```bash
# Unit tests only (no env vars needed)
pnpm test

# With live HA integration tests
HA_URL="..." HA_TOKEN="..." pnpm test
```

## Plugin SDK Reference

This plugin uses `openclaw/plugin-sdk` types:
- `OpenClawPluginApi` — the main API passed to `register()`
- `api.on("before_agent_start", handler)` — returns `{ prependContext }` to inject into system prompt
- `api.registerTool({ name, label, description, parameters, execute })` — register agent tools
- `api.registerCommand({ name, description, handler })` — register `/` commands
