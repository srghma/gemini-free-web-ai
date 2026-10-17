import { CONFIG } from "../config";
import type { ExtractedTurn, PreferenceVoteData, PromptBoxStatus } from "../types";
import type { StatusBadgeManager } from "../ui/statusBadge";

export interface InitialDataPayload {
  turns: ExtractedTurn[];
  prompt: PromptBoxStatus;
  preferenceVote: PreferenceVoteData | null;
}

export type CommandHandler = (payload: Record<string, unknown>) => void | Promise<void>;

export class BridgeWebSocket {
  private socket: WebSocket | null = null;
  private isReconnecting = false;
  private retryDelayMs = 2000;
  private isManuallyDisabled = false;
  private commandHandlers = new Map<string, CommandHandler>();
  private initialDataProvider: (() => InitialDataPayload) | null = null;

  constructor(
    private statusBadge: StatusBadgeManager,
    private tabId: string
  ) {
    this.connect();
  }

  public setInitialDataProvider(provider: () => InitialDataPayload): void {
    this.initialDataProvider = provider;
  }

  public onCommand(command: string, handler: CommandHandler): void {
    this.commandHandlers.set(command, handler);
  }

  public disable(): void {
    this.isManuallyDisabled = true;
    if (this.socket) {
      try {
        this.send({ event: "tab_disconnected", tabId: this.tabId });
        this.socket.close(1000, "User disabled tab");
      } catch {}
      this.socket = null;
    }
  }

  public enable(): void {
    this.isManuallyDisabled = false;
    this.connect();
  }

  private connect(): void {
    if (this.isManuallyDisabled) return;

    try {
      this.socket = new WebSocket(CONFIG.wsUrl);
    } catch {
      this.statusBadge.setOffline("Daemon Offline");
      this.scheduleReconnect();
      return;
    }

    this.socket.onopen = () => {
      if (this.isManuallyDisabled) {
        this.socket?.close();
        return;
      }

      this.isReconnecting = false;
      this.retryDelayMs = 2000;
      this.statusBadge.setReady("Daemon Ready");

      const initData = this.initialDataProvider?.();
      this.send({
        event: "tab_connected",
        tabId: this.tabId,
        title: document.title.replace(" - Google AI Studio", "").trim() || "Chat Tab",
        turns: initData?.turns ?? [],
        promptText: initData?.prompt.promptText ?? "",
        buttonLabel: initData?.prompt.buttonLabel ?? "Run",
        preferenceVote: initData?.preferenceVote ?? null,
      });
    };

    this.socket.onmessage = async (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        const command = data.command;

        if (data.status === "running") {
          this.statusBadge.setRunning(data.type, data.timeout);
          return;
        }

        if (command && this.commandHandlers.has(command)) {
          const handler = this.commandHandlers.get(command);
          await handler?.(data);
        }
      } catch (err) {
        console.error("[Bridge] Failed parsing daemon message:", err);
      }
    };

    this.socket.onclose = () => {
      if (!this.isManuallyDisabled) {
        this.statusBadge.setOffline("Daemon Offline");
        this.scheduleReconnect();
      }
    };

    this.socket.onerror = () => {
      this.socket?.close();
    };
  }

  private scheduleReconnect(): void {
    if (this.isReconnecting || this.isManuallyDisabled) return;
    this.isReconnecting = true;
    setTimeout(() => {
      this.isReconnecting = false;
      this.connect();
    }, this.retryDelayMs);
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, 15000);
  }

  public send(payload: Record<string, unknown>): boolean {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }
}
