/**
 * Unit tests for ha-client ACL filtering and formatting helpers.
 * Integration tests for live HA connection (skipped if no HA_URL/HA_TOKEN env vars).
 */

import { describe, it, expect } from "vitest";
import {
    matchesAnyPattern,
    formatEntityState,
    formatTimeAgo,
    groupEntitiesByDomain,
    formatEntitiesSummary,
    formatLogbookEntries,
    HAClient,
    type HAEntity,
    type HALogbookEntry,
} from "./ha-client.js";

// ---- Unit tests: pattern matching ----

describe("matchesAnyPattern", () => {
    it("matches wildcard *", () => {
        expect(matchesAnyPattern("sensor.temperature", ["*"])).toBe(true);
    });

    it("matches domain glob", () => {
        expect(matchesAnyPattern("sensor.temperature", ["sensor.*"])).toBe(true);
        expect(matchesAnyPattern("light.living_room", ["sensor.*"])).toBe(false);
    });

    it("matches specific entity", () => {
        expect(matchesAnyPattern("light.living_room", ["light.living_room"])).toBe(true);
        expect(matchesAnyPattern("light.bedroom", ["light.living_room"])).toBe(false);
    });

    it("matches partial wildcard", () => {
        expect(matchesAnyPattern("sensor.living_room_temp", ["sensor.living_room_*"])).toBe(true);
        expect(matchesAnyPattern("sensor.bedroom_temp", ["sensor.living_room_*"])).toBe(false);
    });

    it("matches any of multiple patterns", () => {
        expect(matchesAnyPattern("light.bedroom", ["sensor.*", "light.*"])).toBe(true);
        expect(matchesAnyPattern("switch.fan", ["sensor.*", "light.*"])).toBe(false);
    });

    it("returns false for empty patterns", () => {
        expect(matchesAnyPattern("sensor.temp", [])).toBe(false);
    });
});

// ---- Unit tests: formatting ----

describe("formatEntityState", () => {
    const entity: HAEntity = {
        entity_id: "sensor.temperature",
        state: "24.5",
        attributes: { friendly_name: "Living Room Temp", unit_of_measurement: "°C" },
        last_changed: new Date(Date.now() - 5 * 60_000).toISOString(),
        last_updated: new Date().toISOString(),
    };

    it("formats entity with unit and entity_id", () => {
        const result = formatEntityState(entity);
        expect(result).toContain("Living Room Temp");
        expect(result).toContain("`sensor.temperature`");
        expect(result).toContain("24.5 °C");
    });

    it("includes last changed when requested", () => {
        const result = formatEntityState(entity, true);
        expect(result).toContain("5m ago");
    });
});

describe("formatTimeAgo", () => {
    it("formats minutes", () => {
        const ago = new Date(Date.now() - 10 * 60_000).toISOString();
        expect(formatTimeAgo(ago)).toBe("10m ago");
    });

    it("formats hours", () => {
        const ago = new Date(Date.now() - 3 * 3_600_000).toISOString();
        expect(formatTimeAgo(ago)).toBe("3h ago");
    });

    it("formats days", () => {
        const ago = new Date(Date.now() - 2 * 86_400_000).toISOString();
        expect(formatTimeAgo(ago)).toBe("2d ago");
    });

    it("formats just now", () => {
        const ago = new Date(Date.now() - 10_000).toISOString();
        expect(formatTimeAgo(ago)).toBe("just now");
    });
});

describe("groupEntitiesByDomain", () => {
    it("groups entities by domain", () => {
        const entities: HAEntity[] = [
            { entity_id: "sensor.a", state: "1", attributes: {}, last_changed: "", last_updated: "" },
            { entity_id: "sensor.b", state: "2", attributes: {}, last_changed: "", last_updated: "" },
            { entity_id: "light.c", state: "on", attributes: {}, last_changed: "", last_updated: "" },
        ];
        const groups = groupEntitiesByDomain(entities);
        expect(groups.get("sensor")?.length).toBe(2);
        expect(groups.get("light")?.length).toBe(1);
    });
});

describe("formatEntitiesSummary", () => {
    it("respects maxEntities", () => {
        const entities: HAEntity[] = Array.from({ length: 10 }, (_, i) => ({
            entity_id: `sensor.s${i}`,
            state: String(i),
            attributes: { friendly_name: `Sensor ${i}` },
            last_changed: new Date().toISOString(),
            last_updated: new Date().toISOString(),
        }));
        const result = formatEntitiesSummary(entities, { maxEntities: 3 });
        expect(result).toContain("...and 7 more entities");
    });
});

describe("formatLogbookEntries", () => {
    it("formats entries", () => {
        const entries: HALogbookEntry[] = [
            { entity_id: "light.living", name: "Living Light", state: "on", when: new Date().toISOString() },
        ];
        const result = formatLogbookEntries(entries);
        expect(result).toContain("Living Light");
        expect(result).toContain("`light.living`");
        expect(result).toContain("on");
    });

    it("returns message for empty entries", () => {
        expect(formatLogbookEntries([])).toContain("No logbook entries");
    });
});

// ---- Unit tests: HAClient ACL ----

describe("HAClient ACL", () => {
    it("blocks entities matching blockedEntities", () => {
        const client = new HAClient({
            url: "http://fake",
            token: "fake",
            blockedEntities: ["lock.*", "alarm_control_panel.*"],
            writableDomains: [],
        });
        const entities: HAEntity[] = [
            { entity_id: "light.room", state: "on", attributes: {}, last_changed: "", last_updated: "" },
            { entity_id: "lock.front", state: "locked", attributes: {}, last_changed: "", last_updated: "" },
            { entity_id: "alarm_control_panel.home", state: "armed", attributes: {}, last_changed: "", last_updated: "" },
            { entity_id: "sensor.temp", state: "22", attributes: {}, last_changed: "", last_updated: "" },
        ];
        const filtered = client.filterEntities(entities);
        expect(filtered.length).toBe(2);
        expect(filtered.map((e) => e.entity_id)).toEqual(["light.room", "sensor.temp"]);
    });

    it("isConfigured returns false for empty url/token", () => {
        const client = new HAClient({ url: "", token: "", blockedEntities: [], writableDomains: [] });
        expect(client.isConfigured).toBe(false);
    });

    it("isConfigured returns true with url and token", () => {
        const client = new HAClient({ url: "http://ha", token: "tok", blockedEntities: [], writableDomains: [] });
        expect(client.isConfigured).toBe(true);
    });
});

// ---- Integration tests: live HA ----

const HA_URL = process.env.HA_URL;
const HA_TOKEN = process.env.HA_TOKEN;
const hasLiveHA = Boolean(HA_URL && HA_TOKEN);

describe.skipIf(!hasLiveHA)("HAClient live integration", () => {
    let client: HAClient;

    it("verifies connection", async () => {
        client = new HAClient({
            url: HA_URL!,
            token: HA_TOKEN!,
            blockedEntities: [],
            writableDomains: [],
        });
        const config = await client.verifyConnection();
        expect(config).toBeDefined();
        expect(config.version).toBeDefined();
        console.log(`Connected to: ${config.location_name} (HA ${config.version})`);
    });

    it("fetches all states", async () => {
        const states = await client.getStates();
        expect(states.length).toBeGreaterThan(0);
        console.log(`Total entities: ${states.length}`);

        // Print domain counts
        const domains = new Map<string, number>();
        for (const e of states) {
            const d = e.entity_id.split(".")[0]!;
            domains.set(d, (domains.get(d) ?? 0) + 1);
        }
        console.log("Domains:", Object.fromEntries(domains));
    });

    it("fetches states by domain", async () => {
        const sensors = await client.getStatesByDomain("sensor");
        expect(sensors.every((e) => e.entity_id.startsWith("sensor."))).toBe(true);
        console.log(`Sensor count: ${sensors.length}`);
    });

    it("formats entity summary", async () => {
        const states = await client.getStates(["sensor.*"]);
        const summary = formatEntitiesSummary(states.slice(0, 10), { maxEntities: 10 });
        expect(summary.length).toBeGreaterThan(0);
        console.log("Summary (first 10 sensors):\n", summary);
    });

    it("denies service call when domain not writable", async () => {
        const result = await client.callService("light", "turn_on", "light.fake_entity");
        expect(result.success).toBe(false);
        expect(result.message).toContain("not in writableDomains");
    });
});
