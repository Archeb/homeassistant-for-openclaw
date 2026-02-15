# 🏠 Home Assistant for OpenClaw

An [OpenClaw](https://github.com/openclaw/openclaw) plugin that gives your AI agent live smart home awareness and device control through [Home Assistant](https://www.home-assistant.io/).

## Features

- **Live context injection** — watched entity states auto-prepended to agent conversations
- **Device control** — agent can call HA services (lights, climate, switches, etc.) via tools
- **Logbook access** — query historical events and device activity
- **Three-tier access** — readable / watched / writable, with safe defaults
- **Entity IDs everywhere** — all output includes `entity_id` for precise reference

---

## Three-Tier Access Model

| Tier | What it does | Config key | Default |
|------|-------------|------------|---------|
| **Readable** | Queryable via `ha_states` tool | `acl.blockedEntities` (inverse) | All entities |
| **Watched** | Auto-injected into every conversation | `acl.watchedEntities` | None |
| **Writable** | Can call services on these domains | `acl.writableDomains` | None |

---

## Onboarding

### Prerequisites

- [OpenClaw](https://github.com/openclaw/openclaw) installed and running
- A running Home Assistant instance
- A **Long-Lived Access Token** from Home Assistant:
  1. Open your HA web UI → click your profile (bottom-left)
  2. Scroll to **Long-Lived Access Tokens** → **Create Token**

### Step 1: Install the Plugin

**From npm (recommended):**

```bash
openclaw plugins install homeassistant-for-openclaw
```

**From local path (dev):**

```bash
git clone https://github.com/Archeb/homeassistant-for-openclaw.git
cd homeassistant-for-openclaw && pnpm install
openclaw plugins install ./
```

### Step 2: Configure Connection

```bash
openclaw config set plugins.entries.homeassistant-for-openclaw.config.url "http://YOUR_HA_IP:8123"
openclaw config set plugins.entries.homeassistant-for-openclaw.config.token "YOUR_LONG_LIVED_TOKEN"
```

### Step 3: Verify

Run `/ha` in any OpenClaw conversation.

### Step 4: Add Watched Entities (Recommended)

By default, no entities are auto-injected into context. Add patterns for entities you care about:

```bash
# Watch all sensors and climate entities
openclaw config set plugins.entries.homeassistant-for-openclaw.config.acl '{"watchedEntities":["sensor.*","climate.*"]}'
```

### Step 5: Grant Write Access (Optional)

```bash
# Allow controlling lights, switches, and climate
openclaw config set plugins.entries.homeassistant-for-openclaw.config.acl '{"watchedEntities":["sensor.*","climate.*"],"writableDomains":["light","switch","climate"]}'
```

### Step 6: Block Sensitive Entities (Optional)

```bash
# Hide locks and alarm panels entirely
openclaw config set plugins.entries.homeassistant-for-openclaw.config.acl '{"blockedEntities":["lock.*","alarm_control_panel.*"]}'
```

---

## Configuration Reference

All settings live under `plugins.entries.homeassistant-for-openclaw.config`:

```jsonc
{
  "url": "http://homeassistant.local:8123",
  "token": "eyJ...",
  "context": {
    "enabled": true,       // enable auto-injection of watched entities
    "maxEntities": 50,     // cap to avoid overloading context window
    "groupByArea": true    // group entities by HA area
  },
  "acl": {
    "blockedEntities": [],   // glob patterns to hide entirely
    "watchedEntities": [],   // glob patterns to auto-inject into context
    "writableDomains": []    // domains the agent can control
  }
}
```

### ACL Rules

| Setting | Default | Effect |
|---------|---------|--------|
| `blockedEntities` | `[]` | Entities matching these patterns are invisible |
| `watchedEntities` | `[]` | Only these entities appear in automatic context |
| `writableDomains` | `[]` | Only these domains allow service calls |

> `blockedEntities` takes precedence — a blocked entity is always invisible.

## Tools

| Tool | Description |
|------|-------------|
| `ha_states` | Query entity states (all readable entities) |
| `ha_call_service` | Call a HA service — ACL enforced |
| `ha_logbook` | Read historical logbook entries |
| `ha_context_config` | Adjust watched entities / context settings |

## Commands

| Command | Description |
|---------|-------------|
| `/ha` | Quick status: connection info, entity counts, writable domains |

## Development

```bash
pnpm install
pnpm run typecheck
pnpm test
```

## License

Apache-2.0
