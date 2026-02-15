/**
 * Context injection hook.
 *
 * Registers `before_agent_start` to prepend live Home Assistant sensor data
 * into the agent's context. Respects agent-configurable overrides stored
 * in the plugin state directory.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { HAClient } from "./ha-client.js";
import { formatEntitiesSummary, matchesAnyPattern } from "./ha-client.js";

export type ContextConfig = {
    enabled: boolean;
    entityPatterns: string[];
    maxEntities: number;
    groupByArea: boolean;
};

const CONTEXT_CONFIG_FILE = "context-config.json";

export function resolveContextConfigPath(stateDir: string): string {
    return path.join(stateDir, "plugins", "homeassistant", CONTEXT_CONFIG_FILE);
}

export async function readContextConfig(stateDir: string): Promise<ContextConfig | null> {
    const configPath = resolveContextConfigPath(stateDir);
    try {
        const raw = await fs.readFile(configPath, "utf8");
        const parsed = JSON.parse(raw) as Partial<ContextConfig>;
        return {
            enabled: parsed.enabled ?? true,
            entityPatterns: parsed.entityPatterns ?? ["*"],
            maxEntities: parsed.maxEntities ?? 50,
            groupByArea: parsed.groupByArea ?? true,
        };
    } catch {
        return null;
    }
}

export async function writeContextConfig(
    stateDir: string,
    config: ContextConfig,
): Promise<void> {
    const configPath = resolveContextConfigPath(stateDir);
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
}

export type PluginContextOptions = {
    enabled?: boolean;
    entityPatterns?: string[];
    maxEntities?: number;
    groupByArea?: boolean;
};

/** Merge user plugin config with agent-stored overrides. */
export function mergeContextConfig(
    userConfig: PluginContextOptions | undefined,
    agentOverrides: ContextConfig | null,
): ContextConfig {
    return {
        enabled: agentOverrides?.enabled ?? userConfig?.enabled ?? true,
        entityPatterns: agentOverrides?.entityPatterns ?? userConfig?.entityPatterns ?? ["*"],
        maxEntities: agentOverrides?.maxEntities ?? userConfig?.maxEntities ?? 50,
        groupByArea: agentOverrides?.groupByArea ?? userConfig?.groupByArea ?? true,
    };
}

/** Build the context text to prepend to agent conversation. */
export async function buildHomeContext(
    client: HAClient,
    config: ContextConfig,
): Promise<string | null> {
    if (!config.enabled || !client.isConfigured) return null;

    try {
        let entities = await client.getStates();

        // Apply context-specific entity patterns (agent may narrow this)
        const patterns = config.entityPatterns;
        if (patterns.length > 0 && !(patterns.length === 1 && patterns[0] === "*")) {
            entities = entities.filter((e) => matchesAnyPattern(e.entity_id, patterns));
        }

        if (entities.length === 0) return null;

        const summary = formatEntitiesSummary(entities, {
            groupByArea: config.groupByArea,
            maxEntities: config.maxEntities,
        });

        return `## 🏠 Home Status (live)\n${summary}`;
    } catch (err) {
        return `## 🏠 Home Status\n_Failed to fetch: ${String(err)}_`;
    }
}
