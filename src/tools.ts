/**
 * Tools for Home Assistant plugin.
 *
 * Provides agent tools for querying/controlling HA entities:
 * - ha_states: read entity states
 * - ha_call_service: call HA services (ACL-enforced)
 * - ha_logbook: read historical logbook entries
 * - ha_context_config: agent can adjust context injection settings
 */

import type { HAClient } from "./ha-client.js";
import {
    formatEntitiesSummary,
    formatLogbookEntries,
    formatEntityState,
} from "./ha-client.js";
import type { ContextConfig } from "./context-hook.js";
import { readContextConfig, writeContextConfig, mergeContextConfig } from "./context-hook.js";

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
