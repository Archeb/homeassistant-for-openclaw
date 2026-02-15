/**
 * Home Assistant Plugin for OpenClaw
 *
 * Entry point — wires HA client, context hook, tools, and /ha command.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { HAClient } from "./ha-client.js";
import { buildHomeContext, mergeContextConfig, readContextConfig } from "./context-hook.js";
import {
    createHaStatesToolDef,
    createHaCallServiceToolDef,
    createHaLogbookToolDef,
    createHaContextConfigToolDef,
} from "./tools.js";

type PluginConfig = {
    url?: string;
    token?: string;
    context?: {
        enabled?: boolean;
        maxEntities?: number;
        groupByArea?: boolean;
    };
    acl?: {
        blockedEntities?: string[];
        watchedEntities?: string[];
        writableDomains?: string[];
    };
};

function parseConfig(raw: Record<string, unknown> | undefined): PluginConfig {
    if (!raw) return {};
    return {
        url: (raw.url as string) ?? "",
        token: (raw.token as string) ?? "",
        context: raw.context as PluginConfig["context"],
        acl: raw.acl as PluginConfig["acl"],
    };
}

function textResult(text: string) {
    return { content: [{ type: "text" as const, text }], details: { text } };
}

export default function register(api: OpenClawPluginApi) {
    const cfg = parseConfig(api.pluginConfig);
    const client = new HAClient({
        url: cfg.url ?? "",
        token: cfg.token ?? "",
        blockedEntities: cfg.acl?.blockedEntities ?? [],
        writableDomains: cfg.acl?.writableDomains ?? [],
    });

    // ---- Hook: inject home status into agent context ----
    api.on("before_agent_start", async (_event, _ctx) => {
        if (!client.isConfigured) return;

        const stateDir = api.runtime.state.resolveStateDir();
        const agentOverrides = await readContextConfig(stateDir);
        const contextConfig = mergeContextConfig(
            {
                enabled: cfg.context?.enabled,
                watchedEntities: cfg.acl?.watchedEntities,
                maxEntities: cfg.context?.maxEntities,
                groupByArea: cfg.context?.groupByArea,
            },
            agentOverrides,
        );

        const prependContext = await buildHomeContext(client, contextConfig);
        if (!prependContext) return;

        return { prependContext };
    });

    // ---- Tools ----

    const statesToolDef = createHaStatesToolDef(client);
    api.registerTool({
        name: statesToolDef.name,
        label: "Home Assistant States",
        description: statesToolDef.description,
        parameters: statesToolDef.inputSchema,
        async execute(_toolCallId: string, params: Record<string, unknown>) {
            return textResult(await statesToolDef.execute(params));
        },
    });

    const callServiceToolDef = createHaCallServiceToolDef(client);
    api.registerTool({
        name: callServiceToolDef.name,
        label: "Home Assistant Service Call",
        description: callServiceToolDef.description,
        parameters: callServiceToolDef.inputSchema,
        async execute(_toolCallId: string, params: Record<string, unknown>) {
            return textResult(await callServiceToolDef.execute(params));
        },
    });

    const logbookToolDef = createHaLogbookToolDef(client);
    api.registerTool({
        name: logbookToolDef.name,
        label: "Home Assistant Logbook",
        description: logbookToolDef.description,
        parameters: logbookToolDef.inputSchema,
        async execute(_toolCallId: string, params: Record<string, unknown>) {
            return textResult(await logbookToolDef.execute(params));
        },
    });

    // Context config tool — uses stateDir from runtime
    const stateDir = api.runtime.state.resolveStateDir();
    const contextConfigToolDef = createHaContextConfigToolDef(
        stateDir,
        cfg.context as Record<string, unknown> | undefined,
    );
    api.registerTool({
        name: contextConfigToolDef.name,
        label: "Home Assistant Context Config",
        description: contextConfigToolDef.description,
        parameters: contextConfigToolDef.inputSchema,
        async execute(_toolCallId: string, params: Record<string, unknown>) {
            return textResult(await contextConfigToolDef.execute(params));
        },
    });

    // ---- Command: /ha ----
    api.registerCommand({
        name: "ha",
        description: "Quick Home Assistant status overview.",
        acceptsArgs: true,
        handler: async (_ctx) => {
            if (!client.isConfigured) {
                return {
                    text:
                        "Home Assistant is not configured.\n\n" +
                        "Set the URL and token:\n" +
                        "```\n" +
                        'openclaw config set plugins.entries.homeassistant-for-openclaw.config.url "http://YOUR_HA_URL:8123"\n' +
                        'openclaw config set plugins.entries.homeassistant-for-openclaw.config.token "YOUR_TOKEN"\n' +
                        "```\n\n" +
                        "To get a token: HA → Profile → Long-Lived Access Tokens → Create Token.",
                };
            }

            try {
                const haConfig = await client.verifyConnection();
                const entities = await client.getStates();
                const domainCounts = new Map<string, number>();
                for (const e of entities) {
                    const domain = e.entity_id.split(".")[0] ?? "";
                    domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1);
                }
                const domainSummary = [...domainCounts.entries()]
                    .sort((a, b) => b[1] - a[1])
                    .map(([d, n]) => `  ${d}: ${n}`)
                    .join("\n");

                const writableDomains = cfg.acl?.writableDomains ?? [];
                const writableLabel = writableDomains.length > 0
                    ? writableDomains.join(", ")
                    : "none (read-only mode)";

                return {
                    text:
                        `Connected to **${haConfig.location_name}** (HA ${haConfig.version})\n\n` +
                        `**${entities.length} visible entities:**\n${domainSummary}\n\n` +
                        `**Writable domains:** ${writableLabel}`,
                };
            } catch (err) {
                return { text: `Failed to connect to Home Assistant: ${String(err)}` };
            }
        },
    });
}
