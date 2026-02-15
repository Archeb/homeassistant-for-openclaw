/**
 * Tools for Home Assistant plugin.
 *
 * Provides agent tools for querying/controlling HA entities:
 * - ha_states: read entity states
 * - ha_call_service: call HA services (ACL-enforced)
 * - ha_logbook: read historical logbook entries
 * - ha_context_config: agent can adjust context injection settings
 * - ha_listen: manage event listeners for entity state changes
 */

import type { HAClient } from "./ha-client.js";
import {
    formatEntitiesSummary,
    formatLogbookEntries,
    formatEntityState,
} from "./ha-client.js";
import type { ContextConfig } from "./context-hook.js";
import { readContextConfig, writeContextConfig, mergeContextConfig } from "./context-hook.js";
import { addListener, removeListener, loadListeners, formatListener } from "./listener-store.js";

type ToolSchema = {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    execute: (params: Record<string, unknown>) => Promise<string>;
};

export function createHaStatesToolDef(client: HAClient): ToolSchema {
    return {
        name: "ha_states",
        description:
            "Query current Home Assistant entity states. " +
            "Use 'domain' to filter by entity domain (e.g. 'light', 'sensor'), " +
            "'entity_id' for a specific entity, or 'pattern' for glob matching. " +
            "Returns formatted list of entities with their states.",
        inputSchema: {
            type: "object",
            properties: {
                domain: { type: "string", description: "Filter by domain (e.g. light, sensor, climate)" },
                entity_id: { type: "string", description: "Specific entity ID" },
                pattern: { type: "string", description: "Glob pattern (e.g. sensor.living_room_*)" },
            },
        },
        execute: async (params) => {
            if (!client.isConfigured) {
                return "Home Assistant is not configured. The user needs to set plugins.entries.homeassistant-for-openclaw.config.url and .token.";
            }

            const entityId = params.entity_id as string | undefined;
            if (entityId) {
                const entity = await client.getState(entityId);
                if (!entity) return `Entity ${entityId} not found or is blocked by ACL.`;
                return formatEntityState(entity, true);
            }

            const domain = params.domain as string | undefined;
            const pattern = params.pattern as string | undefined;

            let patterns: string[] | undefined;
            if (domain) patterns = [`${domain}.*`];
            else if (pattern) patterns = [pattern];

            const entities = await client.getStates(patterns);
            if (entities.length === 0) return "No entities found matching the filter.";

            return formatEntitiesSummary(entities, { groupByArea: true, maxEntities: 100 });
        },
    };
}

export function createHaCallServiceToolDef(client: HAClient): ToolSchema {
    return {
        name: "ha_call_service",
        description:
            "Call a Home Assistant service to control a device. " +
            "Requires: domain (e.g. 'light'), service (e.g. 'turn_on'), and entity_id. " +
            "Only works for domains in the writableDomains ACL. " +
            "IMPORTANT: Always confirm with the user before performing destructive or security-sensitive actions.",
        inputSchema: {
            type: "object",
            required: ["domain", "service", "entity_id"],
            properties: {
                domain: { type: "string", description: "Service domain (e.g. light, switch, climate)" },
                service: { type: "string", description: "Service name (e.g. turn_on, turn_off, toggle)" },
                entity_id: { type: "string", description: "Target entity ID" },
                data: {
                    type: "object",
                    description: "Additional service data (e.g. brightness, temperature)",
                },
            },
        },
        execute: async (params) => {
            if (!client.isConfigured) {
                return "Home Assistant is not configured. The user needs to set plugins.homeassistant.url and plugins.homeassistant.token.";
            }

            const domain = params.domain as string;
            const service = params.service as string;
            const entityId = params.entity_id as string;
            const data = params.data as Record<string, unknown> | undefined;

            const result = await client.callService(domain, service, entityId, data);
            return result.message;
        },
    };
}

export function createHaLogbookToolDef(client: HAClient): ToolSchema {
    return {
        name: "ha_logbook",
        description:
            "Read historical logbook entries from Home Assistant. " +
            "Useful for checking device activity, automation triggers, or events in a time range. " +
            "start_time is required (ISO 8601). Optionally filter by entity_id and end_time.",
        inputSchema: {
            type: "object",
            required: ["start_time"],
            properties: {
                start_time: {
                    type: "string",
                    description: "Start time in ISO 8601 format (e.g. 2025-02-15T08:00:00+08:00)",
                },
                end_time: {
                    type: "string",
                    description: "End time in ISO 8601 format",
                },
                entity_id: {
                    type: "string",
                    description: "Filter logs to a specific entity ID (recommended to reduce noise)",
                },
            },
        },
        execute: async (params) => {
            if (!client.isConfigured) {
                return "Home Assistant is not configured. The user needs to set plugins.homeassistant.url and plugins.homeassistant.token.";
            }

            const startTime = params.start_time as string;
            const endTime = params.end_time as string | undefined;
            const entityId = params.entity_id as string | undefined;

            const entries = await client.getLogbook(startTime, endTime, entityId);
            return formatLogbookEntries(entries);
        },
    };
}

export function createHaContextConfigToolDef(
    stateDir: string,
    pluginContextConfig: Record<string, unknown> | undefined,
): ToolSchema {
    return {
        name: "ha_context_config",
        description:
            "View or modify what Home Assistant data is injected into your context. " +
            "Actions: 'get' (show current config), 'set' (replace config), " +
            "'add_watch'/'remove_watch' (adjust watched entity patterns). " +
            "Changes take effect on the next message turn.",
        inputSchema: {
            type: "object",
            required: ["action"],
            properties: {
                action: {
                    type: "string",
                    description: "One of: get, set, add_watch, remove_watch",
                },
                watched_entities: {
                    type: "array",
                    items: { type: "string" },
                    description: "Entity patterns to watch/unwatch (for context injection)",
                },
                enabled: { type: "boolean", description: "Enable or disable context injection" },
                max_entities: { type: "integer", description: "Max entities to include in context" },
                group_by_area: { type: "boolean", description: "Group entities by area in context" },
            },
        },
        execute: async (params) => {
            const action = params.action as string;
            const agentOverrides = await readContextConfig(stateDir);
            const current = mergeContextConfig(
                pluginContextConfig as Record<string, unknown> | undefined,
                agentOverrides,
            );

            if (action === "get") {
                return JSON.stringify(current, null, 2);
            }

            if (action === "set") {
                const updated: ContextConfig = {
                    enabled: (params.enabled as boolean) ?? current.enabled,
                    watchedEntities: (params.watched_entities as string[]) ?? current.watchedEntities,
                    maxEntities: (params.max_entities as number) ?? current.maxEntities,
                    groupByArea: (params.group_by_area as boolean) ?? current.groupByArea,
                };
                await writeContextConfig(stateDir, updated);
                return `Context config updated:\n${JSON.stringify(updated, null, 2)}`;
            }

            if (action === "add_watch") {
                const toAdd = (params.watched_entities as string[]) ?? [];
                if (toAdd.length === 0) return "No patterns specified to add.";
                const patterns = new Set(current.watchedEntities);
                for (const p of toAdd) patterns.add(p);
                const updated: ContextConfig = { ...current, watchedEntities: [...patterns] };
                await writeContextConfig(stateDir, updated);
                return `Added watched patterns. Current: ${updated.watchedEntities.join(", ")}`;
            }

            if (action === "remove_watch") {
                const toRemove = new Set((params.watched_entities as string[]) ?? []);
                if (toRemove.size === 0) return "No patterns specified to remove.";
                const updated: ContextConfig = {
                    ...current,
                    watchedEntities: current.watchedEntities.filter((p) => !toRemove.has(p)),
                };
                await writeContextConfig(stateDir, updated);
                return `Removed watched patterns. Current: ${updated.watchedEntities.length > 0 ? updated.watchedEntities.join(", ") : "(none — context injection disabled)"}`;
            }

            return `Unknown action "${action}". Use: get, set, add_watch, remove_watch.`;
        },
    };
}

export function createHaListenToolDef(stateDir: string, client: HAClient): ToolSchema {
    return {
        name: "ha_listen",
        description:
            "Manage Home Assistant event listeners. " +
            "Listeners monitor entity state changes and trigger agent actions automatically. " +
            "Actions:\n" +
            "  - 'add': Create a new listener. Requires entity_id and message. " +
            "Set one_shot=true (default) for single-use tasks (e.g. 'when the light turns on, commit git'). " +
            "Set one_shot=false for recurring listeners (e.g. 'always notify me when the door opens'). " +
            "Decide based on the user's intent whether this is a one-time or recurring task.\n" +
            "  - 'list': Show all active listeners.\n" +
            "  - 'remove': Remove a listener by its ID.",
        inputSchema: {
            type: "object",
            required: ["action"],
            properties: {
                action: {
                    type: "string",
                    description: "One of: add, list, remove",
                },
                entity_id: {
                    type: "string",
                    description: "Entity to listen to (e.g. 'light.bedroom'). Required for 'add'.",
                },
                to_state: {
                    type: "string",
                    description:
                        "Only trigger when entity changes TO this state (e.g. 'on', 'off'). Optional.",
                },
                from_state: {
                    type: "string",
                    description:
                        "Only trigger when entity changes FROM this state. Optional.",
                },
                message: {
                    type: "string",
                    description:
                        "Message to inject into the agent when the listener fires. " +
                        "This becomes the agent's next task. Required for 'add'.",
                },
                one_shot: {
                    type: "boolean",
                    description:
                        "If true (default), the listener is removed after firing once. " +
                        "If false, the listener stays active and fires every time the condition is met. " +
                        "Decide based on context: one-time tasks → true, recurring reactions → false.",
                },
                listener_id: {
                    type: "string",
                    description: "Listener ID to remove. Required for 'remove'.",
                },
            },
        },
        execute: async (params) => {
            if (!client.isConfigured) {
                return "Home Assistant is not configured.";
            }

            const action = params.action as string;

            if (action === "add") {
                const entityId = params.entity_id as string | undefined;
                const message = params.message as string | undefined;
                if (!entityId || !message) {
                    return "Both entity_id and message are required for 'add'.";
                }

                // Validate entity exists
                const entity = await client.getState(entityId);
                if (!entity) {
                    return `Entity \"${entityId}\" not found or is blocked by ACL. Check the entity_id.`;
                }

                const listener = await addListener(stateDir, {
                    entityId,
                    toState: params.to_state as string | undefined,
                    fromState: params.from_state as string | undefined,
                    message,
                    oneShot: (params.one_shot as boolean) ?? true,
                });

                const friendlyName =
                    (entity.attributes?.friendly_name as string) ?? entityId;
                const mode = listener.oneShot ? "one-shot" : "recurring";
                return (
                    `✅ Listener created (${mode}):\n` +
                    `  ID: ${listener.id}\n` +
                    `  Entity: ${friendlyName} (\`${entityId}\`), current state: \"${entity.state}\"\n` +
                    (listener.toState ? `  Trigger when → \"${listener.toState}\"\n` : "") +
                    (listener.fromState ? `  Trigger from \"${listener.fromState}\" →\n` : "") +
                    `  Message: ${listener.message}`
                );
            }

            if (action === "list") {
                const listeners = await loadListeners(stateDir);
                if (listeners.length === 0) {
                    return "No active listeners.";
                }
                return (
                    `**${listeners.length} active listener(s):**\n` +
                    listeners.map(formatListener).join("\n")
                );
            }

            if (action === "remove") {
                const id = params.listener_id as string | undefined;
                if (!id) return "listener_id is required for 'remove'.";
                const removed = await removeListener(stateDir, id);
                return removed
                    ? `✅ Listener ${id} removed.`
                    : `Listener \"${id}\" not found.`;
            }

            return `Unknown action \"${action}\". Use: add, list, remove.`;
        },
    };
}
