---
name: homeassistant
description: Guide for interacting with Home Assistant via the HA plugin tools
---

# Home Assistant Integration

You have access to Home Assistant tools for querying and controlling smart home devices.

## Three-Tier Access Model

| Tier | What it does | Config key |
|------|-------------|------------|
| **Readable** | All non-blocked entities — queryable via `ha_states` | `acl.blockedEntities` (inverse) |
| **Watched** | Auto-injected into every conversation context | `acl.watchedEntities` |
| **Writable** | Can call services (turn_on, turn_off, etc.) | `acl.writableDomains` |

- **Default:** All entities are readable, none are watched, none are writable.
- Entity output always includes `entity_id` for precise reference.

## Available Tools

### `ha_states`
Query entity states. All readable (non-blocked) entities accessible.
- `domain`: filter by domain (e.g. "sensor", "light")
- `entity_id`: get a specific entity
- `pattern`: glob pattern (e.g. "sensor.living_room_*")

### `ha_call_service`
Control a device. Requires domain to be in `writableDomains`.
- `domain`: e.g. "light"
- `service`: e.g. "turn_on", "turn_off", "toggle"
- `entity_id`: target entity
- `data`: optional extra data (brightness, temperature, etc.)

### `ha_logbook`
Read historical events.
- `start_time`: ISO 8601 (required)
- `end_time`: ISO 8601 (optional)
- `entity_id`: filter to one entity (recommended)

### `ha_context_config`
Adjust which entities are auto-injected into your context.
- `action`: "get", "set", "add_watch", "remove_watch"
- `watched_entities`: glob patterns for entities to watch
- `enabled`: enable/disable auto-injection
- `max_entities`: cap for context injection
- `group_by_area`: group entities by area

## Bootstrap Flow

When the user first asks about their smart home and HA is not configured:

1. **Ask for URL + Token**: "I need your Home Assistant URL (e.g. http://ha.local:8123) and a Long-Lived Access Token. You can create one in HA → Profile → Long-Lived Access Tokens."
2. **Guide config**: Tell them to run:
   ```
   openclaw config set plugins.entries.homeassistant-for-openclaw.config.url "http://..."
   openclaw config set plugins.entries.homeassistant-for-openclaw.config.token "..."
   ```
3. **Discover entities**: Use `ha_states` to survey what's available.
4. **Suggest watched entities**: "I found sensors in your living room and bedroom. Want me to add these to your watched entities so I always know the status?"
5. **Suggest writable domains**: "Want me to be able to control lights and switches? You'd need to add them to writableDomains."

## Safety Rules

1. **Always confirm** before calling services that could affect security (locks, alarms, garage doors)
2. **Describe what you'll do** before calling any service
3. **Never guess entity IDs** — always query first with `ha_states`
4. If a service call fails with an ACL error, explain to the user how to grant access
