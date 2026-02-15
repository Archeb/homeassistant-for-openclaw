# 🏠 Home Assistant for OpenClaw

An [OpenClaw](https://github.com/openclaw/openclaw) plugin that gives your AI agent live smart home awareness and device control through [Home Assistant](https://www.home-assistant.io/).

## Features

- **Live context injection** — current sensor states are automatically prepended to agent conversations
- **Device control** — agent can call HA services (lights, climate, switches, etc.) via tools
- **Logbook access** — query historical events and device activity
- **Safe defaults** — read-all, write-nothing; agent guides you through setup
- **Configurable ACL** — block entities, whitelist writable domains

---

## Onboarding

### Prerequisites

- [OpenClaw](https://github.com/openclaw/openclaw) installed and running
- A running Home Assistant instance (accessible via its HTTP API)
- A **Long-Lived Access Token** from Home Assistant:
  1. Open your HA web UI
  2. Click your profile (bottom-left)
  3. Scroll to **Long-Lived Access Tokens**
  4. Click **Create Token**, give it a name (e.g. "OpenClaw"), copy the token

### Step 1: Install the Plugin

**Option A — From npm (recommended):**

```bash
openclaw plugins install homeassistant-for-openclaw
```

**Option B — From local path (for development):**

```bash
# Clone the repo
git clone https://github.com/Archeb/homeassistant-for-openclaw.git
cd homeassistant-for-openclaw
pnpm install

# Install from local directory
openclaw plugins install ./
```

### Step 2: Configure Connection

Plugin config lives under the path `plugins.entries.homeassistant-for-openclaw.config` in your OpenClaw config. Set the HA URL and token:

```bash
openclaw config set plugins.entries.homeassistant-for-openclaw.config.url "http://YOUR_HA_IP:8123"
openclaw config set plugins.entries.homeassistant-for-openclaw.config.token "YOUR_LONG_LIVED_TOKEN"
```

### Step 3: Verify

Run `/ha` in any OpenClaw conversation. You should see:

```
Connected to **My Home** (HA 2025.x.x)

347 visible entities:
  sensor: 79
  switch: 34
  light: 27
  ...

Writable domains: none (read-only mode)
```

### Step 4: Grant Write Access (Optional)

By default the agent can only **read** entities. To let it control devices:

```bash
# Example: allow controlling lights, switches, and climate
openclaw config set plugins.entries.homeassistant-for-openclaw.config.acl '{"writableDomains":["light","switch","climate"]}'
```

### Step 5: Block Sensitive Entities (Optional)

Hide entities from the agent entirely using glob patterns:

```bash
# Example: hide all locks and alarm panels
openclaw config set plugins.entries.homeassistant-for-openclaw.config.acl '{"blockedEntities":["lock.*","alarm_control_panel.*"]}'
```

### Step 6: Let the Agent Help

You can also just start a conversation and the agent will guide you through setup. The bundled skill file (`skills/homeassistant/SKILL.md`) teaches the agent how to:

- Detect missing config and prompt you for URL/token
- Discover your entities and show a summary
- Ask which domains to make writable
- Suggest entities to block

---

## Configuration Reference

All settings live under `plugins.entries.homeassistant-for-openclaw.config` in your OpenClaw config:

```jsonc
{
  "plugins": {
    "entries": {
      "homeassistant-for-openclaw": {
        "enabled": true,
        "config": {
          "url": "http://homeassistant.local:8123",
          "token": "eyJ...",

          "context": {
            "enabled": true,           // inject home status into agent context
            "entityPatterns": ["*"],   // which entities to show (glob patterns)
            "maxEntities": 50,         // cap to avoid overloading context window
            "groupByArea": true        // group entities by HA area
          },

          "acl": {
            "blockedEntities": [],     // glob patterns to hide entirely
            "writableDomains": []      // domains the agent can control (empty = read-only)
          }
        }
      }
    }
  }
}
```

### ACL Rules

| Setting | Default | Effect |
|---------|---------|--------|
| `blockedEntities` | `[]` | Entities matching these patterns are invisible to the agent |
| `writableDomains` | `[]` | Only listed domains allow service calls |

> `blockedEntities` takes precedence — a blocked entity cannot be read or written, even if its domain is in `writableDomains`.

## Tools

| Tool | Description |
|------|-------------|
| `ha_states` | Query entity states (filter by domain, entity_id, or glob pattern) |
| `ha_call_service` | Call a HA service (e.g. `light.turn_on`) — ACL enforced |
| `ha_logbook` | Read historical logbook entries for a time range |
| `ha_context_config` | Adjust what sensor data is injected into agent context |

## Commands

| Command | Description |
|---------|-------------|
| `/ha` | Quick status: connection info, entity counts, writable domains |

## Development

```bash
pnpm install
pnpm run typecheck       # TypeScript type check
pnpm test                # Run all tests

# For integration tests against a live HA instance:
# Create .env with HA_URL and HA_TOKEN, then:
pnpm test
```

## License

Apache-2.0
