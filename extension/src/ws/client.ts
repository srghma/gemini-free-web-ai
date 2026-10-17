import { CONFIG } from "../config";
import { submitPrompt } from "../dom/promptBox";
import { formatExecutionReply } from "../execution/formatter";
import type { DaemonExecutionResponse } from "../types";
import type { StatusBadgeManager } from "../ui/statusBadge";

interface QueuedTask {
  type: string;
  code: string;
  timeout: string;
}

export class BridgeWebSocket {
  private socket: WebSocket | null = null;
  private isReconnecting = false;
  private retryDelayMs = 2000;
  private pendingQueue: QueuedTask[] = [];

  constructor(
    private statusBadge: StatusBadgeManager,
    private tabId: string
  ) {
    this.connect();
  }

  private connect(): void {
    try {
      this.socket = new WebSocket(CONFIG.wsUrl);
    } catch {
      this.statusBadge.setOffline("Daemon Offline");
      this.scheduleReconnect();
      return;
    }

    this.socket.onopen = () => {
      this.isReconnecting = false;
      this.retryDelayMs = 2000;
      this.statusBadge.setReady("Daemon Ready");

      this.send({
        event: "tab_connected",
        tabId: this.tabId,
        title: document.title.replace(" - Google AI Studio", "").trim() || "Chat Tab",
      });

      this.flushQueue();
    };

    this.socket.onmessage = async (event: MessageEvent) => {
      try {
        const data: DaemonExecutionResponse = JSON.parse(event.data);
        if (data.status === "running") {
          this.statusBadge.setRunning(data.type, data.timeout);
          return;
        }

        this.statusBadge.setFinished(data.type, data.exitCode ?? 0, data.output || "");
        await submitPrompt(formatExecutionReply(data));
      } catch (err) {
        console.error("[Bridge] Failed parsing daemon message:", err);
      }
    };

    this.socket.onclose = () => {
      this.statusBadge.setOffline("Daemon Offline");
      this.scheduleReconnect();
    };

    this.socket.onerror = () => {
      this.socket?.close();
    };
  }

  private scheduleReconnect(): void {
    if (this.isReconnecting) return;
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

  public sendTask(type: string, code: string, timeout: string): boolean {
    const task: QueuedTask = { type, code, timeout };
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.dispatchTask(task);
      return true;
    }
    this.pendingQueue.push(task);
    return false;
  }

  private dispatchTask(task: QueuedTask): void {
    this.send({
      command: `execute-${task.type}-and-send-output-to`,
      tabId: this.tabId,
      type: task.type,
      timeout: task.timeout,
      code: task.code,
    });
  }

  private flushQueue(): void {
    while (this.pendingQueue.length > 0) {
      const task = this.pendingQueue.shift();
      if (!task) break;
      this.dispatchTask(task);
    }
  }
}
