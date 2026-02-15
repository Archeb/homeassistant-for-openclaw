/**
 * Watcher Store — file-based persistence for HA event watchers.
 *
 * Each watcher describes a rule: "when entity X transitions to state Y,
 * inject message Z into the agent session."
 */

import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

// ---- Types ----

export type Watcher = {
    /** Unique identifier */
    id: string;
    /** Entity to watch (e.g. "light.bedroom") */
    entityId: string;
    /** Only trigger when old state matches (optional) */
    fromState?: string;
    /** Only trigger when new state matches (optional) */
    toState?: string;
    /** Message to inject into the agent when triggered */
    message: string;
    /**
     * If true, the watcher is removed after it fires once.
     * Use for one-time tasks like "when the light turns on, commit git".
     * Set to false for recurring reactions like "always notify me when door opens".
     */
    oneShot: boolean;
    /** ISO timestamp of creation */
    createdAt: string;
};

export type WatcherInput = Omit<Watcher, "id" | "createdAt">;

// ---- Store path ----

const WATCHERS_FILE = "watchers.json";

export function resolveWatchersPath(stateDir: string): string {
    return path.join(stateDir, "plugins", "homeassistant", WATCHERS_FILE);
}

// ---- CRUD ----

export async function loadWatchers(stateDir: string): Promise<Watcher[]> {
    const filePath = resolveWatchersPath(stateDir);
    try {
        const raw = await fs.readFile(filePath, "utf8");
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed as Watcher[];
    } catch {
        return [];
    }
}

export async function saveWatchers(stateDir: string, watchers: Watcher[]): Promise<void> {
    const filePath = resolveWatchersPath(stateDir);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(watchers, null, 2) + "\n", "utf8");
}

export async function addWatcher(stateDir: string, input: WatcherInput): Promise<Watcher> {
    const watchers = await loadWatchers(stateDir);
    const watcher: Watcher = {
        ...input,
        id: randomUUID().slice(0, 8),
        createdAt: new Date().toISOString(),
    };
    watchers.push(watcher);
    await saveWatchers(stateDir, watchers);
    return watcher;
}

export async function removeWatcher(stateDir: string, id: string): Promise<boolean> {
    const watchers = await loadWatchers(stateDir);
    const idx = watchers.findIndex((w) => w.id === id);
    if (idx < 0) return false;
    watchers.splice(idx, 1);
    await saveWatchers(stateDir, watchers);
    return true;
}

// ---- Matching ----

/**
 * Check if a state change event matches a watcher's criteria.
 */
export function matchesWatcher(
    watcher: Watcher,
    entityId: string,
    oldState: string,
    newState: string,
): boolean {
    if (watcher.entityId !== entityId) return false;
    // Skip if state didn't actually change
    if (oldState === newState) return false;
    if (watcher.fromState && watcher.fromState !== oldState) return false;
    if (watcher.toState && watcher.toState !== newState) return false;
    return true;
}

/**
 * Format a watcher for display to the agent.
 */
export function formatWatcher(w: Watcher): string {
    const trigger = [
        w.fromState ? `from "${w.fromState}"` : null,
        w.toState ? `to "${w.toState}"` : null,
    ]
        .filter(Boolean)
        .join(" → ");
    const triggerStr = trigger || "any state change";
    const mode = w.oneShot ? "one-shot" : "recurring";
    return `[${w.id}] \`${w.entityId}\` ${triggerStr} (${mode}) → "${w.message}"`;
}
