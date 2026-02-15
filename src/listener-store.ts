/**
 * Listener Store — file-based persistence for HA event listeners.
 *
 * Each listener describes a rule: "when entity X transitions to state Y,
 * inject message Z into the agent session."
 */

import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

// ---- Types ----

export type Listener = {
    /** Unique identifier */
    id: string;
    /** Entity to listen to (e.g. "light.bedroom") */
    entityId: string;
    /** Only trigger when old state matches (optional) */
    fromState?: string;
    /** Only trigger when new state matches (optional) */
    toState?: string;
    /** Message to inject into the agent when triggered */
    message: string;
    /**
     * If true, the listener is removed after it fires once.
     * Use for one-time tasks like "when the light turns on, commit git".
     * Set to false for recurring reactions like "always notify me when door opens".
     */
    oneShot: boolean;
    /** ISO timestamp of creation */
    createdAt: string;
};

export type ListenerInput = Omit<Listener, "id" | "createdAt">;

// ---- Store path ----

const LISTENERS_FILE = "listeners.json";

export function resolveListenersPath(stateDir: string): string {
    return path.join(stateDir, "plugins", "homeassistant", LISTENERS_FILE);
}

// ---- CRUD ----

export async function loadListeners(stateDir: string): Promise<Listener[]> {
    const filePath = resolveListenersPath(stateDir);
    try {
        const raw = await fs.readFile(filePath, "utf8");
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed as Listener[];
    } catch {
        return [];
    }
}

export async function saveListeners(stateDir: string, listeners: Listener[]): Promise<void> {
    const filePath = resolveListenersPath(stateDir);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(listeners, null, 2) + "\n", "utf8");
}

export async function addListener(stateDir: string, input: ListenerInput): Promise<Listener> {
    const listeners = await loadListeners(stateDir);
    const listener: Listener = {
        ...input,
        id: randomUUID().slice(0, 8),
        createdAt: new Date().toISOString(),
    };
    listeners.push(listener);
    await saveListeners(stateDir, listeners);
    return listener;
}

export async function removeListener(stateDir: string, id: string): Promise<boolean> {
    const listeners = await loadListeners(stateDir);
    const idx = listeners.findIndex((l) => l.id === id);
    if (idx < 0) return false;
    listeners.splice(idx, 1);
    await saveListeners(stateDir, listeners);
    return true;
}

// ---- Matching ----

/**
 * Check if a state change event matches a listener's criteria.
 */
export function matchesListener(
    listener: Listener,
    entityId: string,
    oldState: string,
    newState: string,
): boolean {
    if (listener.entityId !== entityId) return false;
    // Skip if state didn't actually change
    if (oldState === newState) return false;
    if (listener.fromState && listener.fromState !== oldState) return false;
    if (listener.toState && listener.toState !== newState) return false;
    return true;
}

/**
 * Format a listener for display to the agent.
 */
export function formatListener(l: Listener): string {
    const trigger = [
        l.fromState ? `from "${l.fromState}"` : null,
        l.toState ? `to "${l.toState}"` : null,
    ]
        .filter(Boolean)
        .join(" → ");
    const triggerStr = trigger || "any state change";
    const mode = l.oneShot ? "one-shot" : "recurring";
    return `[${l.id}] \`${l.entityId}\` ${triggerStr} (${mode}) → "${l.message}"`;
}
