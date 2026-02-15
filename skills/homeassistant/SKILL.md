---
name: homeassistant
description: Query and control Home Assistant smart home devices, view sensor data, and read historical logs.
version: 0.1.0
license: Apache-2.0
metadata:
  openclaw:
    emoji: "🏠"
---

# Home Assistant Integration

You have live access to a Home Assistant instance through this plugin. A summary of current entity states is automatically injected into your context at the start of each conversation turn.

## Available Tools

| Tool | Purpose |
|------|---------|
| `ha_states` | Query current entity states (filter by domain, entity_id, or pattern) |
| `ha_call_service` | Control devices (turn on/off lights, adjust climate, etc.) |
| `ha_logbook` | Read historical event logs for a time range |
| `ha_context_config` | Adjust what sensor data is injected into your context |

## Bootstrap / First-Run Setup

If Home Assistant is **not yet configured** (no URL or token set):

1. Tell the user they need to provide their Home Assistant URL and a Long-Lived Access Token
2. Guide them: **HA web UI → Profile (bottom-left) → Long-Lived Access Tokens → Create Token**
3. They can configure it via:
   ```
   openclaw config set plugins.homeassistant.url "http://YOUR_HA:8123"
   openclaw config set plugins.homeassistant.token "YOUR_TOKEN"
   ```
4. Once configured, use `ha_states` to discover all available entities
5. Present a summary to the user and ask:
   - "Would you like me to block any entities from my view?" (privacy/security)
   - "Which device domains should I be able to control?" (lights, switches, climate, etc.)
6. Use `ha_context_config` to persist their preferences

## Access Control

- **Read access**: All entities are readable by default
- **Write access**: No domains are writable by default — the user must explicitly enable domains
- **Blocked entities**: Entities matching `acl.blockedEntities` patterns are completely invisible

When the user grants write access, they can do:
```
openclaw config set plugins.homeassistant.acl.writableDomains '["light","switch","climate"]'
```

## Safety Rules

1. **Always confirm** with the user before:
   - Disabling security devices (locks, alarms, cameras)
   - Making changes to climate/heating that affect comfort
   - Running automations that control multiple devices
2. If a service call is **denied by ACL**, tell the user which domain needs to be added to `writableDomains`
3. For bulk operations (e.g. "turn off all lights"), list what will be affected and confirm first
4. Never call services on entities you haven't verified exist via `ha_states` first

## Common Patterns

**Check room status:**
```
Use ha_states with domain="sensor" or pattern="sensor.living_room_*"
```

**Toggle a light:**
```
Use ha_call_service with domain="light", service="toggle", entity_id="light.living_room"
```

**Review recent activity:**
```
Use ha_logbook with start_time (ISO 8601, e.g. 30 minutes ago) and optionally entity_id
```

**Adjust context scope:**
```
Use ha_context_config with action="set" and entity_patterns=["sensor.*", "climate.*"]
```

## Reading the Injected Context

At the start of your context, you may see a `## 🏠 Home Status (live)` section. This contains current states of entities matching the configured patterns. Use this for situational awareness — e.g., answering "is it cold inside?" without needing a tool call.

If the user asks about the home and the answer is in the injected context, respond directly. Only use `ha_states` when you need more detail or the context doesn't cover the specific entity.
