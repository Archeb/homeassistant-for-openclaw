/**
 * Home Assistant REST API client with ACL filtering.
 *
 * All entity/service operations respect the plugin's ACL config:
 * - blockedEntities: glob patterns for entities to hide entirely
 * - writableDomains: domains where service calls are allowed (empty = read-only)
 */

export type HAEntity = {
    entity_id: string;
    state: string;
    attributes: Record<string, unknown>;
    last_changed: string;
    last_updated: string;
};

export type HALogbookEntry = {
    entity_id?: string;
    name?: string;
    message?: string;
    state?: string;
    when: string;
    domain?: string;
    context_user_id?: string;
};

export type HAConfig = {
    location_name: string;
    latitude: number;
    longitude: number;
    elevation: number;
    unit_system: Record<string, string>;
    time_zone: string;
    version: string;
};

export type HAServiceCallResult = {
    success: boolean;
    message: string;
    states?: HAEntity[];
};

export type HAClientConfig = {
    url: string;
    token: string;
    blockedEntities: string[];
    writableDomains: string[];
    timeoutMs?: number;
};

/**
 * Simple glob-to-regex: supports `*` as wildcard.
 * e.g. "sensor.*" matches "sensor.temperature", "lock.front_*" matches "lock.front_door"
 */
function globToRegex(pattern: string): RegExp {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`);
}

export function matchesAnyPattern(value: string, patterns: string[]): boolean {
    if (patterns.length === 0) return false;
    return patterns.some((p) => {
        if (p === "*") return true;
        return globToRegex(p).test(value);
    });
}

function extractDomain(entityId: string): string {
    return entityId.split(".")[0] ?? "";
}

export class HAClient {
    private readonly baseUrl: string;
    private readonly token: string;
    private readonly blockedPatterns: string[];
    private readonly writableDomains: Set<string>;
    private readonly timeoutMs: number;

    constructor(config: HAClientConfig) {
        this.baseUrl = config.url.replace(/\/+$/, "");
        this.token = config.token;
        this.blockedPatterns = config.blockedEntities;
        this.writableDomains = new Set(config.writableDomains.map((d) => d.toLowerCase()));
        this.timeoutMs = config.timeoutMs ?? 5000;
    }

    get isConfigured(): boolean {
        return Boolean(this.baseUrl && this.token);
    }

    // ---- ACL helpers ----

    private isBlocked(entityId: string): boolean {
        return matchesAnyPattern(entityId, this.blockedPatterns);
    }

    private isWritable(entityId: string): boolean {
        if (this.isBlocked(entityId)) return false;
        const domain = extractDomain(entityId);
        return this.writableDomains.has(domain);
    }

    filterEntities(entities: HAEntity[]): HAEntity[] {
        return entities.filter((e) => !this.isBlocked(e.entity_id));
    }

    // ---- HTTP ----

    private async request<T>(path: string, init?: RequestInit): Promise<T> {
        const url = `${this.baseUrl}${path}`;
        const res = await fetch(url, {
            ...init,
            headers: {
                Authorization: `Bearer ${this.token}`,
                "Content-Type": "application/json",
                ...init?.headers,
            },
            signal: AbortSignal.timeout(this.timeoutMs),
        });

        if (!res.ok) {
            const body = await res.text().catch(() => "");
            throw new Error(`HA API ${res.status}: ${body || res.statusText}`);
        }

        return (await res.json()) as T;
    }

    // ---- Public API ----

    /** Verify connectivity by fetching HA config. */
    async verifyConnection(): Promise<HAConfig> {
        return this.request<HAConfig>("/api/config");
    }

    /** Get all entity states, filtered by ACL and optional patterns. */
    async getStates(patterns?: string[]): Promise<HAEntity[]> {
        const all = await this.request<HAEntity[]>("/api/states");
        let filtered = this.filterEntities(all);

        if (patterns && patterns.length > 0 && !(patterns.length === 1 && patterns[0] === "*")) {
            filtered = filtered.filter((e) => matchesAnyPattern(e.entity_id, patterns));
        }

        return filtered;
    }

    /** Get states filtered by domain. */
    async getStatesByDomain(domain: string): Promise<HAEntity[]> {
        return this.getStates([`${domain}.*`]);
    }

    /** Get a single entity state. */
    async getState(entityId: string): Promise<HAEntity | null> {
        if (this.isBlocked(entityId)) return null;
        try {
            return await this.request<HAEntity>(`/api/states/${entityId}`);
        } catch {
            return null;
        }
    }

    /** Call a HA service. Enforces writableDomains ACL. */
    async callService(
        domain: string,
        service: string,
        entityId: string,
        data?: Record<string, unknown>,
    ): Promise<HAServiceCallResult> {
        // ACL check
        if (this.isBlocked(entityId)) {
            return { success: false, message: `Entity ${entityId} is blocked by ACL.` };
        }
        if (!this.isWritable(entityId)) {
            return {
                success: false,
                message: `Domain "${domain}" is not in writableDomains. Ask the user to grant write access.`,
            };
        }

        const result = await this.request<HAEntity[]>(`/api/services/${domain}/${service}`, {
            method: "POST",
            body: JSON.stringify({ entity_id: entityId, ...data }),
        });

        return {
            success: true,
            message: `Called ${domain}.${service} on ${entityId}.`,
            states: Array.isArray(result) ? this.filterEntities(result) : undefined,
        };
    }

    /** Get logbook entries. */
    async getLogbook(
        startTime: string,
        endTime?: string,
        entityId?: string,
    ): Promise<HALogbookEntry[]> {
        let path = `/api/logbook/${encodeURIComponent(startTime)}`;
        const params = new URLSearchParams();
        if (endTime) params.set("end_time", endTime);
        if (entityId) {
            if (this.isBlocked(entityId)) return [];
            params.set("entity", entityId);
        }
        const qs = params.toString();
        if (qs) path += `?${qs}`;

        const entries = await this.request<HALogbookEntry[]>(path);

        // Filter out blocked entities from logbook results
        return entries.filter((e) => !e.entity_id || !this.isBlocked(e.entity_id));
    }
}

// ---- Formatting helpers ----

export function formatEntityState(entity: HAEntity, includeLastChanged = false): string {
    const friendly = (entity.attributes.friendly_name as string) ?? entity.entity_id;
    const unit = (entity.attributes.unit_of_measurement as string) ?? "";
    const stateStr = unit ? `${entity.state} ${unit}` : entity.state;
    let line = `- ${friendly} (\`${entity.entity_id}\`): ${stateStr}`;
    if (includeLastChanged) {
        const ago = formatTimeAgo(entity.last_changed);
        if (ago) line += ` (${ago})`;
    }
    return line;
}

export function formatTimeAgo(isoTime: string): string {
    const diff = Date.now() - new Date(isoTime).getTime();
    if (diff < 0) return "";
    const minutes = Math.floor(diff / 60_000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

export function groupEntitiesByDomain(entities: HAEntity[]): Map<string, HAEntity[]> {
    const groups = new Map<string, HAEntity[]>();
    for (const e of entities) {
        const domain = extractDomain(e.entity_id);
        const arr = groups.get(domain) ?? [];
        arr.push(e);
        groups.set(domain, arr);
    }
    return groups;
}

export function groupEntitiesByArea(
    entities: HAEntity[],
): Map<string, HAEntity[]> {
    const groups = new Map<string, HAEntity[]>();
    for (const e of entities) {
        const area = (e.attributes.area as string) ?? "Other";
        const arr = groups.get(area) ?? [];
        arr.push(e);
        groups.set(area, arr);
    }
    return groups;
}

export function formatEntitiesSummary(
    entities: HAEntity[],
    opts?: { groupByArea?: boolean; maxEntities?: number },
): string {
    const max = opts?.maxEntities ?? 50;
    const limited = entities.slice(0, max);
    const lines: string[] = [];

    if (opts?.groupByArea) {
        const groups = groupEntitiesByArea(limited);
        for (const [area, areaEntities] of groups) {
            lines.push(`### ${area}`);
            for (const e of areaEntities) {
                lines.push(formatEntityState(e, true));
            }
        }
    } else {
        const groups = groupEntitiesByDomain(limited);
        for (const [domain, domainEntities] of groups) {
            lines.push(`### ${domain}`);
            for (const e of domainEntities) {
                lines.push(formatEntityState(e, true));
            }
        }
    }

    if (entities.length > max) {
        lines.push(`\n_...and ${entities.length - max} more entities (configure acl.watchedEntities to narrow scope)_`);
    }

    return lines.join("\n");
}

export function formatLogbookEntries(entries: HALogbookEntry[]): string {
    if (entries.length === 0) return "No logbook entries found for the given time range.";

    const lines = entries.map((e) => {
        const time = new Date(e.when).toLocaleTimeString();
        const name = e.name ?? e.entity_id ?? "Unknown";
        const id = e.entity_id ? ` (\`${e.entity_id}\`)` : "";
        const msg = e.message ?? e.state ?? "";
        return `- [${time}] ${name}${id}: ${msg}`;
    });
    return lines.join("\n");
}
