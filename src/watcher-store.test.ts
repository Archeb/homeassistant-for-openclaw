/**
 * Unit tests for watcher store: CRUD operations and state-change matching.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
    loadWatchers,
    saveWatchers,
    addWatcher,
    removeWatcher,
    matchesWatcher,
    formatWatcher,
    resolveWatchersPath,
    type Watcher,
} from "./watcher-store.js";

// Use a temp dir for each test to avoid cross-test contamination
let tmpDir: string;

beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ha-watcher-test-"));
});

afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---- CRUD tests ----

describe("loadWatchers", () => {
    it("returns empty array when file does not exist", async () => {
        const watchers = await loadWatchers(tmpDir);
        expect(watchers).toEqual([]);
    });

    it("returns empty array for invalid JSON", async () => {
        const filePath = resolveWatchersPath(tmpDir);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, "not json", "utf8");
        const watchers = await loadWatchers(tmpDir);
        expect(watchers).toEqual([]);
    });

    it("returns empty array for non-array JSON", async () => {
        const filePath = resolveWatchersPath(tmpDir);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, '{"foo": 1}', "utf8");
        const watchers = await loadWatchers(tmpDir);
        expect(watchers).toEqual([]);
    });
});

describe("saveWatchers / loadWatchers roundtrip", () => {
    it("persists and reads back watchers", async () => {
        const watchers: Watcher[] = [
            {
                id: "abc",
                entityId: "light.bedroom",
                toState: "on",
                message: "commit git",
                oneShot: true,
                createdAt: "2026-01-01T00:00:00Z",
            },
        ];
        await saveWatchers(tmpDir, watchers);
        const loaded = await loadWatchers(tmpDir);
        expect(loaded).toEqual(watchers);
    });
});

describe("addWatcher", () => {
    it("adds a watcher and assigns an id", async () => {
        const watcher = await addWatcher(tmpDir, {
            entityId: "light.bedroom",
            toState: "on",
            message: "commit git",
            oneShot: true,
        });
        expect(watcher.id).toBeDefined();
        expect(watcher.entityId).toBe("light.bedroom");
        expect(watcher.createdAt).toBeDefined();

        const loaded = await loadWatchers(tmpDir);
        expect(loaded.length).toBe(1);
        expect(loaded[0]!.id).toBe(watcher.id);
    });

    it("appends to existing watchers", async () => {
        await addWatcher(tmpDir, {
            entityId: "light.a",
            message: "task a",
            oneShot: true,
        });
        await addWatcher(tmpDir, {
            entityId: "light.b",
            message: "task b",
            oneShot: false,
        });
        const loaded = await loadWatchers(tmpDir);
        expect(loaded.length).toBe(2);
    });
});

describe("removeWatcher", () => {
    it("removes by ID", async () => {
        const w1 = await addWatcher(tmpDir, {
            entityId: "light.a",
            message: "a",
            oneShot: true,
        });
        await addWatcher(tmpDir, {
            entityId: "light.b",
            message: "b",
            oneShot: true,
        });

        const removed = await removeWatcher(tmpDir, w1.id);
        expect(removed).toBe(true);

        const loaded = await loadWatchers(tmpDir);
        expect(loaded.length).toBe(1);
        expect(loaded[0]!.entityId).toBe("light.b");
    });

    it("returns false for non-existent ID", async () => {
        const removed = await removeWatcher(tmpDir, "nonexistent");
        expect(removed).toBe(false);
    });
});

// ---- Matching tests ----

describe("matchesWatcher", () => {
    const base: Watcher = {
        id: "test",
        entityId: "light.bedroom",
        message: "do something",
        oneShot: true,
        createdAt: "",
    };

    it("matches when entity and basic state change match", () => {
        expect(matchesWatcher(base, "light.bedroom", "off", "on")).toBe(true);
    });

    it("does not match different entity", () => {
        expect(matchesWatcher(base, "light.kitchen", "off", "on")).toBe(false);
    });

    it("does not match when state unchanged", () => {
        expect(matchesWatcher(base, "light.bedroom", "on", "on")).toBe(false);
    });

    it("matches toState filter", () => {
        const w = { ...base, toState: "on" };
        expect(matchesWatcher(w, "light.bedroom", "off", "on")).toBe(true);
        expect(matchesWatcher(w, "light.bedroom", "on", "off")).toBe(false);
    });

    it("matches fromState filter", () => {
        const w = { ...base, fromState: "off" };
        expect(matchesWatcher(w, "light.bedroom", "off", "on")).toBe(true);
        expect(matchesWatcher(w, "light.bedroom", "on", "off")).toBe(false);
    });

    it("matches both fromState and toState", () => {
        const w = { ...base, fromState: "off", toState: "on" };
        expect(matchesWatcher(w, "light.bedroom", "off", "on")).toBe(true);
        expect(matchesWatcher(w, "light.bedroom", "on", "off")).toBe(false);
        expect(matchesWatcher(w, "light.bedroom", "unavailable", "on")).toBe(false);
    });
});

// ---- Formatting tests ----

describe("formatWatcher", () => {
    it("formats a one-shot watcher", () => {
        const w: Watcher = {
            id: "abc123",
            entityId: "light.bedroom",
            toState: "on",
            message: "commit git",
            oneShot: true,
            createdAt: "",
        };
        const result = formatWatcher(w);
        expect(result).toContain("abc123");
        expect(result).toContain("light.bedroom");
        expect(result).toContain('"on"');
        expect(result).toContain("one-shot");
        expect(result).toContain("commit git");
    });

    it("formats a recurring watcher with no state filter", () => {
        const w: Watcher = {
            id: "def456",
            entityId: "binary_sensor.door",
            message: "notify me",
            oneShot: false,
            createdAt: "",
        };
        const result = formatWatcher(w);
        expect(result).toContain("recurring");
        expect(result).toContain("any state change");
    });
});
