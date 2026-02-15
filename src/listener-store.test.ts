/**
 * Unit tests for listener store: CRUD operations and state-change matching.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
    loadListeners,
    saveListeners,
    addListener,
    removeListener,
    matchesListener,
    formatListener,
    resolveListenersPath,
    type Listener,
} from "./listener-store.js";

// Use a temp dir for each test to avoid cross-test contamination
let tmpDir: string;

beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ha-listener-test-"));
});

afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---- CRUD tests ----

describe("loadListeners", () => {
    it("returns empty array when file does not exist", async () => {
        const listeners = await loadListeners(tmpDir);
        expect(listeners).toEqual([]);
    });

    it("returns empty array for invalid JSON", async () => {
        const filePath = resolveListenersPath(tmpDir);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, "not json", "utf8");
        const listeners = await loadListeners(tmpDir);
        expect(listeners).toEqual([]);
    });

    it("returns empty array for non-array JSON", async () => {
        const filePath = resolveListenersPath(tmpDir);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, '{"foo": 1}', "utf8");
        const listeners = await loadListeners(tmpDir);
        expect(listeners).toEqual([]);
    });
});

describe("saveListeners / loadListeners roundtrip", () => {
    it("persists and reads back listeners", async () => {
        const listeners: Listener[] = [
            {
                id: "abc",
                entityId: "light.bedroom",
                toState: "on",
                message: "commit git",
                oneShot: true,
                createdAt: "2026-01-01T00:00:00Z",
            },
        ];
        await saveListeners(tmpDir, listeners);
        const loaded = await loadListeners(tmpDir);
        expect(loaded).toEqual(listeners);
    });
});

describe("addListener", () => {
    it("adds a listener and assigns an id", async () => {
        const listener = await addListener(tmpDir, {
            entityId: "light.bedroom",
            toState: "on",
            message: "commit git",
            oneShot: true,
        });
        expect(listener.id).toBeDefined();
        expect(listener.entityId).toBe("light.bedroom");
        expect(listener.createdAt).toBeDefined();

        const loaded = await loadListeners(tmpDir);
        expect(loaded.length).toBe(1);
        expect(loaded[0]!.id).toBe(listener.id);
    });

    it("appends to existing listeners", async () => {
        await addListener(tmpDir, {
            entityId: "light.a",
            message: "task a",
            oneShot: true,
        });
        await addListener(tmpDir, {
            entityId: "light.b",
            message: "task b",
            oneShot: false,
        });
        const loaded = await loadListeners(tmpDir);
        expect(loaded.length).toBe(2);
    });
});

describe("removeListener", () => {
    it("removes by ID", async () => {
        const l1 = await addListener(tmpDir, {
            entityId: "light.a",
            message: "a",
            oneShot: true,
        });
        await addListener(tmpDir, {
            entityId: "light.b",
            message: "b",
            oneShot: true,
        });

        const removed = await removeListener(tmpDir, l1.id);
        expect(removed).toBe(true);

        const loaded = await loadListeners(tmpDir);
        expect(loaded.length).toBe(1);
        expect(loaded[0]!.entityId).toBe("light.b");
    });

    it("returns false for non-existent ID", async () => {
        const removed = await removeListener(tmpDir, "nonexistent");
        expect(removed).toBe(false);
    });
});

// ---- Matching tests ----

describe("matchesListener", () => {
    const base: Listener = {
        id: "test",
        entityId: "light.bedroom",
        message: "do something",
        oneShot: true,
        createdAt: "",
    };

    it("matches when entity and basic state change match", () => {
        expect(matchesListener(base, "light.bedroom", "off", "on")).toBe(true);
    });

    it("does not match different entity", () => {
        expect(matchesListener(base, "light.kitchen", "off", "on")).toBe(false);
    });

    it("does not match when state unchanged", () => {
        expect(matchesListener(base, "light.bedroom", "on", "on")).toBe(false);
    });

    it("matches toState filter", () => {
        const l = { ...base, toState: "on" };
        expect(matchesListener(l, "light.bedroom", "off", "on")).toBe(true);
        expect(matchesListener(l, "light.bedroom", "on", "off")).toBe(false);
    });

    it("matches fromState filter", () => {
        const l = { ...base, fromState: "off" };
        expect(matchesListener(l, "light.bedroom", "off", "on")).toBe(true);
        expect(matchesListener(l, "light.bedroom", "on", "off")).toBe(false);
    });

    it("matches both fromState and toState", () => {
        const l = { ...base, fromState: "off", toState: "on" };
        expect(matchesListener(l, "light.bedroom", "off", "on")).toBe(true);
        expect(matchesListener(l, "light.bedroom", "on", "off")).toBe(false);
        expect(matchesListener(l, "light.bedroom", "unavailable", "on")).toBe(false);
    });
});

// ---- Formatting tests ----

describe("formatListener", () => {
    it("formats a one-shot listener", () => {
        const l: Listener = {
            id: "abc123",
            entityId: "light.bedroom",
            toState: "on",
            message: "commit git",
            oneShot: true,
            createdAt: "",
        };
        const result = formatListener(l);
        expect(result).toContain("abc123");
        expect(result).toContain("light.bedroom");
        expect(result).toContain('"on"');
        expect(result).toContain("one-shot");
        expect(result).toContain("commit git");
    });

    it("formats a recurring listener with no state filter", () => {
        const l: Listener = {
            id: "def456",
            entityId: "binary_sensor.door",
            message: "notify me",
            oneShot: false,
            createdAt: "",
        };
        const result = formatListener(l);
        expect(result).toContain("recurring");
        expect(result).toContain("any state change");
    });
});
