/**
 * HA Watcher Service — WebSocket-based event subscription.
 *
 * Connects to Home Assistant's WebSocket API, subscribes to `state_changed`
 * events, and triggers agent actions when watchers match.
 *
 * Lifecycle: registered via `api.registerService()`, started/stopped by
 * OpenClaw's plugin service manager.
 */

import { loadWatchers, matchesWatcher, saveWatchers } from "./watcher-store.js";

// ---- Types ----

type Logger = {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
    debug?: (msg: string) => void;
};

type EnqueueSystemEvent = (text: string, options: { sessionKey: string }) => void;

type ResolveSessionKey = () => string | undefined;

export type WatcherServiceConfig = {
    /** HA base URL (http://...) */
    url: string;
    /** HA long-lived access token */
    token: string;
    /** Plugin state directory for loading watchers */
    stateDir: string;
    /** Logger */
    logger: Logger;
    /** Function to inject a system event into the agent session */
    enqueueSystemEvent: EnqueueSystemEvent;
    /** Function to resolve the current default session key */
    resolveSessionKey: ResolveSessionKey;
};

// ---- HA WebSocket Protocol Types ----

type HAWebSocketMessage =
    | { type: "auth_required"; ha_version: string }
    | { type: "auth_ok"; ha_version: string }
    | { type: "auth_invalid"; message: string }
    | { type: "result"; id: number; success: boolean; error?: { code: string; message: string } }
    | { type: "event"; id: number; event: HAStateChangedEvent }
    | { type: "pong"; id: number };

type HAStateChangedEvent = {
    event_type: string;
    data: {
        entity_id: string;
        old_state?: { state: string; attributes: Record<string, unknown> } | null;
        new_state?: { state: string; attributes: Record<string, unknown> } | null;
    };
};

// ---- Service ----

export class HAWatcherService {
    private ws: WebSocket | null = null;
    private msgId = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private pingTimer: ReturnType<typeof setInterval> | null = null;
    private reconnectDelay = 1000;
    private stopped = false;
    private readonly config: WatcherServiceConfig;

    constructor(config: WatcherServiceConfig) {
        this.config = config;
    }

    async start(): Promise<void> {
        this.stopped = false;
        this.connect();
    }

    async stop(): Promise<void> {
        this.stopped = true;
        this.clearTimers();
        if (this.ws) {
            try {
                this.ws.close();
            } catch {
                // ignore
            }
            this.ws = null;
        }
    }

    private clearTimers(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
    }

    private connect(): void {
        if (this.stopped) return;

        const httpUrl = this.config.url.replace(/\/$/, "");
        const wsUrl = httpUrl.replace(/^http/, "ws") + "/api/websocket";

        this.config.logger.info(`[ha-watcher] connecting to ${wsUrl}`);

        try {
            this.ws = new WebSocket(wsUrl);
        } catch (err) {
            this.config.logger.error(
                `[ha-watcher] WebSocket constructor failed: ${String(err)}`,
            );
            this.scheduleReconnect();
            return;
        }

        this.ws.onopen = () => {
            this.config.logger.info("[ha-watcher] WebSocket connected");
            this.reconnectDelay = 1000; // reset backoff
        };

        this.ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(String(event.data)) as HAWebSocketMessage;
                void this.handleMessage(msg);
            } catch (err) {
                this.config.logger.error(
                    `[ha-watcher] failed to parse message: ${String(err)}`,
                );
            }
        };

        this.ws.onclose = () => {
            this.config.logger.info("[ha-watcher] WebSocket closed");
            this.clearTimers();
            this.ws = null;
            this.scheduleReconnect();
        };

        this.ws.onerror = (event) => {
            this.config.logger.error(
                `[ha-watcher] WebSocket error: ${String(event)}`,
            );
        };
    }

    private scheduleReconnect(): void {
        if (this.stopped) return;

        const delay = this.reconnectDelay;
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
        this.config.logger.info(
            `[ha-watcher] reconnecting in ${Math.round(delay / 1000)}s`,
        );
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.msgId = 0;
            this.connect();
        }, delay);
    }

    private send(msg: Record<string, unknown>): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        this.ws.send(JSON.stringify(msg));
    }

    private async handleMessage(msg: HAWebSocketMessage): Promise<void> {
        switch (msg.type) {
            case "auth_required":
                this.send({ type: "auth", access_token: this.config.token });
                break;

            case "auth_ok":
                this.config.logger.info(
                    `[ha-watcher] authenticated (HA ${msg.ha_version})`,
                );
                this.subscribeEvents();
                this.startPing();
                break;

            case "auth_invalid":
                this.config.logger.error(
                    `[ha-watcher] auth failed: ${msg.message}`,
                );
                // Don't reconnect on auth failure — token is wrong
                this.stopped = true;
                this.ws?.close();
                break;

            case "result":
                if (!msg.success && msg.error) {
                    this.config.logger.error(
                        `[ha-watcher] command ${msg.id} failed: ${msg.error.message}`,
                    );
                }
                break;

            case "event":
                if (msg.event?.event_type === "state_changed") {
                    await this.handleStateChanged(msg.event);
                }
                break;

            case "pong":
                // keepalive response, ignore
                break;
        }
    }

    private subscribeEvents(): void {
        this.msgId += 1;
        this.send({
            id: this.msgId,
            type: "subscribe_events",
            event_type: "state_changed",
        });
        this.config.logger.info("[ha-watcher] subscribed to state_changed events");
    }

    private startPing(): void {
        // Send a ping every 30 seconds to keep the connection alive
        this.pingTimer = setInterval(() => {
            this.msgId += 1;
            this.send({ id: this.msgId, type: "ping" });
        }, 30_000);
    }

    private async handleStateChanged(event: HAStateChangedEvent): Promise<void> {
        const { entity_id, old_state, new_state } = event.data;
        if (!old_state || !new_state) return;

        const oldStateStr = old_state.state;
        const newStateStr = new_state.state;
        if (oldStateStr === newStateStr) return;

        const watchers = await loadWatchers(this.config.stateDir);
        const matched = watchers.filter((w) =>
            matchesWatcher(w, entity_id, oldStateStr, newStateStr),
        );

        if (matched.length === 0) return;

        const sessionKey = this.config.resolveSessionKey();
        if (!sessionKey) {
            this.config.logger.warn(
                `[ha-watcher] watcher matched for ${entity_id} but no sessionKey available`,
            );
            return;
        }

        // Get friendly name for context
        const friendlyName =
            (new_state.attributes?.friendly_name as string) ?? entity_id;

        for (const watcher of matched) {
            const triggerText =
                `[Home Assistant Event] ${friendlyName} (\`${entity_id}\`) ` +
                `changed from "${oldStateStr}" to "${newStateStr}".\n` +
                `Watcher message: ${watcher.message}`;

            this.config.logger.info(
                `[ha-watcher] triggered: ${entity_id} ${oldStateStr}→${newStateStr} → "${watcher.message}"`,
            );

            try {
                this.config.enqueueSystemEvent(triggerText, { sessionKey });
            } catch (err) {
                this.config.logger.error(
                    `[ha-watcher] failed to enqueue system event: ${String(err)}`,
                );
            }
        }

        // Remove one-shot watchers that fired
        const firedOneShotIds = new Set(
            matched.filter((w) => w.oneShot).map((w) => w.id),
        );
        if (firedOneShotIds.size > 0) {
            const remaining = watchers.filter((w) => !firedOneShotIds.has(w.id));
            await saveWatchers(this.config.stateDir, remaining);
            this.config.logger.info(
                `[ha-watcher] removed ${firedOneShotIds.size} one-shot watcher(s)`,
            );
        }
    }
}
