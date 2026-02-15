/**
 * HA Listener Service — WebSocket-based event subscription.
 *
 * Connects to Home Assistant's WebSocket API, subscribes to `state_changed`
 * events, and triggers agent actions when listeners match.
 *
 * Lifecycle: registered via `api.registerService()`, started/stopped by
 * OpenClaw's plugin service manager.
 */

import { loadListeners, matchesListener, saveListeners } from "./listener-store.js";
import { exec } from "node:child_process";

// ---- Types ----

type Logger = {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
    debug?: (msg: string) => void;
};

export type ListenerServiceConfig = {
    /** HA base URL (http://...) */
    url: string;
    /** HA long-lived access token */
    token: string;
    /** Plugin state directory for loading listeners */
    stateDir: string;
    /** Logger */
    logger: Logger;
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

export class HAListenerService {
    private ws: WebSocket | null = null;
    private msgId = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private pingTimer: ReturnType<typeof setInterval> | null = null;
    private reconnectDelay = 1000;
    private stopped = false;
    private readonly config: ListenerServiceConfig;

    constructor(config: ListenerServiceConfig) {
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

        this.config.logger.info(`[ha-listener] connecting to ${wsUrl}`);

        try {
            this.ws = new WebSocket(wsUrl);
        } catch (err) {
            this.config.logger.error(
                `[ha-listener] WebSocket constructor failed: ${String(err)}`,
            );
            this.scheduleReconnect();
            return;
        }

        this.ws.onopen = () => {
            this.config.logger.info("[ha-listener] WebSocket connected");
            this.reconnectDelay = 1000; // reset backoff
        };

        this.ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(String(event.data)) as HAWebSocketMessage;
                void this.handleMessage(msg);
            } catch (err) {
                this.config.logger.error(
                    `[ha-listener] failed to parse message: ${String(err)}`,
                );
            }
        };

        this.ws.onclose = () => {
            this.config.logger.info("[ha-listener] WebSocket closed");
            this.clearTimers();
            this.ws = null;
            this.scheduleReconnect();
        };

        this.ws.onerror = (event) => {
            this.config.logger.error(
                `[ha-listener] WebSocket error: ${String(event)}`,
            );
        };
    }

    private scheduleReconnect(): void {
        if (this.stopped) return;

        const delay = this.reconnectDelay;
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
        this.config.logger.info(
            `[ha-listener] reconnecting in ${Math.round(delay / 1000)}s`,
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
                    `[ha-listener] authenticated (HA ${msg.ha_version})`,
                );
                this.subscribeEvents();
                this.startPing();
                break;

            case "auth_invalid":
                this.config.logger.error(
                    `[ha-listener] auth failed: ${msg.message}`,
                );
                // Don't reconnect on auth failure — token is wrong
                this.stopped = true;
                this.ws?.close();
                break;

            case "result":
                if (!msg.success && msg.error) {
                    this.config.logger.error(
                        `[ha-listener] command ${msg.id} failed: ${msg.error.message}`,
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
        this.config.logger.info("[ha-listener] subscribed to state_changed events");
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

        const listeners = await loadListeners(this.config.stateDir);
        const matched = listeners.filter((l) =>
            matchesListener(l, entity_id, oldStateStr, newStateStr),
        );

        if (matched.length === 0) return;

        // Get friendly name for context
        const friendlyName =
            (new_state.attributes?.friendly_name as string) ?? entity_id;

        for (const listener of matched) {
            const triggerText =
                `[Home Assistant Event] ${friendlyName} (\`${entity_id}\`) ` +
                `changed from "${oldStateStr}" to "${newStateStr}".\n` +
                `Listener message: ${listener.message}`;

            this.config.logger.info(
                `[ha-listener] triggered: ${entity_id} ${oldStateStr}→${newStateStr} → "${listener.message}"`,
            );

            // Use `openclaw agent` CLI to trigger an actual agent turn
            const escapedMessage = triggerText.replace(/'/g, "'\''");
            const cmd = `openclaw agent --agent main --message '${escapedMessage}'`;

            try {
                exec(cmd, { timeout: 120_000 }, (err, stdout, stderr) => {
                    if (err) {
                        this.config.logger.error(
                            `[ha-listener] openclaw agent failed: ${String(err)}${stderr ? ` stderr: ${stderr}` : ""}`,
                        );
                    } else {
                        this.config.logger.info(
                            `[ha-listener] openclaw agent completed for ${entity_id}`,
                        );
                    }
                });
            } catch (err) {
                this.config.logger.error(
                    `[ha-listener] failed to exec openclaw agent: ${String(err)}`,
                );
            }
        }

        // Remove one-shot listeners that fired
        const firedOneShotIds = new Set(
            matched.filter((l) => l.oneShot).map((l) => l.id),
        );
        if (firedOneShotIds.size > 0) {
            const remaining = listeners.filter((l) => !firedOneShotIds.has(l.id));
            await saveListeners(this.config.stateDir, remaining);
            this.config.logger.info(
                `[ha-listener] removed ${firedOneShotIds.size} one-shot listener(s)`,
            );
        }
    }
}
